# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

**Floaters** is a single-page browser art piece — no framework, no build step, no npm. The entire project is two files: `index.html` (structure + CSS) and `main.js` (everything else). A `background.jpg` is panned by gaze if present; without it the fallback is a blue gradient.

## Running locally

The camera API requires HTTPS or `localhost`:

```bash
python -m http.server 8000
# then open http://localhost:8000 in Chrome
```

No install step. No bundler. No tests. Open the file, test it in the browser.

## Architecture

Everything lives in `main.js` as a single flat module. Read-order mirrors execution order:

| Section | What it does |
|---|---|
| `showError` | Routes JS errors to the on-page `#status` bar |
| `loadMediapipe()` | Lazy-loads MediaPipe FaceLandmarker from CDN |
| Canvas / resize | DPR-aware canvas sizing |
| `makePaperTexture` / `makeGrain` | Offscreen textures: static paper grain + per-frame film grain |
| Background image loader | Loads `background.jpg`; falls back to blue gradient |
| `BLINK_VOICES` + `loadVoicesFromSheet()` | 20 hardcoded first-person floater descriptions; `loadVoicesFromSheet()` prepends live Google Sheets submissions at page load |
| `submitVoice()` + `wireVoiceInput()` | no-cors POST to Google Forms; wires both entry-screen and about-panel inputs |
| Blink state machine | Threshold hysteresis on MediaPipe blendshapes → `triggerBlink()`: physics impulse + white flash + blink-text voice |
| `FloaterAudio` class | Procedural Web Audio: drone + saccade tones + blink pulse |
| `Floater` class | Per-floater physics + draw. Two types: `strand`, `knot` |
| `floaters[]` array | 15 floaters (10 strand + 5 knot), stratified depth 0.05–1.0, sorted far→near |
| Eye tracking | MediaPipe → `computeGaze()` → iris offset + head-pose augmentation |
| `drawEyeMonitor()` | Schematic eye HUD (almond shapes + iris dots) in `#eye-monitor` canvas |
| `initTracking()` | Requests camera, loads model, GPU→CPU fallback |
| `frame()` loop | `requestAnimationFrame` — background → floaters → grain → blink flash |
| Entry/nav wiring | Button event listeners, `startExperience()`, `backToLanding()` |
| `animateTitleDrift` | Per-letter Lissajous drift on the `<h1>` title spans |

## Key physics constants

- `GAZE_DRAG` / `GAZE_DRAG_MAX` — how strongly eye velocity deflects floaters (28 / 95)
- `RESTORE_K` / `RESTORE_D` — spring stiffness/damping, sub-critical so floaters overshoot (1.1 / 0.32)
- `FIXATION_VEL_THRESHOLD` / `FOVEA_RADIUS` / `REPULSION_FORCE` — the slip-away behavior (5.0 / 0.75 / 220)
- No gravity constants — floaters are intentionally neutrally buoyant, no falling

## CSS design tokens

`index.html` has two CSS blocks:
1. Original warm-paper tokens on `:root` (`--ink`, `--paper`, etc.) — used for base styles
2. A **dark system override block** at the bottom of `<style>` that replaces all backgrounds and text colors with a deep black glass aesthetic (`#06060a` background). The dark block wins everywhere in the actual experience.

Font roles: `--sans` (SF Pro / system UI) and `--display` (Cormorant Garamond italic, display text and blink voices only).

## Gaze coordinate system

Gaze is in `[-1.2, 1.2]²` normalized visual-field space. `+x` = user looking right, `+y` = user looking down. The background pans *opposite* to gaze (world stays fixed); floaters move *with* gaze (suspended in vitreous). Two gaze signals: `gaze` (alpha=0.42, fast, drives floaters) and `bgGaze` (alpha=0.07, slow, drives background pan).

## Participatory voice system

Google Form: `https://forms.gle/MMdzeZid9JXdZRd86`
Form POST URL: `https://docs.google.com/forms/d/e/1FAIpQLSdsgI-TnrmwOllHhinmQrjSvhuR7Sj3H2hZ5DdkbzsiHxun_w/formResponse`
Field entry ID: `entry.1730490316`
Sheet CSV: `https://docs.google.com/spreadsheets/d/1rwpIkz9TRUfD6JmmsUml-LssfUU9EUaG7_4RpUutzHs/export?format=csv&gid=960665220`

Inline inputs on both the landing page and about panel submit silently via `wireVoiceInput()`. The Sheet must remain public (Anyone with link → Viewer) for the CSV fetch to work.

## Constraints

- **Camera requires a secure context** — `localhost` or HTTPS only. A plain `file://` open will fail silently.
- **No audio without a user gesture** — `FloaterAudio.start()` must be called inside a click handler.
- **MediaPipe and model weights load from CDN** — the piece needs a network connection on first load.
- **Chrome / Chromium strongly preferred** — MediaPipe GPU delegate and some canvas compositing may behave differently in other browsers.
- **No scene switching** — the multi-scene system was removed. There is one background only. Do not reintroduce `pendingScene` / `currentScene`.
- **No eyelid sweep** — `drawEyelids()` was removed. Blink is expressed through the white flash and voice text only.
