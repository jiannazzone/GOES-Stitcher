/*
 * timelapse.js — Time-lapse mode.
 *
 * Given a region, let the user pick one product (composite / band / L2), a
 * variant (plain or coastlines), a working resolution and fps, then decode every
 * matching frame across time into downscaled ImageBitmaps and play them back on a
 * canvas. Supports scrubbing, looping, a burned-in UTC timestamp, WebM export and
 * single-frame PNG save.
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
      var state = {
        frames: [], bitmaps: [], index: 0, playing: false,
        raf: 0, acc: 0, last: 0, buildToken: 0, product: null, meta: ''
      };

      /* ----- build panel controls ----- */
      var products = region.products.filter(function (p) { return p.frames.length > 0; });

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

      var buildBtn = el('button', { class: 'gs-btn gs-btn-primary', text: 'Build time-lapse' });
      var progWrap = el('div', { class: 'gs-progress', style: { display: 'none' } });
      var progBar = el('div', { class: 'gs-progress-bar' });
      progWrap.appendChild(progBar);
      var progText = el('div', { class: 'gs-hint', style: { display: 'none' } });

      function refreshVariant() {
        var p = products.filter(function (x) { return x.key === productSel.value; })[0];
        var hasMap = p && p.hasMap;
        variantMap.disabled = !hasMap;
        variantMapLabel.classList.toggle('gs-disabled', !hasMap);
        if (!hasMap) variantPlain.checked = true;
      }
      productSel.addEventListener('change', refreshVariant);

      panel.appendChild(el('div', { class: 'gs-field' }, [el('label', { class: 'gs-label', text: 'Product' }), productSel]));
      panel.appendChild(el('div', { class: 'gs-field' }, [
        el('label', { class: 'gs-label', text: 'Overlay' }),
        el('div', { class: 'gs-radios' }, [
          el('label', { class: 'gs-radio' }, [variantPlain, ' Plain']),
          variantMapLabel
        ])
      ]));
      panel.appendChild(el('div', { class: 'gs-field' }, [el('label', { class: 'gs-label', text: 'Resolution' }), resSel]));
      panel.appendChild(el('div', { class: 'gs-field' }, [
        el('label', { class: 'gs-label' }, ['Speed ', fpsOut]), fps
      ]));
      panel.appendChild(el('div', { class: 'gs-field gs-checks' }, [
        el('label', { class: 'gs-check' }, [loopChk, ' Loop']),
        el('label', { class: 'gs-check' }, [stampChk, ' Burn timestamp'])
      ]));
      panel.appendChild(buildBtn);
      panel.appendChild(progWrap);
      panel.appendChild(progText);

      /* ----- transport (hidden until built) ----- */
      var playBtn = el('button', { class: 'gs-btn', text: '▶ Play', disabled: true });
      var prevBtn = el('button', { class: 'gs-btn gs-btn-icon', text: '⏮', disabled: true });
      var nextBtn = el('button', { class: 'gs-btn gs-btn-icon', text: '⏭', disabled: true });
      var scrub = el('input', { type: 'range', min: '0', max: '0', value: '0', class: 'gs-range', disabled: true });
      var counter = el('span', { class: 'gs-num', text: '— / —' });
      var webmBtn = el('button', { class: 'gs-btn', text: 'Export WebM', disabled: true });
      var pngBtn = el('button', { class: 'gs-btn', text: 'Save frame PNG', disabled: true });

      if (!GS.imaging.supportsWebM()) {
        webmBtn.title = 'WebM export needs Chrome, Edge or Firefox.';
      }

      var transport = el('div', { class: 'gs-transport', style: { display: 'none' } }, [
        el('div', { class: 'gs-transport-row' }, [prevBtn, playBtn, nextBtn, counter]),
        scrub,
        el('div', { class: 'gs-transport-row' }, [webmBtn, pngBtn])
      ]);
      panel.appendChild(transport);

      /* ----- stage ----- */
      var canvas = el('canvas', { class: 'gs-canvas' });
      var stageMsg = el('div', { class: 'gs-stage-msg', text: 'Pick a product and press “Build time-lapse”.' });
      stage.appendChild(canvas);
      stage.appendChild(stageMsg);

      /* ----- helpers ----- */
      function currentMeta() {
        var p = state.product;
        return {
          title: p ? p.name : '',
          sub: ctx.satLabel + ' · ' + region.id
        };
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

      function stop() {
        state.playing = false;
        playBtn.textContent = '▶ Play';
        if (state.raf) { cancelAnimationFrame(state.raf); state.raf = 0; }
      }

      function tick(ts) {
        if (!state.playing) return;
        if (!state.last) state.last = ts;
        var step = 1000 / Math.max(1, parseInt(fps.value, 10));
        state.acc += ts - state.last;
        state.last = ts;
        while (state.acc >= step) {
          state.acc -= step;
          var next = state.index + 1;
          if (next >= state.frames.length) {
            if (loopChk.checked) next = 0;
            else { paint(state.frames.length - 1); stop(); return; }
          }
          paint(next);
        }
        state.raf = requestAnimationFrame(tick);
      }

      function play() {
        if (state.frames.length < 2) return;
        state.playing = true; state.last = 0; state.acc = 0;
        playBtn.textContent = '⏸ Pause';
        state.raf = requestAnimationFrame(tick);
      }

      playBtn.addEventListener('click', function () { state.playing ? stop() : play(); });
      prevBtn.addEventListener('click', function () { stop(); paint((state.index - 1 + state.frames.length) % state.frames.length); });
      nextBtn.addEventListener('click', function () { stop(); paint((state.index + 1) % state.frames.length); });
      scrub.addEventListener('input', function () { stop(); paint(parseInt(scrub.value, 10)); });

      function closeBitmaps() {
        state.bitmaps.forEach(function (b) { if (b && b.close) b.close(); });
        state.bitmaps = [];
      }

      function setBuilding(on) {
        buildBtn.disabled = on;
        buildBtn.textContent = on ? 'Building…' : 'Build time-lapse';
        progWrap.style.display = on ? 'block' : 'none';
      }

      function build() {
        var p = products.filter(function (x) { return x.key === productSel.value; })[0];
        if (!p) return;
        var variant = variantMap.checked ? 'map' : 'plain';
        var sizeRaw = resSel.value;
        var size = sizeRaw === 'native' ? null : parseInt(sizeRaw, 10);

        var frames = p.frames.filter(function (f) { return f.variants[variant]; }).map(function (f) {
          return { time: f.time, label: f.label, file: f.variants[variant] };
        });
        if (!frames.length) { ctx.toast('No frames for that overlay choice.', 'warn'); return; }

        stop();
        var token = ++state.buildToken;
        closeBitmaps();
        state.frames = frames;
        state.product = p;
        state.bitmaps = new Array(frames.length);
        setBuilding(true);
        progBar.style.width = '0%';
        progText.style.display = 'block';
        progText.textContent = 'Decoding 0 / ' + frames.length + ' frames…';
        stageMsg.style.display = 'none';

        var i = 0;
        function next() {
          if (token !== state.buildToken) return; // superseded by a newer build
          if (i >= frames.length) { finishBuild(token); return; }
          GS.imaging.decodeScaled(frames[i].file, size).then(function (bmp) {
            if (token !== state.buildToken) { if (bmp.close) bmp.close(); return; }
            state.bitmaps[i] = bmp;
            i++;
            var pct = Math.round((i / frames.length) * 100);
            progBar.style.width = pct + '%';
            progText.textContent = 'Decoding ' + i + ' / ' + frames.length + ' frames…';
            next();
          }).catch(function (e) {
            ctx.toast('Failed to decode a frame: ' + e.message, 'error');
            i++; next();
          });
        }
        next();
      }

      function finishBuild(token) {
        if (token !== state.buildToken) return;
        setBuilding(false);
        progText.style.display = 'none';
        var n = state.frames.length;
        scrub.max = String(n - 1);
        var multi = n > 1;
        [playBtn, prevBtn, nextBtn].forEach(function (b) { b.disabled = !multi; });
        scrub.disabled = !multi;
        pngBtn.disabled = false;
        webmBtn.disabled = !(multi && GS.imaging.supportsWebM());
        transport.style.display = 'block';
        paint(0);
        ctx.toast('Built ' + n + ' frame' + (n > 1 ? 's' : '') + '.', 'ok');
      }

      buildBtn.addEventListener('click', build);

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
        var p = state.product;
        return sanitize(ctx.satLabel.split(' ')[0] + '_' + region.id + '_' + (p ? p.name : 'product'));
      }

      pngBtn.addEventListener('click', function () {
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
          fps: fpsVal,
          count: state.frames.length,
          draw: function (i) { renderTo(ex, i); },
          onProgress: function (d, t) { webmBtn.textContent = 'Recording… ' + d + '/' + t; }
        }).then(function (blob) {
          var start = GS.imaging.stamp(state.frames[0].time);
          GS.imaging.downloadBlob(blob, baseName() + '_' + start + '_' + fpsVal + 'fps.webm');
          ctx.toast('Exported WebM (' + state.frames.length + ' frames @ ' + fpsVal + ' fps).', 'ok');
        }).catch(function (e) {
          ctx.toast('WebM export failed: ' + e.message, 'error');
        }).then(function () {
          webmBtn.textContent = 'Export WebM'; webmBtn.disabled = false;
        });
      });

      refreshVariant();

      // Keyboard shortcuts, active only while this mode is mounted.
      function onKey(e) {
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        var t = e.target, tag = t && (t.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
        var k = e.key;
        if (k === ' ' || k === 'Spacebar') {
          if (state.frames.length > 1) { state.playing ? stop() : play(); e.preventDefault(); }
        } else if (k === 'ArrowRight') {
          if (state.frames.length) { stop(); paint((state.index + 1) % state.frames.length); e.preventDefault(); }
        } else if (k === 'ArrowLeft') {
          if (state.frames.length) { stop(); paint((state.index - 1 + state.frames.length) % state.frames.length); e.preventDefault(); }
        } else if (k === 'b' || k === 'B') {
          if (!buildBtn.disabled) build();
        } else if (k === 'e' || k === 'E') {
          if (!webmBtn.disabled) webmBtn.click();
        } else if (k === 's' || k === 'S') {
          if (!pngBtn.disabled) pngBtn.click();
        }
      }
      document.addEventListener('keydown', onKey);

      return {
        destroy: function () {
          document.removeEventListener('keydown', onKey);
          stop();
          state.buildToken++; // cancel any in-flight build
          closeBitmaps();
        }
      };
    }
  };
})(window.GS = window.GS || {});
