/*
 * scanner.js — turn a picked folder (a FileList from <input webkitdirectory> or
 * a drag-and-drop) into a structured, in-memory index of everything worth
 * showing. Nothing is uploaded or copied: we only read the lightweight path/name
 * metadata here and keep the File objects for lazy decoding later.
 *
 * Output shape (GS.scanner.scan -> { runs, primarySat, defaultRun, stats }):
 *
 *   run -> sat -> region -> product -> frame{ time, variants:{plain,map} }
 *
 * SatDump writes a NEW session folder each time the receiver starts, so a whole
 * day is split across folders (and a folder may sit next to unrelated days). We
 * ignore folder boundaries: every file is merged into ONE sat/region/product tree
 * (deduped by scan time + variant), then the timeline is segmented into RECEPTION
 * RUNS — maximal stretches where consecutive scans are within BREAK_MS. A run is
 * one continuous "receiver was on" window: two adjacent folders that form a
 * contiguous capture become one run, while day-apart captures split. The
 * satellite you actually receive (the one with the most scans) is the 'primary';
 * anything else (e.g. GOES-18's hourly Band-13 relay carried on a GOES-19
 * downlink) is a sparse 'relayed' passenger, attributed to a run purely by
 * timestamp — we never model the relay schedule. IMAGES (composites + raw ABI
 * bands) and L2 (derived products) for the same satellite/region are merged into
 * one region node, with each product tagged by `kind` so the modes can filter.
 */
