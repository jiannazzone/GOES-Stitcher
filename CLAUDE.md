# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

GOES-Stitcher is a **fully client-side static web app** that turns a SatDump GOES-R HRIT
output folder into animated MP4 time-lapses and layered whole-disk Level-2 views. Everything
(decode, compositing, encoding) runs in the browser; nothing is uploaded.

## Hard architectural constraints (don't break these)

- **No build step, no bundler, no npm, no dependencies** except one vendored library
  (`src/vendor/mp4-muxer.js`, MIT). The app must run both **double-clicked via `file://`**
  and **hosted** (GitHub/Cloudflare Pages).
- Therefore: **classic `<script>` tags + a single global `GS` namespace** — *not* ES modules.
  Do not add `import`/`export`, a package.json, or a transpile step. Each module is an IIFE
  that attaches to `window.GS` (`GS.catalog`, `GS.imaging`, `GS.scanner`, `GS.ViewMode`,
  `GS.samples`, `GS.app`, plus `GS.dom`/`GS.ui`).
- **Script load order in `index.html` is dependency order** and matters:
  `vendor → catalog → imaging → samples → scanner → view → app`. A new module must be
  inserted at the right point (e.g. it may call `GS.imaging.formatClock`, which loads before
  the scanner).
- **All GOES times are UTC** — use the `formatDate/formatClock/formatUTC/stamp` helpers in
  `imaging.js`; never local time.

## Commands

There is no test runner or linter. Verification is manual + ad-hoc.

- **Run locally:** `python3 -m http.server 8080` then open `http://localhost:8080`.
  A server (not `file://`) is required for the "try sample data" loader and any `fetch`.
- **Syntax check a file:** `node --check src/<file>.js` (catches parse errors; there is no lint).
- **Bundle sample data:** drop *downscaled* PNGs under `samples/<session>/IMAGES|L2/...`
  keeping the `.../IMAGES|L2/<sat>/<region>/<YYYY-MM-DD_HH-MM-SS>/<file>.png` tail, then run
  `node samples/build-manifest.mjs`. Cloudflare Pages caps files at **25 MB**; native
  full-disk PNGs are 15–35 MB, so downscale to ~1024–2048 px. Sample content is not committed.
- **Browser-behavior testing:** there is no framework. Behavior is verified with an ad-hoc
  CDP harness — Node 22's built-in global `WebSocket` driving `--headless=new` Chrome in
  **real time**, loading the app over the local server and asserting via `Runtime.evaluate`.
  IMPORTANT: drive it real-time, *not* with `--virtual-time-budget` — WebCodecs' threaded
  encode deadlocks under virtual time (`enc.flush()` never resolves).

## Architecture (the parts that span files)

**Data model — `src/scanner.js`.** `GS.scanner.scan(FileList)` parses each file's
`webkitRelativePath` (or `.relativePath` for drag-drop / synthetic files), finds the
`IMAGES`/`L2` boundary, and requires **exactly 5 segments after it**
(`category/sat/region/timeDir/file`). It builds `session → sat → region → product → frame`,
where a frame has `variants:{plain, map}` (`_map` = SatDump's coastline overlay). `abi_rgb_*`
files are composites (IMAGES) or L2 products; `G##_<band>_…Z.png` are raw ABI bands. A "session"
is any folder directly containing `IMAGES/` or `L2/`, so a parent of several sessions works.

**The one unified view — `src/view.js` (`GS.ViewMode.create(panel, stage, region, ctx)`).**
There is a single `<canvas>`. **`renderComposite(dest, i, opts)` is the choke point for
everything** — playback, scrub, PNG, MP4, batch, deflicker, and pan/zoom all go through it.
`opts = { base (defaults to state.baseEntry), layers (default on), view (pan/zoom transform) }`.
It draws a BASE entry then stacks toggled L2 layers (each snaps to the frame nearest the base
in time, with its own opacity/blend), then draws the burned-in caption in screen space.
Understand this function before touching rendering. Also here: a per-`(product|variant|resolution)`
decode cache that closes ImageBitmaps on prune/destroy; deflicker (per-frame brightness gains,
base-only, memoized on the entry); batch export; and the DOM colorbar legend.

**Imaging pipeline — `src/imaging.js` (`GS.imaging`).** `decodeScaled`/`getBitmap` decode +
downscale PNGs to ImageBitmaps (full-disk is 5424² — always downscale for memory).
`exportVideo({count, fps, render})` encodes via WebCodecs H.264 → MP4 (vendored mp4-muxer),
falling back to MediaRecorder (prefers MP4, else WebM). **H.264 caps at 2048 px** (it cannot
encode native 5424²). `zipStore(entries)` is a dependency-free store-only ZIP writer used to
deliver a batch of MP4s as one download.

**Catalog — `src/catalog.js` (`GS.catalog`).** Pure data: ABI band metadata, raw→clean product
name mapping, and L2 colorbar scales (`L2_SCALES` / `l2Scale`). **Accuracy rule:** the gradient
stops reproduce SatDump's actual LUTs, and numeric colorbar labels are shown **only where
NOAA's product range is verified** (cloud-top temperature/height, rain rate); CAPE/TPW are
qualitative. Do not invent value scales — SatDump discards the count→value calibration.

**Shell — `src/app.js` (`GS.app`).** Folder pick + drag-drop → `loadFiles(files)` →
`GS.scanner.scan` → builds the session/sat/region selectors → mounts a fresh `ViewMode` per
region (destroying the previous one). `GS.samples.load()` reuses this exact `loadFiles` path by
fetching bundled PNGs and wrapping them as `File`s with a synthetic `relativePath`, so the
scanner needs no special case. Also defines the shared `GS.dom.el/clear` and `GS.ui.list` widgets.

## Conventions

- Pan/zoom is an **on-screen viewing aid only**; exports are always full-disk (the view
  transform is never passed to the export render path). Deflicker is **base-layer only**.
- The maintainer controls when to push — commit when asked, but don't `git push` unless told.
