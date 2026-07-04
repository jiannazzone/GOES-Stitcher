/*
 * overlay.js — L2 Overlay mode.
 *
 * Pick a base image (any composite / band / L2 product at a chosen time, with an
 * optional coastline overlay) and stack the region's Level-2 data products on top
 * as toggleable layers, each with its own opacity and blend mode. Because all
 * full-disk products share the same earth extent, layers of different native
 * resolutions line up once scaled to the common working canvas.
 *
 * Opacity / blend changes redraw instantly from cached bitmaps; only base, time
 * or resolution changes trigger new decodes.
 *
 * Exposed as GS.OverlayMode.create(panelEl, stageEl, region, ctx) -> { destroy }.
 */
(function (GS) {
  'use strict';

  function sanitize(s) { return String(s).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, ''); }

  function resolutionOptions(region) {
    if (/mesoscale/i.test(region.id)) return [{ v: 500, label: '500 px' }, { v: 1000, label: '1000 px' }];
    return [{ v: 512, label: '512 px (fast)' }, { v: 1024, label: '1024 px' }, { v: 2048, label: '2048 px (sharp)' }];
  }
  function defaultResolution(region) { return /mesoscale/i.test(region.id) ? 500 : 1024; }

  function nearestFrame(product, t) {
    var best = product.frames[0], bd = Infinity;
    product.frames.forEach(function (f) {
      var d = Math.abs(f.time - t);
      if (d < bd) { bd = d; best = f; }
    });
    return best;
  }

  GS.OverlayMode = {
    create: function (panel, stage, region, ctx) {
      var el = GS.dom.el;
      var renderToken = 0, debounce = 0;

      var products = region.products.filter(function (p) { return p.frames.length > 0; });
      var l2 = region.l2 || [];

      /* ----- base selector ----- */
      var baseSel = el('select', { class: 'gs-select' });
      var groups = { composite: 'Composites', channel: 'Raw ABI Bands', l2: 'Level-2 Products' };
      ['composite', 'channel', 'l2'].forEach(function (kind) {
        var items = products.filter(function (p) { return p.kind === kind; });
        if (!items.length) return;
        var og = el('optgroup', { label: groups[kind] });
        items.forEach(function (p) { og.appendChild(el('option', { value: p.key, text: p.name })); });
        baseSel.appendChild(og);
      });
      // Prefer ABI False Color as the default base if present.
      var preferred = products.filter(function (p) { return /false color/i.test(p.name); })[0] || products[0];
      if (preferred) baseSel.value = preferred.key;

      var timeSel = el('select', { class: 'gs-select' });
      var coastChk = el('input', { type: 'checkbox' });
      var coastLabel = el('label', { class: 'gs-check' }, [coastChk, ' Coastlines on base']);

      function baseProduct() { return products.filter(function (p) { return p.key === baseSel.value; })[0]; }

      function rebuildTimes() {
        GS.dom.clear(timeSel);
        var p = baseProduct();
        if (!p) return;
        p.frames.forEach(function (f, i) {
          timeSel.appendChild(el('option', { value: String(i), text: GS.imaging.formatUTC(f.time) }));
        });
        timeSel.value = String(p.frames.length - 1); // default: most recent
        var hasMap = p.hasMap;
        coastChk.disabled = !hasMap;
        coastLabel.classList.toggle('gs-disabled', !hasMap);
        if (!hasMap) coastChk.checked = false;
      }

      var resSel = el('select', { class: 'gs-select' });
      resolutionOptions(region).forEach(function (o) { resSel.appendChild(el('option', { value: String(o.v), text: o.label })); });
      resSel.value = String(defaultResolution(region));

      panel.appendChild(el('div', { class: 'gs-field' }, [el('label', { class: 'gs-label', text: 'Base image' }), baseSel]));
      panel.appendChild(el('div', { class: 'gs-field' }, [el('label', { class: 'gs-label', text: 'Time' }), timeSel]));
      panel.appendChild(el('div', { class: 'gs-field' }, [coastLabel]));
      panel.appendChild(el('div', { class: 'gs-field' }, [el('label', { class: 'gs-label', text: 'Resolution' }), resSel]));

      /* ----- L2 layer rows ----- */
      var layerControls = [];
      if (l2.length) {
        panel.appendChild(el('div', { class: 'gs-section-label', text: 'Level-2 layers' }));
        l2.forEach(function (p) {
          var chk = el('input', { type: 'checkbox' });
          var opacity = el('input', { type: 'range', min: '0', max: '100', value: '70', class: 'gs-range gs-range-sm' });
          var blend = el('select', { class: 'gs-select gs-select-sm' });
          GS.imaging.blendModes.forEach(function (b) { blend.appendChild(el('option', { value: b.id, text: b.label })); });
          blend.value = 'screen';
          var timeTag = el('span', { class: 'gs-layer-time', text: '' });

          var row = el('div', { class: 'gs-layer' }, [
            el('label', { class: 'gs-layer-head' }, [chk, el('span', { class: 'gs-layer-name', text: p.name }), timeTag]),
            el('div', { class: 'gs-layer-ctl' }, [
              el('span', { class: 'gs-mini', text: 'opacity' }), opacity,
              blend
            ])
          ]);
          panel.appendChild(row);
          layerControls.push({ product: p, chk: chk, opacity: opacity, blend: blend, timeTag: timeTag, row: row });
        });
      } else {
        panel.appendChild(el('div', { class: 'gs-hint', html: 'No Level-2 products in this region. You can still view the base image with coastlines, or switch to a region that has L2 (e.g. <b>GOES-19 / Full Disk</b>).' }));
      }

      var pngBtn = el('button', { class: 'gs-btn gs-btn-primary', text: 'Save overlay PNG', disabled: true });
      panel.appendChild(pngBtn);
      var progText = el('div', { class: 'gs-hint', style: { display: 'none' } });
      panel.appendChild(progText);

      /* ----- stage ----- */
      var canvas = el('canvas', { class: 'gs-canvas' });
      var stageMsg = el('div', { class: 'gs-stage-msg', text: 'Rendering…' });
      stage.appendChild(canvas);
      stage.appendChild(stageMsg);

      /* ----- render ----- */
      function scheduleRender() {
        clearTimeout(debounce);
        debounce = setTimeout(render, 70);
      }

      function render() {
        var p = baseProduct();
        if (!p) return;
        var token = ++renderToken;
        var size = parseInt(resSel.value, 10);
        var baseFrame = p.frames[parseInt(timeSel.value, 10)] || p.frames[p.frames.length - 1];
        var baseVariant = (coastChk.checked && baseFrame.variants.map) ? 'map' : 'plain';
        var baseFile = baseFrame.variants[baseVariant] || baseFrame.variants.plain || baseFrame.variants.map;

        var active = [];
        layerControls.forEach(function (lc) {
          if (!lc.chk.checked) { lc.timeTag.textContent = ''; lc.row.classList.remove('gs-layer-on'); return; }
          lc.row.classList.add('gs-layer-on');
          var f = nearestFrame(lc.product, baseFrame.time);
          var file = f.variants.plain || f.variants.map;
          lc.timeTag.textContent = f.label;
          active.push({ file: file, alpha: parseInt(lc.opacity.value, 10) / 100, blend: lc.blend.value });
        });

        stageMsg.textContent = 'Rendering…';
        stageMsg.style.display = 'block';
        progText.style.display = 'block';
        progText.textContent = 'Decoding ' + (1 + active.length) + ' layer' + (active.length ? 's' : '') + '…';

        var jobs = [GS.imaging.getBitmap(baseFile, size)].concat(active.map(function (a) { return GS.imaging.getBitmap(a.file, size); }));
        Promise.all(jobs).then(function (bmps) {
          if (token !== renderToken) return; // superseded
          var baseBmp = bmps[0];
          var layers = active.map(function (a, i) { return { bmp: bmps[i + 1], alpha: a.alpha, blend: a.blend }; });
          GS.imaging.composeLayers(canvas, size, baseBmp, layers, '#080604');
          stageMsg.style.display = 'none';
          progText.style.display = 'none';
          pngBtn.disabled = false;
        }).catch(function (e) {
          if (token !== renderToken) return;
          stageMsg.textContent = 'Failed to render: ' + e.message;
          progText.style.display = 'none';
        });
      }

      /* ----- wiring ----- */
      baseSel.addEventListener('change', function () { rebuildTimes(); scheduleRender(); });
      timeSel.addEventListener('change', scheduleRender);
      coastChk.addEventListener('change', scheduleRender);
      resSel.addEventListener('change', scheduleRender);
      layerControls.forEach(function (lc) {
        lc.chk.addEventListener('change', scheduleRender);
        lc.opacity.addEventListener('input', scheduleRender);
        lc.blend.addEventListener('change', scheduleRender);
      });

      pngBtn.addEventListener('click', function () {
        var p = baseProduct();
        var baseFrame = p.frames[parseInt(timeSel.value, 10)] || p.frames[p.frames.length - 1];
        var onLayers = layerControls.filter(function (lc) { return lc.chk.checked; })
          .map(function (lc) { return lc.product.name.replace(/[^A-Za-z0-9]+/g, ''); }).join('+');
        var name = sanitize(ctx.satLabel.split(' ')[0] + '_' + region.id + '_' + p.name +
          (onLayers ? '_over_' + onLayers : '') + '_' + GS.imaging.stamp(baseFrame.time)) + '.png';
        GS.imaging.canvasToPng(canvas).then(function (blob) { GS.imaging.downloadBlob(blob, name); });
      });

      rebuildTimes();
      render();

      // Keyboard shortcut: save the composited PNG.
      function onKey(e) {
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        var t = e.target, tag = t && (t.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
        if ((e.key === 's' || e.key === 'S') && !pngBtn.disabled) pngBtn.click();
      }
      document.addEventListener('keydown', onKey);

      return {
        destroy: function () {
          document.removeEventListener('keydown', onKey);
          renderToken++;
          clearTimeout(debounce);
        }
      };
    }
  };
})(window.GS = window.GS || {});
