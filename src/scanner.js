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

  // EMWIN imagery filename (WMO/EMWIN convention), e.g.
  //   Z_QATA00KWBC080245_C_KWIN_20260708144607_477813-3-RADREFUS.GIF
  // The reliable frame time is the full ISO stamp after "_KWIN_" (the WMO header
  // DDHHMM is nominal, not reception); the trailing token is the product code —
  // the SERIES key (same chart, over and over). Captures: [1]=YYYYMMDDHHMMSS,
  // [2]=product code.
  var EMWIN_IMG_RE = /_KWIN_(\d{14})_\d+-\d+-([A-Za-z0-9]+)\.(?:gif|jpe?g|png)$/i;

  // An EMWIN image product must recur at least this many times to count as a
  // series worth animating; sparse one-offs (admin charts, occasional satellite
  // pictures) are dropped. The natural gap in a full-day capture is wide (radar
  // mosaics ~40 frames vs one-offs <10), so this sits comfortably between.
  var MIN_EMWIN_FRAMES = 10;

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

  // "20260708144607" (UTC) -> Date. EMWIN stamps carry no zone; they are UTC.
  function parseEmwinStamp(s) {
    return new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8),
      +s.slice(8, 10), +s.slice(10, 12), +s.slice(12, 14)));
  }

  // Decide what product a filename represents. Returns null to skip the file.
  function classify(filename, category) {
    // EMWIN imagery (GIF/JPG/PNG) keys off the trailing product code, not the
    // ABI filename forms below. One variant only — there is no coastline overlay.
    if (category === 'EMWIN') {
      var em = EMWIN_IMG_RE.exec(filename);
      if (!em) return null;
      var code = em[2].toUpperCase();
      return {
        key: 'emwin::' + code,
        name: GS.catalog.emwinName(code),
        rawName: code, code: code,
        kind: 'emwin', band: null, variant: 'plain'
      };
    }

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

    // EMWIN branch: a file anywhere under an "EMWIN" folder whose name is an EMWIN
    // image. There is no sat/region/timeDir subtree — the filename carries the
    // time and series — so we synthesize the tree: a single synthetic "EMWIN"
    // satellite, and a region by broad family (radar mosaics vs. everything else).
    var hasEmwin = false;
    for (var e = 0; e < segs.length; e++) { if (/^EMWIN$/i.test(segs[e])) { hasEmwin = true; break; } }
    if (hasEmwin) {
      var em = EMWIN_IMG_RE.exec(segs[segs.length - 1]);
      // Only CLAIM the file if it's actually an EMWIN image; otherwise fall through
      // to the IMAGES/L2 logic below, so a stray non-image (or an ABI tree that
      // happens to sit under a folder named "EMWIN") isn't silently dropped.
      if (em) {
        var stamp = em[1], code = em[2].toUpperCase();
        // EMWIN retransmits some charts a few seconds apart for reliability; key the
        // frame by the MINUTE (not second) so a retransmit dedupes to one frame
        // instead of stuttering the animation. Cadence is ~15 min, so distinct
        // frames never share a minute. The kept frame keeps its true (second) time.
        return {
          category: 'EMWIN', sat: 'EMWIN',
          region: /^RAD/.test(code) ? 'Radar Mosaics' : 'EMWIN',
          timeDir: stamp.slice(0, 12), time: parseEmwinStamp(stamp),
          filename: segs[segs.length - 1], code: code
        };
      }
    }

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

  // "2h 7m" / "53m" — floored to whole minutes so it agrees with the HH:MM span.
  function humanDur(ms) {
    var mins = Math.max(0, Math.floor(ms / 60000));
    if (mins < 60) return mins + 'm';
    var h = Math.floor(mins / 60), m = mins % 60;
    return m ? (h + 'h ' + m + 'm') : (h + 'h');
  }

  // Human label for a reception run, e.g. "2026-07-04 · 16:30–18:37Z · 2h 7m"
  // (or a "date time → date time" form when the run crosses a UTC day). We show
  // the run's time SPAN + duration — not a scan count — because a run aggregates
  // products of different cadence, so no single number is the animation length
  // (that's the per-product ×N in the base list). A single-instant run shows just
  // its time.
  function runLabel(start, end) {
    var sd = GS.imaging.formatDate(start), ed = GS.imaging.formatDate(end);
    if (start.getTime() === end.getTime()) return sd + ' · ' + hhmm(start) + 'Z';
    var span = (sd === ed)
      ? sd + ' · ' + hhmm(start) + '–' + hhmm(end) + 'Z'
      : sd + ' ' + hhmm(start) + 'Z → ' + ed + ' ' + hhmm(end) + 'Z';
    return span + ' · ' + humanDur(end - start);
  }

  /* ---- Mesoscale sector location (from product.cbor) ----
     Mesoscale 1/2 are just SLOT numbers, not places — operators steer the two
     sectors at storms, so "Mesoscale 1" is a different geography on different
     days. Every SatDump timestamp folder ships a product.cbor whose
     projection_cfg carries the geostationary crop position; we read it to key
     each meso frame by WHERE it looked, so stitching never splices locations. */

  // Minimal CBOR decoder (maps/arrays/strings/ints/floats), DataView-based so it
  // runs unchanged in the browser and in Node. Enough for SatDump's product.cbor.
  function decodeCbor(ab) {
    var dv = new DataView(ab), u8 = new Uint8Array(ab), pos = 0, td = new TextDecoder();
    function rU(n) { var v = 0; for (var i = 0; i < n; i++) v = v * 256 + u8[pos++]; return v; }
    function f16(h) { var s = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 0x1f, m = h & 0x3ff;
      if (e === 0) return s * Math.pow(2, -14) * (m / 1024);
      if (e === 31) return m ? NaN : s * Infinity;
      return s * Math.pow(2, e - 15) * (1 + m / 1024); }
    function dec() {
      var ib = u8[pos++], major = ib >> 5, info = ib & 0x1f;
      if (major === 7) {
        if (info === 20) return false; if (info === 21) return true;
        if (info === 22 || info === 23) return null;
        if (info === 25) { var h = dv.getUint16(pos); pos += 2; return f16(h); }
        if (info === 26) { var f = dv.getFloat32(pos); pos += 4; return f; }
        if (info === 27) { var d = dv.getFloat64(pos); pos += 8; return d; }
        return null;
      }
      var len;
      if (info < 24) len = info; else if (info === 24) len = u8[pos++]; else if (info === 25) len = rU(2);
      else if (info === 26) len = rU(4); else if (info === 27) len = rU(8); else len = 0;
      if (major === 0) return len;
      if (major === 1) return -1 - len;
      if (major === 2) { var b = u8.subarray(pos, pos + len); pos += len; return b; }
      if (major === 3) { var s = td.decode(u8.subarray(pos, pos + len)); pos += len; return s; }
      if (major === 4) { var a = []; for (var i = 0; i < len; i++) a.push(dec()); return a; }
      if (major === 5) { var o = {}; for (var j = 0; j < len; j++) { var k = dec(); o[k] = dec(); } return o; }
      if (major === 6) return dec();
    }
    return dec();
  }

  // GOES-R fixed-grid inverse: scan angles (rad) -> lat/lon (deg). Validated
  // against SatDump's coastline overlay (Chesapeake sector -> 38.2N 76.0W).
  var REQ = 6378137, RPOL = 6356752.31414;
  function invGeos(x, y, lon0, altitude) {
    var H = altitude + REQ, r2 = (REQ * REQ) / (RPOL * RPOL);
    var cx = Math.cos(x), sx = Math.sin(x), cy = Math.cos(y), sy = Math.sin(y);
    var a = sx * sx + cx * cx * (cy * cy + r2 * sy * sy);
    var b = -2 * H * cx * cy, c = H * H - REQ * REQ;
    var disc = b * b - 4 * a * c; if (disc < 0) return null;
    var rs = (-b - Math.sqrt(disc)) / (2 * a);
    var Sx = rs * cx * cy, Sy = -rs * sx, Sz = rs * cx * sy;
    return {
      lat: Math.atan(r2 * Sz / Math.sqrt((H - Sx) * (H - Sx) + Sy * Sy)) * 180 / Math.PI,
      lon: (lon0 * Math.PI / 180 - Math.atan2(Sy, H - Sx)) * 180 / Math.PI
    };
  }

  // projection_cfg -> { posKey, lat, lon } for the crop CENTER, or null. In
  // SatDump's cfg, pixel (0,0) maps to (offset_x, offset_y) and each pixel steps
  // by (scalar_x, scalar_y) meters, so the center is offset + (w/2,h/2)*scalar.
  function cfgToPos(cfg) {
    if (!cfg || cfg.type !== 'geos' || cfg.offset_x == null || cfg.scalar_x == null) return null;
    var alt = cfg.altitude || 35786023;
    var cx = cfg.offset_x + (cfg.width / 2) * cfg.scalar_x;
    var cy = cfg.offset_y + (cfg.height / 2) * cfg.scalar_y;
    var ll = invGeos(cx / alt, cy / alt, cfg.lon0 || 0, alt);
    if (!ll || !isFinite(ll.lat) || !isFinite(ll.lon)) return null;
    // key on the corner rounded to the km — identical within a run, distinct across moves.
    return { posKey: Math.round(cfg.offset_x / 1000) + ',' + Math.round(cfg.offset_y / 1000), lat: ll.lat, lon: ll.lon };
  }

  function latlonLabel(c) {
    return Math.abs(c.lat).toFixed(1) + '°' + (c.lat >= 0 ? 'N' : 'S') + ' ' +
           Math.abs(c.lon).toFixed(1) + '°' + (c.lon >= 0 ? 'E' : 'W');
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
        // A region is single-kind by construction (EMWIN never mixes with ABI); tag
        // it once here so the view reads region.kind instead of re-sniffing products.
        region.kind = prodArr.some(function (p) { return p.kind === 'emwin'; }) ? 'emwin' : 'abi';
        // Display name: a roving meso sector shows WHERE it looked, not just its slot.
        region.label = region.slot + (region.center ? ' · ' + latlonLabel(region.center) : '');
        regionArr.push(region);
      });
      regionArr.sort(function (a, b) {
        var rr = regionRank(a.slot) - regionRank(b.slot);
        if (rr) return rr;
        if (a.center && b.center) return (b.center.lat - a.center.lat) || (a.center.lon - b.center.lon);
        return a.id.localeCompare(b.id);
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
      sat.regions.forEach(function (region, regionKey) {
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
        // Key by the merged region key (slot|position), so a meso sector that
        // moved stays two separate regions in the span-gaps run.
        if (products.size) regions.set(regionKey, { id: region.id, slot: region.slot, center: region.center, products: products });
      });
      if (regions.size) satMap.set(sat.id, { id: sat.id, label: sat.label, regions: regions });
    });
    return freezeSats(satMap);
  }

  // scan() is async: mesoscale sector positions live in each folder's
  // product.cbor, which we read (async) before building the index so meso
  // regions can be keyed by geography. Non-meso datasets resolve with no reads.
  function scan(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    var stats = { total: files.length, used: 0, skipped: 0, runs: 0 };

    // Index product.cbor by its folder; note which folders hold meso frames.
    var cborByFolder = new Map();
    var mesoFolders = new Set();
    files.forEach(function (file) {
      var rel = file.webkitRelativePath || file.relativePath || file.name;
      var slash = rel.lastIndexOf('/');
      var folder = slash >= 0 ? rel.slice(0, slash) : '';
      if (/product\.cbor$/i.test(rel)) { cborByFolder.set(folder, file); return; }
      var p = parsePath(rel);
      if (p && /^Mesoscale/i.test(p.region)) mesoFolders.add(folder);
    });

    // Read each meso folder's cbor for the sector center (async, in parallel).
    var posByFolder = new Map();
    var reads = [];
    mesoFolders.forEach(function (folder) {
      var cbor = cborByFolder.get(folder);
      if (!cbor || typeof cbor.arrayBuffer !== 'function') return;
      reads.push(cbor.arrayBuffer().then(function (ab) {
        try { var pos = cfgToPos((decodeCbor(ab) || {}).projection_cfg); if (pos) posByFolder.set(folder, pos); }
        catch (e) { /* unreadable cbor: the sector just keeps its slot label */ }
      }).catch(function () {}));
    });

    return Promise.all(reads).then(function () { return buildIndex(files, posByFolder, stats); });
  }

  function buildIndex(files, posByFolder, stats) {
    // 1. Merge every file into ONE sat -> region -> product -> frame tree, unioning
    //    across all session folders and deduping frames by (timeKey, variant).
    var mergedSats = new Map();
    var allTimesSet = new Set();   // distinct scan-time ms across everything
    var satTimes = new Map();      // sat id -> Set(ms), for primary detection

    // EMWIN one-offs aren't worth animating: keep only product codes that recur at
    // least MIN_EMWIN_FRAMES times across the whole capture. Counted up-front so a
    // dropped series' sparse timestamps never enter the merge or the run timeline.
    // We count DISTINCT MINUTES (p.timeDir) — the same key the frames dedupe on —
    // so reliability retransmits don't inflate a one-off past the threshold. The
    // cheap `EMWIN` path check keeps this from parsing every file of a non-EMWIN
    // archive (parsePath's full work is wasted on them).
    var emwinMinutes = new Map();   // code -> Set(minute key)
    files.forEach(function (file) {
      var rel = file.webkitRelativePath || file.relativePath || file.name;
      if (!/EMWIN/i.test(rel)) return;
      var p = parsePath(rel);
      if (!p || p.category !== 'EMWIN') return;
      var mins = emwinMinutes.get(p.code);
      if (!mins) { mins = new Set(); emwinMinutes.set(p.code, mins); }
      mins.add(p.timeDir);
    });
    var keepEmwin = new Set();
    emwinMinutes.forEach(function (mins, code) { if (mins.size >= MIN_EMWIN_FRAMES) keepEmwin.add(code); });

    files.forEach(function (file) {
      var rel = file.webkitRelativePath || file.relativePath || file.name;
      var p = parsePath(rel);
      if (!p) { stats.skipped++; return; }
      // Drop below-threshold EMWIN before the (pointless) classify + tree insert.
      if (p.category === 'EMWIN' && !keepEmwin.has(p.code)) { stats.skipped++; return; }
      var c = classify(p.filename, p.category);
      if (!c) { stats.skipped++; return; }

      var sat = ensure(mergedSats, p.sat, function () {
        return { id: p.sat, label: GS.catalog.satelliteLabel(p.sat), regions: new Map() };
      });

      // Meso regions key by (slot | position): a sector that moved becomes a
      // distinct, separately-animatable region. Other regions key by name.
      var pos = null, regionKey = p.region;
      if (/^Mesoscale/i.test(p.region)) {
        var slash = rel.lastIndexOf('/');
        pos = posByFolder.get(slash >= 0 ? rel.slice(0, slash) : '') || null;
        if (pos) regionKey = p.region + '|' + pos.posKey;
      }
      var region = ensure(sat.regions, regionKey, function () {
        return { id: p.region, slot: p.region, center: pos, products: new Map() };
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
    //    times). Everything else is a sparse 'relayed' passenger. The synthetic
    //    'EMWIN' sat is relayed data, not a downlink — exclude it from the contest
    //    so a dense radar feed can't out-count and demote the real satellite. Fall
    //    back to it only when there's no real satellite (an EMWIN-only capture).
    var primarySat = null, best = -1;
    satTimes.forEach(function (set, id) { if (id !== 'EMWIN' && set.size > best) { best = set.size; primarySat = id; } });
    if (primarySat === null) satTimes.forEach(function (set, id) { if (set.size > best) { best = set.size; primarySat = id; } });

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
        name: spanGaps ? 'All · span gaps' : runLabel(new Date(startMs), new Date(endMs)),
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
      var allRun = buildRun(allTimes[0], allTimes[allTimes.length - 1], true);
      allRun.name = 'All · span gaps · ' + realRuns.length + ' runs';
      runs = realRuns.concat([allRun]);
    }

    stats.runs = realRuns.length;
    return { runs: runs, primarySat: primarySat, defaultRun: defaultRun, stats: stats };
  }

  GS.scanner = { scan: scan, parsePath: parsePath, classify: classify, detectRuns: detectRuns };
})(window.GS = window.GS || {});
