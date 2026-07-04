/*
 * imaging.js — all the pixel work, kept in one place so the two modes stay thin.
 *
 * Responsibilities:
 *   - UTC time formatting helpers (shared by the scanner and the UI)
 *   - decode + downscale PNGs to ImageBitmaps (memory-bounded), with a per-File
 *     cache and a canvas fallback for browsers whose createImageBitmap ignores
 *     resize options (older Safari)
 *   - draw-to-fit and layer compositing on a 2D canvas
 *   - WebM export from a canvas via MediaRecorder + manual frame stepping
 *   - blob/PNG download helpers
 *
 * Loaded before scanner.js because the scanner uses formatClock().
 */
(function (GS) {
  'use strict';

  /* ---------- time formatting (everything GOES is UTC) ---------- */
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function formatDate(d) { return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()); }
  function formatClock(d) { return pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds()) + 'Z'; }
  function formatUTC(d) { return formatDate(d) + ' ' + formatClock(d); }
  function stamp(d) { return formatDate(d) + '_' + pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds()); }

  /* ---------- decode + downscale, with cache ---------- */
  // WeakMap<File, Map<sizeKey, Promise<ImageBitmap>>>. Files from a FileList are
  // stable object identities, so the WeakMap keys work and free automatically.
  var cache = new WeakMap();
  function sizeKey(size) { return size == null ? 'native' : String(size); }

  function decodeScaled(file, size) {
    // Fast path: let the browser decode-and-resize in one step.
    var attempt = (size == null)
      ? createImageBitmap(file)
      : createImageBitmap(file, { resizeWidth: size, resizeQuality: 'high' });
    return attempt.catch(function () {
      // Fallback: full decode then canvas downscale (works everywhere).
      return createImageBitmap(file).then(function (full) {
        if (size == null || full.width <= size) return full;
        var scale = size / full.width;
        var w = Math.max(1, Math.round(full.width * scale));
        var h = Math.max(1, Math.round(full.height * scale));
        var c = document.createElement('canvas');
        c.width = w; c.height = h;
        var cx = c.getContext('2d');
        cx.imageSmoothingEnabled = true; cx.imageSmoothingQuality = 'high';
        cx.drawImage(full, 0, 0, w, h);
        if (full.close) full.close();
        return createImageBitmap(c);
      });
    });
  }

  function getBitmap(file, size) {
    var m = cache.get(file);
    if (!m) { m = new Map(); cache.set(file, m); }
    var k = sizeKey(size);
    var p = m.get(k);
    if (!p) { p = decodeScaled(file, size); m.set(k, p); }
    return p;
  }

  // Drop cached decodes for a set of Files (used when overlay layers change a lot).
  function forget(files) {
    (files || []).forEach(function (f) { if (f) cache.delete(f); });
  }

  /* ---------- drawing ---------- */
  // Draw a bitmap centered and letterboxed inside W×H.
  function drawContain(ctx, bmp, W, H) {
    var scale = Math.min(W / bmp.width, H / bmp.height);
    var w = bmp.width * scale, h = bmp.height * scale;
    ctx.drawImage(bmp, (W - w) / 2, (H - h) / 2, w, h);
  }

  // Compose a base bitmap plus ordered layers onto `canvas`. Each layer:
  // { bmp, alpha (0..1), blend (globalCompositeOperation) }. Base is drawn
  // normally; layers use their blend mode. Canvas is sized to `side`×`side`.
  function composeLayers(canvas, side, base, layers, bg) {
    canvas.width = side; canvas.height = side;
    var ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, side, side);
    if (bg) { ctx.fillStyle = bg; ctx.fillRect(0, 0, side, side); }
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    if (base) drawContain(ctx, base, side, side);
    (layers || []).forEach(function (L) {
      if (!L || !L.bmp) return;
      ctx.globalCompositeOperation = L.blend || 'screen';
      ctx.globalAlpha = (L.alpha == null ? 1 : L.alpha);
      drawContain(ctx, L.bmp, side, side);
    });
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }

  var BLEND_MODES = [
    { id: 'screen', label: 'Screen' },
    { id: 'source-over', label: 'Normal' },
    { id: 'lighten', label: 'Lighten' },
    { id: 'multiply', label: 'Multiply' }
  ];

  /* ---------- WebM export ---------- */
  function pickMime() {
    if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return null;
    var cands = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    for (var i = 0; i < cands.length; i++) {
      if (MediaRecorder.isTypeSupported(cands[i])) return cands[i];
    }
    return null;
  }

  function supportsWebM() {
    return typeof MediaRecorder !== 'undefined' &&
      !!HTMLCanvasElement.prototype.captureStream &&
      !!pickMime();
  }

  function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // Record `count` frames from `canvas`. draw(i) paints frame i (may be async).
  // Returns a Promise<Blob> (WebM). onProgress(done,total) optional.
  function recordWebM(canvas, opts) {
    var fps = opts.fps || 8;
    var mime = pickMime();
    if (!mime || !canvas.captureStream) {
      return Promise.reject(new Error('WebM export is not supported in this browser.'));
    }
    var stream = canvas.captureStream(0); // manual frame stepping
    var track = stream.getVideoTracks()[0];
    var rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: opts.bitrate || 16000000 });
    var chunks = [];
    rec.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };

    return new Promise(function (resolve, reject) {
      rec.onerror = function (e) { reject((e && e.error) || new Error('Recorder error')); };
      rec.onstop = function () { resolve(new Blob(chunks, { type: mime })); };
      rec.start();

      var frameDur = 1000 / fps;
      var i = 0;
      function step() {
        if (i >= opts.count) {
          // hold the final frame briefly so players don't clip it
          delay(Math.max(frameDur, 150)).then(function () { rec.stop(); });
          return;
        }
        Promise.resolve(opts.draw(i)).then(function () {
          if (track.requestFrame) track.requestFrame();
          else if (stream.requestFrame) stream.requestFrame();
          if (opts.onProgress) opts.onProgress(i + 1, opts.count);
          i++;
          return delay(frameDur);
        }).then(step).catch(reject);
      }
      step();
    });
  }

  /* ---------- downloads ---------- */
  function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
  }

  function canvasToPng(canvas) {
    return new Promise(function (resolve) { canvas.toBlob(resolve, 'image/png'); });
  }

  GS.imaging = {
    formatDate: formatDate,
    formatClock: formatClock,
    formatUTC: formatUTC,
    stamp: stamp,
    decodeScaled: decodeScaled,
    getBitmap: getBitmap,
    forget: forget,
    drawContain: drawContain,
    composeLayers: composeLayers,
    blendModes: BLEND_MODES,
    supportsWebM: supportsWebM,
    recordWebM: recordWebM,
    downloadBlob: downloadBlob,
    canvasToPng: canvasToPng,
    delay: delay
  };
})(window.GS = window.GS || {});
