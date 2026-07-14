#!/usr/bin/env node
/*
 * build-manifest.mjs — regenerate samples/manifest.json from whatever is in
 * this samples/ folder. No dependencies; run from the repo root or here:
 *
 *     node samples/build-manifest.mjs
 *
 * The samples loader (src/samples.js) fetches every listed file and hands them
 * to the same scanner a real folder pick uses, so we list exactly the files the
 * scanner ingests — nothing it would fetch and then silently skip:
 *
 *   1. ABI product images: …/IMAGES|L2/<sat>/<region>/<time>/<file>.png
 *   2. Mesoscale product.cbor (same tail, filename product.cbor) — read for the
 *      sector's geographic center so meso regions key by location, not slot.
 *   3. EMWIN imagery: any file under an EMWIN/ folder whose name is a WMO/EMWIN
 *      image (…_KWIN_<14-digit stamp>_<seq>-<pri>-<CODE>.{gif,jpg,png}).
 *
 * Drop a *downscaled* session under samples/ (native full-disk PNGs are 15–35 MB
 * and exceed Cloudflare Pages' 25 MB/file limit), then run this. Meso/EMWIN are
 * small pre-rendered images and are copied native.
 */
import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

// Files the scanner ingests, keyed by extension / basename we bother to walk.
const WALK_RE = /\.(png|gif|jpe?g)$/i;
const isCbor = (name) => /^product\.cbor$/i.test(name);

// (1)+(2): the SatDump tail — <IMAGES|L2>/<sat>/<region>/<UTC time>/<png|cbor>.
const ABI_TAIL_RE = /(^|\/)(IMAGES|L2)\/[^/]+\/[^/]+\/\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\/([^/]+\.png|product\.cbor)$/i;
// (3): an EMWIN image filename (matches src/scanner.js EMWIN_IMG_RE).
const EMWIN_IMG_RE = /_KWIN_\d{14}_\d+-\d+-[A-Za-z0-9]+\.(?:gif|jpe?g|png)$/i;

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (WALK_RE.test(name) || isCbor(name)) out.push(full);
  }
  return out;
}

function keep(p) {
  if (ABI_TAIL_RE.test(p)) return true;
  // EMWIN: a path segment named "EMWIN" plus an EMWIN image basename.
  const segs = p.split('/');
  return segs.some((s) => /^EMWIN$/i.test(s)) && EMWIN_IMG_RE.test(segs[segs.length - 1]);
}

const all = walk(here, [])
  .map((f) => relative(here, f).split('\\').join('/'))
  .filter(keep)
  .sort();

writeFileSync(
  join(here, 'manifest.json'),
  JSON.stringify({ label: '', files: all }, null, 2) + '\n'
);
console.log(`manifest.json: ${all.length} file(s)`);
