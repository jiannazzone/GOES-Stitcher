/*
 * scanner.js — turn a picked folder (a FileList from <input webkitdirectory> or
 * a drag-and-drop) into a structured, in-memory index of everything worth
 * showing. Nothing is uploaded or copied: we only read the lightweight path/name
 * metadata here and keep the File objects for lazy decoding later.
 *
 * Output shape (GS.scanner.scan -> { sessions, stats }):
 *
 *   session -> sat -> region -> product -> frame{ time, variants:{plain,map} }
 *
 * A "session" is any folder that directly contains an IMAGES/ or L2/ subtree, so
 * the user can pick a single session OR a parent folder holding many sessions and
 * we detect each one. IMAGES (composites + raw ABI bands) and L2 (derived
 * products) for the same satellite/region are merged into one region node, with
 * each product tagged by `kind` so the two modes can filter.
 */
(function (GS) {
  'use strict';

  var TIME_DIR_RE = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})$/;
  var CHANNEL_FILE_RE = /^G\d+_([A-Za-z0-9]+)_\d{8}T\d{6}Z$/;

  // Preferred display order for regions; anything else sorts alphabetically after.
  var REGION_ORDER = ['Full Disk', 'Mesoscale 1', 'Mesoscale 2'];

  function parseTimeDir(dir) {
    var m = TIME_DIR_RE.exec(dir);
    if (!m) return null;
    // SatDump timestamps are UTC.
    return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
  }

  // Decide what product a filename represents. Returns null to skip the file.
  function classify(filename, category) {
    if (!/\.png$/i.test(filename)) return null;            // only PNGs here
    if (/ copy(\.| )/i.test(filename) || / copy$/i.test(filename)) return null; // stray dupes

    var base = filename.replace(/\.png$/i, '');
    var variant = 'plain';
    if (/_map$/.test(base)) { variant = 'map'; base = base.slice(0, -4); }

    if (base.toLowerCase().indexOf('abi_rgb_') === 0) {
      var name = base.slice('abi_rgb_'.length).replace(/_/g, ' ').trim();
      if (!name) return null;
      var kind = category === 'L2' ? 'l2' : 'composite';
      return {
        key: kind + '::' + name,
        name: name,
        kind: kind,
        band: null,
        variant: variant
      };
    }

    var cm = CHANNEL_FILE_RE.exec(base);
    if (cm) {
      var tok = cm[1];
      if (/^\d+$/.test(tok)) {                              // numeric ABI band
        var band = parseInt(tok, 10);
        return {
          key: 'channel::' + band,
          name: GS.catalog.bandLabel(band),
          kind: 'channel',
          band: band,
          variant: variant
        };
      }
      // Non-numeric single-band file under L2 (e.g. G19_ACHT) — grayscale
      // duplicate of the colorized abi_rgb_* product. Skip in favor of color.
      return null;
    }

    return null; // unrecognized filename form
  }

  // Locate the "IMAGES"/"L2" boundary and split a webkitRelativePath into parts.
  // Returns null if the path is not a standard SatDump product image.
  function parsePath(relPath) {
    var segs = relPath.split('/');
    var i = -1;
    for (var k = 0; k < segs.length; k++) {
      if (segs[k] === 'IMAGES' || segs[k] === 'L2') { i = k; break; }
    }
    if (i === -1) return null;

    // We require exactly: <category>/<sat>/<region>/<timeDir>/<file>
    if (segs.length - i !== 5) return null;

    var category = segs[i];
    var sat = segs[i + 1];
    var region = segs[i + 2];
    var timeDir = segs[i + 3];
    var filename = segs[i + 4];

    var time = parseTimeDir(timeDir);
    if (!time) return null;

    var sessionSegs = segs.slice(0, i);
    var sessionId = sessionSegs.join('/') || sat; // fall back if picked at root
    var sessionName = sessionSegs.length ? sessionSegs[sessionSegs.length - 1] : sat;

    return {
      sessionId: sessionId,
      sessionName: sessionName,
      category: category,
      sat: sat,
      region: region,
      timeDir: timeDir,
      time: time,
      filename: filename
    };
  }

  function ensure(map, key, make) {
    var v = map.get(key);
    if (!v) { v = make(); map.set(key, v); }
    return v;
  }

  function regionRank(id) {
    var idx = REGION_ORDER.indexOf(id);
    return idx === -1 ? REGION_ORDER.length : idx;
  }

  function kindRank(kind) {
    return kind === 'composite' ? 0 : kind === 'channel' ? 1 : 2; // l2 last
  }

  function satNumber(id) {
    var m = /(\d+)/.exec(id);
    return m ? +m[1] : 9999;
  }

  function scan(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    var sessions = new Map();
    var stats = { total: files.length, used: 0, skipped: 0, sessions: 0 };

    files.forEach(function (file) {
      var rel = file.webkitRelativePath || file.relativePath || file.name;
      var p = parsePath(rel);
      if (!p) { stats.skipped++; return; }
      var c = classify(p.filename, p.category);
      if (!c) { stats.skipped++; return; }

      var session = ensure(sessions, p.sessionId, function () {
        return { id: p.sessionId, name: p.sessionName, sats: new Map() };
      });
      var sat = ensure(session.sats, p.sat, function () {
        return { id: p.sat, label: GS.catalog.satelliteLabel(p.sat), regions: new Map() };
      });
      var region = ensure(sat.regions, p.region, function () {
        return { id: p.region, products: new Map() };
      });
      var product = ensure(region.products, c.key, function () {
        return {
          key: c.key, name: c.name, kind: c.kind, category: p.category,
          band: c.band, blurb: GS.catalog.productBlurb(c.name), frames: new Map()
        };
      });
      var frame = ensure(product.frames, p.timeDir, function () {
        return { time: p.time, timeKey: p.timeDir, variants: {} };
      });
      frame.variants[c.variant] = file;
      stats.used++;
    });

    // Freeze maps into sorted arrays and compute per-node summaries.
    var sessionArr = [];
    sessions.forEach(function (session) {
      var satArr = [];
      session.sats.forEach(function (sat) {
        var regionArr = [];
        sat.regions.forEach(function (region) {
          var prodArr = [];
          region.products.forEach(function (product) {
            var frameArr = [];
            product.frames.forEach(function (f) {
              f.label = GS.imaging.formatClock(f.time);
              f.hasMap = !!f.variants.map;
              f.hasPlain = !!f.variants.plain;
              frameArr.push(f);
            });
            frameArr.sort(function (a, b) { return a.time - b.time; });
            product.frames = frameArr;
            product.hasMap = frameArr.some(function (f) { return f.hasMap; });
            product.hasPlain = frameArr.some(function (f) { return f.hasPlain; });
            product.start = frameArr.length ? frameArr[0].time : null;
            product.end = frameArr.length ? frameArr[frameArr.length - 1].time : null;
            prodArr.push(product);
          });
          prodArr.sort(function (a, b) {
            var kr = kindRank(a.kind) - kindRank(b.kind);
            if (kr) return kr;
            if (a.band != null && b.band != null) return a.band - b.band;
            return a.name.localeCompare(b.name);
          });
          region.products = prodArr;
          region.l2 = prodArr.filter(function (p) { return p.kind === 'l2'; });
          region.hasL2 = region.l2.length > 0;
          // Longest single-product time series in the region — i.e. how many
          // scans the most-frequently-captured product has (its animatable length).
          region.maxFrames = prodArr.reduce(function (m, p) { return Math.max(m, p.frames.length); }, 0);
          regionArr.push(region);
        });
        regionArr.sort(function (a, b) {
          var rr = regionRank(a.id) - regionRank(b.id);
          return rr || a.id.localeCompare(b.id);
        });
        sat.regions = regionArr;
        satArr.push(sat);
      });
      satArr.sort(function (a, b) { return satNumber(a.id) - satNumber(b.id) || a.id.localeCompare(b.id); });
      session.sats = satArr;
      sessionArr.push(session);
    });
    sessionArr.sort(function (a, b) { return a.name.localeCompare(b.name); });

    stats.sessions = sessionArr.length;
    return { sessions: sessionArr, stats: stats };
  }

  GS.scanner = { scan: scan, parsePath: parsePath, classify: classify };
})(window.GS = window.GS || {});
