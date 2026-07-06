#!/usr/bin/env node
/*
 * build-manifest.mjs — regenerate samples/manifest.json from whatever is in
 * this samples/ folder. No dependencies; run from the repo root or here:
 *
 *     node samples/build-manifest.mjs
 *
 * It lists every .png under samples/ whose path contains an "IMAGES" or "L2"
 * segment with the SatDump tail (…/IMAGES|L2/<sat>/<region>/<time>/<file>).
 * Drop a *downscaled* session under samples/ (native full-disk PNGs are 15–35 MB
 * and exceed Cloudflare Pages' 25 MB/file limit), then run this.
 */
import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.png$/i.test(name)) out.push(full);
  }
  return out;
}

const all = walk(here, [])
  .map((f) => relative(here, f).split('\\').join('/'))
  // Match the scanner's exact shape: <IMAGES|L2>/<sat>/<region>/<UTC time>/<file>.png.
  // A looser filter would list files the scanner then silently skips (wasted fetches).
  .filter((p) => /(^|\/)(IMAGES|L2)\/[^/]+\/[^/]+\/\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\/[^/]+\.png$/i.test(p))
  .sort();

writeFileSync(
  join(here, 'manifest.json'),
  JSON.stringify({ label: '', files: all }, null, 2) + '\n'
);
console.log(`manifest.json: ${all.length} file(s)`);
