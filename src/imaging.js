/*
 * imaging.js — all the pixel work, kept in one place so the two modes stay thin.
 *
 * Responsibilities:
 *   - UTC time formatting helpers (shared by the scanner and the UI)
 *   - decode + downscale PNGs to ImageBitmaps (memory-bounded), with a per-File
 *     cache and a canvas fallback for browsers whose createImageBitmap ignores
 *     resize options (older Safari)
 *   - draw-to-fit and layer compositing on a 2D canvas
 *   - video export: WebCodecs H.264 -> MP4 (via the vendored mp4-muxer), with a
 *     MediaRecorder fallback (prefers MP4, else WebM) for browsers without WebCodecs
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

  /* ---------- video export ----------
     Primary: WebCodecs VideoEncoder (H.264) muxed to MP4 by the vendored
     mp4-muxer — a real, universally-playable file, encoded deterministically
     frame-by-frame (no realtime-capture jitter on large frames). Fallback:
     MediaRecorder, preferring an MP4 mime type, else WebM.

     The export API is `exportVideo(opts)`:
       opts.count       number of frames
       opts.fps         frames per second
       opts.render(i)   paints frame i and returns a source <canvas>
       opts.onProgress  (done, total) optional
       opts.maxDim      cap on encode dimension (default 2048; H.264 can't do
                        native full-disk 5424²)
     Resolves { blob, ext, mime, encoder }. */

  function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function even(n) { n = Math.round(n); return Math.max(2, n - (n % 2)); }

  function hasWebCodecs() {
    return typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined' &&
      (typeof window === 'undefined' || window.isSecureContext !== false) &&
      !!(window.Mp4Muxer && window.Mp4Muxer.Muxer);
  }
  function pickMediaMime() {
    if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return null;
    var cands = ['video/mp4;codecs=avc1.640028', 'video/mp4',
      'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    for (var i = 0; i < cands.length; i++) if (MediaRecorder.isTypeSupported(cands[i])) return cands[i];
    return null;
  }
  function hasMediaRecorder() {
    return typeof MediaRecorder !== 'undefined' && !!HTMLCanvasElement.prototype.captureStream && !!pickMediaMime();
  }
  // Any client-side video export at all (used to enable the button).
  function supportsVideoExport() { return hasWebCodecs() || hasMediaRecorder(); }
  // Specifically true when the output will be a real MP4 (used for UI copy).
  function supportsMp4() { var m = pickMediaMime() || ''; return hasWebCodecs() || m.indexOf('video/mp4') === 0; }

  function bitrateFor(W, H, fps) {
    return Math.min(48000000, Math.max(6000000, Math.round(W * H * fps * 0.4)));
  }
  // First supported H.264 codec string for W×H@fps, preferring High then Main.
  function chooseAvc(W, H, fps, bitrate) {
    var cands = ['avc1.640033', 'avc1.4D0033', 'avc1.640028', 'avc1.4D0028', 'avc1.42E01E'];
    var i = 0;
    function next() {
      if (i >= cands.length) return Promise.resolve(null);
      var c = cands[i++];
      return VideoEncoder.isConfigSupported({ codec: c, width: W, height: H, bitrate: bitrate, framerate: fps, avc: { format: 'avc' } })
        .then(function (s) { return (s && s.supported) ? c : next(); })
        .catch(function () { return next(); });
    }
    return next();
  }

  // WebCodecs H.264 -> MP4.
  function encodeMp4(opts) {
    var fps = opts.fps || 8, count = opts.count, maxDim = opts.maxDim || 2048;
    var src0 = opts.render(0);
    var srcMax = Math.max(src0.width, src0.height);
    var W, H, codec, bitrate, dim = Math.min(srcMax, maxDim);
    function findCodec() {
      if (dim < 128) return Promise.resolve(false);
      W = even(src0.width * dim / srcMax); H = even(src0.height * dim / srcMax);
      bitrate = bitrateFor(W, H, fps);
      return chooseAvc(W, H, fps, bitrate).then(function (c) {
        if (c) { codec = c; return true; }
        dim = Math.floor(dim * 0.75); return findCodec();
      });
    }
    return findCodec().then(function (ok) {
      if (!ok) throw new Error('no supported H.264 configuration for these dimensions');
      var muxer = new window.Mp4Muxer.Muxer({
        target: new window.Mp4Muxer.ArrayBufferTarget(),
        video: { codec: 'avc', width: W, height: H }, fastStart: 'in-memory'
      });
      var encErr = null;
      var enc = new VideoEncoder({
        output: function (chunk, meta) { muxer.addVideoChunk(chunk, meta); },
        error: function (e) { encErr = e; }
      });
      enc.configure({ codec: codec, width: W, height: H, bitrate: bitrate, framerate: fps, avc: { format: 'avc' } });

      var encCv = document.createElement('canvas'); encCv.width = W; encCv.height = H;
      var ex = encCv.getContext('2d');
      var us = 1000000 / fps, gop = Math.max(1, Math.round(fps * 2)), i = 0;
      function pump() {
        if (encErr) return Promise.reject(encErr);
        if (i >= count) return Promise.resolve();
        ex.clearRect(0, 0, W, H);
        ex.drawImage(opts.render(i), 0, 0, W, H);
        var frame = new VideoFrame(encCv, { timestamp: Math.round(us * i), duration: Math.round(us) });
        enc.encode(frame, { keyFrame: (i % gop) === 0 });
        frame.close();
        if (opts.onProgress) opts.onProgress(i + 1, count);
        i++;
        return (enc.encodeQueueSize > 8 ? delay(0) : Promise.resolve()).then(pump);
      }
      return pump().then(function () { return enc.flush(); }).then(function () {
        if (encErr) throw encErr;
        muxer.finalize();
        return { blob: new Blob([muxer.target.buffer], { type: 'video/mp4' }), ext: 'mp4', mime: 'video/mp4', encoder: 'H.264 / MP4' };
      });
    });
  }

  // MediaRecorder fallback (prefers MP4, else WebM), captured in realtime.
  function recordMedia(opts) {
    var fps = opts.fps || 8, count = opts.count, mime = pickMediaMime();
    if (!mime) return Promise.reject(new Error('no MediaRecorder video support'));
    var src0 = opts.render(0);
    var cv = document.createElement('canvas'); cv.width = src0.width; cv.height = src0.height;
    var cx = cv.getContext('2d');
    var stream = cv.captureStream(0), track = stream.getVideoTracks()[0];
    var rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: opts.bitrate || bitrateFor(cv.width, cv.height, fps) });
    var chunks = [];
    rec.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
    var isMp4 = mime.indexOf('video/mp4') === 0;
    return new Promise(function (resolve, reject) {
      rec.onerror = function (e) { reject((e && e.error) || new Error('Recorder error')); };
      rec.onstop = function () {
        resolve({ blob: new Blob(chunks, { type: mime }), ext: isMp4 ? 'mp4' : 'webm', mime: mime, encoder: isMp4 ? 'MP4 (MediaRecorder)' : 'WebM' });
      };
      rec.start();
      var frameDur = 1000 / fps, i = 0;
      function step() {
        if (i >= count) { delay(Math.max(frameDur, 150)).then(function () { rec.stop(); }); return; }
        cx.clearRect(0, 0, cv.width, cv.height);
        cx.drawImage(opts.render(i), 0, 0, cv.width, cv.height);
        if (track.requestFrame) track.requestFrame(); else if (stream.requestFrame) stream.requestFrame();
        if (opts.onProgress) opts.onProgress(i + 1, count);
        i++;
        delay(frameDur).then(step);
      }
      step();
    });
  }

  function exportVideo(opts) {
    if (hasWebCodecs()) {
      return encodeMp4(opts).catch(function (e) {
        if (hasMediaRecorder()) return recordMedia(opts); // last-ditch if WebCodecs config fails
        throw e;
      });
    }
    if (hasMediaRecorder()) return recordMedia(opts);
    return Promise.reject(new Error('Video export is not supported in this browser.'));
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

  /* ---------- store-only ZIP (batch export) ----------
     Bundles already-compressed files (MP4s) with no compression, so one download
     delivers many clips. STORE method only — no deflate — which keeps it tiny and
     dependency-free. Not ZIP64: fine well below 4 GB / 65k files. */
  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(buf) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function localHeader(nameBytes, crc, size) {
    var h = new Uint8Array(30 + nameBytes.length), v = new DataView(h.buffer);
    v.setUint32(0, 0x04034b50, true); v.setUint16(4, 20, true); v.setUint16(6, 0x0800, true);
    v.setUint16(8, 0, true); v.setUint16(10, 0, true); v.setUint16(12, 0x21, true);
    v.setUint32(14, crc, true); v.setUint32(18, size, true); v.setUint32(22, size, true);
    v.setUint16(26, nameBytes.length, true); v.setUint16(28, 0, true);
    h.set(nameBytes, 30); return h;
  }
  function centralHeader(nameBytes, crc, size, offset) {
    var h = new Uint8Array(46 + nameBytes.length), v = new DataView(h.buffer);
    v.setUint32(0, 0x02014b50, true); v.setUint16(4, 20, true); v.setUint16(6, 20, true);
    v.setUint16(8, 0x0800, true); v.setUint16(10, 0, true); v.setUint16(12, 0, true);
    v.setUint16(14, 0x21, true); v.setUint32(16, crc, true); v.setUint32(20, size, true);
    v.setUint32(24, size, true); v.setUint16(28, nameBytes.length, true);
    v.setUint16(30, 0, true); v.setUint16(32, 0, true); v.setUint16(34, 0, true);
    v.setUint16(36, 0, true); v.setUint32(38, 0, true); v.setUint32(42, offset, true);
    h.set(nameBytes, 46); return h;
  }
  function eocd(n, cdSize, cdOffset) {
    var h = new Uint8Array(22), v = new DataView(h.buffer);
    v.setUint32(0, 0x06054b50, true); v.setUint16(4, 0, true); v.setUint16(6, 0, true);
    v.setUint16(8, n, true); v.setUint16(10, n, true); v.setUint32(12, cdSize, true);
    v.setUint32(16, cdOffset, true); v.setUint16(20, 0, true); return h;
  }
  function blobBytes(blob) {
    return blob.arrayBuffer ? blob.arrayBuffer() : new Response(blob).arrayBuffer();
  }
  // entries: [{ name, blob }] -> Promise<Blob> (application/zip)
  function zipStore(entries) {
    var enc = new TextEncoder();
    return Promise.all(entries.map(function (e) {
      return blobBytes(e.blob).then(function (ab) { return { name: enc.encode(e.name), data: new Uint8Array(ab) }; });
    })).then(function (items) {
      var chunks = [], central = [], offset = 0, i;
      for (i = 0; i < items.length; i++) {
        var it = items[i], crc = crc32(it.data), size = it.data.length, lh = localHeader(it.name, crc, size);
        chunks.push(lh, it.data);
        central.push(centralHeader(it.name, crc, size, offset));
        offset += lh.length + size;
      }
      var cdOffset = offset, cdSize = 0;
      for (i = 0; i < central.length; i++) { chunks.push(central[i]); cdSize += central[i].length; }
      chunks.push(eocd(items.length, cdSize, cdOffset));
      return new Blob(chunks, { type: 'application/zip' });
    });
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
    supportsVideoExport: supportsVideoExport,
    supportsMp4: supportsMp4,
    exportVideo: exportVideo,
    downloadBlob: downloadBlob,
    canvasToPng: canvasToPng,
    zipStore: zipStore,
    delay: delay
  };
})(window.GS = window.GS || {});
