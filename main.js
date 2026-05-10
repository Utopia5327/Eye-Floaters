// ── error surfacing ───────────────────────────────────────────────────────────
// the preview panel hides the devtools console, so we route any failure into
// the on-page status line. otherwise a silent failure looks like "nothing
// happens" and there's nothing to debug from.
function showError(msg) {
  const s = document.getElementById('status');
  if (s) {
    s.textContent = msg;
    s.style.color = '#a02828';
    s.style.opacity = '1';
    s.classList.add('shown');
  }
  console.error('[eye-glitch]', msg);
}
window.addEventListener('error', e => showError('error: ' + (e.message || e.error)));
window.addEventListener('unhandledrejection', e => showError('error: ' + (e.reason && e.reason.message || e.reason)));

let FaceLandmarker = null, FilesetResolver = null;
async function loadMediapipe() {
  const mod = await import("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.17/vision_bundle.mjs");
  FaceLandmarker = mod.FaceLandmarker;
  FilesetResolver = mod.FilesetResolver;
}

// ── canvas ────────────────────────────────────────────────────────────────────
const canvas = document.getElementById('scene');
const ctx = canvas.getContext('2d');
let W = 0, H = 0, DPR = 1;
function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = canvas.width = Math.floor(window.innerWidth * DPR);
  H = canvas.height = Math.floor(window.innerHeight * DPR);
  canvas.style.width = window.innerWidth + 'px';
  canvas.style.height = window.innerHeight + 'px';
}
window.addEventListener('resize', resize);
resize();

