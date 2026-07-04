/*
 * catalog.js — static metadata about GOES ABI bands and SatDump L2 products.
 *
 * SatDump renders GOES-R HRIT downlinks into PNGs whose names encode either a
 * single ABI band (e.g. "G19_13_...") or a named composite / Level-2 product
 * (e.g. "abi_rgb_ABI_False_Color"). This module turns those raw tokens into
 * human-friendly names, short descriptions and display hints. Everything here is
 * pure data — no DOM, no state — so it loads first and every other module reads
 * from GS.catalog.
 */
(function (GS) {
  'use strict';

  // GOES-R ABI band reference (band number -> label, central wavelength, blurb).
  // Only the bands SatDump commonly writes over HRIT are listed; unknown bands
  // fall back to a generic "Band N" label.
  var BANDS = {
    1: { name: 'Blue (Visible)', wavelength: '0.47 µm', blurb: 'Aerosols, haze.' },
    2: { name: 'Red (Visible)', wavelength: '0.64 µm', blurb: 'Highest-res daytime visible.' },
    3: { name: 'Veggie (Near-IR)', wavelength: '0.86 µm', blurb: 'Vegetation, land/water.' },
    5: { name: 'Snow/Ice (Near-IR)', wavelength: '1.6 µm', blurb: 'Cloud-phase, snow.' },
    6: { name: 'Cloud Particle (Near-IR)', wavelength: '2.2 µm', blurb: 'Cloud particle size.' },
    7: { name: 'Shortwave Window', wavelength: '3.9 µm', blurb: 'Fog, fire, low cloud at night.' },
    8: { name: 'Upper-Level Water Vapor', wavelength: '6.2 µm', blurb: 'Upper-tropospheric moisture.' },
    9: { name: 'Mid-Level Water Vapor', wavelength: '6.9 µm', blurb: 'Mid-tropospheric moisture.' },
    10: { name: 'Lower-Level Water Vapor', wavelength: '7.3 µm', blurb: 'Lower-tropospheric moisture.' },
    11: { name: 'Cloud-Top Phase', wavelength: '8.4 µm', blurb: 'Cloud-top phase.' },
    13: { name: 'Clean Longwave IR', wavelength: '10.3 µm', blurb: 'Clean IR window — clouds day & night.' },
    14: { name: 'Longwave IR Window', wavelength: '11.2 µm', blurb: 'IR window.' },
    15: { name: 'Dirty Longwave IR', wavelength: '12.3 µm', blurb: 'Dirty IR window — low cloud, dust.' },
    16: { name: 'CO₂ Longwave IR', wavelength: '13.3 µm', blurb: 'Air-mass, cloud-top height.' }
  };

  // Level-2 product abbreviations SatDump uses in single-band filenames
  // (e.g. "G19_ACHT_...Z.png"). We generally prefer the colorized "abi_rgb_*"
  // renderings, but this map lets us recognize/label the mono ones too.
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

  // Short descriptions for the named composites / L2 products SatDump renders,
  // keyed by the display name (underscores already turned into spaces). Used for
  // tooltips / captions. Missing keys just show no blurb.
  var PRODUCT_BLURBS = {
    'ABI False Color': 'Daytime true-ish color from visible + near-IR bands.',
    'Clean Longwave IR Window Band': 'Band 13 IR — cloud tops day & night.',
    'Infrared Longwave Window Band': 'Band 14 longwave IR window.',
    'Dirty Longwave Window': 'Band 15 IR — sensitive to low cloud & dust.',
    'Dirty Longwave Window - CIRA': 'CIRA-style colorized band 15 IR.',
    'Shortwave Window Band': 'Band 7 — fog, fire and nighttime low cloud.',
    'Mid-level Tropospheric Water Vapor': 'Band 9 mid-level moisture.',
    'Upper-Level Tropospheric Water Vapor': 'Band 8 upper-level moisture.',
    'Cloud top Temperature (ACHT)': 'L2: temperature of cloud tops.',
    'AWG Cloud Height Algorithm (ACHA)': 'L2: height of cloud tops.',
    'Derived Stability Indices - CAPE': 'L2: convective available potential energy.',
    'Rain Rate Per Quarter Hour': 'L2: instantaneous rainfall rate.',
    'Total Precipitable Water': 'L2: column water vapor.'
  };

  // Full-name lookup for satellites.
  var SATELLITES = {
    'GOES-16': 'GOES-16 (East, retired slot)',
    'GOES-17': 'GOES-17 (West)',
    'GOES-18': 'GOES-18 (West)',
    'GOES-19': 'GOES-19 (East)'
  };

  GS.catalog = {
    bands: BANDS,
    l2Abbr: L2_ABBR,
    productBlurbs: PRODUCT_BLURBS,
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

    productBlurb: function (name) {
      return PRODUCT_BLURBS[name] || '';
    },

    satelliteLabel: function (id) {
      return SATELLITES[id] || id;
    },

    // Is this L2 abbreviation one we recognize?
    isL2Abbr: function (tok) {
      return Object.prototype.hasOwnProperty.call(L2_ABBR, tok);
    }
  };
})(window.GS = window.GS || {});
