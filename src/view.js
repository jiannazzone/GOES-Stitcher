/*
 * view.js — the unified view.
 *
 * One canvas that composites a BASE image (any composite / band / L2, optionally
 * with coastlines) plus a stack of toggleable Level-2 LAYERS (opacity + blend) —
 * and a single TIMELINE you scrub or play. The base product is the clock: its
 * scans define the timeline, and every active layer snaps to its nearest frame in
 * time as you move, so base + layers animate together.
 *
 * Decoded frames are cached per (product, variant, resolution) and shared between
 * the base and the layers; "Prerender all" (and the auto pass) decode every
 * product so scrubbing and layer toggles stay instant. Exports composite each
 * frame: an MP4 over the whole timeline, PNG of the current composite.
 *
 * Exposed as GS.ViewMode.create(panelEl, stageEl, region, ctx) -> { destroy }.
 */
(function (GS) {
  'use strict';

  function sanitize(s) { return String(s).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, ''); }

  function resolutionOptions(region) {
    if (/mesoscale/i.test(region.id)) return [{ v: 500, label: '500 px (native)' }, { v: 1000, label: '1000 px' }];
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
    ctx.textBaseline = 'alphabetic';
    var padX = f * 0.7, padY = f * 0.55, gap = f * 0.35;
    ctx.font = f + 'px system-ui, sans-serif';
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

  GS.ViewMode = {
    create: function (panel, stage, region, ctx) {
      var el = GS.dom.el;
      var destroyed = false;
      var cache = {};                 // "productKey|variant|res" -> entry
      var autoTimer = 0;
      var aboutEl = document.getElementById('about');   // cached; queried on every keydown
      var state = { baseEntry: null, index: 0, playing: false, raf: 0, acc: 0, last: 0, prerendering: false };

      // Deflicker uses ctx.filter='brightness(g)' per frame; feature-detect once
      // (older Safari ignores canvas filters). lumaCv samples frame brightness.
      var CTX_FILTER_OK = (function () {
        try { var c = document.createElement('canvas').getContext('2d'); c.filter = 'brightness(0.5)'; return c.filter !== '' && c.filter !== 'none'; }
        catch (e) { return false; }
      })();
      var lumaCv = document.createElement('canvas'); lumaCv.width = lumaCv.height = 64;
      var batchRunning = false;
      var view = { scale: 1, tx: 0, ty: 0 };   // pan/zoom of the on-screen canvas

      var products = region.products.filter(function (p) { return p.frames.length > 0; });
      var l2 = region.l2 || [];

      /* ---------- base picker ---------- */
      // Hover tooltip for a product: bands get their wavelength + what they show;
      // composites/L2 get their plain-language blurb.
      function tipFor(p) {
        if (p.kind === 'channel' && p.band != null) {
          var b = GS.catalog.bands[p.band];
          return b ? (b.wavelength + ' — ' + b.blurb) : '';
        }
        return p.blurb || '';
      }
      var groupDefs = [
        { kind: 'composite', label: 'composites' },
        { kind: 'channel', label: 'spectral bands' },
        { kind: 'l2', label: 'level-2 products' }
      ];
      var preferred = products.filter(function (p) { return /false color/i.test(p.name); })[0] || products[0];
      var baseList = GS.ui.list(
        groupDefs.map(function (g) {
          return {
            label: g.label,
            items: products.filter(function (p) { return p.kind === g.kind; })
              .map(function (p) { return { key: p.key, label: p.name, meta: '×' + p.frames.length, title: tipFor(p) }; })
          };
        }).filter(function (g) { return g.items.length; }),
        { selected: preferred ? preferred.key : null, onSelect: function () { onBaseChange(); } }
      );

      var coastChk = el('input', { type: 'checkbox' });
      var coastLabel = el('label', { class: 'gs-check', title: 'Overlay coastlines & borders on the base image (uses SatDump’s _map version of the frame).' }, [coastChk, ' Coastlines']);

      var resSel = el('select', { class: 'gs-select', title: 'Working resolution for decoding, playback and export. Higher is sharper but uses more memory; video export caps at 2048 px.' });
      resolutionOptions(region).forEach(function (o) { resSel.appendChild(el('option', { value: o.v == null ? 'native' : String(o.v), text: o.label })); });
      resSel.value = String(defaultResolution(region));

      panel.appendChild(el('div', { class: 'gs-field' }, [el('label', { class: 'gs-label', text: 'Base image' }), baseList.el]));
      panel.appendChild(el('div', { class: 'gs-field' }, [coastLabel]));
      panel.appendChild(el('div', { class: 'gs-field' }, [el('label', { class: 'gs-label', text: 'Resolution' }), resSel]));
      panel.appendChild(el('div', { class: 'gs-hint gs-zoomhint', text: 'viewport · scroll to zoom · drag to pan · double-click resets' }));

      /* ---------- L2 layers ---------- */
      var layerControls = [];
      var legendChk = null;
      if (l2.length) {
        panel.appendChild(el('div', { class: 'gs-section-label', text: 'level-2 layers' }));
        legendChk = el('input', { type: 'checkbox', checked: true });
        legendChk.addEventListener('change', updateLegend);
        panel.appendChild(el('label', { class: 'gs-check gs-legend-toggle', title: 'Show a color scale for active Level-2 layers. Numeric where NOAA’s standard product range is known (cloud-top temperature/height, rain rate); a relative low→high scale otherwise.' }, [legendChk, ' Legend']));
        l2.forEach(function (p) {
          var chk = el('input', { type: 'checkbox' });
          var opacity = el('input', { type: 'range', min: '0', max: '100', value: '70', class: 'gs-range gs-range-sm', title: 'Layer opacity.' });
          var blend = el('select', { class: 'gs-select gs-select-sm', title: 'Blend mode — how this layer combines with what’s below. Screen lets bright data show through dark, off-disk backgrounds.' });
          GS.imaging.blendModes.forEach(function (b) { blend.appendChild(el('option', { value: b.id, text: b.label })); });
          blend.value = 'screen';
          var timeTag = el('span', { class: 'gs-layer-time' });
          var row = el('div', { class: 'gs-layer', title: tipFor(p) }, [
            el('label', { class: 'gs-layer-head' }, [chk, el('span', { class: 'gs-layer-name', text: p.name }), timeTag]),
            el('div', { class: 'gs-layer-ctl' }, [el('span', { class: 'gs-mini', text: 'opacity' }), opacity, blend])
          ]);
          panel.appendChild(row);
          var lc = { product: p, chk: chk, opacity: opacity, blend: blend, timeTag: timeTag, row: row, entry: null };
          chk.addEventListener('change', function () { onLayerToggle(lc); });
          opacity.addEventListener('input', function () { if (state.baseEntry && state.baseEntry.done) paint(state.index); });
          blend.addEventListener('change', function () { if (state.baseEntry && state.baseEntry.done) paint(state.index); });
          layerControls.push(lc);
        });
      } else {
        panel.appendChild(el('div', { class: 'gs-hint', html: 'No Level-2 layers in this region. Switch to a region that has L2 (e.g. <b>GOES-19 / Full Disk</b>) to stack them.' }));
      }

      /* ---------- playback controls ---------- */
      var fps = el('input', { type: 'range', min: '1', max: '24', value: '8', class: 'gs-range' });
      var fpsOut = el('span', { class: 'gs-num', text: '8 fps' });
      fps.addEventListener('input', function () { fpsOut.textContent = fps.value + ' fps'; });
      var loopChk = el('input', { type: 'checkbox', checked: true });
      var stampChk = el('input', { type: 'checkbox', checked: true });
      var deflickChk = el('input', { type: 'checkbox' });
      if (!CTX_FILTER_OK) deflickChk.disabled = true;

      var prerenderBtn = el('button', { class: 'gs-btn gs-btn-primary', text: 'Prerender all · ' + products.length, title: 'Decode every product in this region up front, so switching base image and toggling layers stays instant.' });
      var autoChk = el('input', { type: 'checkbox', checked: true });
      var progWrap = el('div', { class: 'gs-progress', style: { display: 'none' } });
      var progBar = el('div', { class: 'gs-progress-bar' });
      progWrap.appendChild(progBar);
      var progText = el('div', { class: 'gs-hint', style: { display: 'none' } });

      panel.appendChild(el('div', { class: 'gs-section-label', text: 'timeline' }));
      panel.appendChild(el('div', { class: 'gs-field' }, [el('label', { class: 'gs-label', title: 'Playback and export frame rate.' }, ['Speed ', fpsOut]), fps]));
      panel.appendChild(el('div', { class: 'gs-field gs-checks' }, [
        el('label', { class: 'gs-check', title: 'Repeat playback from the start.' }, [loopChk, ' Loop']),
        el('label', { class: 'gs-check', title: 'Burn a UTC timestamp caption into playback and exports.' }, [stampChk, ' Burn timestamp']),
        el('label', { class: 'gs-check', title: CTX_FILTER_OK ? 'Even out frame-to-frame brightness flicker (e.g. as the day/night terminator sweeps the disk). Normalizes the base layer toward the median frame; best on visible/false-color, harmless on IR.' : 'Deflicker needs a browser with canvas filter support.' }, [deflickChk, ' Deflicker'])
      ]));
      panel.appendChild(el('div', { class: 'gs-field gs-prerender-row' }, [prerenderBtn, el('label', { class: 'gs-check', title: 'Prerender the whole region automatically in the background after you open it.' }, [autoChk, ' auto'])]));
      panel.appendChild(progWrap);
      panel.appendChild(progText);

      var playBtn = el('button', { class: 'gs-btn', text: '▶ Play', disabled: true });
      var prevBtn = el('button', { class: 'gs-btn gs-btn-icon', text: '⏮', disabled: true });
      var nextBtn = el('button', { class: 'gs-btn gs-btn-icon', text: '⏭', disabled: true });
      var scrub = el('input', { type: 'range', min: '0', max: '0', value: '0', class: 'gs-range', disabled: true });
      var counter = el('span', { class: 'gs-num', text: '— / —' });
      var vidLabel = GS.imaging.supportsMp4() ? 'Export MP4' : 'Export WebM';
      var vidBtn = el('button', { class: 'gs-btn', text: vidLabel, disabled: true });
      var pngBtn = el('button', { class: 'gs-btn', text: 'Save PNG', disabled: true });
      if (!GS.imaging.supportsVideoExport()) vidBtn.title = 'Video export needs a recent Chrome, Edge, Safari or Firefox.';

      var transport = el('div', { class: 'gs-transport', style: { display: 'none' } }, [
        el('div', { class: 'gs-transport-row' }, [prevBtn, playBtn, nextBtn, counter]),
        scrub,
        el('div', { class: 'gs-transport-row' }, [vidBtn, pngBtn])
      ]);
      panel.appendChild(transport);

      /* ---------- batch export ---------- */
      // Pick several products, render each as its own MP4, download all in one ZIP
      // (like goes-timelapse --all). Base-only: the L2 layer stack isn't applied.
      var batchItems = [];
      var animatable = products.filter(function (p) { return p.frames.length > 1; });
      if (animatable.length && GS.imaging.supportsVideoExport()) {
        var batchList = el('div', { class: 'gs-batch-list' });
        animatable.forEach(function (p) {
          var cb = el('input', { type: 'checkbox' });
          batchList.appendChild(el('label', { class: 'gs-batch-row', title: tipFor(p) }, [
            cb, el('span', { class: 'gs-batch-name', text: p.name }), el('span', { class: 'gs-batch-meta', text: '×' + p.frames.length })
          ]));
          batchItems.push({ product: p, cb: cb });
        });
        var batchAll = el('input', { type: 'checkbox' });
        var batchBtn = el('button', { class: 'gs-btn', text: 'Export selected as ZIP', disabled: true, title: 'Render each checked product as its own MP4 and download them together in one ZIP. Uses the current resolution, speed, coastlines and deflicker; L2 layers are not applied.' });

        var syncBatch = function () {
          var n = batchItems.filter(function (it) { return it.cb.checked; }).length;
          batchBtn.disabled = !n || batchRunning;
          if (!batchRunning) batchBtn.textContent = n ? ('Export ' + n + ' as ZIP') : 'Export selected as ZIP';
        };

        // Lock the controls that could prune/replace the entries a batch is
        // encoding (resolution/coastlines/base/layers) plus the single-export and
        // prerender buttons, so a mid-batch change can't close a live ImageBitmap.
        function setBatchLock(on) {
          resSel.disabled = on; coastChk.disabled = on; prerenderBtn.disabled = on;
          layerControls.forEach(function (lc) { lc.chk.disabled = on; lc.opacity.disabled = on; lc.blend.disabled = on; });
          baseList.el.classList.toggle('gs-list-locked', on);
          if (on) { vidBtn.disabled = true; pngBtn.disabled = true; }
        }

        function runBatch() {
          var chosen = batchItems.filter(function (it) { return it.cb.checked; }).map(function (it) { return it.product; });
          if (!chosen.length || batchRunning) return;
          stop(); clearTimeout(autoTimer);
          batchRunning = true; syncBatch(); setBatchLock(true);
          var fpsVal = parseInt(fps.value, 10), ex = document.createElement('canvas'), results = [];
          progWrap.style.display = 'block'; progText.style.display = 'block'; progBar.style.width = '0%';

          function finish() {
            setBatchLock(false);
            progWrap.style.display = 'none'; progText.style.display = 'none';
            updateTransport();
            if (!results.length) { batchRunning = false; syncBatch(); return; }
            batchBtn.textContent = 'Zipping…';
            var zipName = sanitize(ctx.satLabel.split(' ')[0] + '_' + region.id) + '_batch_' + fpsVal + 'fps.zip';
            GS.imaging.zipStore(results).then(function (blob) {
              GS.imaging.downloadBlob(blob, zipName);
              ctx.toast('Exported ' + results.length + ' clip' + (results.length > 1 ? 's' : '') + ' → ' + zipName, 'ok');
            }).catch(function (e) { ctx.toast('ZIP failed: ' + e.message, 'error'); })
              .then(function () { batchRunning = false; syncBatch(); });
          }

          (function chain(idx) {
            if (destroyed || idx >= chosen.length) { finish(); return; }
            var p = chosen[idx], variant = (coastChk.checked && p.hasMap) ? 'map' : 'plain', entry = getEntry(p, variant);
            progText.textContent = 'Batch ' + (idx + 1) + ' / ' + chosen.length + ' · ' + p.name;
            buildEntry(entry, function (e, nf) {
              progBar.style.width = Math.round(((idx + nf / Math.max(1, e.frames.length)) / chosen.length) * 100) + '%';
            }).then(function () {
              var idxs = validIndices(entry);
              if (destroyed || !idxs.length) { chain(idx + 1); return; }
              batchBtn.textContent = 'Encoding ' + (idx + 1) + '/' + chosen.length + '…';
              return GS.imaging.exportVideo({
                fps: fpsVal, count: idxs.length,
                render: function (k) { renderComposite(ex, idxs[k], { base: entry, layers: false }); return ex; },
                onProgress: function (d, t) { batchBtn.textContent = 'Encoding ' + (idx + 1) + '/' + chosen.length + '… ' + d + '/' + t; }
              }).then(function (res) {
                results.push({ name: sanitize(ctx.satLabel.split(' ')[0] + '_' + region.id + '_' + p.name) + '_' + GS.imaging.stamp(entry.frames[idxs[0]].time) + '_' + fpsVal + 'fps.' + res.ext, blob: res.blob });
                chain(idx + 1);
              });
            }).catch(function (e) { ctx.toast('Batch failed on ' + p.name + ': ' + e.message, 'error'); finish(); });
          })(0);
        }

        batchAll.addEventListener('change', function () { batchItems.forEach(function (it) { it.cb.checked = batchAll.checked; }); syncBatch(); });
        batchItems.forEach(function (it) { it.cb.addEventListener('change', syncBatch); });
        batchBtn.addEventListener('click', runBatch);
        panel.appendChild(el('details', { class: 'gs-batch' }, [
          el('summary', { class: 'gs-batch-sum', text: 'Batch export · ' + animatable.length + ' products' }),
          el('label', { class: 'gs-check gs-batch-all' }, [batchAll, ' select all']),
          batchList, batchBtn
        ]));
      }

      /* ---------- stage ---------- */
      var canvas = el('canvas', { class: 'gs-canvas' });
      var stageMsg = el('div', { class: 'gs-stage-msg', text: 'Loading region…' });
      var legend = el('div', { class: 'gs-legend', style: { display: 'none' } });
      stage.appendChild(canvas);
      stage.appendChild(stageMsg);
      stage.appendChild(legend);

      /* ---------- cache / build ---------- */
      function framesFor(product, variant) {
        var fs = product.frames.filter(function (f) { return f.variants[variant]; });
        if (!fs.length && variant === 'map') fs = product.frames.filter(function (f) { return f.variants.plain; });
        return fs.map(function (f) { return { time: f.time, label: f.label, file: f.variants[variant] || f.variants.plain || f.variants.map }; });
      }
      function keyFor(product, variant) { return product.key + '|' + variant + '|' + resSel.value; }
      function getEntry(product, variant) {
        var k = keyFor(product, variant);
        var e = cache[k];
        if (!e) {
          var frames = framesFor(product, variant);
          e = { key: k, product: product, variant: variant, size: resSel.value === 'native' ? null : parseInt(resSel.value, 10), frames: frames, bitmaps: new Array(frames.length), done: frames.length === 0, promise: null };
          cache[k] = e;
        }
        return e;
      }
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
            }).catch(function (err) { ctx.toast('Decode failed: ' + err.message, 'error'); i++; next(); });
          })();
        });
        return e.promise;
      }
      function pruneCache() {
        var suffix = '|' + resSel.value;   // resolution is in the key suffix
        Object.keys(cache).forEach(function (k) {
          if (k.indexOf(suffix, k.length - suffix.length) === -1) {
            (cache[k].bitmaps || []).forEach(function (b) { if (b && b.close) b.close(); });
            delete cache[k];
          }
        });
      }
      function nearestIndex(entry, t) {
        var best = 0, bd = Infinity;
        for (var i = 0; i < entry.frames.length; i++) { var d = Math.abs(entry.frames[i].time - t); if (d < bd) { bd = d; best = i; } }
        return best;
      }

      function selectedBase() { return products.filter(function (p) { return p.key === baseList.getSelected(); })[0]; }
      function curVariant() { return (coastChk.checked && selectedBase() && selectedBase().hasMap) ? 'map' : 'plain'; }
      function activeLayerEntries() {
        var out = [];
        layerControls.forEach(function (lc) {
          if (lc.chk.checked) { lc.entry = getEntry(lc.product, 'plain'); out.push(lc.entry); }
        });
        return out;
      }

      /* ---------- deflicker ---------- */
      function deflickOn() { return CTX_FILTER_OK && deflickChk.checked; }
      // Mean on-disk luminance of a bitmap, alpha-weighted so transparent off-disk
      // pixels don't skew it. Sampled at 64×64 — cheap enough to do per frame once.
      function frameMean(bmp) {
        var s = 64, c = lumaCv.getContext('2d');
        c.clearRect(0, 0, s, s); c.drawImage(bmp, 0, 0, s, s);
        var d = c.getImageData(0, 0, s, s).data, sl = 0, sa = 0;
        for (var i = 0; i < d.length; i += 4) {
          var a = d[i + 3]; if (!a) continue;
          sl += (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) * a; sa += a;
        }
        return sa ? sl / sa : 0;
      }
      // Per-frame brightness gains toward the median frame (computed once per entry,
      // clamped so it corrects flicker without blowing out a single dark frame).
      function ensureGains(entry) {
        if (!entry || !entry.done || entry.gainsComputed) return;
        entry.gainsComputed = true;   // memoize even a null result (all-dark entry)
        var n = entry.bitmaps.length, means = new Array(n), i;
        for (i = 0; i < n; i++) { var b = entry.bitmaps[i]; means[i] = b ? frameMean(b) : 0; }
        var valid = means.filter(function (m) { return m > 1; }).sort(function (a, b) { return a - b; });
        if (!valid.length) { entry.gains = null; return; }
        var ref = valid[Math.floor(valid.length / 2)];
        entry.gains = means.map(function (m) { return m > 1 ? Math.max(0.5, Math.min(2, ref / m)) : 1; });
      }

      /* ---------- compositing ---------- */
      function renderComposite(dest, i, opts) {
        opts = opts || {};
        var base = opts.base || state.baseEntry;
        var bb = base && base.bitmaps[i];
        if (!bb) return false;
        if (deflickOn() && base.done && !base.gainsComputed) ensureGains(base);
        dest.width = bb.width; dest.height = bb.height;
        var cx = dest.getContext('2d');
        cx.clearRect(0, 0, dest.width, dest.height);
        cx.fillStyle = '#080604'; cx.fillRect(0, 0, dest.width, dest.height);
        var vw = opts.view;   // pan/zoom transform (on-screen only; exports omit it)
        if (vw && (vw.scale !== 1 || vw.tx !== 0 || vw.ty !== 0)) cx.setTransform(vw.scale, 0, 0, vw.scale, vw.tx, vw.ty);
        cx.globalCompositeOperation = 'source-over'; cx.globalAlpha = 1;
        var gain = (deflickOn() && base.gains) ? base.gains[i] : 1;
        if (gain !== 1) cx.filter = 'brightness(' + gain + ')';
        cx.drawImage(bb, 0, 0, dest.width, dest.height);
        if (gain !== 1) cx.filter = 'none';
        var t = base.frames[i].time;
        if (opts.layers !== false) layerControls.forEach(function (lc) {
          if (!lc.chk.checked || !lc.entry || !lc.entry.done || !lc.entry.frames.length) { if (!lc.chk.checked) lc.timeTag.textContent = ''; return; }
          var ni = nearestIndex(lc.entry, t), lb = lc.entry.bitmaps[ni];
          if (!lb) return;
          cx.globalCompositeOperation = lc.blend.value || 'screen';
          cx.globalAlpha = parseInt(lc.opacity.value, 10) / 100;
          cx.drawImage(lb, 0, 0, dest.width, dest.height);
          lc.timeTag.textContent = lc.entry.frames[ni].label;
        });
        cx.setTransform(1, 0, 0, 1, 0, 0);   // caption in screen space, unaffected by zoom
        cx.globalCompositeOperation = 'source-over'; cx.globalAlpha = 1;
        if (stampChk.checked) drawCaption(cx, dest.width, dest.height, GS.imaging.formatUTC(t), base.product.name + ' · ' + ctx.satLabel + ' · ' + region.id);
        return true;
      }

      function paint(i) {
        if (!renderComposite(canvas, i, { view: view })) return;
        var n = state.baseEntry.frames.length;
        counter.textContent = (i + 1) + ' / ' + n + '  ·  ' + state.baseEntry.frames[i].label;
        scrub.value = String(i);
        state.index = i;
      }

      function updateTransport() {
        var e = state.baseEntry;
        var ready = !!(e && e.done && e.frames.length >= 1);
        var multi = !!(e && e.done && e.frames.length > 1);
        [playBtn, prevBtn, nextBtn].forEach(function (b) { b.disabled = !multi; });
        scrub.disabled = !multi;
        scrub.max = String(Math.max(0, (e ? e.frames.length : 1) - 1));
        pngBtn.disabled = !ready;
        vidBtn.disabled = !(multi && GS.imaging.supportsVideoExport());
        transport.style.display = ready ? 'block' : 'none';
      }

      // Color scale(s) for the active L2 layers — a DOM overlay in the stage (not
      // burned into exports). Numeric endpoints only where NOAA's product range is
      // verified; otherwise a relative low→high bar. Rebuilt on any layer change.
      function updateLegend() {
        if (!legend) return;
        GS.dom.clear(legend);
        if (!legendChk || !legendChk.checked) { legend.style.display = 'none'; return; }
        var shown = 0;
        layerControls.forEach(function (lc) {
          if (!lc.chk.checked || !lc.entry || !lc.entry.done || !lc.entry.frames.length) return;
          var s = GS.catalog.l2Scale(lc.product.rawName);
          if (!s) return;
          shown++;
          legend.appendChild(el('div', { class: 'gs-cbar', title: s.note + ' — source: ' + s.source }, [
            el('div', { class: 'gs-cbar-name', text: lc.product.name }),
            el('div', { class: 'gs-cbar-track', style: { background: 'linear-gradient(90deg,' + s.stops.join(',') + ')' } }),
            el('div', { class: 'gs-cbar-scale' }, [
              el('span', { text: s.numeric ? String(s.min) : 'low' }),
              el('span', { class: 'gs-cbar-units', text: s.units }),
              el('span', { text: s.numeric ? String(s.max) : 'high' })
            ])
          ]));
        });
        legend.style.display = shown ? 'flex' : 'none';
      }

      /* ---------- assemble the scene (base + active layers) ---------- */
      function showScene(resetIndex) {
        var base = getEntry(selectedBase(), curVariant());
        state.baseEntry = base;
        if (resetIndex || state.index >= base.frames.length) state.index = 0;
        if (!base.frames.length) { stageMsg.textContent = 'No frames for this base.'; stageMsg.style.display = 'block'; updateTransport(); return Promise.resolve(); }

        var needed = [base].concat(activeLayerEntries());
        var toBuild = needed.filter(function (e) { return !e.done; });
        if (!toBuild.length) { stageMsg.style.display = 'none'; paint(state.index); updateTransport(); updateLegend(); return Promise.resolve(); }

        stageMsg.textContent = 'Decoding…'; stageMsg.style.display = 'block';
        if (!state.prerendering) { progWrap.style.display = 'block'; progText.style.display = 'block'; progBar.style.width = '0%'; }
        var done = 0, total = toBuild.length;
        return (function chain(idx) {
          if (destroyed || idx >= total) return Promise.resolve();
          var e = toBuild[idx];
          return buildEntry(e, function (entry, nf) {
            if (state.baseEntry === entry && nf === 1) { stageMsg.style.display = 'none'; paint(0); }
            else if (state.baseEntry && state.baseEntry.done) paint(state.index);
            if (!state.prerendering) { progBar.style.width = Math.round(((done + nf / e.frames.length) / total) * 100) + '%'; progText.textContent = 'Decoding ' + e.product.name + '…'; }
          }).then(function () { done++; return chain(idx + 1); });
        })(0).then(function () {
          if (destroyed) return;
          if (!state.prerendering) { progWrap.style.display = 'none'; progText.style.display = 'none'; }
          stageMsg.style.display = 'none';
          paint(state.index); updateTransport(); updateLegend();
        });
      }

      /* ---------- prerender ---------- */
      function prerenderAll() {
        if (state.prerendering || batchRunning) return;
        var base = selectedBase();
        var list = products.slice().sort(function (a, b) { return a === base ? -1 : b === base ? 1 : 0; });
        var total = list.length, done = 0;
        state.prerendering = true; prerenderBtn.disabled = true; prerenderBtn.textContent = 'Prerendering…';
        progWrap.style.display = 'block'; progText.style.display = 'block';
        (function step(i) {
          if (destroyed) { finish(false); return; }
          if (i >= list.length) { finish(true); return; }
          progBar.style.width = Math.round((done / total) * 100) + '%';
          progText.textContent = 'Prerendering ' + (done + 1) + ' / ' + total + ' · ' + list[i].name;
          buildEntry(getEntry(list[i], 'plain'), function () {}).then(function () {
            if (state.baseEntry && state.baseEntry.done) { updateTransport(); paint(state.index); }
            done++; step(i + 1);
          });
        })(0);
        function finish(ok) {
          state.prerendering = false; prerenderBtn.disabled = false; prerenderBtn.textContent = 'Prerender all · ' + products.length;
          progWrap.style.display = 'none'; progText.style.display = 'none';
          if (ok) ctx.toast('Prerendered ' + total + ' product' + (total > 1 ? 's' : '') + '.', 'ok');
        }
      }
      function scheduleAutoPrerender() {
        clearTimeout(autoTimer);
        if (!autoChk.checked || resSel.value === 'native') return;
        autoTimer = setTimeout(function () { if (!destroyed && autoChk.checked && !state.prerendering && resSel.value !== 'native') prerenderAll(); }, 1000);
      }

      /* ---------- playback ---------- */
      function stop() { state.playing = false; playBtn.textContent = '▶ Play'; if (state.raf) { cancelAnimationFrame(state.raf); state.raf = 0; } }
      function tick(ts) {
        if (!state.playing) return;
        if (!state.last) state.last = ts;
        var step = 1000 / Math.max(1, parseInt(fps.value, 10));
        state.acc += ts - state.last; state.last = ts;
        var n = state.baseEntry.frames.length;
        while (state.acc >= step) {
          state.acc -= step;
          var nx = state.index + 1;
          if (nx >= n) { if (loopChk.checked) nx = 0; else { paint(n - 1); stop(); return; } }
          paint(nx);
        }
        state.raf = requestAnimationFrame(tick);
      }
      function play() { if (!state.baseEntry || state.baseEntry.frames.length < 2) return; state.playing = true; state.last = 0; state.acc = 0; playBtn.textContent = '⏸ Pause'; state.raf = requestAnimationFrame(tick); }

      playBtn.addEventListener('click', function () { state.playing ? stop() : play(); });
      prevBtn.addEventListener('click', function () { stop(); paint((state.index - 1 + state.baseEntry.frames.length) % state.baseEntry.frames.length); });
      nextBtn.addEventListener('click', function () { stop(); paint((state.index + 1) % state.baseEntry.frames.length); });
      scrub.addEventListener('input', function () { stop(); paint(parseInt(scrub.value, 10)); });

      /* ---------- change handlers ---------- */
      function onBaseChange() { if (batchRunning) return; var wp = state.playing; stop(); showScene(true).then(function () { if (view.scale !== 1) { clampView(); paint(state.index); } if (wp && !destroyed) play(); }); }
      function onDimChange() { if (batchRunning) return; resetView(); var wp = state.playing; stop(); pruneCache(); showScene(false).then(function () { if (wp && !destroyed) play(); }); }
      function onLayerToggle(lc) { if (batchRunning) return; var wp = state.playing; stop(); lc.row.classList.toggle('gs-layer-on', lc.chk.checked); showScene(false).then(function () { if (wp && !destroyed) play(); }); }
      coastChk.addEventListener('change', onDimChange);
      resSel.addEventListener('change', onDimChange);
      deflickChk.addEventListener('change', function () { if (state.baseEntry && state.baseEntry.done) paint(state.index); });
      prerenderBtn.addEventListener('click', prerenderAll);
      autoChk.addEventListener('change', function () { autoChk.checked ? scheduleAutoPrerender() : clearTimeout(autoTimer); });

      /* ---------- pan / zoom (viewport inspection) ---------- */
      // Viewing aid only: transforms the on-screen canvas; exports stay full-disk.
      // Zoom samples the working-resolution bitmap, so deep zoom is soft — raise
      // Resolution for crisp inspection.
      function toCanvasPx(e) {
        var r = canvas.getBoundingClientRect(), W = canvas.width, H = canvas.height;
        if (!W || !H || !r.width || !r.height) return null;
        var ds = Math.min(r.width / W, r.height / H);
        return { x: (e.clientX - r.left - (r.width - W * ds) / 2) / ds, y: (e.clientY - r.top - (r.height - H * ds) / 2) / ds };
      }
      function clampView() {
        var W = canvas.width || 1, H = canvas.height || 1;
        if (view.scale <= 1) { view.scale = 1; view.tx = 0; view.ty = 0; }
        else {
          view.tx = Math.max(W * (1 - view.scale), Math.min(0, view.tx));
          view.ty = Math.max(H * (1 - view.scale), Math.min(0, view.ty));
        }
        canvas.classList.toggle('gs-zoomed', view.scale > 1);
      }
      function resetView() {
        if (view.scale === 1 && !view.tx && !view.ty) return;
        view.scale = 1; view.tx = 0; view.ty = 0;
        canvas.classList.remove('gs-zoomed', 'gs-grabbing');
        if (state.baseEntry && state.baseEntry.done) paint(state.index);
      }
      canvas.addEventListener('wheel', function (e) {
        if (!state.baseEntry || !state.baseEntry.done) return;
        e.preventDefault();
        var p = toCanvasPx(e); if (!p) return;
        // Normalize wheel delta by deltaMode (line/page vs pixel) so zoom isn't
        // inert on browsers that report DOM_DELTA_LINE (e.g. Firefox).
        var dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? (canvas.clientHeight || 400) : 1);
        var ns = Math.max(1, Math.min(8, view.scale * Math.exp(-dy * 0.0015)));
        if (ns === view.scale) return;
        view.tx = p.x - (ns / view.scale) * (p.x - view.tx);   // keep point under cursor fixed
        view.ty = p.y - (ns / view.scale) * (p.y - view.ty);
        view.scale = ns; clampView(); paint(state.index);
      }, { passive: false });
      var dragging = false, lastX = 0, lastY = 0;
      canvas.addEventListener('pointerdown', function (e) {
        if (view.scale <= 1 || !state.baseEntry || !state.baseEntry.done) return;
        dragging = true; lastX = e.clientX; lastY = e.clientY;
        try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
        canvas.classList.add('gs-grabbing');
      });
      canvas.addEventListener('pointermove', function (e) {
        if (!dragging) return;
        var r = canvas.getBoundingClientRect(), ds = Math.min(r.width / canvas.width, r.height / canvas.height) || 1;
        view.tx += (e.clientX - lastX) / ds; view.ty += (e.clientY - lastY) / ds;
        lastX = e.clientX; lastY = e.clientY; clampView(); paint(state.index);
      });
      function endDrag(e) { if (dragging) { dragging = false; try { canvas.releasePointerCapture(e.pointerId); } catch (_) {} canvas.classList.remove('gs-grabbing'); } }
      canvas.addEventListener('pointerup', endDrag);
      canvas.addEventListener('pointercancel', endDrag);
      canvas.addEventListener('dblclick', function (e) { e.preventDefault(); resetView(); });

      /* ---------- export ---------- */
      // Frame indices whose bitmap actually decoded; export skips holes so a
      // failed decode never duplicates a frame or mis-sizes the clip.
      function validIndices(entry) {
        var out = [];
        for (var i = 0; entry && i < entry.frames.length; i++) if (entry.bitmaps[i]) out.push(i);
        return out;
      }
      function baseName() {
        var b = state.baseEntry && state.baseEntry.product;
        var on = layerControls.filter(function (lc) { return lc.chk.checked; }).map(function (lc) { return lc.product.name.replace(/[^A-Za-z0-9]+/g, ''); }).join('+');
        return sanitize(ctx.satLabel.split(' ')[0] + '_' + region.id + '_' + (b ? b.name : 'view') + (on ? '_over_' + on : ''));
      }
      pngBtn.addEventListener('click', function () {
        if (!state.baseEntry || !state.baseEntry.done) return;
        var ex = document.createElement('canvas');
        if (!renderComposite(ex, state.index)) return;
        GS.imaging.canvasToPng(ex).then(function (blob) { GS.imaging.downloadBlob(blob, baseName() + '_' + GS.imaging.stamp(state.baseEntry.frames[state.index].time) + '.png'); });
      });
      vidBtn.addEventListener('click', function () {
        if (!state.baseEntry || !state.baseEntry.done || batchRunning) return;
        stop();
        var ex = document.createElement('canvas'), fpsVal = parseInt(fps.value, 10);
        var idxs = validIndices(state.baseEntry), restore = vidBtn.textContent;
        if (!idxs.length) { ctx.toast('No decoded frames to export.', 'warn'); return; }
        vidBtn.disabled = true; vidBtn.textContent = 'Encoding…';
        GS.imaging.exportVideo({
          fps: fpsVal, count: idxs.length,
          render: function (k) { renderComposite(ex, idxs[k]); return ex; },
          onProgress: function (d, t) { vidBtn.textContent = 'Encoding… ' + d + '/' + t; }
        }).then(function (res) {
          GS.imaging.downloadBlob(res.blob, baseName() + '_' + GS.imaging.stamp(state.baseEntry.frames[idxs[0]].time) + '_' + fpsVal + 'fps.' + res.ext);
          ctx.toast('Exported ' + res.encoder + ' (' + idxs.length + ' frames @ ' + fpsVal + ' fps).', 'ok');
        }).catch(function (e) { ctx.toast('Video export failed: ' + e.message, 'error'); })
          .then(function () { vidBtn.textContent = restore; vidBtn.disabled = false; updateTransport(); });
      });

      /* ---------- keyboard ---------- */
      function onKey(e) {
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        if (aboutEl && !aboutEl.hidden) return;             // About panel is open
        var t = e.target, tag = t && (t.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
        var k = e.key;
        if (k === ' ' || k === 'Spacebar') { if (tag === 'button' || tag === 'summary' || tag === 'a') return; if (state.baseEntry && state.baseEntry.frames.length > 1) { state.playing ? stop() : play(); e.preventDefault(); } }
        else if (k === 'ArrowRight') { if (state.baseEntry && state.baseEntry.frames.length) { stop(); paint((state.index + 1) % state.baseEntry.frames.length); e.preventDefault(); } }
        else if (k === 'ArrowLeft') { if (state.baseEntry && state.baseEntry.frames.length) { stop(); paint((state.index - 1 + state.baseEntry.frames.length) % state.baseEntry.frames.length); e.preventDefault(); } }
        else if (k === 'ArrowDown') { baseList.next(true); e.preventDefault(); }
        else if (k === 'ArrowUp') { baseList.prev(true); e.preventDefault(); }
        else if (k === 'b' || k === 'B') { if (!prerenderBtn.disabled) prerenderAll(); }
        else if (k === 'e' || k === 'E') { if (!vidBtn.disabled) vidBtn.click(); }
        else if (k === 's' || k === 'S') { if (!pngBtn.disabled) pngBtn.click(); }
      }
      document.addEventListener('keydown', onKey);

      /* ---------- init ---------- */
      showScene(true);
      scheduleAutoPrerender();

      return {
        destroy: function () {
          destroyed = true;
          clearTimeout(autoTimer);
          document.removeEventListener('keydown', onKey);
          stop();
          Object.keys(cache).forEach(function (k) { (cache[k].bitmaps || []).forEach(function (b) { if (b && b.close) b.close(); }); });
        }
      };
    }
  };
})(window.GS = window.GS || {});
