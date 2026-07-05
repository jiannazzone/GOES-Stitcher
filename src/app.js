/*
 * app.js — the shell: folder picking (input + drag-drop), the session / satellite
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

  /* ---------- toast ---------- */
  function toast(msg, type) {
    var host = document.getElementById('toast-host');
    if (!host) return;
    var t = el('div', { class: 'gs-toast gs-toast-' + (type || 'info'), text: msg });
    host.appendChild(t);
    setTimeout(function () { t.classList.add('gs-toast-out'); setTimeout(function () { t.remove(); }, 350); }, 3400);
  }

  /* ---------- drag & drop folder traversal ---------- */
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
    sel: { session: 0, sat: 0, region: 0 },
    mode: null // active mode instance
  };

  function q(id) { return document.getElementById(id); }

  function currentRegion() {
    if (!App.data) return null;
    var s = App.data.sessions[App.sel.session]; if (!s) return null;
    var sat = s.sats[App.sel.sat]; if (!sat) return null;
    return { session: s, sat: sat, region: sat.regions[App.sel.region] || null };
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

    // Session (only if more than one)
    if (d.sessions.length > 1) {
      host.appendChild(makeSelect('sel-session', 'Session',
        d.sessions.map(function (s, i) { return { value: i, label: s.name }; }),
        App.sel.session, function (e) { App.sel.session = +e.target.value; App.sel.sat = 0; App.sel.region = 0; buildSelectors(); mount(); }));
    }

    var session = d.sessions[App.sel.session];
    host.appendChild(makeSelect('sel-sat', 'Satellite',
      session.sats.map(function (s, i) { return { value: i, label: s.label }; }),
      App.sel.sat, function (e) { App.sel.sat = +e.target.value; App.sel.region = 0; buildSelectors(); mount(); }));

    var sat = session.sats[App.sel.sat];
    host.appendChild(makeSelect('sel-region', 'Region',
      sat.regions.map(function (r, i) {
        var l2 = r.hasL2 ? ' · L2' : '';
        return { value: i, label: r.id + ' — ' + r.maxFrames + ' scan' + (r.maxFrames === 1 ? '' : 's') + ' · ' + r.products.length + ' products' + l2 };
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

  function updateStatus() {
    var cur = currentRegion();
    var stmode = q('st-mode'); if (stmode) stmode.style.display = 'none';
    setText('st-loc', (cur && cur.region) ? (cur.sat.id.toLowerCase() + ' · ' + cur.region.id.toLowerCase()) : '—');
    setText('panel-title', 'view');
    setText('stage-title', (cur && cur.region) ? ('viewport · ' + cur.sat.id.toLowerCase() + ' · ' + cur.region.id.toLowerCase()) : 'viewport');
    setKeys([['↑↓', 'base'], ['␣', 'play'], ['←→', 'time'], ['b', 'prerender'], ['e', 'webm'], ['s', 'png']]);
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
      var res = GS.scanner.scan(files);
      if (busy) busy.style.display = 'none';
      if (!res.sessions.length) {
        toast('No GOES IMAGES/ or L2/ folders found here. Pick a SatDump session (or a folder that contains one).', 'error');
        return;
      }
      App.data = res;
      App.sel = { session: 0, sat: 0, region: 0 };
      q('workspace').classList.remove('gs-empty');
      var summary = res.stats.sessions + ' session' + (res.stats.sessions > 1 ? 's' : '') +
        ' · ' + res.stats.used.toLocaleString() + ' images indexed';
      q('summary').textContent = summary;
      setText('st-summary', summary);
      q('repick').style.display = 'inline-flex';
      buildSelectors();
      mount();
      toast('Loaded ' + summary + '.', 'ok');
    }, 30);
  }

  /* ---------- wiring ---------- */
  function init() {
    var input = q('folder-input');
    q('pick-btn').addEventListener('click', function () { input.click(); });
    q('repick').addEventListener('click', function () { input.click(); });
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

    if (!GS.imaging.supportsWebM()) {
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