(function (GS) {
  'use strict';

  var TIME_DIR_RE = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})$/;
  var CHANNEL_FILE_RE = /^G\d+_([A-Za-z0-9]+)_\d{8}T\d{6}Z$/;

  // Preferred display order for regions; anything else sorts alphabetically after.
  var REGION_ORDER = ['Full Disk', 'Mesoscale 1', 'Mesoscale 2'];

  // Reception-run break: a gap in EVERY product at once longer than this starts a
  // new run. Day-boundary gaps are hours; the largest within-capture gap seen is
  // ~20 min, so 2 h sits safely between and can't over-merge sparse captures.
  var BREAK_MS = 120 * 60 * 1000;

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
      var rawName = base.slice('abi_rgb_'.length).replace(/_/g, ' ').trim();
      if (!rawName) return null;
      var kind = category === 'L2' ? 'l2' : 'composite';
      // Key off the RAW name so two distinct products never merge, even if their
      // cleaned display names happen to coincide.
      return {
        key: kind + '::' + rawName,
        name: GS.catalog.displayName(rawName),
        rawName: rawName,
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
  // Returns null if the path is not a standard SatDump product image. Folder
  // boundaries above IMAGES/L2 are intentionally ignored — runs come from scan
  // times, not folders.
  function parsePath(relPath) {
    var segs = relPath.split('/');
    var i = -1;
    for (var k = 0; k < segs.length; k++) {
      if (segs[k] === 'IMAGES' || segs[k] === 'L2') { i = k; break; }
    }
    if (i === -1) return null;

    // We require exactly: <category>/<sat>/<region>/<timeDir>/<file>
    if (segs.length - i !== 5) return null;

    var timeDir = segs[i + 3];
    var time = parseTimeDir(timeDir);
    if (!time) return null;

    return {
      category: segs[i],
      sat: segs[i + 1],
      region: segs[i + 2],
      timeDir: timeDir,
      time: time,
      filename: segs[i + 4]
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

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function hhmm(d) { return pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()); }

  // Human label for a reception run, e.g. "2026-07-04 · 16:30–18:37Z · 24 scans"
  // (or a "date time → date time" form when the run crosses a UTC day).
  function runLabel(start, end, count) {
    var sd = GS.imaging.formatDate(start), ed = GS.imaging.formatDate(end);
    var span = (sd === ed)
      ? sd + ' · ' + hhmm(start) + '–' + hhmm(end) + 'Z'
      : sd + ' ' + hhmm(start) + 'Z → ' + ed + ' ' + hhmm(end) + 'Z';
    return span + ' · ' + count + ' scan' + (count === 1 ? '' : 's');
  }

  // Split an ASCENDING array of scan-time ms into reception runs: any gap larger
  // than breakMs starts a new run. Pure and deterministic. Returns [{startMs,endMs}].
  function detectRuns(sortedTimes, breakMs) {
    if (!sortedTimes || !sortedTimes.length) return [];
    breakMs = breakMs || BREAK_MS;
    var runs = [];
    var start = sortedTimes[0], prev = sortedTimes[0];
    for (var i = 1; i < sortedTimes.length; i++) {
      if (sortedTimes[i] - prev > breakMs) { runs.push({ startMs: start, endMs: prev }); start = sortedTimes[i]; }
      prev = sortedTimes[i];
    }
    runs.push({ startMs: start, endMs: prev });
    return runs;
  }

  // Freeze a Map(satId -> {id,label,regions:Map}) into a sorted sat[] with each
  // node's frames sorted and per-node summaries computed.
  function freezeSats(satMap) {
    var satArr = [];
    satMap.forEach(function (sat) {
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
    return satArr;
  }

  // Build a run's frozen sat[] by copying only the frames of the merged tree that
  // fall inside [startMs, endMs]. Fresh product/region/sat nodes each call; frame
  // objects are shared (each frame lands in exactly one run, except the span-gaps
  // run which reuses them read-only).
  function materializeRun(mergedSats, startMs, endMs) {
    var satMap = new Map();
    mergedSats.forEach(function (sat) {
      var regions = new Map();
      sat.regions.forEach(function (region) {
        var products = new Map();
        region.products.forEach(function (product) {
          var frames = new Map();
          product.frames.forEach(function (frame, timeKey) {
            var t = frame.time.getTime();
            if (t >= startMs && t <= endMs) frames.set(timeKey, frame);
          });
          if (frames.size) {
            products.set(product.key, {
              key: product.key, name: product.name, rawName: product.rawName, kind: product.kind,
              category: product.category, band: product.band, blurb: product.blurb, frames: frames
            });
          }
        });
        if (products.size) regions.set(region.id, { id: region.id, products: products });
      });
      if (regions.size) satMap.set(sat.id, { id: sat.id, label: sat.label, regions: regions });
    });
    return freezeSats(satMap);
  }

  function scan(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    var stats = { total: files.length, used: 0, skipped: 0, runs: 0 };

    // 1. Merge every file into ONE sat -> region -> product -> frame tree, unioning
    //    across all session folders and deduping frames by (timeKey, variant).
    var mergedSats = new Map();
    var allTimesSet = new Set();   // distinct scan-time ms across everything
    var satTimes = new Map();      // sat id -> Set(ms), for primary detection

    files.forEach(function (file) {
      var rel = file.webkitRelativePath || file.relativePath || file.name;
      var p = parsePath(rel);
      if (!p) { stats.skipped++; return; }
      var c = classify(p.filename, p.category);
      if (!c) { stats.skipped++; return; }

      var sat = ensure(mergedSats, p.sat, function () {
        return { id: p.sat, label: GS.catalog.satelliteLabel(p.sat), regions: new Map() };
      });
      var region = ensure(sat.regions, p.region, function () {
        return { id: p.region, products: new Map() };
      });
      var product = ensure(region.products, c.key, function () {
        return {
          key: c.key, name: c.name, rawName: c.rawName || c.name, kind: c.kind, category: p.category,
          band: c.band, blurb: GS.catalog.productBlurb(c.name), frames: new Map()
        };
      });
      var frame = ensure(product.frames, p.timeDir, function () {
        return { time: p.time, timeKey: p.timeDir, variants: {} };
      });
      if (!frame.variants[c.variant]) frame.variants[c.variant] = file; // dedupe: first file wins

      allTimesSet.add(p.time.getTime());
      var st = satTimes.get(p.sat);
      if (!st) { st = new Set(); satTimes.set(p.sat, st); }
      st.add(p.time.getTime());
      stats.used++;
    });

    var allTimes = Array.from(allTimesSet).sort(function (a, b) { return a - b; });
    if (!allTimes.length) { return { runs: [], primarySat: null, defaultRun: 0, stats: stats }; }

    // 2. Primary satellite = the downlink you actually receive (most distinct scan
    //    times). Everything else is a sparse 'relayed' passenger.
    var primarySat = null, best = -1;
    satTimes.forEach(function (set, id) { if (set.size > best) { best = set.size; primarySat = id; } });

    // 3. Segment into reception runs on the union of all scan times (a gap in
    //    EVERYTHING at once is the only true "receiver off"), then materialize each.
    function buildRun(startMs, endMs, spanGaps) {
      var sats = materializeRun(mergedSats, startMs, endMs);
      sats.forEach(function (s) { s.role = (s.id === primarySat) ? 'primary' : 'relayed'; });
      sats.sort(function (a, b) {
        var d = (a.role === 'primary' ? 0 : 1) - (b.role === 'primary' ? 0 : 1);
        return d || (satNumber(a.id) - satNumber(b.id)) || a.id.localeCompare(b.id);
      });
      var count = 0;
      for (var i = 0; i < allTimes.length; i++) if (allTimes[i] >= startMs && allTimes[i] <= endMs) count++;
      return {
        id: spanGaps ? 'run-all' : 'run-' + startMs,
        start: new Date(startMs), end: new Date(endMs),
        scanCount: count, spanGaps: !!spanGaps,
        name: spanGaps ? ('All · span gaps · ' + count + ' scans')
                       : runLabel(new Date(startMs), new Date(endMs), count),
        sats: sats
      };
    }

    var windows = detectRuns(allTimes, BREAK_MS);
    var realRuns = windows.map(function (w) { return buildRun(w.startMs, w.endMs, false); });
    realRuns.sort(function (a, b) { return b.start - a.start; }); // newest first

    // 4. Default = most recent "substantial" run (>=3 scans); else the largest.
    var defaultRun = 0, found = false;
    for (var i = 0; i < realRuns.length; i++) { if (realRuns[i].scanCount >= 3) { defaultRun = i; found = true; break; } }
    if (!found) { var mx = -1; realRuns.forEach(function (r, i) { if (r.scanCount > mx) { mx = r.scanCount; defaultRun = i; } }); }

    // 5. Escape hatch: one merged timeline that spans gaps (only meaningful >1 run).
    var runs = realRuns;
    if (realRuns.length > 1) {
      runs = realRuns.concat([buildRun(allTimes[0], allTimes[allTimes.length - 1], true)]);
    }

    stats.runs = realRuns.length;
    return { runs: runs, primarySat: primarySat, defaultRun: defaultRun, stats: stats };
  }

  GS.scanner = { scan: scan, parsePath: parsePath, classify: classify, detectRuns: detectRuns };
})(window.GS = window.GS || {});
