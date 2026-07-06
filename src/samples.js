/*
 * samples.js — optional "load sample data" path for the hosted site.
 *
 * Static hosting has no directory listing, so the demo files must be enumerated
 * in samples/manifest.json ({ "files": ["<path-with-IMAGES|L2-segment>", …] },
 * each path relative to samples/). We fetch each PNG, wrap it in a File whose
 * relativePath mirrors a SatDump tree (…/IMAGES|L2/<sat>/<region>/<time>/<file>),
 * and hand the array straight to the same loadFiles() a real folder pick uses —
 * so the scanner needs no changes.
 *
 * Unavailable (button stays hidden) when: no manifest, empty manifest, or the
 * page is opened via file:// (relative fetch is blocked there).
 */
(function (GS) {
  'use strict';

  var MANIFEST_URL = 'samples/manifest.json';
  var cachedAvail = null;   // Promise<manifest|null>, resolved once

  function usable() {
    return typeof fetch === 'function' &&
      !(typeof location !== 'undefined' && location.protocol === 'file:');
  }

  // Resolves the manifest object if there's real sample data to load, else null.
  function available() {
    if (cachedAvail) return cachedAvail;
    if (!usable()) { cachedAvail = Promise.resolve(null); return cachedAvail; }
    cachedAvail = fetch(MANIFEST_URL, { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (m) {
        return (m && Array.isArray(m.files) && m.files.length) ? m : null;
      })
      .catch(function () { return null; });
    return cachedAvail;
  }

  function baseName(path) { var s = path.split('/'); return s[s.length - 1]; }

  function toFile(path, blob) {
    var f = new File([blob], baseName(path), { type: blob.type || 'image/png' });
    // Scanner reads file.webkitRelativePath || file.relativePath || file.name.
    // webkitRelativePath is read-only, so use relativePath (same fallback the
    // drag-and-drop path uses in app.js).
    try { Object.defineProperty(f, 'relativePath', { value: path, configurable: true }); }
    catch (e) { try { f.relativePath = path; } catch (e2) {} }
    return f;
  }

  // Fetch every listed sample (sequentially, with progress) into a File[].
  function load(onProgress) {
    return available().then(function (m) {
      if (!m) throw new Error('No sample data available.');
      var files = m.files, out = [], done = 0;
      return files.reduce(function (chain, path) {
        return chain.then(function () {
          return fetch('samples/' + path).then(function (r) {
            if (!r.ok) throw new Error('Missing sample: ' + path);
            return r.blob();
          }).then(function (b) {
            out.push(toFile(path, b));
            done++; if (onProgress) onProgress(done, files.length);
          });
        });
      }, Promise.resolve()).then(function () { return out; });
    });
  }

  GS.samples = { available: available, load: load };
})(window.GS = window.GS || {});
