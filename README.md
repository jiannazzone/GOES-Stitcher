# 🛰️ GOES Stitcher

Turn a **SatDump GOES HRIT** output folder into animated, layered whole-disk views — entirely in your browser. Nothing is uploaded; the page reads your folder locally and does all decoding and rendering on your machine.

> 🤖 **Co-authored with Claude.** This project was designed and built collaboratively with Anthropic's [Claude](https://claude.com/claude-code) (Claude Code). The git history reflects that — commits carry `Co-Authored-By: Claude` trailers.

## What it does

One **view** that combines animation over *time* with compositing over *layers*:

- **Base image** — pick any product (composite, raw ABI band, or L2) as the bottom layer, with an optional **coastline** overlay.
- **Level-2 layers** — stack derived products (rain rate, cloud-top height/temperature, CAPE, total precipitable water) on top, each with its own **opacity** and **blend mode**, and a **colorbar legend** reproduced from SatDump's own LUT (with real units — numeric where NOAA's product range is known).
- **Timeline** — the base product's scans define a timeline you **play / scrub / loop**; every active layer snaps to its nearest frame in time, so base and layers animate together. **Deflicker** evens out the day/night brightness pulse. Burn in a UTC timestamp and **export an H.264 MP4** of the whole run (encoded in-browser, plays everywhere), or **save a PNG** of the current composite.
- **Pan & zoom** — scroll to zoom into a feature, drag to pan, double-click to reset (raise the resolution for crisp deep zoom).
- **Batch export** — check several products and render them all to MP4 in one pass, delivered as a single **ZIP**.

It reads one shared, automatically-built index of your folder and caches every decoded frame, so switching base, toggling layers, and scrubbing stay instant — and **Prerender all** (on by default) decodes the whole region in the background up front.

Product names are cleaned up for readability (`Rain Rate Per Quarter Hour` → **Rainfall Rate (15 min)**), every control has a hover tooltip, and a **? about** panel explains the bands, products and data model with links to NOAA/NASA references.

## Use it

