/*
 * view.js — the unified view.
 *
 * One canvas that composites a BASE image (any composite / band / L2, optionally
 * with coastlines) plus a stack of toggleable Level-2 LAYERS (opacity + blend) —
 * and a single TIMELINE you scrub or play. The base product is the clock: its
 * scans define the timeline, and every active layer snaps to its nearest frame in
 * time as you move, so base + layers animate together.
 *
 * Frames are decoded on demand: only the on-screen base + active L2 layers are held
 * as ImageBitmaps (cached per product/variant/resolution), and everything else is
 * evicted, so memory stays flat regardless of run length. Layers get a smaller frame
 * budget than the base (they snap to the nearest base frame). Exports composite each
 * frame: an MP4 over the whole timeline, PNG of the current composite.
 *
 * Exposed as GS.ViewMode.create(panelEl, stageEl, region, ctx) -> { destroy }.
 */
(function (GS) {
  'use strict';

  function sanitize(s) { return String(s).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, ''); }

  // EMWIN products are small pre-rendered charts (a few hundred px), not full-disk
  // scans — there is nothing to downscale, so they render at native size only.
  // region.kind is set once by the scanner (freezeSats).
  function isEmwinRegion(region) { return region.kind === 'emwin'; }

  function resolutionOptions(region) {
    if (isEmwinRegion(region)) return [{ v: null, label: 'Native' }];
    if (/mesoscale/i.test(region.id)) return [{ v: 500, label: '500 px (native)' }, { v: 1000, label: '1000 px' }];
    return [
      { v: 512, label: '512 px (fast)' },
      { v: 1024, label: '1024 px (recommended)' },
      { v: 2048, label: '2048 px (sharp)' },
      { v: null, label: 'Native 5424 px (heavy)' }
    ];
  }
  function defaultResolution(region) {
    if (isEmwinRegion(region)) return 'native';
    return /mesoscale/i.test(region.id) ? 500 : 1024;
  }

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
      var exporting = false;       // single MP4 export in flight — block cache-mutating controls
      var winTimer = 0;            // debounce for Range (time-window) commits
      var aboutEl = document.getElementById('about');   // cached; queried on every keydown
      var state = { baseEntry: null, index: 0, playing: false, raf: 0, acc: 0, last: 0 };

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
      var isEmwin = isEmwinRegion(region);

      /* ---------- frame budget (memory + watchability) ----------
       * A continuously-received run has no folder/gap boundary to split on, so a
       * multi-day capture is legitimately ONE run with thousands of frames. We
       * hold every base frame as a decoded ImageBitmap, so an un-capped run OOMs
       * (a day of full-disk ≈ 144 × 16 MB at 2048 px ≈ 2.3 GB) long before it just
       * "chugs". So each entry's frame list is thinned to a budget derived from
       * bytes-per-frame — which makes RESOLUTION the memory/detail dial: raise it
       * for fewer, sharper frames; lower it for more, softer ones. Thinning is an
       * even index-stride (not even-by-time), so `All · span gaps` spends frames
       * where data exists instead of on empty gaps. */
      var MEM_TARGET = 1.5e9;   // ~1.5 GB for the on-screen base entry (tunable)
      var LAYER_MEM = 0.4e9;    // ~0.4 GB per active L2 layer (they snap to the base, so coarser is fine)
      var NATIVE_PX = isEmwin ? 1200 : (/mesoscale/i.test(region.id) ? 2000 : 5424);   // native long-edge est.
      function frameWidthPx() { return resSel.value === 'native' ? NATIVE_PX : parseInt(resSel.value, 10); }
      function budgetFor(memTarget) {
        var w = frameWidthPx() || NATIVE_PX;
        return Math.max(8, Math.min(1200, Math.floor(memTarget / (w * w * 4))));   // floor => hard ceiling
      }
      function frameBudget() { return budgetFor(MEM_TARGET); }
      function layerBudget() { return Math.min(frameBudget(), budgetFor(LAYER_MEM)); }
      // Evenly-strided subsample of `arr` to at most `budget` items, first & last
      // kept; consecutive-dedup so a near-budget list never repeats a frame.
      function stridePick(arr, budget) {
        var n = arr.length;
        if (n <= budget || budget < 2) return n <= budget ? arr : arr.slice(0, budget);
        var out = [], last = -1;
        for (var k = 0; k < budget; k++) {
          var idx = Math.round(k * (n - 1) / (budget - 1));
          if (idx !== last) { out.push(arr[idx]); last = idx; }
        }
        return out;
      }

      /* ---------- time window ----------
       * A long run stays ONE run (that's correct — the receiver was on), but you
       * rarely want the whole span at once. The window narrows the timeline to a
       * sub-range; because the budget then covers fewer hours, the same memory
       * buys higher cadence over the range (and exports just that range). Handles
       * index the run's unique scan times (not linear ms) so empty gaps in an
       * `All · span gaps` run collapse instead of eating handle travel. */
      var runTimes = (function () {
        var seen = {};
        products.forEach(function (p) { p.frames.forEach(function (f) { seen[f.time.getTime()] = 1; }); });
        return Object.keys(seen).map(Number).sort(function (a, b) { return a - b; });
      })();
      var win = { lo: 0, hi: Math.max(0, runTimes.length - 1) };
      function windowFull() { return runTimes.length === 0 || (win.lo === 0 && win.hi === runTimes.length - 1); }
      function pad2(n) { return (n < 10 ? '0' : '') + n; }
      function winLabel(ms) { var d = new Date(ms); return GS.imaging.formatDate(d) + ' ' + pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + 'Z'; }
      function humanDur(ms) {
        var h = ms / 3.6e6;
        if (h < 1) return Math.max(1, Math.round(ms / 6e4)) + ' min';
        if (h < 48) return (h >= 10 ? Math.round(h) : h.toFixed(1)) + ' h';
        return (h / 24).toFixed(1) + ' d';
      }

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
        { kind: 'l2', label: 'level-2 products' },
        { kind: 'emwin', label: 'radar mosaics' }
      ];
      // Default base: False Color for ABI, the national CONUS mosaic for EMWIN.
      var preferred = products.filter(function (p) { return /false color/i.test(p.name); })[0]
        || products.filter(function (p) { return p.rawName === 'RADREFUS'; })[0]
        || products[0];
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
      // EMWIN charts have no SatDump _map (coastline) variant — hide the toggle.
      if (!isEmwin) panel.appendChild(el('div', { class: 'gs-field' }, [coastLabel]));
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
      } else if (!isEmwin) {
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

      var progWrap = el('div', { class: 'gs-progress', style: { display: 'none' } });
      var progBar = el('div', { class: 'gs-progress-bar' });
      progWrap.appendChild(progBar);
      var progText = el('div', { class: 'gs-hint', style: { display: 'none' } });

      var budgetHint = el('div', { class: 'gs-hint', style: { display: 'none' } });
      var fromEl = null, toEl = null, winField = null;   // window handles + their field

      panel.appendChild(el('div', { class: 'gs-section-label', text: 'timeline' }));

      // Range control. Built whenever SOME resolution's budget could thin this run
      // (min budget ≈ 12 frames at native), but hidden until it actually helps —
      // see updateWindowVisibility. Short runs never surface it.
      if (runTimes.length > 12) {
        var maxIdx = runTimes.length - 1;
        fromEl = el('input', { type: 'range', min: '0', max: String(maxIdx), value: '0', class: 'gs-range gs-range-sm' });
        toEl = el('input', { type: 'range', min: '0', max: String(maxIdx), value: String(maxIdx), class: 'gs-range gs-range-sm' });
        var fromLbl = el('span', { class: 'gs-num' });
        var toLbl = el('span', { class: 'gs-num' });
        var winSummary = el('div', { class: 'gs-hint' });
        // Labels/summary reflect the LIVE handle positions; `win` itself is committed
        // only in applyWindow (on release) so mid-drag decodes stay consistent.
        var syncWinLabels = function () {
          var lo = +fromEl.value, hi = +toEl.value, full = (lo === 0 && hi === maxIdx);
          fromLbl.textContent = winLabel(runTimes[lo]);
          toLbl.textContent = winLabel(runTimes[hi]);
          var count = hi - lo + 1, shown = Math.min(count, frameBudget());
          winSummary.textContent = humanDur(runTimes[hi] - runTimes[lo]) + ' · ' + count + ' scans' +
            (shown < count ? ' → ~' + shown + ' shown' : '') + (full ? ' (full run)' : '');
        };
        // Keep a ≥2-frame window (from strictly below to) so playback/export never
        // collapse to a dead single frame.
        fromEl.addEventListener('input', function () { if (+fromEl.value >= +toEl.value) fromEl.value = String(Math.max(0, +toEl.value - 1)); syncWinLabels(); });
        toEl.addEventListener('input', function () { if (+toEl.value <= +fromEl.value) toEl.value = String(Math.min(maxIdx, +fromEl.value + 1)); syncWinLabels(); });
        fromEl.addEventListener('change', onWindowChange);
        toEl.addEventListener('change', onWindowChange);
        syncWinLabels();
        winField = el('div', { class: 'gs-field', style: { display: 'none' } }, [
          el('label', { class: 'gs-label', title: 'Limit the timeline to a sub-range of this run. Narrowing the window lets the frame budget cover fewer hours at higher cadence — same memory, more detail — and exports only the range.' }, ['Range']),
          el('div', { class: 'gs-winrow' }, [el('span', { class: 'gs-mini', text: 'from' }), fromEl, fromLbl]),
          el('div', { class: 'gs-winrow' }, [el('span', { class: 'gs-mini', text: 'to' }), toEl, toLbl]),
          winSummary
        ]);
        panel.appendChild(winField);
      }

      panel.appendChild(budgetHint);
      panel.appendChild(el('div', { class: 'gs-field' }, [el('label', { class: 'gs-label', title: 'Playback and export frame rate.' }, ['Speed ', fpsOut]), fps]));
      panel.appendChild(el('div', { class: 'gs-field gs-checks' }, [
        el('label', { class: 'gs-check', title: 'Repeat playback from the start.' }, [loopChk, ' Loop']),
        el('label', { class: 'gs-check', title: 'Burn a UTC timestamp caption into playback and exports.' }, [stampChk, ' Burn timestamp']),
        el('label', { class: 'gs-check', title: CTX_FILTER_OK ? 'Even out frame-to-frame brightness flicker (e.g. as the day/night terminator sweeps the disk). Normalizes the base layer toward the median frame; best on visible/false-color, harmless on IR.' : 'Deflicker needs a browser with canvas filter support.' }, [deflickChk, ' Deflicker'])
      ]));
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
        // encoding (resolution/coastlines/base/layers) plus the single-export
        // button, so a mid-batch change can't close a live ImageBitmap.
        function setBatchLock(on) {
          resSel.disabled = on; coastChk.disabled = on;
          if (fromEl) { fromEl.disabled = on; toEl.disabled = on; }
          layerControls.forEach(function (lc) { lc.chk.disabled = on; lc.opacity.disabled = on; lc.blend.disabled = on; });
          baseList.el.classList.toggle('gs-list-locked', on);
          if (on) { vidBtn.disabled = true; pngBtn.disabled = true; }
        }

        function runBatch() {
          var chosen = batchItems.filter(function (it) { return it.cb.checked; }).map(function (it) { return it.product; });
          if (!chosen.length || batchRunning) return;
          stop();
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
              // Skip a product the window has thinned below 2 frames — a 1-frame
              // clip in the ZIP is a degenerate export, not a time-lapse.
              if (destroyed || idxs.length < 2) { chain(idx + 1); return; }
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
      function framesFor(product, variant, isLayer) {
        var fs = product.frames.filter(function (f) { return f.variants[variant]; });
        if (!fs.length && variant === 'map') fs = product.frames.filter(function (f) { return f.variants.plain; });
        var all = fs.map(function (f) { return { time: f.time, label: f.label, file: f.variants[variant] || f.variants.plain || f.variants.map }; });
        // Restrict to the selected time window, then thin to the budget (layers get a
        // smaller budget — they snap to the nearest base frame, so coarser is fine).
        var inWin = all;
        if (!windowFull() && runTimes.length) {
          var lo = runTimes[win.lo], hi = runTimes[win.hi];
          inWin = all.filter(function (f) { var t = f.time.getTime(); return t >= lo && t <= hi; });
        }
        return stridePick(inWin, isLayer ? layerBudget() : frameBudget());
      }
      // Resolution segment stays LAST so pruneCache's end-anchored suffix match holds;
      // the '|L' marks a layer entry (smaller budget) so a product used as both base
      // and layer never collides on frame count.
      function keyFor(product, variant, isLayer) { return product.key + '|' + variant + (isLayer ? '|L' : '') + '|' + resSel.value; }
      function getEntry(product, variant, isLayer) {
        var k = keyFor(product, variant, isLayer);
        var e = cache[k];
        if (!e) {
          var frames = framesFor(product, variant, isLayer);
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
            // Bail if the entry was evicted from the cache mid-decode (resolution or
            // window change): keep decoding into an orphaned entry and its bitmaps
            // would never be reachable by any close path — a leak. Stop and close.
            if (destroyed || cache[e.key] !== e) { resolve(e); return; }
            if (i >= e.frames.length) { e.done = true; resolve(e); return; }
            GS.imaging.decodeScaled(e.frames[i].file, e.size).then(function (bmp) {
              if (destroyed || cache[e.key] !== e) { if (bmp && bmp.close) bmp.close(); resolve(e); return; }
              e.bitmaps[i] = bmp; i++;
              if (onFrame) onFrame(e, i);
              next();
            }).catch(function (err) { ctx.toast('Decode failed: ' + err.message, 'error'); i++; next(); });
          })();
        });
        return e.promise;
      }
      function closeEntry(e) { (e.bitmaps || []).forEach(function (b) { if (b && b.close) b.close(); }); }
      function pruneCache() {
        var suffix = '|' + resSel.value;   // resolution is in the key suffix
        Object.keys(cache).forEach(function (k) {
          if (k.indexOf(suffix, k.length - suffix.length) === -1) { closeEntry(cache[k]); delete cache[k]; }
        });
      }
      // Keep-current-only: close every entry whose key isn't in `keep` (the on-screen
      // base + active layers). Safe mid-decode via buildEntry's eviction guard.
      function evictCache(keep) {
        Object.keys(cache).forEach(function (k) { if (!keep[k]) { closeEntry(cache[k]); delete cache[k]; } });
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
          if (lc.chk.checked) { lc.entry = getEntry(lc.product, 'plain', true); out.push(lc.entry); }
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
          if (!lc.chk.checked || !lc.entry || !lc.entry.done || !lc.entry.frames.length) {
            // Unchecked → blank; checked but no frames in the current window → say so
            // (else the tag keeps a stale timestamp for a layer that isn't drawing).
            if (!lc.chk.checked) lc.timeTag.textContent = '';
            else if (lc.entry && lc.entry.done && !lc.entry.frames.length) lc.timeTag.textContent = 'out of range';
            return;
          }
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
        updateBudgetHint();
        updateWindowVisibility();
      }

      // Offer the Range control exactly when it helps: the run is long, OR the
      // current resolution's budget is actually thinning it (so a sub-range would
      // raise cadence). Keeps short runs at low res free of the control.
      function updateWindowVisibility() {
        if (!winField) return;
        var show = runTimes.length > 120 || runTimes.length > frameBudget();
        winField.style.display = show ? 'block' : 'none';
      }

      // When the run is bigger than the budget, say so honestly: the base picker
      // still shows the archive-true total (×N); this shows the working count.
      function updateBudgetHint() {
        var base = selectedBase();
        var archived = base ? base.frames.length : 0;
        var shown = state.baseEntry ? state.baseEntry.frames.length : 0;
        if (!base || archived <= shown) { budgetHint.style.display = 'none'; }
        else {
          var winActive = !!fromEl && !windowFull();
          budgetHint.textContent = 'Showing ' + shown + ' of ' + archived + ' frames @ ' + frameWidthPx() + ' px' +
            (winActive ? ' (windowed).' : ' — raise Resolution for sharper detail, lower it for more frames.');
          budgetHint.style.display = 'block';
        }
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
        if (!base.frames.length) {
          stageMsg.textContent = (fromEl && !windowFull())
            ? 'No frames for this product in the selected range — widen the Range or pick a denser product.'
            : 'No frames for this base.';
          stageMsg.style.display = 'block'; updateTransport(); return Promise.resolve();
        }

        var needed = [base].concat(activeLayerEntries());
        // Keep only the on-screen set resident (current base + active layers); free any
        // previously-decoded base/layers now, before decoding new frames.
        var keep = {}; needed.forEach(function (e) { keep[e.key] = 1; });
        evictCache(keep);
        var toBuild = needed.filter(function (e) { return !e.done; });
        if (!toBuild.length) { stageMsg.style.display = 'none'; paint(state.index); updateTransport(); updateLegend(); return Promise.resolve(); }

        stageMsg.textContent = 'Decoding…'; stageMsg.style.display = 'block';
        progWrap.style.display = 'block'; progText.style.display = 'block'; progBar.style.width = '0%';
        var done = 0, total = toBuild.length;
        return (function chain(idx) {
          if (destroyed || idx >= total) return Promise.resolve();
          var e = toBuild[idx];
          return buildEntry(e, function (entry, nf) {
            if (state.baseEntry === entry && nf === 1) { stageMsg.style.display = 'none'; paint(0); }
            else if (state.baseEntry && state.baseEntry.done) paint(state.index);
            progBar.style.width = Math.round(((done + nf / e.frames.length) / total) * 100) + '%'; progText.textContent = 'Decoding ' + e.product.name + '…';
          }).then(function () { done++; return chain(idx + 1); });
        })(0).then(function () {
          if (destroyed) return;
          progWrap.style.display = 'none'; progText.style.display = 'none';
          stageMsg.style.display = 'none';
          paint(state.index); updateTransport(); updateLegend();
        });
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
      // All of these mutate the decode cache; block them while a single export is
      // encoding (it reads bitmaps that pruneCache/resetAllEntries would close).
      function busy() { return batchRunning || exporting; }
      function onBaseChange() { if (busy()) return; var wp = state.playing; stop(); showScene(true).then(function () { if (view.scale !== 1) { clampView(); paint(state.index); } if (wp && !destroyed) play(); }); }
      function onDimChange() { if (busy()) return; resetView(); var wp = state.playing; stop(); pruneCache(); showScene(false).then(function () { if (wp && !destroyed) play(); }); }
      // Close and drop EVERY cached entry (window changes every entry's frame list).
      function resetAllEntries() { Object.keys(cache).forEach(function (k) { closeEntry(cache[k]); delete cache[k]; }); }
      // Range inputs fire `change` per arrow-step and per drag-release; coalesce a
      // burst into ONE rebuild, and commit the window only when we actually apply.
      function onWindowChange() { if (busy()) return; clearTimeout(winTimer); winTimer = setTimeout(applyWindow, 150); }
      function applyWindow() {
        if (destroyed || busy() || !fromEl) return;
        win.lo = +fromEl.value; win.hi = +toEl.value;   // commit the dragged handles
        var wp = state.playing; stop(); resetView(); resetAllEntries();
        showScene(true).then(function () { if (wp && !destroyed) play(); });
      }
      function onLayerToggle(lc) { if (busy()) return; var wp = state.playing; stop(); lc.row.classList.toggle('gs-layer-on', lc.chk.checked); showScene(false).then(function () { if (wp && !destroyed) play(); }); }
      coastChk.addEventListener('change', onDimChange);
      resSel.addEventListener('change', onDimChange);
      deflickChk.addEventListener('change', function () { if (state.baseEntry && state.baseEntry.done) paint(state.index); });

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
        if (!state.baseEntry || !state.baseEntry.done || batchRunning || exporting) return;
        stop();
        var ex = document.createElement('canvas'), fpsVal = parseInt(fps.value, 10);
        var idxs = validIndices(state.baseEntry), restore = vidBtn.textContent;
        if (!idxs.length) { ctx.toast('No decoded frames to export.', 'warn'); return; }
        // Lock cache-mutating controls (resolution/base/layers/window) while the
        // encoder reads these exact bitmaps — else a mid-encode change closes them.
        exporting = true; if (fromEl) { fromEl.disabled = true; toEl.disabled = true; }
        vidBtn.disabled = true; vidBtn.textContent = 'Encoding…';
        GS.imaging.exportVideo({
          fps: fpsVal, count: idxs.length,
          render: function (k) { renderComposite(ex, idxs[k]); return ex; },
          onProgress: function (d, t) { vidBtn.textContent = 'Encoding… ' + d + '/' + t; }
        }).then(function (res) {
          GS.imaging.downloadBlob(res.blob, baseName() + '_' + GS.imaging.stamp(state.baseEntry.frames[idxs[0]].time) + '_' + fpsVal + 'fps.' + res.ext);
          ctx.toast('Exported ' + res.encoder + ' (' + idxs.length + ' frames @ ' + fpsVal + ' fps).', 'ok');
        }).catch(function (e) { ctx.toast('Video export failed: ' + e.message, 'error'); })
          .then(function () { exporting = false; if (fromEl) { fromEl.disabled = false; toEl.disabled = false; } vidBtn.textContent = restore; vidBtn.disabled = false; updateTransport(); });
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
        else if (k === 'e' || k === 'E') { if (!vidBtn.disabled) vidBtn.click(); }
        else if (k === 's' || k === 'S') { if (!pngBtn.disabled) pngBtn.click(); }
      }
      document.addEventListener('keydown', onKey);

      /* ---------- init ---------- */
      showScene(true);

      return {
        destroy: function () {
          destroyed = true;
          clearTimeout(winTimer);
          document.removeEventListener('keydown', onKey);
          stop();
          Object.keys(cache).forEach(function (k) { closeEntry(cache[k]); });
        }
      };
    }
  };
})(window.GS = window.GS || {});
