/*
 * samples.js — optional "load sample data" path for the hosted site.
 *
 * Static hosting has no directory listing, so the demo files must be enumerated
 * in samples/manifest.json ({ "files": ["<path-with-IMAGES|L2-segment>", …] },
 * each path relative to samples/). We fetch each listed file (ABI PNGs, each meso
 * folder's product.cbor, and EMWIN imagery), wrap it in a File whose relativePath
 * mirrors a SatDump tree (…/IMAGES|L2/<sat>/<region>/<time>/<file>, …/EMWIN/<file>),
 * and hand the array straight to the same loadFiles() a real folder pick uses —
 * so the scanner needs no changes.
 *
 * Unavailable (button stays hidden) when: no manifest, empty manifest, or the
 * page is opened via file:// (relative fetch is blocked there).
 */
(function (GS) {
  'use strict';

  var MANIFEST_URL = 'samples/manifest.json';
  var cachedManifest = null;   // positive result only, cached for the session
  var inflight = null;         // de-dupe concurrent probes

  function usable() {
    return typeof fetch === 'function' &&
      !(typeof location !== 'undefined' && location.protocol === 'file:');
  }

  // Resolves the manifest object if there's real sample data to load, else null.
  // Only a positive result is cached, so a transient network/manifest failure
  // can be retried (a permanently-cached null would hide the button forever).
  function available() {
    if (cachedManifest) return Promise.resolve(cachedManifest);
    if (!usable()) return Promise.resolve(null);
    if (inflight) return inflight;
    inflight = fetch(MANIFEST_URL, { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (m) {
        cachedManifest = (m && Array.isArray(m.files) && m.files.length) ? m : null;
        inflight = null;
        return cachedManifest;
      })
      .catch(function () { inflight = null; return null; });
    return inflight;
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

  // How many sample fetches to keep in flight. The manifest runs to hundreds of
  // files, so fetching one at a time makes the load a queue of round trips
  // (~125ms each = ~50s of latency alone) instead of a download. Modest enough
  // to not monopolise the browser's connection pool.
  var CONCURRENCY = 12;

  // Fetch every listed sample (bounded pool, with progress) into a File[].
  // Results are written BY INDEX, so the array keeps manifest order no matter
  // which worker finishes first (the scanner keys off paths, but a stable order
  // keeps the load deterministic). Any 404 rejects the whole load, as before.
  function load(onProgress) {
    return available().then(function (m) {
      if (!m) throw new Error('No sample data available.');
      var files = m.files, out = new Array(files.length), next = 0, done = 0;

      function worker() {
        if (next >= files.length) return Promise.resolve();
        var i = next++, path = files[i];
        return fetch('samples/' + path).then(function (r) {
          if (!r.ok) throw new Error('Missing sample: ' + path);
          return r.blob();
        }).then(function (b) {
          out[i] = toFile(path, b);
          done++; if (onProgress) onProgress(done, files.length);
          return worker();   // this worker picks up the next queued file
        });
      }

      var workers = [];
      for (var w = 0; w < Math.min(CONCURRENCY, files.length); w++) workers.push(worker());
      return Promise.all(workers).then(function () { return out; });
    });
  }

  GS.samples = { available: available, load: load };
})(window.GS = window.GS || {});
