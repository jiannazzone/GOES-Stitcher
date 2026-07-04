/*
 * timelapse.js — Time-lapse mode.
 *
 * Pick a product (composite / band / L2), a variant (plain or coastlines), a
 * working resolution and fps; the mode decodes each matching frame across time
 * into downscaled ImageBitmaps and plays them back with scrub / loop / burned-in
 * timestamp, plus WebM + PNG export.
 *
 * Built time-lapses are CACHED per (product, variant, resolution) for the life of
 * the region, so switching product never re-runs a build — it just swaps to the
 * cached frames instantly (auto-building the product the first time it's shown).
 * "Prerender all" decodes every product up front so every switch is zero-latency.
 *
 * Exposed as GS.TimelapseMode.create(panelEl, stageEl, region, ctx) -> { destroy }.
 * DOM is built with GS.dom.el (defined in app.js, available at mount time).
 */
(function (GS) {
  'use strict';

  function sanitize(s) { return String(s).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, ''); }

  function resolutionOptions(region) {
    var meso = /mesoscale/i.test(region.id);
    if (meso) return [{ v: 500, label: '500 px (native)' }, { v: 1000, label: '1000 px' }];
    return [
      { v: 512, label: '512 px (fast)' },
      { v: 1024, label: '1024 px (recommended)' },
      { v: 2048, label: '2048 px (sharp)' },
      { v: null, label: 'Native 5424 px (heavy)' }
    ];
  }
  function defaultResolution(region) { return /mesoscale/i.test(region.id) ? 500 : 1024; }

  function drawCaption(ctx, W, H, title, sub) {
    var f = Math.max(11, Math.round(W * 0.018));
    ctx.save();
    ctx.font = f + 'px system-ui, sans-serif';
    ctx.textBaseline = 'alphabetic';
    var padX = f * 0.7, padY = f * 0.55, gap = f * 0.35;
    var tW = ctx.measureText(title).width;
    ctx.font = (f * 0.82) + 'px system-ui, sans-serif';
    var sW = sub ? ctx.measureText(sub).width : 0;
    var boxW = Math.max(tW, sW) + padX * 2;
    var boxH = (sub ? f + f * 0.82 + gap : f) + padY * 2;
    var x = f * 0.6, y = H - boxH - f * 0.6;
    ctx.fillStyle = 'rgba(10,7,3,0.64)';
    ctx.fillRect(x, y, boxW, boxH);
    ctx.fillStyle = '#f5efe2';
    ctx.font = f + 'px system-ui, sans-serif';
    ctx.fillText(title, x + padX, y + padY + f * 0.85);
    if (sub) {
      ctx.fillStyle = '#f2c37a';
      ctx.font = (f * 0.82) + 'px system-ui, sans-serif';
      ctx.fillText(sub, x + padX, y + padY + f + gap + f * 0.82);
    }
    ctx.restore();
  }

  GS.TimelapseMode = {
    create: function (panel, stage, region, ctx) {
      var el = GS.dom.el;
      var destroyed = false;
      var cache = {};   // "productKey|variant|res" -> entry
      var state = { cur: null, frames: [], bitmaps: [], index: 0, playing: false, raf: 0, acc: 0, last: 0, prerendering: false };

      var products = region.products.filter(function (p) { return p.frames.length > 0; });

      /* ----- panel controls ----- */
      var productSel = el('select', { class: 'gs-select' });
      var groups = { composite: 'Composites', channel: 'Raw ABI Bands', l2: 'Level-2 Products' };
      ['composite', 'channel', 'l2'].forEach(function (kind) {
        var items = products.filter(function (p) { return p.kind === kind; });
        if (!items.length) return;
        var og = el('optgroup', { label: groups[kind] });
        items.forEach(function (p) {
          og.appendChild(el('option', { value: p.key, text: p.name + '  (' + p.frames.length + ' frame' + (p.frames.length > 1 ? 's' : '') + ')' }));
        });
        productSel.appendChild(og);
      });

      var variantPlain = el('input', { type: 'radio', name: 'gs-tl-var', value: 'plain', checked: true });
      var variantMap = el('input', { type: 'radio', name: 'gs-tl-var', value: 'map' });
      var variantMapLabel = el('label', { class: 'gs-radio' }, [variantMap, ' Coastlines']);

      var resSel = el('select', { class: 'gs-select' });
      resolutionOptions(region).forEach(function (o) {
        resSel.appendChild(el('option', { value: o.v == null ? 'native' : String(o.v), text: o.label }));
      });
      resSel.value = String(defaultResolution(region));

      var fps = el('input', { type: 'range', min: '1', max: '24', value: '8', class: 'gs-range' });
      var fpsOut = el('span', { class: 'gs-num', text: '8 fps' });
      fps.addEventListener('input', function () { fpsOut.textContent = fps.value + ' fps'; });

      var loopChk = el('input', { type: 'checkbox', checked: true });
      var stampChk = el('input', { type: 'checkbox', checked: true });

      var prerenderBtn = el('button', { class: 'gs-btn gs-btn-primary', text: 'Prerender all · ' + products.length });
      var progWrap = el('div', { class: 'gs-progress', style: { display: 'none' } });
      var progBar = el('div', { class: 'gs-progress-bar' });
      progWrap.appendChild(progBar);
      var progText = el('div', { class: 'gs-hint', style: { display: 'none' } });

      function selectedProduct() { return products.filter(function (x) { return x.key === productSel.value; })[0]; }
      function curVariant() { return (variantMap.checked && !variantMap.disabled) ? 'map' : 'plain'; }

      function refreshVariant() {
        var p = selectedProduct();
        var hasMap = p && p.hasMap;
        variantMap.disabled = !hasMap;
        variantMapLabel.classList.toggle('gs-disabled', !hasMap);
        if (!hasMap) variantPlain.checked = true;
      }
      productSel.addEventListener('change', onProductChange);

      panel.appendChild(el('div', { class: 'gs-field' }, [el('label', { class: 'gs-label', text: 'Product' }), productSel]));
      panel.appendChild(el('div', { class: 'gs-field' }, [
        el('label', { class: 'gs-label', text: 'Overlay' }),
        el('div', { class: 'gs-radios' }, [el('label', { class: 'gs-radio' }, [variantPlain, ' Plain']), variantMapLabel])
      ]));
      panel.appendChild(el('div', { class: 'gs-field' }, [el('label', { class: 'gs-label', text: 'Resolution' }), resSel]));
      panel.appendChild(el('div', { class: 'gs-field' }, [el('label', { class: 'gs-label' }, ['Speed ', fpsOut]), fps]));
      panel.appendChild(el('div', { class: 'gs-field gs-checks' }, [
        el('label', { class: 'gs-check' }, [loopChk, ' Loop']),
        el('label', { class: 'gs-check' }, [stampChk, ' Burn timestamp'])
      ]));
      panel.appendChild(prerenderBtn);
      panel.appendChild(progWrap);
      panel.appendChild(progText);

      /* ----- transport ----- */
      var playBtn = el('button', { class: 'gs-btn', text: '▶ Play', disabled: true });
      var prevBtn = el('button', { class: 'gs-btn gs-btn-icon', text: '⏮', disabled: true });
      var nextBtn = el('button', { class: 'gs-btn gs-btn-icon', text: '⏭', disabled: true });
      var scrub = el('input', { type: 'range', min: '0', max: '0', value: '0', class: 'gs-range', disabled: true });
      var counter = el('span', { class: 'gs-num', text: '— / —' });
      var webmBtn = el('button', { class: 'gs-btn', text: 'Export WebM', disabled: true });
      var pngBtn = el('button', { class: 'gs-btn', text: 'Save frame PNG', disabled: true });
      if (!GS.imaging.supportsWebM()) webmBtn.title = 'WebM export needs Chrome, Edge or Firefox.';

      var transport = el('div', { class: 'gs-transport', style: { display: 'none' } }, [
        el('div', { class: 'gs-transport-row' }, [prevBtn, playBtn, nextBtn, counter]),
        scrub,
        el('div', { class: 'gs-transport-row' }, [webmBtn, pngBtn])
      ]);
      panel.appendChild(transport);

      /* ----- stage ----- */
      var canvas = el('canvas', { class: 'gs-canvas' });
      var stageMsg = el('div', { class: 'gs-stage-msg', text: 'Loading region…' });
      stage.appendChild(canvas);
      stage.appendChild(stageMsg);

      /* ----- cache / build ----- */
      function framesFor(product, variant) {
        var fs = product.frames.filter(function (f) { return f.variants[variant]; });
        if (!fs.length && variant === 'map') fs = product.frames.filter(function (f) { return f.variants.plain; });
        return fs.map(function (f) {
          var file = f.variants[variant] || f.variants.plain || f.variants.map;
          return { time: f.time, label: f.label, file: file };
        });
      }
      function keyFor(product, variant) { return product.key + '|' + variant + '|' + resSel.value; }

      function getEntry(product) {
        var variant = curVariant();
        var k = keyFor(product, variant);
        var e = cache[k];
        if (!e) {
          var frames = framesFor(product, variant);
          e = {
            key: k, product: product, variant: variant,
            size: resSel.value === 'native' ? null : parseInt(resSel.value, 10),
            frames: frames, bitmaps: new Array(frames.length),
            done: frames.length === 0, promise: null
          };
          cache[k] = e;
        }
        return e;
      }

      // Decode an entry's frames sequentially (once). Resolves the entry.
      function buildEntry(e, onFrame) {
        if (e.done) return Promise.resolve(e);
        if (e.promise) return e.promise;
        var i = 0;
        e.promise = new Promise(function (resolve) {
          (function next() {
            if (destroyed) { resolve(e); return; }
            if (i >= e.frames.length) { e.done = true; resolve(e); return; }
            GS.imaging.decodeScaled(e.frames[i].file, e.size).then(function (bmp) {
              if (destroyed) { if (bmp.close) bmp.close(); resolve(e); return; }
              e.bitmaps[i] = bmp; i++;
              if (onFrame) onFrame(e, i);
              next();
            }).catch(function (err) {
              ctx.toast('Decode failed: ' + err.message, 'error'); i++; next();
            });
          })();
        });
        return e.promise;
      }

      // Free bitmaps for cache entries not matching the current variant/resolution.
      function pruneCache() {
        var suffix = '|' + curVariant() + '|' + resSel.value;
        Object.keys(cache).forEach(function (k) {
          if (k.indexOf(suffix, k.length - suffix.length) === -1) {
            (cache[k].bitmaps || []).forEach(function (b) { if (b && b.close) b.close(); });
            delete cache[k];
          }
        });
      }

      /* ----- display ----- */
      function currentMeta() {
        var p = state.cur && state.cur.product;
        return { title: p ? p.name : '', sub: ctx.satLabel + ' · ' + region.id };
      }

      function paint(i) {
        var bmp = state.bitmaps[i];
        if (!bmp) return;
        if (canvas.width !== bmp.width) { canvas.width = bmp.width; canvas.height = bmp.height; }
        var cx = canvas.getContext('2d');
        cx.clearRect(0, 0, canvas.width, canvas.height);
        cx.drawImage(bmp, 0, 0);
        if (stampChk.checked) {
          var m = currentMeta();
          drawCaption(cx, canvas.width, canvas.height, GS.imaging.formatUTC(state.frames[i].time), m.title + ' · ' + m.sub);
        }
        counter.textContent = (i + 1) + ' / ' + state.frames.length + '  ·  ' + state.frames[i].label;
        scrub.value = String(i);
        state.index = i;
      }

      function updateTransport() {
        var e = state.cur;
        var ready = !!(e && e.done && e.frames.length >= 1);
        var multi = !!(e && e.done && e.frames.length > 1);
        [playBtn, prevBtn, nextBtn].forEach(function (b) { b.disabled = !multi; });
        scrub.disabled = !multi;
        scrub.max = String(Math.max(0, (e ? e.frames.length : 1) - 1));
        pngBtn.disabled = !ready;
        webmBtn.disabled = !(multi && GS.imaging.supportsWebM());
        transport.style.display = ready ? 'block' : 'none';
      }

      // Show a product: swap to its cached frames (building on demand). Returns a
      // promise that resolves once the product is displayed (fully built).
      function showProduct(product, resetIndex) {
        var e = getEntry(product);
        state.cur = e;
        state.frames = e.frames;
        state.bitmaps = e.bitmaps;
        if (resetIndex || state.index >= e.frames.length) state.index = 0;

        if (!e.frames.length) {
          stageMsg.textContent = 'No frames for this product/overlay.';
          stageMsg.style.display = 'block';
          updateTransport();
          return Promise.resolve(e);
        }
        if (e.done) {
          stageMsg.style.display = 'none';
          updateTransport();
          paint(state.index);
          return Promise.resolve(e);
        }
        // needs building
        stageMsg.textContent = 'Decoding ' + product.name + '…';
        stageMsg.style.display = 'block';
        if (!state.prerendering) { progWrap.style.display = 'block'; progText.style.display = 'block'; progBar.style.width = '0%'; }
        return buildEntry(e, function (entry, n) {
          if (state.cur !== entry) return;      // user moved on
          if (n === 1) { stageMsg.style.display = 'none'; paint(0); }
          if (!state.prerendering) {
            progBar.style.width = Math.round((n / entry.frames.length) * 100) + '%';
            progText.textContent = 'Decoding ' + product.name + ' · ' + n + ' / ' + entry.frames.length;
          }
          updateTransport();
        }).then(function (entry) {
          if (state.cur !== entry) return entry;
          if (!state.prerendering) { progWrap.style.display = 'none'; progText.style.display = 'none'; }
          stageMsg.style.display = 'none';
          updateTransport();
          paint(state.index);
          return entry;
        });
      }

      /* ----- prerender all ----- */
      function prerenderAll() {
        if (state.prerendering) return;
        var cur = selectedProduct();
        var list = products.slice().sort(function (a, b) { return a === cur ? -1 : b === cur ? 1 : 0; });
        var total = list.length, done = 0;
        state.prerendering = true;
        prerenderBtn.disabled = true; prerenderBtn.textContent = 'Prerendering…';
        progWrap.style.display = 'block'; progText.style.display = 'block';
        (function step(i) {
          if (destroyed) { finish(false); return; }
          if (i >= list.length) { finish(true); return; }
          var e = getEntry(list[i]);
          progBar.style.width = Math.round((done / total) * 100) + '%';
          progText.textContent = 'Prerendering ' + (done + 1) + ' / ' + total + ' · ' + list[i].name;
          buildEntry(e, function (entry, n) {
            if (state.cur === entry && n === 1) { stageMsg.style.display = 'none'; paint(0); updateTransport(); }
          }).then(function (entry) {
            if (state.cur === entry) { updateTransport(); paint(state.index); }
            done++; step(i + 1);
          });
        })(0);
        function finish(ok) {
          state.prerendering = false;
          prerenderBtn.disabled = false; prerenderBtn.textContent = 'Prerender all · ' + products.length;
          progWrap.style.display = 'none'; progText.style.display = 'none';
          if (ok) ctx.toast('Prerendered ' + total + ' product' + (total > 1 ? 's' : '') + '.', 'ok');
        }
      }

      /* ----- playback ----- */
      function stop() { state.playing = false; playBtn.textContent = '▶ Play'; if (state.raf) { cancelAnimationFrame(state.raf); state.raf = 0; } }
      function tick(ts) {
        if (!state.playing) return;
        if (!state.last) state.last = ts;
        var step = 1000 / Math.max(1, parseInt(fps.value, 10));
        state.acc += ts - state.last; state.last = ts;
        while (state.acc >= step) {
          state.acc -= step;
          var nx = state.index + 1;
          if (nx >= state.frames.length) { if (loopChk.checked) nx = 0; else { paint(state.frames.length - 1); stop(); return; } }
          paint(nx);
        }
        state.raf = requestAnimationFrame(tick);
      }
      function play() { if (state.frames.length < 2) return; state.playing = true; state.last = 0; state.acc = 0; playBtn.textContent = '⏸ Pause'; state.raf = requestAnimationFrame(tick); }

      playBtn.addEventListener('click', function () { state.playing ? stop() : play(); });
      prevBtn.addEventListener('click', function () { stop(); paint((state.index - 1 + state.frames.length) % state.frames.length); });
      nextBtn.addEventListener('click', function () { stop(); paint((state.index + 1) % state.frames.length); });
      scrub.addEventListener('input', function () { stop(); paint(parseInt(scrub.value, 10)); });

      /* ----- change handlers ----- */
      function onProductChange() {
        refreshVariant();
        var wasPlaying = state.playing; stop();
        showProduct(selectedProduct(), true).then(function () { if (wasPlaying && !destroyed) play(); });
      }
      function onDimChange() {
        var wasPlaying = state.playing; stop();
        pruneCache();
        showProduct(selectedProduct(), false).then(function () { if (wasPlaying && !destroyed) play(); });
      }
      variantPlain.addEventListener('change', onDimChange);
      variantMap.addEventListener('change', onDimChange);
      resSel.addEventListener('change', onDimChange);
      prerenderBtn.addEventListener('click', prerenderAll);

      /* ----- export ----- */
      function renderTo(exportCanvas, i) {
        var bmp = state.bitmaps[i];
        exportCanvas.width = bmp.width; exportCanvas.height = bmp.height;
        var cx = exportCanvas.getContext('2d');
        cx.clearRect(0, 0, bmp.width, bmp.height);
        cx.drawImage(bmp, 0, 0);
        if (stampChk.checked) {
          var m = currentMeta();
          drawCaption(cx, bmp.width, bmp.height, GS.imaging.formatUTC(state.frames[i].time), m.title + ' · ' + m.sub);
        }
      }
      function baseName() {
        var p = state.cur && state.cur.product;
        return sanitize(ctx.satLabel.split(' ')[0] + '_' + region.id + '_' + (p ? p.name : 'product'));
      }

      pngBtn.addEventListener('click', function () {
        if (!state.cur || !state.cur.done) return;
        var ex = document.createElement('canvas');
        renderTo(ex, state.index);
        GS.imaging.canvasToPng(ex).then(function (blob) {
          GS.imaging.downloadBlob(blob, baseName() + '_' + GS.imaging.stamp(state.frames[state.index].time) + '.png');
        });
      });

      webmBtn.addEventListener('click', function () {
        if (!state.frames.length) return;
        stop();
        var ex = document.createElement('canvas');
        var fpsVal = parseInt(fps.value, 10);
        webmBtn.disabled = true; webmBtn.textContent = 'Recording…';
        GS.imaging.recordWebM(ex, {
          fps: fpsVal, count: state.frames.length,
          draw: function (i) { renderTo(ex, i); },
          onProgress: function (d, t) { webmBtn.textContent = 'Recording… ' + d + '/' + t; }
        }).then(function (blob) {
          GS.imaging.downloadBlob(blob, baseName() + '_' + GS.imaging.stamp(state.frames[0].time) + '_' + fpsVal + 'fps.webm');
          ctx.toast('Exported WebM (' + state.frames.length + ' frames @ ' + fpsVal + ' fps).', 'ok');
        }).catch(function (e) { ctx.toast('WebM export failed: ' + e.message, 'error'); })
          .then(function () { webmBtn.textContent = 'Export WebM'; webmBtn.disabled = false; updateTransport(); });
      });

      /* ----- keyboard ----- */
      function onKey(e) {
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        var t = e.target, tag = t && (t.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
        var k = e.key;
        if (k === ' ' || k === 'Spacebar') { if (state.frames.length > 1) { state.playing ? stop() : play(); e.preventDefault(); } }
        else if (k === 'ArrowRight') { if (state.frames.length) { stop(); paint((state.index + 1) % state.frames.length); e.preventDefault(); } }
        else if (k === 'ArrowLeft') { if (state.frames.length) { stop(); paint((state.index - 1 + state.frames.length) % state.frames.length); e.preventDefault(); } }
        else if (k === 'b' || k === 'B') { if (!prerenderBtn.disabled) prerenderAll(); }
        else if (k === 'e' || k === 'E') { if (!webmBtn.disabled) webmBtn.click(); }
        else if (k === 's' || k === 'S') { if (!pngBtn.disabled) pngBtn.click(); }
      }
      document.addEventListener('keydown', onKey);

      /* ----- init: auto-show the default product ----- */
      refreshVariant();
      showProduct(selectedProduct(), true);

      return {
        destroy: function () {
          destroyed = true;
          document.removeEventListener('keydown', onKey);
          stop();
          Object.keys(cache).forEach(function (k) {
            (cache[k].bitmaps || []).forEach(function (b) { if (b && b.close) b.close(); });
          });
        }
      };
    }
  };
})(window.GS = window.GS || {});
