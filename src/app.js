/*
 * app.js — the shell: folder picking (input + drag-drop), the run / satellite
 * / region selectors, the mode tabs, and the mount/unmount lifecycle for the two
 * modes. Also defines the tiny GS.dom helper used by every module at mount time.
 *
 * Nothing here touches the network. Files are read locally and lazily.
 */
(function (GS) {
  'use strict';

  /* ---------- GS.dom (used by all modules) ---------- */
  function append(node, children) {
    if (children == null) return;
    if (Array.isArray(children)) { children.forEach(function (c) { append(node, c); }); return; }
    if (typeof children === 'string' || typeof children === 'number') { node.appendChild(document.createTextNode(String(children))); return; }
    if (children instanceof Node) node.appendChild(children);
  }
  function el(tag, props, children) {
    var node = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (k) {
        var v = props[k];
        if (v == null) return;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'html') node.innerHTML = v;
        else if (k === 'style' && typeof v === 'object') Object.keys(v).forEach(function (s) { node.style[s] = v[s]; });
        else if (k === 'checked' || k === 'disabled' || k === 'selected') node[k] = !!v;
        else if (k === 'value') node.value = v;
        else if (k === 'on' && typeof v === 'object') Object.keys(v).forEach(function (ev) { node.addEventListener(ev, v[ev]); });
        else node.setAttribute(k, v);
      });
    }
    append(node, children);
    return node;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  GS.dom = { el: el, clear: clear };

  /* ---------- GS.ui: shared widgets ---------- */
  // A keyboard-navigable, cursor-style list (grouped). Rows show a label and a
  // right-aligned meta (e.g. frame count). Selection shows a "›" cursor.
  //   groups: [{ label, items: [{ key, label, meta }] }]
  //   opts:   { selected, onSelect(key) }
  function list(groups, opts) {
    opts = opts || {};
    var container = el('div', { class: 'gs-list', tabindex: '0' });
    var rows = [];
    var selected = opts.selected || null;

    groups.forEach(function (g) {
      if (g.label) container.appendChild(el('div', { class: 'gs-list-group', text: g.label }));
      g.items.forEach(function (it) {
        var cur = el('span', { class: 'gs-list-cur' });
        var row = el('div', { class: 'gs-list-row' }, [
          cur, el('span', { class: 'gs-list-label', text: it.label }),
          el('span', { class: 'gs-list-meta', text: it.meta || '' })
        ]);
        if (it.title) row.title = it.title;
        row.addEventListener('click', function () { select(it.key, true); });
        rows.push({ key: it.key, node: row, cur: cur });
        container.appendChild(row);
      });
    });

    function idx(key) { for (var i = 0; i < rows.length; i++) if (rows[i].key === key) return i; return -1; }
    function select(key, fire) {
      selected = key;
      rows.forEach(function (r) {
        var on = r.key === key;
        r.node.classList.toggle('is-sel', on);
        r.cur.textContent = on ? '›' : '';
      });
      var i = idx(key);
      if (i >= 0 && rows[i].node.scrollIntoView) rows[i].node.scrollIntoView({ block: 'nearest' });
      if (fire && opts.onSelect) opts.onSelect(key);
    }
    function step(delta, fire) {
      var i = idx(selected);
      if (i < 0) { if (rows.length) select(rows[0].key, fire); return; }
      var j = Math.max(0, Math.min(rows.length - 1, i + delta));
      if (j !== i) select(rows[j].key, fire);
    }
    if (selected) select(selected, false);

    return {
      el: container,
      select: select,
      next: function (f) { step(1, f); },
      prev: function (f) { step(-1, f); },
      getSelected: function () { return selected; }
    };
  }
  GS.ui = { list: list };

  /* ---------- about / glossary overlay ----------
     Built once from GS.catalog so the glossary stays in sync with the data.
     All html: strings below are hard-coded literals (no user/filesystem text). */
  function glossList(items) {
    return el('dl', { class: 'gs-gloss' }, items.map(function (it) {
      return el('div', { class: 'gs-gloss-row' }, [
        el('dt', { text: it.name }), el('dd', { text: it.blurb })
      ]);
    }));
  }
  function buildAbout() {
    var host = q('about');
    if (!host || host._built) return;
    var g = GS.catalog.glossary();
    var bandRows = g.bands.map(function (b) {
      return { name: 'Band ' + b.band + ' · ' + b.name + ' (' + b.wavelength + ')', blurb: b.blurb };
    });
    function p(html) { return el('p', { class: 'gs-about-p', html: html }); }
    function h(t) { return el('h3', { class: 'gs-about-h', text: t }); }

    var closeBtn = el('button', { class: 'gs-about-x', 'aria-label': 'Close', text: '✕' });
    closeBtn.addEventListener('click', closeAbout);

    host.appendChild(closeBtn);
    host.appendChild(el('div', { class: 'gs-about-body' }, [
        p('<b>goes-stitcher</b> turns a folder of <b>SatDump</b> GOES-R HRIT captures into animated, layered whole-disk imagery. Everything runs locally in your browser — nothing is uploaded.'),
        h('How it works'),
        p('The <b>base image</b> is the bottom layer — a composite, a single spectral band, or a Level-2 product, optionally with coastlines. Its scans define the <b>timeline</b> you play, scrub and export as MP4. <b>Level-2 layers</b> stack derived products on top with their own opacity and blend mode; each snaps to the frame nearest the base in time.'),
        h('The data'),
        p('GOES-R satellites (GOES-19 East, GOES-18 West) broadcast imagery over <b>HRIT</b>, which SatDump decodes into PNGs. <b>Full Disk</b> covers the whole visible hemisphere about every 10 minutes; <b>Mesoscale</b> sectors are small, fast, roving windows. All times are <b>UTC</b>.'),
        h('Spectral bands'),
        glossList(bandRows),
        h('Composites & Level-2 products'),
        glossList(g.products),
        h('References'),
        el('ul', { class: 'gs-refs' }, g.references.map(function (r) {
          return el('li', {}, [el('a', { class: 'gs-link', href: r.url, target: '_blank', rel: 'noopener noreferrer', text: r.label + ' ↗' })]);
        })),
        el('p', { class: 'gs-about-fine', html: 'Not affiliated with NOAA or NASA. GOES imagery is public-domain data you received yourself. Source on <a class="gs-link" href="https://github.com/jiannazzone/GOES-Stitcher" target="_blank" rel="noopener noreferrer">GitHub ↗</a> · MIT.' })
      ]));
    host._built = true;
  }
  function aboutEsc(e) { if (e.key === 'Escape') closeAbout(); }
  // Opening About swaps the viewport window's title to "about" and fills the
  // stage with the panel, so it reads as the viewport's content — not an overlay.
  // The title is always *recomputed* (never snapshotted), so it stays correct
  // even if the selectors are used while the panel is open.
  function setAboutBtn(on) {
    var b = q('about-btn'); if (!b) return;
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
  function openAbout() {
    var h = q('about'); if (!h || !h.hidden) return;   // no-op if already open
    buildAbout();
    h.hidden = false;
    setText('stage-title', 'about · goes-stitcher');
    setAboutBtn(true);
    document.addEventListener('keydown', aboutEsc);
  }
  function closeAbout() {
    var h = q('about'); if (!h || h.hidden) return;
    h.hidden = true;
    setText('stage-title', viewportTitle());
    setAboutBtn(false);
    document.removeEventListener('keydown', aboutEsc);
  }
  function toggleAbout() { aboutOpen() ? closeAbout() : openAbout(); }

  /* ---------- toast ---------- */
  function toast(msg, type) {
    var host = document.getElementById('toast-host');
    if (!host) return;
    var t = el('div', { class: 'gs-toast gs-toast-' + (type || 'info'), text: msg });
    host.appendChild(t);
    setTimeout(function () { t.classList.add('gs-toast-out'); setTimeout(function () { t.remove(); }, 350); }, 3400);
  }

  /* ---------- drag & drop folder traversal ---------- */
  // SatDump writes several non-image category folders alongside IMAGES/ and L2/
  // (DCS reports, admin messages, …). They hold no imagery but often thousands of
  // tiny files, so when traversing a DROPPED folder we don't descend into them.
  // Matched case-insensitively by folder name; none collide with a sat / region /
  // timestamp segment. EMWIN is NOT skipped — it carries animatable radar-mosaic
  // GIFs — but it's mostly text products, so we descend and drop its non-images
  // per-file (see walkEntry). (The folder <input> can't be pruned this way — the
  // browser enumerates the whole tree before it hands us the FileList; there we
  // only surface the skipped count.)
  var SKIP_DIRS = { dcs: 1, 'admin messages': 1, 'additional data': 1, text: 1 };

  // Under EMWIN/, keep only the image products (the rest is ~10k text bulletins we
  // don't animate); elsewhere keep everything and let the scanner classify.
  function keepDropped(path) {
    return !/(^|\/)EMWIN(\/|$)/i.test(path) || /\.(gif|jpe?g|png)$/i.test(path);
  }

  function readAllEntries(reader) {
    return new Promise(function (resolve, reject) {
      var out = [];
      (function pump() {
        reader.readEntries(function (batch) {
          if (!batch.length) { resolve(out); return; }
          out = out.concat(Array.prototype.slice.call(batch));
          pump();
        }, reject);
      })();
    });
  }
  function walkEntry(entry, files) {
    if (entry.isFile) {
      if (!keepDropped(entry.fullPath || entry.name || '')) return Promise.resolve();
      return new Promise(function (resolve) {
        entry.file(function (f) {
          try { f.relativePath = entry.fullPath.replace(/^\//, ''); } catch (e) { /* read-only in some browsers */ }
          if (!f.relativePath) { try { Object.defineProperty(f, 'relativePath', { value: entry.fullPath.replace(/^\//, '') }); } catch (e2) {} }
          files.push(f);
          resolve();
        }, function () { resolve(); });
      });
    }
    if (entry.isDirectory) {
      if (SKIP_DIRS[(entry.name || '').toLowerCase()]) return Promise.resolve();
      var reader = entry.createReader();
      return readAllEntries(reader).then(function (entries) {
        return Promise.all(entries.map(function (e) { return walkEntry(e, files); }));
      });
    }
    return Promise.resolve();
  }
  function filesFromDrop(dataTransfer) {
    var items = dataTransfer.items;
    if (!items || !items.length || !items[0].webkitGetAsEntry) {
      return Promise.resolve(Array.prototype.slice.call(dataTransfer.files || []));
    }
    var entries = [];
    for (var i = 0; i < items.length; i++) {
      var e = items[i].webkitGetAsEntry && items[i].webkitGetAsEntry();
      if (e) entries.push(e);
    }
    var files = [];
    return Promise.all(entries.map(function (e) { return walkEntry(e, files); })).then(function () { return files; });
  }

  /* ---------- app state ---------- */
  var App = {
    data: null,
    sel: { run: 0, sat: 0, region: 0 },
    mode: null // active mode instance
  };

  function q(id) { return document.getElementById(id); }

  function currentRegion() {
    if (!App.data) return null;
    var r = App.data.runs[App.sel.run]; if (!r) return null;
    var sat = r.sats[App.sel.sat]; if (!sat) return null;
    return { run: r, sat: sat, region: sat.regions[App.sel.region] || null };
  }

  function makeSelect(id, label, options, value, onChange) {
    var sel = el('select', { class: 'gs-select', id: id });
    options.forEach(function (o) { sel.appendChild(el('option', { value: String(o.value), text: o.label })); });
    sel.value = String(value);
    sel.addEventListener('change', onChange);
    return el('div', { class: 'gs-topfield' }, [el('label', { class: 'gs-toplabel', text: label }), sel]);
  }

  function buildSelectors() {
    var host = q('selectors');
    clear(host);
    var d = App.data;

    // Reception run (only if more than one; "All · span gaps" trails the real runs)
    if (d.runs.length > 1) {
      host.appendChild(makeSelect('sel-run', 'Run',
        d.runs.map(function (r, i) { return { value: i, label: r.name }; }),
        App.sel.run, function (e) { App.sel.run = +e.target.value; App.sel.sat = 0; App.sel.region = 0; buildSelectors(); mount(); }));
    }

    var run = d.runs[App.sel.run];
    host.appendChild(makeSelect('sel-sat', 'Satellite',
      run.sats.map(function (s, i) { return { value: i, label: s.role === 'relayed' ? (s.label + ' · relayed') : s.label }; }),
      App.sel.sat, function (e) { App.sel.sat = +e.target.value; App.sel.region = 0; buildSelectors(); mount(); }));

    var sat = run.sats[App.sel.sat];
    host.appendChild(makeSelect('sel-region', 'Region',
      sat.regions.map(function (r, i) {
        var l2 = r.hasL2 ? ' · L2' : '';
        return { value: i, label: (r.label || r.id) + ' — ' + r.maxFrames + ' scan' + (r.maxFrames === 1 ? '' : 's') + ' · ' + r.products.length + ' product' + (r.products.length === 1 ? '' : 's') + l2 };
      }),
      App.sel.region, function (e) { App.sel.region = +e.target.value; buildSelectors(); mount(); }));
  }

  function setText(id, txt) { var e = q(id); if (e) e.textContent = txt; }

  function setKeys(pairs) {
    var host = q('st-keys'); if (!host) return;
    clear(host);
    pairs.forEach(function (p, i) {
      if (i) host.appendChild(document.createTextNode('  ·  '));
      host.appendChild(el('b', { text: p[0] }));
      host.appendChild(document.createTextNode(' ' + p[1]));
    });
  }

  // The viewport window's title for the current selection.
  function viewportTitle() {
    var cur = currentRegion();
    return (cur && cur.region) ? ('viewport · ' + cur.sat.id.toLowerCase() + ' · ' + cur.region.id.toLowerCase()) : 'viewport';
  }
  function aboutOpen() { var h = q('about'); return !!(h && !h.hidden); }

  function updateStatus() {
    var cur = currentRegion();
    var stmode = q('st-mode'); if (stmode) stmode.style.display = 'none';
    setText('st-loc', (cur && cur.region) ? (cur.sat.id.toLowerCase() + ' · ' + cur.region.id.toLowerCase()) : '—');
    setText('panel-title', 'view');
    // Keep the "about" title while the panel is open, even across a region change.
    setText('stage-title', aboutOpen() ? 'about · goes-stitcher' : viewportTitle());
    setKeys([['↑↓', 'base'], ['␣', 'play'], ['←→', 'time'], ['e', 'mp4'], ['s', 'png']]);
  }

  function mount() {
    var cur = currentRegion();
    if (App.mode && App.mode.destroy) { try { App.mode.destroy(); } catch (e) {} }
    App.mode = null;
    var panel = q('panel'), stage = q('stage');
    clear(panel); clear(stage);
    updateStatus();
    if (!cur || !cur.region) { panel.appendChild(el('div', { class: 'gs-hint', text: 'No region selected.' })); return; }

    var ctx = { toast: toast, satLabel: cur.sat.label };
    try {
      App.mode = GS.ViewMode.create(panel, stage, cur.region, ctx);
    } catch (e) {
      panel.appendChild(el('div', { class: 'gs-hint', text: 'Error: ' + e.message } ));
      if (window.console) console.error(e);
    }
  }

  function loadFiles(files) {
    if (!files || !files.length) { toast('No files found in that selection.', 'warn'); return; }
    var busy = q('busy');
    if (busy) busy.style.display = 'flex';
    // Let the browser paint the busy state before the (synchronous) scan.
    setTimeout(function () {
      GS.scanner.scan(files).then(function (res) {
        if (busy) busy.style.display = 'none';
        if (!res.runs.length) {
          toast('No GOES IMAGES/ or L2/ folders found here. Pick a SatDump session (or a folder that contains one).', 'error');
          return;
        }
        App.data = res;
        App.sel = { run: res.defaultRun || 0, sat: 0, region: 0 };
        q('workspace').classList.remove('gs-empty');
        var summary = res.stats.runs + ' run' + (res.stats.runs > 1 ? 's' : '') +
          ' · ' + res.stats.used.toLocaleString() + ' images indexed' +
          (res.stats.skipped ? ' · ' + res.stats.skipped.toLocaleString() + ' files skipped' : '');
        setText('st-summary', summary);
        q('repick').style.display = 'inline-flex';
        buildSelectors();
        mount();
        toast('Loaded ' + summary + '.', 'ok');
      }).catch(function (err) {
        if (busy) busy.style.display = 'none';
        toast('Could not index that folder: ' + (err && err.message ? err.message : err), 'error');
        if (window.console) console.error(err);
      });
    }, 30);
  }

  /* ---------- wiring ---------- */
  function init() {
    var input = q('folder-input');
    q('pick-btn').addEventListener('click', function (e) { e.stopPropagation(); input.click(); });
    q('repick').addEventListener('click', function () { input.click(); });
    var aboutBtn = q('about-btn'); if (aboutBtn) aboutBtn.addEventListener('click', toggleAbout);

    // Optional "try sample data" button — only shown when a samples/manifest.json
    // with files exists and we're not on file:// (relative fetch is blocked there).
    var sampleBtn = q('sample-btn'), sampleLoading = false;
    if (sampleBtn && GS.samples) {
      GS.samples.available().then(function (m) { if (m) sampleBtn.style.display = 'inline-flex'; });
      sampleBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        if (sampleLoading) return;                 // ignore repeat clicks while loading
        sampleLoading = true; sampleBtn.disabled = true;
        var busy = q('busy'), busyText = busy && busy.lastElementChild;
        if (busyText) busyText.textContent = 'loading sample data';
        if (busy) busy.style.display = 'flex';
        GS.samples.load().then(function (files) {
          if (busy) busy.style.display = 'none';
          if (busyText) busyText.textContent = 'reading folder';
          loadFiles(files);
        }).catch(function (err) {
          if (busy) busy.style.display = 'none';
          if (busyText) busyText.textContent = 'reading folder';
          toast('Could not load sample data: ' + (err && err.message ? err.message : 'unavailable') + '.', 'error');
        }).then(function () { sampleLoading = false; sampleBtn.disabled = false; });
      });
    }

    // Clicking anywhere in the empty viewport opens the picker too.
    q('stage').addEventListener('click', function () { if (q('workspace').classList.contains('gs-empty')) input.click(); });
    input.addEventListener('change', function () { loadFiles(Array.prototype.slice.call(input.files || [])); input.value = ''; });

    // Drop a folder anywhere on the window; the viewport highlights while dragging.
    var dragDepth = 0;
    function hot(on) { var st = q('stage'); if (st) st.classList.toggle('gs-drop-hot', on); }
    window.addEventListener('dragenter', function (e) { e.preventDefault(); if (++dragDepth === 1) hot(true); });
    window.addEventListener('dragover', function (e) { e.preventDefault(); });
    window.addEventListener('dragleave', function (e) { e.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; hot(false); } });
    window.addEventListener('drop', function (e) {
      e.preventDefault(); dragDepth = 0; hot(false);
      var busy = q('busy'); if (busy) busy.style.display = 'flex';
      filesFromDrop(e.dataTransfer).then(function (files) {
        if (busy) busy.style.display = 'none';
        if (files && files.length) loadFiles(files);
      }).catch(function (err) {
        if (busy) busy.style.display = 'none';
        toast('Could not read that folder: ' + err.message, 'error');
      });
    });

    if (!GS.imaging.supportsVideoExport()) {
      var note = q('webm-note');
      if (note) note.style.display = 'block';
    }

    // Live UTC clock in the status bar.
    function tickClock() { var c = q('st-clock'); if (c) c.textContent = GS.imaging.formatClock(new Date()); }
    tickClock();
    setInterval(tickClock, 1000);

  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  GS.App = App;
})(window.GS = window.GS || {});
