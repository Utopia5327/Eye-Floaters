# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

**Floaters** is a single-page browser art piece — no framework, no build step, no npm. The entire project is two files: `index.html` (structure + CSS) and `main.js` (everything else). A `background.jpg` is panned by gaze if present; without it the fallback is a warm radial wash.

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
| `showError` | Routes JS errors to the on-page `#status` bar (DevTools is hidden in preview) |
| `loadMediapipe()` | Lazy-loads MediaPipe FaceLandmarker from CDN |
| Canvas / resize | DPR-aware canvas sizing |
| `makePaperTexture` / `makeGrain` | Offscreen textures drawn once (paper) or per-frame (grain) |
| Background image loader | Tries `background.{jpg,jpeg,png,webp}` in order; falls back to warm wash |
| Blink state machine | Threshold hysteresis on MediaPipe blendshapes → `triggerBlink()` |
| `FloaterAudio` class | Procedural Web Audio: drone + saccade tones + blink pulse |
| `drawEyelids(coverage)` | Quadratic-bezier eyelid sweep drawn over everything during a blink |
| `Floater` class | Per-floater physics + draw. Three types: `string`, `cell`, `ring` |
| `floaters[]` array | 79 floaters stratified across depth 0.05–1.0, sorted far→near |
| Eye tracking | MediaPipe → `computeGaze()` → iris offset + head-pose augmentation |
| `drawEyeMonitor()` | Cropped webcam feed + eyelid perimeter + iris markers in `#eye-monitor` |
| `initTracking()` | Requests camera, loads model, GPU→CPU fallback |
| `frame()` loop | `requestAnimationFrame` — background → floaters → grain → eyelids |
| Entry/nav wiring | Button event listeners, `startExperience()`, `backToLanding()` |
| `animateTitleDrift` | Per-letter Lissajous drift on the `<h1>` title spans |

## Key physics constants (top of `main.js`)

- `GAZE_DRAG` / `GAZE_DRAG_MAX` — how strongly eye velocity deflects floaters
- `RESTORE_K` / `RESTORE_D` — spring stiffness/damping (sub-critical = overshoot)
- `BUOYANT_DRIFT` — slow downward sinking of each floater's home position
- `FIXATION_VEL_THRESHOLD` / `FOVEA_RADIUS` / `REPULSION_FORCE` — the slip-away behavior

## CSS design tokens (top of `index.html`)

All colors come from CSS custom properties on `:root`: `--ink`, `--ink-mid`, `--ink-faint`, `--paper`, `--paper-warm`. Font roles are `--sans` (UI) and `--display` (Cormorant Garamond italic, titles only).

## Gaze coordinate system

Gaze is in `[-1.2, 1.2]²` normalized visual-field space. `+x` = user looking right, `+y` = user looking down. The background pans *opposite* to gaze (world stays fixed); floaters move *with* gaze (suspended in vitreous). That contrast is the embodied core of the piece.

## Constraints

- **Camera requires a secure context** — `localhost` or HTTPS only. A plain `file://` open will fail silently.
- **No audio without a user gesture** — `FloaterAudio.start()` must be called inside a click handler.
- **MediaPipe and model weights load from CDN** — the piece needs a network connection on first load.
- **Chrome / Chromium strongly preferred** — MediaPipe GPU delegate and some canvas compositing may behave differently in other browsers.
