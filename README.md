# 🛰️ GOES Stitcher

Turn a **SatDump GOES HRIT** output folder into **time-lapses** and **toggleable Level-2 data overlays** — entirely in your browser. Nothing is uploaded; the page reads your folder locally and does all decoding and rendering on your machine.

![mode: time-lapse + overlay](https://img.shields.io/badge/modes-time--lapse%20%2B%20L2%20overlay-38ccff) ![runs](https://img.shields.io/badge/runs-100%25%20client--side-45d69a)

## What it does

- **Time-lapse** — pick a satellite / region / product (composite, raw ABI band, or L2), and every scan across time is stitched into a smooth loop you can **play, scrub, loop**, burn a UTC timestamp into, and **export as WebM** (or save a single frame as PNG).
- **L2 overlay** — put a base disk image down and stack **Level-2 layers** (rain rate, cloud-top height/temperature, CAPE, total precipitable water) on top, each with its own **opacity** and **blend mode**, plus a coastline toggle. Save the composite as a **PNG**.

Both modes read one shared, automatically-built index of your folder, so switching satellite/region/mode is instant.

## Use it

### Hosted (recommended)
Open the deployed page and click **Choose folder…** (or drag a folder onto it), then point it at a SatDump session — e.g. `2026-07-04_17-10_goes_hrit_1.6941 GHz` — **or** at a parent folder containing several sessions (each is detected).

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
| `t` / `o` | switch to **t**ime-lapse / **o**verlay (`m` toggles) |
| `b` | build the time-lapse |
| `space` | play / pause |
| `←` / `→` | step frames |
| `e` | export WebM · `s` | save PNG |

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

No build step, no bundler, no dependencies.

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
- Grayscale single-band L2 duplicates (`G19_ACHT_…`), `product.cbor`, stray `… copy.png`, and non-standard folders (e.g. `NWS/`) are ignored by the two modes.
- **Note:** overlay layers of different native resolutions (e.g. 5424² vs 1086²) line up because all full-disk products share the same earth extent; they're scaled to a common working canvas.

## Tips

- **Full-disk images are large (5424², 15–37 MB each).** The app downscales for playback/memory; start at **1024 px** and bump to 2048/native only if you need it.
- **WebM → MP4:** WebM exports play in browsers. To get an MP4 (e.g. for social media) with `ffmpeg`:
  ```bash
  ffmpeg -i timelapse.webm -c:v libx264 -pix_fmt yuv420p -movflags +faststart timelapse.mp4
  ```
- **Browser support:** Chrome / Edge / Firefox for WebM export. Safari can view and save PNGs but its WebM recording is unreliable (the app tells you if export isn't available).

## How it's built

Plain HTML/CSS/JS, no dependencies. A "ground-station terminal" (TUI) look: self-hosted [IBM Plex Mono](https://github.com/IBM/plex) + [Departure Mono](https://departuremono.com/) (both OFL), so it renders identically offline and on Pages with **no external requests**.

| File | Role |
| --- | --- |
| `index.html` | markup + script includes |
| `assets/styles.css` | terminal theme |
| `assets/fonts/` | self-hosted mono webfonts |
| `src/catalog.js` | ABI band + L2 product metadata / names |
| `src/scanner.js` | folder → `session → sat → region → product → frames` index |
| `src/imaging.js` | decode/downscale, compositing, WebM export, downloads |
| `src/timelapse.js` | time-lapse mode |
| `src/overlay.js` | L2 overlay mode |
| `src/app.js` | folder picking, selectors, mode lifecycle, `GS.dom` |

## License

MIT — see below. Not affiliated with NOAA/NASA; GOES imagery is public-domain data you received yourself.
