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
(`category/sat/region/timeDir/file`). It **returns a Promise** of
`{ runs, primarySat, defaultRun, stats }` (async because it reads mesoscale
`product.cbor` — see below), where each **run** is `sat → region → product → frame` and a
frame has `variants:{plain, map}` (`_map` = SatDump's coastline overlay). `abi_rgb_*` files
are composites (IMAGES) or L2 products; `G##_<band>_…Z.png` are raw ABI bands.

**Folders don't define timelines — reception runs do.** SatDump writes a new session folder
each time the receiver starts, so a whole day is split across folders (and unrelated days sit
side by side). The scanner **ignores folder boundaries**: it merges every file into one
`sat → region → product` tree (deduped by scan-time + variant), then `detectRuns` segments the
**union of all scan times** into runs — maximal stretches with no gap larger than `BREAK_MS`
(2 h). A run is one continuous "receiver was on" window, so two adjacent folders that form a
contiguous capture become one run while day-apart captures split. The satellite with the most
scans is the `primary`; anything else (e.g. GOES-18's hourly Band-13 relay carried on a GOES-19
downlink) is a sparse `relayed` passenger, attributed to a run purely by timestamp — the relay
schedule is never modelled. When >1 run exists, an `All · span gaps` run (whole archive, one
timeline) trails the list, and `defaultRun` is the most-recent run with ≥3 scans.

**Mesoscale sectors rove — key them by location, not slot number.** "Mesoscale 1"/"2" are
just the two ABI meso *slots*; operators steer them at storms, so the same slot is a different
place on different days. Merging by slot alone would splice unrelated geographies into one
animation. So the scanner reads each meso folder's `product.cbor` (a minimal CBOR decoder +
GOES-R inverse-geos live in `scanner.js`), takes the crop **center** (`offset_x/y` is the
`(0,0)` corner; center = `offset + (w/2,h/2)·scalar`), and keys meso regions by
`slot|position`. A moved sector becomes a **distinct region labelled by lat/lon** (`Mesoscale 1
· 38.2°N 76.0°W`), so same-place frames stitch and different-place frames never merge — a real
run has one meso position, `All · span gaps` shows each position separately. The math was
validated against SatDump's coastline overlay (Chesapeake sector → 38.2°N 76.0°W). If a
`product.cbor` is missing/unreadable (e.g. the sample loader), the sector falls back to its
slot label. **This is the only reason `scan` is async.** Non-meso datasets do zero reads.

**EMWIN imagery — a second ingest grammar.** Alongside ABI, the HRIT downlink relays EMWIN
(the low-rate text/graphics broadcast). Its files have no `IMAGES`/`L2` subtree — the WMO
filename carries everything: `Z_…_KWIN_<YYYYMMDDHHMMSS>_<seq>-<pri>-<CODE>.GIF`. So `parsePath`
has an **EMWIN branch** (a file under any `EMWIN/` folder matching `EMWIN_IMG_RE` — it *falls
through* to the IMAGES/L2 logic if the name doesn't match, so an ABI tree under a folder named
`EMWIN` isn't dropped): the 14-digit `_KWIN_` stamp is the frame **time** (UTC; the WMO header
DDHHMM is nominal, not reception), and the trailing `CODE` is the **series** key — the same chart
over and over. These map to a synthetic `sat "EMWIN" → region "Radar Mosaics"` (or `"EMWIN"` for
non-`RAD*` codes), one product per code, `kind:'emwin'`, `variant:'plain'` only (no `_map`). The
dedupe key is coarsened to the **minute** (`timeDir = stamp.slice(0,12)`) so EMWIN's reliability
retransmits (~10 s apart) mostly collapse to one frame. Only codes recurring in **≥
`MIN_EMWIN_FRAMES`** (10) distinct *minutes* survive — sparse one-offs are dropped before the tree
insert (a cheap `EMWIN`-path pre-pass, so non-EMWIN archives pay nothing). The synthetic sat is
**excluded from `primarySat` detection** (a dense radar feed must not demote the real satellite to
`relayed`); it wins only when it's the sole sat. Friendly names for the ~15 NWS radar mosaic sectors
live in `catalog.js` (`emwinName`); unknown codes degrade to the raw token. On drop, `app.js` no
longer prunes `EMWIN/` but skips its ~10k text files per-file (`keepDropped`). `freezeSats` tags each
region `region.kind` (`'emwin'`/`'abi'`); `view.js` reads that to render EMWIN **native-only** (small
pre-rendered charts — nothing to downscale), add a `radar mosaics` base-list group, and hide the
coastline toggle + the L2 hint.

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
`GS.scanner.scan` → builds the run/sat/region selectors (the **Run** dropdown appears only when
>1 run; relayed satellites are marked `· relayed` and never auto-selected) → mounts a fresh
`ViewMode` per region (destroying the previous one). `GS.samples.load()` reuses this exact `loadFiles` path by
fetching bundled PNGs and wrapping them as `File`s with a synthetic `relativePath`, so the
scanner needs no special case. Also defines the shared `GS.dom.el/clear` and `GS.ui.list` widgets.

## Conventions

- Pan/zoom is an **on-screen viewing aid only**; exports are always full-disk (the view
  transform is never passed to the export render path). Deflicker is **base-layer only**.
- The maintainer controls when to push — commit when asked, but don't `git push` unless told.
