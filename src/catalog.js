/*
 * catalog.js — static metadata about GOES ABI bands and SatDump L2 products.
 *
 * SatDump renders GOES-R HRIT downlinks into PNGs whose names encode either a
 * single ABI band (e.g. "G19_13_...") or a named composite / Level-2 product
 * (e.g. "abi_rgb_ABI_False_Color"). Those raw product names are inconsistent and
 * jargon-y, so this module maps them to clean display names, carries a short
 * plain-language blurb for each, and lists a few authoritative references. It is
 * pure data — no DOM, no state — so it loads first and every other module reads
 * from GS.catalog.
 */
(function (GS) {
  'use strict';

  // GOES-R ABI band reference (band number -> label, central wavelength, blurb).
  // Only the bands SatDump commonly writes over HRIT are listed; unknown bands
  // fall back to a generic "Band N" label.
  var BANDS = {
    1: { name: 'Blue (Visible)', wavelength: '0.47 µm', blurb: 'Aerosols and haze.' },
    2: { name: 'Red (Visible)', wavelength: '0.64 µm', blurb: 'Highest-resolution daytime visible.' },
    3: { name: 'Veggie (Near-IR)', wavelength: '0.86 µm', blurb: 'Vegetation and land/water boundaries.' },
    5: { name: 'Snow/Ice (Near-IR)', wavelength: '1.6 µm', blurb: 'Cloud phase and snow.' },
    6: { name: 'Cloud Particle (Near-IR)', wavelength: '2.2 µm', blurb: 'Cloud particle size.' },
    7: { name: 'Shortwave Window', wavelength: '3.9 µm', blurb: 'Fog, fire and nighttime low cloud.' },
    8: { name: 'Upper-Level Water Vapor', wavelength: '6.2 µm', blurb: 'Upper-tropospheric moisture and jet streaks.' },
    9: { name: 'Mid-Level Water Vapor', wavelength: '6.9 µm', blurb: 'Mid-tropospheric moisture and flow.' },
    10: { name: 'Lower-Level Water Vapor', wavelength: '7.3 µm', blurb: 'Lower-tropospheric moisture.' },
    11: { name: 'Cloud-Top Phase', wavelength: '8.4 µm', blurb: 'Cloud-top phase.' },
    13: { name: 'Clean Longwave IR', wavelength: '10.3 µm', blurb: 'Clean IR window — cloud tops day & night.' },
    14: { name: 'Longwave IR Window', wavelength: '11.2 µm', blurb: 'IR window channel.' },
    15: { name: 'Dirty Longwave IR', wavelength: '12.3 µm', blurb: 'Dirty IR window — low cloud and dust.' },
    16: { name: 'CO₂ Longwave IR', wavelength: '13.3 µm', blurb: 'Air-mass and cloud-top height.' }
  };

  // Level-2 product abbreviations SatDump uses in single-band filenames
  // (e.g. "G19_ACHT_...Z.png"). We prefer the colorized "abi_rgb_*" renderings,
  // but this map lets us recognize/label the mono ones and name codes in the
  // glossary.
  var L2_ABBR = {
    ACHT: 'Cloud-Top Temperature',
    ACHA: 'Cloud-Top Height',
    ACHP: 'Cloud-Top Pressure',
    ACM: 'Clear-Sky Mask',
    DSI: 'Derived Stability Indices',
    RRQPE: 'Rainfall Rate (QPE)',
    TPW: 'Total Precipitable Water',
    ACTP: 'Cloud-Top Phase',
    COD: 'Cloud Optical Depth',
    CPS: 'Cloud Particle Size',
    LST: 'Land Surface Temperature',
    FDC: 'Fire / Hot Spot',
    ADP: 'Aerosol Detection'
  };

  // Raw SatDump product name (underscores already turned into spaces) -> clean,
  // consistent display name. Cleaned but not over-simplified: meaningful
  // qualifiers (time windows, level) are kept; algorithm codes move to the blurb.
  var PRODUCT_NAMES = {
    'ABI False Color': 'False Color',
    'Clean Longwave IR Window Band': 'Clean Longwave IR',
    'Infrared Longwave Window Band': 'Longwave IR Window',
    'Dirty Longwave Window': 'Dirty Longwave IR',
    'Dirty Longwave Window - CIRA': 'Dirty Longwave IR (CIRA)',
    'Mid-level Tropospheric Water Vapor': 'Mid-Level Water Vapor',
    'Upper-Level Tropospheric Water Vapor': 'Upper-Level Water Vapor',
    'Cloud top Temperature (ACHT)': 'Cloud-Top Temperature',
    'AWG Cloud Height Algorithm (ACHA)': 'Cloud-Top Height',
    'Derived Stability Indices - CAPE': 'CAPE (instability)',
    'Rain Rate Per Quarter Hour': 'Rainfall Rate (15 min)'
    // (names already clean via cleanFallback — e.g. "Total Precipitable Water",
    //  "Shortwave Window Band" — need no explicit entry)
  };

  // Plain-language blurbs keyed by the *clean* display name. Missing keys just
  // show no blurb.
  var PRODUCT_BLURBS = {
    'False Color': 'Daytime near-true color from visible + near-IR bands: vegetation green, water dark, clouds white.',
    'Clean Longwave IR': 'Band 13 (10.3 µm) — cloud-top temperatures day & night; the workhorse IR channel.',
    'Longwave IR Window': 'Band 14 (11.2 µm) longwave IR window.',
    'Dirty Longwave IR': 'Band 15 (12.3 µm) — sensitive to low cloud, dust and moisture.',
    'Dirty Longwave IR (CIRA)': 'CIRA-style colorized band 15 IR.',
    'Shortwave Window': 'Band 7 (3.9 µm) — fog, fire hot-spots and nighttime low cloud.',
    'Mid-Level Water Vapor': 'Band 9 (6.9 µm) — mid-tropospheric moisture and flow.',
    'Upper-Level Water Vapor': 'Band 8 (6.2 µm) — upper-tropospheric moisture and jet streaks.',
    'Cloud-Top Temperature': 'Level-2 retrieval (ACHT): temperature of cloud tops — colder tops are generally higher.',
    'Cloud-Top Height': 'Level-2 retrieval (ACHA): height of cloud tops.',
    'CAPE (instability)': 'Level-2 (Derived Stability Indices): convective available potential energy — atmospheric instability / storm potential.',
    'Rainfall Rate (15 min)': 'Level-2 (RRQPE): instantaneous rainfall rate, a quarter-hourly quantitative estimate.',
    'Total Precipitable Water': 'Level-2 (TPW): total column water vapor.'
  };

  // Full-name lookup for satellites.
  var SATELLITES = {
    'GOES-16': 'GOES-16 (on-orbit spare)',
    'GOES-17': 'GOES-17 (West)',
    'GOES-18': 'GOES-18 (West)',
    'GOES-19': 'GOES-19 (East)'
  };

  // A few authoritative references, surfaced in the About / glossary panel.
  var REFERENCES = [
    { label: 'NOAA GOES-R mission', url: 'https://www.goes-r.gov/' },
    { label: 'ABI band quick guides (NOAA)', url: 'https://www.goes-r.gov/mission/ABI-bands-quick-info.html' },
    { label: 'NOAA STAR GOES imagery', url: 'https://www.star.nesdis.noaa.gov/goes/' },
    { label: 'SatDump (the decoder)', url: 'https://www.satdump.org/' }
  ];

  // Colorbar scales for SatDump's colorized L2 products. SatDump applies a fixed
  // LUT to the raw 8-bit HRIT counts (deterministic, not auto-scaled) but discards
  // the count→value calibration, so:
  //   - `stops` reproduces SatDump's LUT ramp (low→high), so the bar matches what's
  //     drawn on screen; space / no-retrieval / clear-sky sentinel counts (black)
  //     are trimmed off the ends.
  //   - numeric min/max come from NOAA F&PS / ATBDs and are shown only where they
  //     could be verified (ACHT, ACHA, RRQPE). CAPE/TPW keep certain units but an
  //     unverifiable range, so they render a relative low→high bar with no numbers.
  var L2_SCALES = [
    { id: 'acht', match: /ACHT|cloud[\s-]*top temp/i, units: 'K', numeric: true, min: 180, max: 300,
      stops: ['#7316ed', '#401cfa', '#3650ff', '#4dabff', '#60e4d0', '#67fe7c', '#65fe05', '#86fe00', '#b5f600', '#f8e300', '#ff0000'],
      note: 'Standard GOES-R product range (180–300 K); SatDump carries no per-frame calibration. Cold cloud tops read violet/blue, warm surfaces red. Black = space / clear.',
      source: 'NOAA GOES-R F&PS · Cloud ACHA ATBD v3.4' },
    { id: 'acha', match: /ACHA|cloud height/i, units: 'km', numeric: true, min: 0, max: 20,
      stops: ['#e29a1a', '#e5d11d', '#d7fc19', '#90f500', '#62f00a', '#65f17c', '#5bd5c0', '#479bdb', '#3f61e5', '#3f27e6', '#5819b8'],
      note: 'Standard GOES-R product range (0–20 km); no per-frame calibration. Black = no retrieval.',
      source: 'NOAA GOES-R F&PS · Cloud ACHA ATBD v3.4' },
    { id: 'rrqpe', match: /RRQPE|rain rate/i, units: 'mm/hr', numeric: true, min: 0, max: 100,
      stops: ['#c3c3c3', '#cfcfce', '#dadbda', '#e6e6e6', '#b763be', '#e623e8', '#ff4f00', '#ffed00', '#0cbf07', '#031eca', '#036fea'],
      note: 'Standard GOES-R product range (0–100 mm/hr); no per-frame calibration. Clear-sky is transparent/black.',
      source: 'NOAA GOES-R Enterprise Rainfall Rate ATBD v3' },
    { id: 'cape', match: /CAPE|derived stability|\bDSI\b/i, units: 'J/kg', numeric: false,
      stops: ['#920ea0', '#7b0652', '#cd192d', '#ef4e3d', '#f4a94d', '#f8f700', '#a4a446', '#6f6eaf', '#a198c4', '#c5a890', '#93764b', '#523f21'],
      note: 'SatDump does not carry CAPE’s value scale, so this is a relative low→high gradient (units J/kg).',
      source: 'NOAA GOES-R Derived Stability Indices' },
    { id: 'tpw', match: /TPW|precipitable/i, units: 'mm', numeric: false,
      stops: ['#fff1ff', '#ffe4ff', '#ffd7ff', '#ffc9ff', '#f654f6', '#8f008f', '#df6752', '#eef509', '#418942', '#6565b4', '#cfa489', '#3e2a0b'],
      note: 'SatDump does not carry TPW’s value scale, so this is a relative low→high gradient (units mm).',
      source: 'NOAA GOES-R Total Precipitable Water' }
  ];

  // Light tidy for a raw product name we don't have an explicit mapping for.
  function cleanFallback(s) {
    return String(s).replace(/\s+Band$/i, '').replace(/\s*-\s*/g, ' — ').replace(/\s+/g, ' ').trim();
  }

  GS.catalog = {
    bands: BANDS,
    l2Abbr: L2_ABBR,
    satellites: SATELLITES,

    // "13" -> "Band 13 · Clean Longwave IR (10.3 µm)"
    bandLabel: function (n) {
      var b = BANDS[n];
      if (!b) return 'Band ' + n;
      return 'Band ' + n + ' · ' + b.name + ' (' + b.wavelength + ')';
    },

    bandShort: function (n) {
      var b = BANDS[n];
      return b ? b.name : 'Band ' + n;
    },

    // Raw SatDump product name -> clean display name.
    displayName: function (raw) {
      return PRODUCT_NAMES[raw] || cleanFallback(raw);
    },

    // Blurb for a *clean* display name.
    productBlurb: function (name) {
      return PRODUCT_BLURBS[name] || '';
    },

    // Colorbar scale for an L2 product (matched on its raw SatDump name), or null.
    l2Scale: function (rawName) {
      for (var i = 0; i < L2_SCALES.length; i++) if (L2_SCALES[i].match.test(rawName || '')) return L2_SCALES[i];
      return null;
    },

    satelliteLabel: function (id) {
      return SATELLITES[id] || id;
    },

    // Is this L2 abbreviation one we recognize?
    isL2Abbr: function (tok) {
      return Object.prototype.hasOwnProperty.call(L2_ABBR, tok);
    },

    // Structured data for the About / glossary panel.
    glossary: function () {
      var bands = Object.keys(BANDS).map(function (n) {
        return { band: +n, name: BANDS[n].name, wavelength: BANDS[n].wavelength, blurb: BANDS[n].blurb };
      }).sort(function (a, b) { return a.band - b.band; });
      var products = Object.keys(PRODUCT_BLURBS).map(function (name) {
        return { name: name, blurb: PRODUCT_BLURBS[name] };
      });
      return { bands: bands, products: products, references: REFERENCES };
    }
  };
})(window.GS = window.GS || {});