### Hosted (recommended) https://goes.k2cat.xyz
Open the deployed page [here](https://goes.k2cat.xyz) and click **Choose folder…** (or drag a folder onto it), then point it at a SatDump session — e.g. `2026-07-04_17-10_goes_hrit_1.6941 GHz` — **or** at a parent folder holding many sessions: captures are auto-stitched into continuous **runs** (one per receiver-on window), so a whole day plays as a single timeline.

> Folder access uses the standard `<input webkitdirectory>` picker: the browser reads files locally and **does not upload** them.

### Run it locally
Because it's just static files, any static server works:

```bash
cd GOES-Stitcher
python3 -m http.server 8080
# then open http://localhost:8080
```

Opening `index.html` by double-click also works in most browsers (it uses classic scripts, not ES modules, to avoid `file://` restrictions), but a local server is the most reliable.

## Keyboard

The workspace is keyboard-driven, like the terminal tool it's dressed as:

| Key | Action |
| --- | --- |
| `↑` / `↓` | change **base** image |
| `space` | play / pause |
| `←` / `→` | step through time |
| `b` | prerender the whole region |
| `e` | export MP4 · `s` save PNG |

(Shortcuts are ignored while a dropdown or field is focused.)

## Deploy (free static hosting)

**GitHub Pages**
1. Push this repo to GitHub.
2. **Settings → Pages → Build and deployment → Source: Deploy from a branch**, branch `main`, folder `/ (root)`.
3. Your site appears at `https://<user>.github.io/GOES-Stitcher/`.

**Cloudflare Pages**
1. **Create project → Connect to Git**, pick this repo.
2. **Build command:** *(leave empty)* — **Output directory:** `/` (repo root).
3. Deploy.

No build step, no bundler — just one small vendored library ([`mp4-muxer`](https://www.npmjs.com/package/mp4-muxer), MIT) checked into `src/vendor/` for MP4 export.

## Sample data (optional)

To let first-time visitors try the app without their own capture, drop a **downscaled** SatDump session under `samples/` (keep the `…/IMAGES|L2/<sat>/<region>/<time>/…` path tail), then regenerate the manifest:

```bash
node samples/build-manifest.mjs
```

A **try sample data** button then appears in the empty viewport *on the hosted site* — it's hidden on `file://`, where fetching bundled files is blocked. Keep each PNG **under 25 MB** (Cloudflare Pages' per-file limit): downscale full-disk frames (native 5424² are 15–35 MB each); ~1024–2048 px is plenty for a demo.

## What folders it understands

SatDump writes something like:

```
<session>/
├── IMAGES/
│   └── GOES-19 | GOES-18/
│       └── Full Disk | Mesoscale 1 | Mesoscale 2/
│           └── <YYYY-MM-DD_HH-MM-SS>/         (UTC scan time)
│               ├── G19_2/7/8/9/13/14/15_…Z.png   raw ABI bands
│               └── abi_rgb_<Name>[_map].png      composites (+ coastline variant)
└── L2/
    └── GOES-19/Full Disk/<timestamp>/
        └── abi_rgb_<Product>[_map].png           derived Level-2 products
```

- Time comes from the scan-time folder name (UTC). `_map` files are the coastline-overlaid variant.
- **Sessions are stitched into runs.** SatDump starts a new folder each capture, so the app ignores folder boundaries and segments everything by scan-time gaps into **reception runs** — a gap over **2 hours** starts a new run, so two adjacent folders from one continuous capture merge while day-apart captures stay separate. Pick a run from the **Run** selector, or **All · span gaps** to force the whole archive into one timeline.
- **Relayed satellites.** On a GOES-19 (East) HRIT downlink you'll see occasional GOES-18 (West) frames — its hourly Band-13 relay. The satellite you actually receive (the one with the most scans) is the *primary*; the other is marked **· relayed** and never auto-selected, since it's far too sparse to animate on its own.
- **Mesoscale sectors are located by lat/lon, not slot number.** The two ABI mesoscale sectors are *roving* — operators point them at storms, so "Mesoscale 1" is a different place on different days. The app reads each frame's `product.cbor` navigation and labels each sector by its center (**Mesoscale 1 · 38.2°N 76.0°W**), so a sector that moved shows up as separate, correctly-stitched regions instead of an animation that teleports between locations.
- Grayscale single-band L2 duplicates (`G19_ACHT_…`), `product.cbor`, stray `… copy.png`, and non-standard folders (e.g. `NWS/`) are ignored.
- **Note:** layers of different native resolutions (e.g. 5424² vs 1086²) line up because all full-disk products share the same earth extent; they're scaled to a common working canvas.

## Tips

- **Full-disk images are large (5424², 15–37 MB each).** The app downscales for playback/memory; start at **1024 px** and bump to 2048/native only if you need it.
- **Exports are H.264 MP4**, encoded in your browser via WebCodecs — they play everywhere (QuickTime, iOS/Android, most social platforms) with no transcoding, and nothing is uploaded.
- **Video caps at 2048²** because H.264 can't encode the native 5424² frame; PNG stills still export at whatever resolution you pick.
- **Browser support:** MP4 export needs WebCodecs (recent Chrome/Edge, Safari 16.4+, Firefox 130+). Older browsers fall back to MediaRecorder — MP4 where the browser supports it, otherwise WebM. Playback and PNG export work everywhere (the app tells you if video export isn't available).
- **Deflicker** smooths the brightness pulse as the day/night line crosses the disk — most useful on visible/false-color runs, harmless on IR.
- **Pan & zoom** (scroll / drag / double-click) is a viewing aid on the working-resolution image, so deep zoom softens — raise **Resolution** for a crisp close-up. Exports stay full-disk.
- **Level-2 colorbars** reproduce SatDump's LUT exactly. SatDump doesn't carry the value calibration, so numbers appear only where NOAA's standard range is verified (cloud-top temperature/height, rain rate); CAPE and TPW show a relative low→high scale.

## How it's built

Plain HTML/CSS/JS with a single vendored dependency ([`mp4-muxer`](https://www.npmjs.com/package/mp4-muxer), MIT, for MP4 export). A "ground-station terminal" (TUI) look: self-hosted [IBM Plex Mono](https://github.com/IBM/plex) + [Departure Mono](https://departuremono.com/) (both OFL), so it renders identically offline and on Pages with **no external requests**.

The code was pair-programmed with Anthropic's **Claude** (Claude Code) — architecture, implementation, and review — with a human in the loop on every decision.

| File | Role |
| --- | --- |
| `index.html` | markup + script includes |
| `assets/styles.css` | terminal theme |
| `assets/fonts/` | self-hosted mono webfonts |
| `src/catalog.js` | ABI band + product metadata, display-name cleanup, L2 colorbar scales, glossary |
| `src/scanner.js` | folder → `session → sat → region → product → frames` index |
| `src/imaging.js` | decode/downscale, compositing, deflicker, MP4/video export, batch ZIP, downloads |
| `src/samples.js` | optional "try sample data" loader (fetches bundled demo PNGs) |
| `src/view.js` | the unified view — base + layers + timeline + deflicker + pan/zoom + batch + legend |
| `src/app.js` | folder picking, selectors, view lifecycle, `GS.dom` / `GS.ui` |
| `src/vendor/mp4-muxer.js` | vendored MP4 muxer ([mp4-muxer](https://www.npmjs.com/package/mp4-muxer), MIT) |

## License

MIT — see below. Not affiliated with NOAA/NASA; GOES imagery is public-domain data you received yourself.
