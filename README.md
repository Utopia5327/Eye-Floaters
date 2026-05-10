# Floaters

*The cobwebs drifting in your eyes you've stopped paying attention to.*

A browser-based art piece that brings the floaters in your eyes onto a screen. Real vitreous physics, webcam eye tracking, blink detection.

[→ Try it live](https://utopia5327.github.io/Eye-Floaters/)

---

## About

There are little shapes drifting in your eyes — cobwebs, fibers, faint specks. You've had them since you were a kid. You probably stopped seeing them.

One morning I noticed mine again. So I put them on a screen.

They're tiny fragments suspended in the gel that fills the eye, casting soft shadows on the retina. They lag and overshoot as you look around. A blink reshuffles them. They accumulate over a lifetime — a quiet clock.

## How it works

Everything runs in the browser, no server.

- **Eye tracking** — [MediaPipe FaceLandmarker](https://developers.google.com/mediapipe/solutions/vision/face_landmarker) gives gaze direction and blink blendshapes. Zero per-user calibration.
- **Floater physics** — each floater is a particle on a sub-critically damped spring with continuous gaze-velocity coupling. Closer floaters (higher depth) sweep more during eye motion; far floaters barely move. The differential is what reads as motion parallax.
- **Blink as compositional gesture** — every blink, the upper and lower eyelids visually sweep over the field, and the floaters get a fluid-slosh impulse that reshuffles their resting positions slightly.
- **Material** — paper-fiber texture, slow palette modulation, ink-bleed halos around the strings, per-frame film grain.
- **Background** — a wide panoramic image, panned opposite to gaze direction so the world stays fixed in space while floaters move with the eye.

## Run it locally

The camera API requires HTTPS or `localhost`, so you need a tiny local server:

```bash
git clone https://github.com/Utopia5327/Eye-Floaters.git
cd Eye-Floaters
python -m http.server 8000
```

Then open `http://localhost:8000` in Chrome (or any modern Chromium browser). Allow camera access when prompted. Best with the lights on you.

## Built with

- [MediaPipe Tasks Vision](https://developers.google.com/mediapipe) — face landmarks + blendshapes
- HTML5 Canvas — rendering and physics
- [Claude](https://claude.ai/code) — AI collaborator across a series of conversations

> I knew what I'd been watching. Claude wrote the math — eye tracking, fluid physics, the right damping for the floaters to feel real. The piece is the translation between the two.

---

— Manas Bhatia, 2026