// ── material textures ─────────────────────────────────────────────────────────
// Paper grain (static): a warm sepia field with low-freq fiber stains and
// high-freq pigment noise, drawn once and tiled. Multiplies under everything
// to give the canvas a paper-not-screen quality.
function makePaperTexture(size = 512) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const cx = c.getContext('2d');
  cx.fillStyle = '#f1e7d4';
  cx.fillRect(0, 0, size, size);
  // soft fiber stains
  for (let i = 0; i < 90; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const r = 25 + Math.random() * 110;
    const a = 0.02 + Math.random() * 0.035;
    const tint = Math.random() < 0.5 ? '180,150,108' : '215,195,160';
    const g = cx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(${tint},${a})`);
    g.addColorStop(1, `rgba(${tint},0)`);
    cx.fillStyle = g;
    cx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  // high-freq pigment noise
  const img = cx.getImageData(0, 0, size, size);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 16;
    img.data[i]     = clamp255(img.data[i]     + n);
    img.data[i + 1] = clamp255(img.data[i + 1] + n * 0.9);
    img.data[i + 2] = clamp255(img.data[i + 2] + n * 0.7);
  }
  cx.putImageData(img, 0, 0);
  return c;
}

// Film grain (dynamic): a small high-freq luminance texture redrawn at a
// random offset every frame. Adds the breathing "live" quality you get on
// projected film without the heaviness of per-pixel noise generation.
function makeGrain(size = 256) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const cx = c.getContext('2d');
  const img = cx.createImageData(size, size);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = Math.random() * 255;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = n;
    img.data[i + 3] = 255;
  }
  cx.putImageData(img, 0, 0);
  return c;
}

const clamp255 = v => v < 0 ? 0 : v > 255 ? 255 : v;
const lerp = (a, b, t) => a + (b - a) * t;
const lerpRGB = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

const paperTex = makePaperTexture(512);
const grainTex = makeGrain(256);
let paperPattern = null, grainPattern = null;

// ── background image (the world the floaters are seen against) ────────────────
// loaded asynchronously; until ready, we fall back to the warm wash. the image
// is panned based on gaze direction so head/eye motion shifts the world
// *opposite* (correct physics — world is fixed, eye rotated). floaters move
// *with* gaze. that contrast is the embodied feel.
let bgImage = null;
let bgImageReady = false;
const BG_CANDIDATES = ['background.jpg', 'background.jpeg', 'background.png', 'background.webp'];
(function tryLoadBg(idx = 0) {
  if (idx >= BG_CANDIDATES.length) return; // none found, stay on wash
  const img = new Image();
  img.onload = () => { bgImage = img; bgImageReady = true; };
  img.onerror = () => tryLoadBg(idx + 1);
  img.src = BG_CANDIDATES[idx];
})();

// ── blink state ───────────────────────────────────────────────────────────────
// A blink redistributes the vitreous, so real floaters resettle on each blink.
// We make the body's reflex a compositional element: every blink the eyelids
// visually sweep across the screen (dark sweep curves matching real eyelid
// geometry), then retract — mirroring what the viewer's actual body just did.
// While the eyelids cover the world, the floaters get a gentle impulse and a
// trajectory phase jitter, so when the eye reopens, the field has subtly
// reshuffled — exactly what happens in real vitreous after a blink.
let blinkActive = false;     // current physical eye state
let rawBlink = 0;            // raw blendshape value
let blinkAnimT = -1;         // -1 = idle; otherwise seconds since blink fired
const BLINK_FIRE_THRESHOLD    = 0.55;
const BLINK_RELEASE_THRESHOLD = 0.32;
const BLINK_DURATION          = 0.22; // total close-and-open arc, seconds (real ≈150-200ms)

function triggerBlink() {
  blinkAnimT = 0;
  for (const f of floaters) {
    // depth-scaled fluid slosh
    const k = 1.4 * f.depth;
    f.dispVel.x += (Math.random() - 0.5) * k;
    f.dispVel.y += (Math.random() - 0.5) * k;
    // jitter the trajectory phase so the resting positions also reshuffle a bit
    f.phase.x += (Math.random() - 0.5) * 0.45;
    f.phase.y += (Math.random() - 0.5) * 0.45;
  }
}

// draws the upper and lower eyelids closing over the screen with a curved
// inner edge. coverage=0 ⇒ retracted (off-screen); coverage=1 ⇒ fully shut.
// the curve is a quadratic bezier with the control point dipping past the
// straight edge — gives the natural eyelid shape (deeper at center, shallower
// at the corners) without resorting to anatomical drawing.
function drawEyelids(coverage) {
  if (coverage <= 0.005) return;
  // calibrated so at coverage=1 the lids overlap fully at center *and* sides:
  // side reaches 55% of H, center reaches ~65% of H (since cp = 78%, midpoint of
  // bezier = (55 + 78) / 2 = 66.5%). top + bottom mirrored ⇒ full closure.
  const sideY = coverage * 0.55 * H;
  const cpY   = coverage * 0.78 * H;

  ctx.save();
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.shadowColor = 'rgba(10,6,3,0.55)';
  ctx.shadowBlur = 14;
  ctx.fillStyle = 'rgba(10,6,3,0.97)'; // warm near-black — skin/blood-adjacent, not screen-black

  // upper eyelid
  ctx.beginPath();
  ctx.moveTo(-60, -60);
  ctx.lineTo(W + 60, -60);
  ctx.lineTo(W + 60, sideY);
  ctx.quadraticCurveTo(W * 0.5, cpY, -60, sideY);
  ctx.closePath();
  ctx.fill();

  // lower eyelid (mirrored)
  ctx.beginPath();
  ctx.moveTo(-60, H + 60);
  ctx.lineTo(W + 60, H + 60);
  ctx.lineTo(W + 60, H - sideY);
  ctx.quadraticCurveTo(W * 0.5, H - cpY, -60, H - sideY);
  ctx.closePath();
  ctx.fill();

  ctx.restore();
}

// ── floater physics ───────────────────────────────────────────────────────────
//
// Floaters are suspended inside the vitreous humor — they ride with the eye,
// not with the scene. So in the viewer's visual field they're approximately
// stationary, only perturbed when the eye accelerates. To make the field feel
// *spatial*, each floater is a fully independent object with:
//
//   • its own slow trajectory through visual-field space (Lissajous + drift
//     phase per floater, so they never move together);
//   • a stratified depth — closer floaters are larger, blurrier, and react
//     more strongly to saccades, far floaters are small/sharp/subtle. The
//     differential reaction creates real motion-parallax during eye movement;
//   • a sub-critically damped spring on its *displacement from trajectory*
//     (not on gaze) so saccadic jolts produce the signature lag→overshoot→
//     settle, but the resting position stays in the floater's own region of
//     the field rather than locked to the viewer's gaze.
//
// At rest, floaters drift very slowly (buoyancy + per-floater noise). On a
// saccade, each gets a depth-scaled impulse opposite to the eye's velocity —
// modeling the vitreous fluid pushing back as the eye accelerates.
// ─────────────────────────────────────────────────────────────────────────────

const FLOATER_COUNTS = {
  string: 9,    // wispy cobwebs
  cell:   34,   // small dark dots / cells
  ring:    3,   // Weiss-ring style translucent loops
};

// gaze coupling — applied EVERY frame, not gated. as the eye rotates the
// floater (suspended in fluid) momentarily stays in place, which shows up on
// the retina as motion *opposite* to eye direction. the magnitude is large so
// fast eye movements actually carry floaters across the field.
const GAZE_DRAG        = 4.5;   // velocity coupling — floater_dispVel -= eye_vel × depth × this
const GAZE_DRAG_MAX    = 14.0;  // cap to prevent insane noise spikes
// soft spring that pulls the displacement back to the floater's home over
// ~2-3 seconds. low stiffness + sub-critical damping = visible decay with
// a slight overshoot/settle.
const RESTORE_K        = 2.4;   // critical damping would be 2*√k ≈ 3.10
const RESTORE_D        = 0.95;
const BUOYANT_DRIFT    = 0.012; // very slow downward drift of the trajectory center
const TRAJ_SPEED       = 0.07;  // base speed of the slow trajectory wandering

const rand  = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;

class Floater {
  constructor(type, depth) {
    this.type = type;
    this.depth = depth; // 0 = far (sharp, small, subtle), 1 = close (big, blurry, reactive)

    // each floater wanders along its OWN slow trajectory — different center,
    // different amplitude, different frequency, different phase. This is what
    // makes the field feel populated rather than monolithic.
    this.center = { x: rand(-0.85, 0.85), y: rand(-0.85, 0.85) };
    this.amp    = { x: rand(0.10, 0.32),  y: rand(0.08, 0.26) };
    this.freq   = { x: rand(0.6, 1.5),    y: rand(0.5, 1.3) };
    this.phase  = { x: rand(0, Math.PI * 2), y: rand(0, Math.PI * 2) };

    // displacement from trajectory caused by saccadic disturbance. relaxes
    // back to zero through a sub-critically damped spring (= overshoot).
    this.disp    = { x: 0, y: 0 };
    this.dispVel = { x: 0, y: 0 };
    this.pos     = { x: this.center.x, y: this.center.y };

    // depth-scaled visual properties
    const dscale = 0.5 + depth * 1.1;
    if (type === 'string') {
      const length = rand(70, 180) * dscale;
      this.opacity = rand(0.05, 0.13) * (0.55 + depth * 0.7);
      this.blur    = 4 + depth * 9;
      this.lineW   = 0.7 + depth * 1.5;
      const segs   = 7 + Math.floor(Math.random() * 5);
      this.path = [];
      let a = rand(0, Math.PI * 2), r = 0;
      for (let i = 0; i < segs; i++) {
        a += rand(-0.9, 0.9);
        r += rand(length * 0.10, length * 0.22);
        this.path.push({ x: Math.cos(a) * r, y: Math.sin(a) * r, w: rand(0.4, 1.3) });
      }
    } else if (type === 'cell') {
      this.size    = rand(1.2, 4.5) * dscale;
      this.opacity = rand(0.14, 0.30) * (0.5 + depth * 0.7);
      this.blur    = 1 + depth * 6;
    } else { // ring
      this.size    = rand(16, 38) * dscale;
      this.opacity = rand(0.14, 0.26) * (0.55 + depth * 0.6);
      this.blur    = 3 + depth * 8;
      this.lineW   = 0.6 + depth * 1.2;
    }
  }

  step(dt, gazeVel) {
    // independent slow trajectory in visual-field space
    const t = performance.now() * 0.001 * TRAJ_SPEED;
    const trajX = this.center.x + Math.sin(t * this.freq.x + this.phase.x) * this.amp.x;
    const trajY = this.center.y + Math.cos(t * this.freq.y + this.phase.y) * this.amp.y;

    // continuous gaze drag: as the eye rotates, the floater stays behind in
    // the vitreous, so on the retina it shifts opposite to eye motion. depth
    // controls how far from the rotation center the floater sits — closer
    // floaters sweep further, far ones barely budge. this is what makes fast
    // eye movements visibly carry floaters across the field.
    const drag = GAZE_DRAG * this.depth;
    const dvx = clamp(-gazeVel.x * drag, -GAZE_DRAG_MAX, GAZE_DRAG_MAX);
    const dvy = clamp(-gazeVel.y * drag, -GAZE_DRAG_MAX, GAZE_DRAG_MAX);
    this.dispVel.x += dvx * dt;
    this.dispVel.y += dvy * dt;

    // sub-critically damped spring back to home (zero displacement). this is
    // the slow settling that happens after eye motion stops — fluid drag
    // eventually equalizes and the floater returns to retinal home, but
    // overshoots first because damping is below critical.
    this.dispVel.x += (-this.disp.x * RESTORE_K - this.dispVel.x * RESTORE_D) * dt;
    this.dispVel.y += (-this.disp.y * RESTORE_K - this.dispVel.y * RESTORE_D) * dt;

    this.disp.x += this.dispVel.x * dt;
    this.disp.y += this.dispVel.y * dt;

    // soft cap on displacement — a runaway noise spike shouldn't fling a
    // floater 5 screens away. allow large excursions, just not absurd ones.
    const maxDisp = 2.5;
    if (this.disp.x >  maxDisp) { this.disp.x =  maxDisp; this.dispVel.x *= 0.5; }
    if (this.disp.x < -maxDisp) { this.disp.x = -maxDisp; this.dispVel.x *= 0.5; }
    if (this.disp.y >  maxDisp) { this.disp.y =  maxDisp; this.dispVel.y *= 0.5; }
    if (this.disp.y < -maxDisp) { this.disp.y = -maxDisp; this.dispVel.y *= 0.5; }

    // very slow buoyant sinking of the trajectory itself
    this.center.y += BUOYANT_DRIFT * (0.6 + this.depth * 0.7) * dt;
    if (this.center.y > 1.2) {
      this.center.y = -1.2;
      this.center.x = rand(-0.85, 0.85);
    }

    this.pos.x = trajX + this.disp.x;
    this.pos.y = trajY + this.disp.y;
  }

  draw(ctx, opacityMul = 1) {
    const sx = (this.pos.x * 0.5 + 0.5) * W;
    const sy = (this.pos.y * 0.5 + 0.5) * H;
    const scale = (Math.min(W, H) / 900) * DPR;
    const op = this.opacity * opacityMul;
    if (op < 0.001) return;

    ctx.save();
    ctx.translate(sx, sy);
    ctx.scale(scale, scale);

    if (this.type === 'string') {
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = '#1a1108';
      ctx.beginPath();
      ctx.moveTo(this.path[0].x, this.path[0].y);
      for (let i = 1; i < this.path.length - 1; i++) {
        const p = this.path[i], n = this.path[i + 1];
        ctx.quadraticCurveTo(p.x, p.y, (p.x + n.x) / 2, (p.y + n.y) / 2);
      }
      const last = this.path[this.path.length - 1];
      ctx.lineTo(last.x, last.y);

      // ink-bleed halo: wide diffuse pass like pigment soaking into paper
      ctx.shadowColor = 'rgba(20,12,6,0.5)';
      ctx.shadowBlur = this.blur * 2.4;
      ctx.lineWidth = this.lineW * 4.5;
      ctx.globalAlpha = op * 0.18;
      ctx.stroke();

      // body strokes: layered for soft edges, tightening progressively
      ctx.shadowBlur = this.blur;
      for (let pass = 0; pass < 3; pass++) {
        ctx.lineWidth = (3.2 - pass) * this.lineW;
        ctx.globalAlpha = op * (1 - pass * 0.22);
        ctx.stroke();
      }

      // beads / nodules
      ctx.shadowBlur = this.blur * 0.5;
      ctx.fillStyle = '#0e0804';
      for (let i = 0; i < this.path.length; i += 2) {
        const p = this.path[i];
        ctx.globalAlpha = op * 1.7;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 1.3 * p.w * (0.5 + this.depth), 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (this.type === 'cell') {
      const r = this.size;
      const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, r * 2.4);
      grad.addColorStop(0,    `rgba(18,11,5,${op})`);
      grad.addColorStop(0.55, `rgba(18,11,5,${op * 0.35})`);
      grad.addColorStop(1,    'rgba(18,11,5,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(0, 0, r * 2.4, 0, Math.PI * 2);
      ctx.fill();
    } else { // ring
      ctx.strokeStyle = '#1a1108';
      ctx.shadowColor = 'rgba(20,12,6,0.3)';
      // ink-bleed halo
      ctx.shadowBlur = this.blur * 2.0;
      ctx.lineWidth = this.lineW * 3.5;
      ctx.globalAlpha = op * 0.22;
      ctx.beginPath();
      ctx.arc(0, 0, this.size, 0, Math.PI * 2);
      ctx.stroke();
      // body
      ctx.shadowBlur = this.blur;
      ctx.lineWidth = this.lineW;
      ctx.globalAlpha = op;
      ctx.beginPath();
      ctx.arc(0, 0, this.size, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.restore();
  }
}

// stratify floaters across the full depth range so we get strong parallax —
// some virtually fixed in the field, others sweeping across with eye motion.
const floaters = [];
for (const [type, count] of Object.entries(FLOATER_COUNTS)) {
  for (let i = 0; i < count; i++) {
    // even spread across [0.05, 1.0] so each floater has a distinct parallax
    const depth = 0.05 + Math.random() * 0.95;
    floaters.push(new Floater(type, depth));
  }
}
// draw far first, near last (painter's algorithm — near floaters overlap far)
floaters.sort((a, b) => a.depth - b.depth);

// ── eye tracking ──────────────────────────────────────────────────────────────
const video = document.getElementById('cam');
const status = document.getElementById('status');

let landmarker = null;
let rawGaze = { x: 0, y: 0 };
let gaze = { x: 0, y: 0 };
let gazePrev = { x: 0, y: 0 };
let gazeVel = { x: 0, y: 0 };
let lastVideoTime = -1;

const EYE = {
  L_OUTER: 33, L_INNER: 133,
  R_OUTER: 263, R_INNER: 362,
  L_IRIS: [468, 469, 470, 471, 472],
  R_IRIS: [473, 474, 475, 476, 477],
  NOSE: 1, FOREHEAD: 10,
};

function avg(lm, idx) {
  let x = 0, y = 0;
  for (const i of idx) { x += lm[i].x; y += lm[i].y; }
  return { x: x / idx.length, y: y / idx.length };
}
function mid(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }

function computeGaze(lm) {
  // iris offset relative to eye center, normalized by eye width
  const li = avg(lm, EYE.L_IRIS);
  const ri = avg(lm, EYE.R_IRIS);
  const lc = mid(lm[EYE.L_OUTER], lm[EYE.L_INNER]);
  const rc = mid(lm[EYE.R_OUTER], lm[EYE.R_INNER]);
  const lw = Math.hypot(lm[EYE.L_OUTER].x - lm[EYE.L_INNER].x, lm[EYE.L_OUTER].y - lm[EYE.L_INNER].y);
  const rw = Math.hypot(lm[EYE.R_OUTER].x - lm[EYE.R_INNER].x, lm[EYE.R_OUTER].y - lm[EYE.R_INNER].y);
  const lox = (li.x - lc.x) / lw, loy = (li.y - lc.y) / lw;
  const rox = (ri.x - rc.x) / rw, roy = (ri.y - rc.y) / rw;

  // raw camera is unmirrored: user looking right ⇒ iris in image-left ⇒ negative ox
  // we want gaze.x positive when user looks right, so flip x.
  let gx = -((lox + rox) / 2) * 4.0;
  let gy =  ((loy + roy) / 2) * 4.0;

  // augment with head pose so gaze can reach screen edges without straining the eyes
  const faceCx = (lm[EYE.L_OUTER].x + lm[EYE.R_INNER].x) / 2;
  gx += -(faceCx - 0.5) * 1.4;
  const pitch = lm[EYE.NOSE].y - lm[EYE.FOREHEAD].y;
  gy += (pitch - 0.135) * 1.6;

  return { x: clamp(gx, -1.2, 1.2), y: clamp(gy, -1.2, 1.2) };
}

async function initTracking() {
  if (!window.isSecureContext) {
    throw new Error('insecure context — camera needs https or localhost');
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('getUserMedia unavailable in this context');
  }

  status.textContent = 'loading face model…';
  status.classList.add('shown');
  await loadMediapipe();

  status.textContent = 'requesting camera…';
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: 640, height: 480, facingMode: 'user' },
    audio: false,
  });
  video.srcObject = stream;
  await new Promise(r => video.onloadedmetadata = () => { video.play(); r(); });

  status.textContent = 'initializing tracker…';
  const fileset = await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.17/wasm"
  );
  try {
    landmarker = await FaceLandmarker.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
        delegate: "GPU",
      },
      runningMode: "VIDEO",
      numFaces: 1,
      outputFaceBlendshapes: true,
    });
  } catch (e) {
    landmarker = await FaceLandmarker.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
        delegate: "CPU",
      },
      runningMode: "VIDEO",
      numFaces: 1,
      outputFaceBlendshapes: true,
    });
  }

  status.textContent = '';
  status.classList.remove('shown');
}

// ── main loop ─────────────────────────────────────────────────────────────────
let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dtRaw = (now - last) / 1000;
  last = now;
  const dt = Math.min(dtRaw, 1 / 30);

  if (landmarker && video.readyState >= 2 && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    const res = landmarker.detectForVideo(video, now);
    if (res.faceLandmarks && res.faceLandmarks[0]) {
      rawGaze = computeGaze(res.faceLandmarks[0]);
    }
    if (res.faceBlendshapes && res.faceBlendshapes[0]) {
      const cats = res.faceBlendshapes[0].categories;
      let lb = 0, rb = 0;
      for (const c of cats) {
        if (c.categoryName === 'eyeBlinkLeft')  lb = c.score;
        if (c.categoryName === 'eyeBlinkRight') rb = c.score;
      }
      rawBlink = (lb + rb) * 0.5;
    }
  }

  // blink state machine — fire on rising edge, release on falling. only one
  // event per blink, even if the value oscillates around the threshold.
  if (!blinkActive && rawBlink > BLINK_FIRE_THRESHOLD) {
    blinkActive = true;
    triggerBlink();
  } else if (blinkActive && rawBlink < BLINK_RELEASE_THRESHOLD) {
    blinkActive = false;
  }
  // advance eyelid animation. coverage follows a sin(πt) envelope so it closes
  // smoothly to peak then opens again over BLINK_DURATION.
  let blinkCoverage = 0;
  if (blinkAnimT >= 0) {
    blinkAnimT += dt;
    const tt = blinkAnimT / BLINK_DURATION;
    if (tt >= 1) {
      blinkAnimT = -1;
    } else {
      blinkCoverage = Math.sin(tt * Math.PI);
    }
  }

  // smooth raw gaze (low-pass) before computing velocity
  const a = 0.22;
  gaze.x += (rawGaze.x - gaze.x) * a;
  gaze.y += (rawGaze.y - gaze.y) * a;

  gazeVel.x = (gaze.x - gazePrev.x) / Math.max(dt, 0.001);
  gazeVel.y = (gaze.y - gazePrev.y) / Math.max(dt, 0.001);
  gazePrev.x = gaze.x;
  gazePrev.y = gaze.y;

  // ── background ──
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;

  if (bgImageReady) {
    // panoramic image: fit-to-cover with a small extra zoom so we have pan
    // room in both axes. shift opposite to gaze (world stays fixed in space,
    // viewer's eye/head rotated).
    const img = bgImage;
    const scale = Math.max(W / img.width, H / img.height) * 1.18;
    const drawW = img.width * scale;
    const drawH = img.height * scale;
    const maxPanX = (drawW - W) * 0.5;
    const maxPanY = (drawH - H) * 0.5;
    const panX = clamp(gaze.x, -1, 1) * maxPanX;
    const panY = clamp(gaze.y, -1, 1) * maxPanY;
    const xOff = (W - drawW) * 0.5 - panX;
    const yOff = (H - drawH) * 0.5 - panY;

    // soft treatment so the image stays a *condition of seeing*, not content:
    // slight blur (out-of-focus periphery), desaturate, gentle brightness lift
    ctx.save();
    ctx.filter = 'blur(2px) saturate(0.55) brightness(1.06) contrast(0.92)';
    ctx.drawImage(img, xOff, yOff, drawW, drawH);
    ctx.filter = 'none';

    // warm overlay tint to unify with the rest of the palette
    const tWarm = now * 0.00004;
    const warmth = (Math.sin(tWarm) + 1) * 0.5;
    const tint = lerpRGB([245, 232, 208], [232, 215, 188], warmth);
    ctx.globalCompositeOperation = 'multiply';
    ctx.globalAlpha = 0.18;
    ctx.fillStyle = `rgb(${tint.map(Math.round).join(',')})`;
    ctx.fillRect(0, 0, W, H);

    // soft vignette to focus the eye toward center
    ctx.globalCompositeOperation = 'multiply';
    ctx.globalAlpha = 1;
    const vig = ctx.createRadialGradient(W * 0.5, H * 0.5, Math.min(W, H) * 0.2, W * 0.5, H * 0.5, Math.max(W, H) * 0.7);
    vig.addColorStop(0, 'rgba(255,255,255,1)');
    vig.addColorStop(1, 'rgba(160,140,110,1)');
    ctx.fillStyle = vig;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  } else {
    // fallback: warm radial wash with slow palette modulation
    const tWarm = now * 0.00004;
    const warmth = (Math.sin(tWarm) + 1) * 0.5;
    const inner = lerpRGB([252, 246, 232], [246, 236, 215], warmth);
    const outer = lerpRGB([212, 192, 162], [196, 170, 135], warmth);
    const wash = ctx.createRadialGradient(W * 0.5, H * 0.45, 0, W * 0.5, H * 0.5, Math.max(W, H) * 0.75);
    wash.addColorStop(0, `rgb(${inner.map(Math.round).join(',')})`);
    wash.addColorStop(1, `rgb(${outer.map(Math.round).join(',')})`);
    ctx.fillStyle = wash;
    ctx.fillRect(0, 0, W, H);

    // paper-fiber overlay only on the wash (would muddy a real image)
    if (!paperPattern) paperPattern = ctx.createPattern(paperTex, 'repeat');
    ctx.globalCompositeOperation = 'multiply';
    ctx.globalAlpha = 0.28;
    ctx.fillStyle = paperPattern;
    ctx.fillRect(0, 0, W, H);
  }

  // ── floaters ──
  // eyelid sweep handles the visual cover; floaters keep near-full opacity so
  // they remain recognizable in the partial moments of the blink envelope.
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  const floaterOpacityMul = 1 - blinkCoverage * 0.25;
  for (const f of floaters) {
    f.step(dt, gazeVel);
    f.draw(ctx, floaterOpacityMul);
  }

  // ── film grain: per-frame breath, very low opacity ──
  if (!grainPattern) grainPattern = ctx.createPattern(grainTex, 'repeat');
  ctx.save();
  ctx.globalCompositeOperation = 'soft-light';
  ctx.globalAlpha = 0.07;
  ctx.translate(-Math.random() * grainTex.width, -Math.random() * grainTex.height);
  ctx.fillStyle = grainPattern;
  ctx.fillRect(0, 0, W + grainTex.width, H + grainTex.height);
  ctx.restore();

  // ── eyelid sweep (drawn last, covers everything during a blink) ──
  drawEyelids(blinkCoverage);
}

requestAnimationFrame(frame);

// ── entry / about / nav wiring ────────────────────────────────────────────────
const entry         = document.getElementById('entry');
const enterBtn      = document.getElementById('enterBtn');
const aboutEntryBtn = document.getElementById('aboutEntryBtn');
const aboutPanel    = document.getElementById('about-panel');
const closeAboutBtn = document.getElementById('closeAboutBtn');
const aboutLink     = document.getElementById('about-link');
const homeLink      = document.getElementById('home-link');
const nav           = document.getElementById('nav');

let started = false;
async function startExperience() {
  entry.classList.add('gone');
  nav.classList.add('shown');           // nav fades in alongside the entry fade-out
  if (started) return;                  // re-entering = just hide the overlay
  started = true;
  status.textContent = 'starting…';
  status.classList.add('shown');
  try {
    await initTracking();
    status.textContent = 'tracking';
    setTimeout(() => status.classList.remove('shown'), 900);
  } catch (e) {
    showError('camera/tracker failed: ' + (e && e.message || e) + ' — ambient mode');
  }
}

function backToLanding() {
  // bring the entry overlay back. tracking + floaters keep running quietly
  // behind the frosted glass, so re-entering is instant.
  entry.classList.remove('gone');
  nav.classList.remove('shown');
}

function openAbout()  { aboutPanel.classList.add('open'); }
function closeAbout() { aboutPanel.classList.remove('open'); }

enterBtn.addEventListener('click', startExperience);
aboutEntryBtn.addEventListener('click', openAbout);
aboutLink.addEventListener('click', openAbout);
homeLink.addEventListener('click', backToLanding);
closeAboutBtn.addEventListener('click', closeAbout);

aboutPanel.addEventListener('click', (e) => {
  if (e.target === aboutPanel) closeAbout();
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && aboutPanel.classList.contains('open')) closeAbout();
});
