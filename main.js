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

const grainTex = makeGrain(256);
let grainPattern = null;

// ── background ────────────────────────────────────────────────────────────────
const bgImg = new Image();
bgImg.src = 'background.jpg';

// ── voices from the world ─────────────────────────────────────────────────────
// Loaded from Reddit on startup — real people describing their own floaters.
// Falls back to a small curated set if the fetch fails.
const VOICE_FALLBACKS = [
  "Mine have been with me my whole life. One long thread and a few dots.",
  "I have a big one shaped like a worm. I've made peace with it.",
  "After my vitreous detachment at 45 I got dozens. Like a snow globe.",
  "Just one cobweb. I forget about it for months, then suddenly there it is.",
  "Mine look like a transparent jellyfish. Fascinating and maddening.",
];
let blinkVoices = [...VOICE_FALLBACKS];
let blinkVoiceIndex = 0;
let blinkVoiceTimer = null;

async function loadVoices() {
  // Reddit blocks direct browser fetch (CORS). Route through a free proxy.
  const proxy = 'https://corsproxy.io/?';
  const urls = [
    'https://www.reddit.com/r/eyefloaters/top.json?limit=100&t=all',
    'https://www.reddit.com/search.json?q=eye+floaters&sort=top&t=all&limit=100&type=link',
  ];
  for (const url of urls) {
    try {
      const res = await fetch(proxy + encodeURIComponent(url));
      if (!res.ok) continue;
      const json = await res.json();
      const posts = json.data?.children ?? [];
      const voices = posts
        .map(p => (p.data.selftext?.trim() || p.data.title?.trim()) ?? '')
        .filter(t => t.length > 60 && t.length < 400
                  && !/http/i.test(t)
                  && /\bI\b|\bmine\b|\bmy\b/i.test(t))
        .map(t => {
          const s = t.split(/[.!?]/)[0].trim();
          return s.length > 40 ? s + '.' : t.slice(0, 220).trim();
        });
      if (voices.length >= 4) {
        for (let i = voices.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [voices[i], voices[j]] = [voices[j], voices[i]];
        }
        blinkVoices = voices;
        return;
      }
    } catch (_) { /* try next url */ }
  }
  // both failed — fallbacks already set
}

// ── blink state ───────────────────────────────────────────────────────────────
// A blink redistributes the vitreous, so real floaters resettle on each blink.
// We make the body's reflex a compositional element: every blink the eyelids
// visually sweep across the screen (dark sweep curves matching real eyelid
// geometry), then retract — mirroring what the viewer's actual body just did.
// While the eyelids cover the world, the floaters get a gentle impulse and a
// trajectory phase jitter, so when the eye reopens, the field has subtly
// reshuffled — exactly what happens in real vitreous after a blink.
let blinkActive = false;
let rawBlink = 0;
let blinkAnimT = -1;
let blinkCoverage = 0;
let blinkFlashT  = -1;
const BLINK_FIRE_THRESHOLD    = 0.36;
const BLINK_RELEASE_THRESHOLD = 0.16;
const BLINK_DURATION          = 0.13;


function triggerBlink() {
  blinkAnimT  = 0;
  blinkFlashT = 0;
  for (const f of floaters) {
    const k = 1.4 * f.depth;
    f.dispVel.x += (Math.random() - 0.5) * k;
    f.dispVel.y += (Math.random() - 0.5) * k;
    f.phase.x   += (Math.random() - 0.5) * 0.45;
    f.phase.y   += (Math.random() - 0.5) * 0.45;
  }
  audio.blink();

  // surface the next voice on each blink
  const el = document.getElementById('blink-text');
  if (el) {
    el.textContent = BLINK_VOICES[blinkVoiceIndex % BLINK_VOICES.length];
    blinkVoiceIndex++;
    el.classList.add('visible');
    clearTimeout(blinkVoiceTimer);
    blinkVoiceTimer = setTimeout(() => el.classList.remove('visible'), 2800);
  }
}

// ── sound design ─────────────────────────────────────────────────────────────
// three layers, all generated procedurally (no audio files):
//   • drone: three detuned sines at a fundamental + 5th + octave, passed
//     through a slowly-modulated low-pass filter. the breath of the piece.
//   • saccade tone: each fast eye movement triggers a soft bell-like sine on
//     a pitch picked from a pentatonic-ish scale. the rhythm of looking
//     becomes the rhythm of the music.
//   • blink pulse: each blink fires a low warm tone — a quiet body sound.
// audio context can only be created on a user gesture, so we initialize it
// inside startExperience(). a master gain fades in over ~1.5s so sound
// emerges with the experience rather than punching in.

class FloaterAudio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.muted = false;
    this.lastSaccadeTime = 0;
    this.targetGain = 0.32;
  }

  async start() {
    if (this.ctx) return;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) {
        showError('audio: no Web Audio API support');
        return;
      }
      this.ctx = new Ctx();
      // always try to resume — some browsers create as suspended even after
      // a user gesture, and resume is idempotent if already running
      try { await this.ctx.resume(); } catch (_) {}

      this.master = this.ctx.createGain();
      this.master.gain.value = 0;
      this.master.connect(this.ctx.destination);
      // quick fade-in so sound is clearly audible within ~0.5s of clicking begin
      this.master.gain.setTargetAtTime(this.muted ? 0 : this.targetGain,
                                       this.ctx.currentTime, 0.4);

      // drone — detuned triad in a register laptop speakers actually reproduce.
      // root + perfect fifth + octave, each oscillator getting equal weight.
      const droneOut = this.ctx.createGain();
      droneOut.gain.value = 0.32;

      const filter = this.ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 1200;
      filter.Q.value = 0.7;

      droneOut.connect(filter);
      filter.connect(this.master);

      for (const f of [220, 330.4, 440.8]) {
        const o = this.ctx.createOscillator();
        o.type = 'sine';
        o.frequency.value = f;
        const g = this.ctx.createGain();
        g.gain.value = 0.33;
        o.connect(g);
        g.connect(droneOut);
        o.start();
      }

      // slow LFO on filter cutoff — drone breath
      const lfo = this.ctx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = 0.045; // ~22 second period
      const lfoGain = this.ctx.createGain();
      lfoGain.gain.value = 350;
      lfo.connect(lfoGain);
      lfoGain.connect(filter.frequency);
      lfo.start();
    } catch (e) {
      showError('audio failed to start: ' + (e && e.message || e));
      this.ctx = null;
    }
  }

  saccade(velocity) {
    if (!this.ctx || !this.master || this.muted) return;
    const now = this.ctx.currentTime;
    if (now - this.lastSaccadeTime < 0.18) return; // throttle
    this.lastSaccadeTime = now;

    // pentatonic palette an octave higher than before — squarely in the range
    // laptop speakers handle well
    const pitches = [440, 554, 659, 740, 880, 988, 1109];
    const pitch = pitches[Math.floor(Math.random() * pitches.length)];

    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = pitch;

    const g = this.ctx.createGain();
    const peak = Math.min(0.12, velocity * 0.018);
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(peak, now + 0.025);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 1.1);

    o.connect(g);
    g.connect(this.master);
    o.start(now);
    o.stop(now + 1.1);
  }

  blink() {
    if (!this.ctx || !this.master || this.muted) return;
    const now = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = 146.8; // D3 — warm but audible on laptop speakers
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(0.10, now + 0.04);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.55);
    o.connect(g);
    g.connect(this.master);
    o.start(now);
    o.stop(now + 0.55);
  }

  toggleMute() {
    this.muted = !this.muted;
    if (this.ctx && this.master) {
      this.master.gain.setTargetAtTime(this.muted ? 0 : this.targetGain,
                                       this.ctx.currentTime, 0.3);
    }
    return this.muted;
  }
}

const audio = new FloaterAudio();
let saccadeFired = false;
const SACCADE_AUDIO_TRIGGER = 2.4; // gaze-speed at which a saccade tone fires
const SACCADE_AUDIO_RESET   = 1.0; // drop below this to re-arm


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
  strand: 10, // long sinuous threads — the dominant real floater type
  knot:   5,  // tangled knotted clusters — where strands curl on themselves
};

// gaze coupling — applied EVERY frame, not gated. as the eye rotates the
// floater (suspended in fluid) momentarily stays in place, which shows up on
// the retina as motion *opposite* to eye direction. cranked high so fast eye
// movements really do whip floaters across the field, the way real ones do.
const GAZE_DRAG        = 28.0;  // velocity coupling — floater_dispVel += eye_vel × depth × this
const GAZE_DRAG_MAX    = 95.0;  // per-frame cap — high enough for a real saccade rush, low enough to prevent runaway
// loose spring back to home — low stiffness + low damping means a saccade-
// induced excursion oscillates for a couple seconds before settling, so
// floaters are *always* moving, never landing on a stable point.
const RESTORE_K        = 1.1;   // softer spring — floaters drift longer before settling
const RESTORE_D        = 0.32;  // lower damping — post-saccade coast is more visible
const TRAJ_SPEED        = 0.34;  // autonomous wandering speed

// fixation slip — the conceptual core of the piece. real floaters slip away
// when you try to look at one, because the eye moves toward the floater and
// the floater moves with the eye (it's suspended in vitreous fluid), so the
// fovea never catches up. modeled here as a repulsive force centered on the
// gaze point, active only when gaze is relatively still. floaters very near
// the fovea push outward with a quadratic falloff; outside the fovea radius
// they're unaffected. during saccades (high gazeVel) the slip turns off so
// you can see floaters streak across the field unimpeded.
const FIXATION_VEL_THRESHOLD = 5.0;  // lenient — tracker noise won't block fixation detection
const FOVEA_RADIUS           = 0.75; // wide zone — catches even imprecise gaze alignment
const REPULSION_FORCE        = 220;  // floater darts away fast — conceptual core of the piece

const rand  = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;

class Floater {
  constructor(type, depth) {
    this.type = type;
    this.depth = depth; // 0 = far (sharp, small, subtle), 1 = close (big, blurry, reactive)

    // each floater wanders along its OWN slow trajectory — different center,
    // different amplitude, different frequency, different phase. amplitudes
    // are large so each floater traverses a real region of the field over
    // time, never settling at a single point.
    this.center = { x: rand(-0.7, 0.7),  y: rand(-1.0, 0.0) }; // start in sky
    // tiny Lissajous — just enough for organic breathing motion.
    // large amplitudes used to swamp the gravity signal, making falling invisible.
    this.amp    = { x: rand(0.07, 0.18), y: rand(0.02, 0.07) }; // wider x for lateral wander
    this.freq   = { x: rand(0.5, 1.4),   y: rand(0.4, 1.2) };
    this.phase  = { x: rand(0, Math.PI * 2), y: rand(0, Math.PI * 2) };

    // displacement from trajectory caused by saccadic disturbance. relaxes
    // back to zero through a sub-critically damped spring (= overshoot).
    this.disp    = { x: 0, y: 0 };
    this.dispVel = { x: 0, y: 0 };
    this.pos     = { x: this.center.x, y: this.center.y };

    // slow lateral drift — each floater wanders horizontally at its own pace
    this.vel  = { x: (Math.random() - 0.5) * 0.04 };
    this.gravX = (Math.random() - 0.5) * 0.06;

    // All floaters are paths — arrays of {x,y} in local space.
    // Generated as polylines with many short segments so the shapes are
    // genuinely wiggly and organic, not smooth or geometric.
    const dscale = 0.6 + depth * 1.2;

    if (type === 'strand') {
      const numSegs  = 14 + Math.floor(Math.random() * 10); // 14–23 segments (fewer = faster)
      const totalLen = rand(160, 400) * dscale;
      const segLen   = totalLen / numSegs;
      this.opacity = rand(0.30, 0.54);
      this.blur    = 1.5 + depth * 4.0;
      this.lineW   = 7 + depth * 16;
      let a = rand(0, Math.PI * 2);
      let x = 0, y = 0;
      this.path = [{ x, y }];
      for (let i = 0; i < numSegs; i++) {
        a += rand(-0.28, 0.28) + Math.sin(i * 0.4 + this.phase.x) * 0.08;
        x += Math.cos(a) * segLen;
        y += Math.sin(a) * segLen;
        this.path.push({ x, y });
      }

    } else { // knot
      const numSegs = 10 + Math.floor(Math.random() * 7); // 10–16 segments (was 18–29)
      const segLen  = rand(12, 30) * dscale;
      this.opacity = rand(0.24, 0.44);
      this.blur    = 1.5 + depth * 4.5;
      this.lineW   = 8 + depth * 14;
      let a = rand(0, Math.PI * 2);
      let x = 0, y = 0;
      this.path = [{ x, y }];
      for (let i = 0; i < numSegs; i++) {
        a += rand(-0.82, 0.82);
        x += Math.cos(a) * segLen * rand(0.5, 1.4);
        y += Math.sin(a) * segLen * rand(0.5, 1.4);
        this.path.push({ x, y });
      }
    }
  }

  step(dt, gaze, gazeVel) {
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
    // positive coupling: floaters sweep WITH eye direction (intuitive for gallery visitors)
    const dvx = clamp(gazeVel.x * drag, -GAZE_DRAG_MAX, GAZE_DRAG_MAX);
    const dvy = clamp(gazeVel.y * drag, -GAZE_DRAG_MAX, GAZE_DRAG_MAX);
    this.dispVel.x += dvx * dt;
    this.dispVel.y += dvy * dt;

    // fixation slip — when the eye tries to fixate near a floater, the floater
    // slides away. only active when gaze is relatively still (saccades pass
    // through unimpeded). the closer the floater is to the fovea center, the
    // harder it pushes outward — quadratic falloff so the effect is sharp at
    // the center and fades to nothing at the fovea's edge.
    const gazeSpeed = Math.hypot(gazeVel.x, gazeVel.y);
    if (gazeSpeed < FIXATION_VEL_THRESHOLD) {
      const fixationStrength = 1 - gazeSpeed / FIXATION_VEL_THRESHOLD;
      const dx = this.pos.x - gaze.x;
      const dy = this.pos.y - gaze.y;
      const dist = Math.hypot(dx, dy);
      if (dist < FOVEA_RADIUS && dist > 0.001) {
        const proximity = 1 - dist / FOVEA_RADIUS; // 1 at center, 0 at edge
        const strength = proximity * REPULSION_FORCE * fixationStrength;
        const nx = dx / dist;
        const ny = dy / dist;
        this.dispVel.x += nx * strength * dt;
        this.dispVel.y += ny * strength * dt;
      }
    }

    // sub-critically damped spring back to home (zero displacement). this is
    // the slow settling that happens after eye motion stops — fluid drag
    // eventually equalizes and the floater returns to retinal home, but
    // overshoots first because damping is below critical.
    this.dispVel.x += (-this.disp.x * RESTORE_K - this.dispVel.x * RESTORE_D) * dt;
    this.dispVel.y += (-this.disp.y * RESTORE_K - this.dispVel.y * RESTORE_D) * dt;

    this.disp.x += this.dispVel.x * dt;
    this.disp.y += this.dispVel.y * dt;

    // hard displacement cap — keeps floaters on-screen. inelastic: kill the
    // escape-direction velocity so impulses can't accumulate through the wall.
    const maxDisp = 0.8;
    if (this.disp.x >  maxDisp) { this.disp.x =  maxDisp; if (this.dispVel.x > 0) this.dispVel.x = 0; }
    if (this.disp.x < -maxDisp) { this.disp.x = -maxDisp; if (this.dispVel.x < 0) this.dispVel.x = 0; }
    if (this.disp.y >  maxDisp) { this.disp.y =  maxDisp; if (this.dispVel.y > 0) this.dispVel.y = 0; }
    if (this.disp.y < -maxDisp) { this.disp.y = -maxDisp; if (this.dispVel.y < 0) this.dispVel.y = 0; }

    // gentle horizontal wander — each floater drifts slowly sideways
    this.vel.x += (this.gravX + (Math.random() - 0.5) * 0.04) * 0.03 * dt;

    this.vel.x = clamp(this.vel.x, -0.5, 0.5);

    this.center.x += this.vel.x * dt;

    if (this.center.x >  1.4) this.center.x = -1.4;
    if (this.center.x < -1.4) this.center.x =  1.4;

    this.pos.x = trajX + this.disp.x;
    this.pos.y = trajY + this.disp.y;
  }

  respawn() {
    this.center.y = -1.05 - Math.random() * 0.15; // just above visible top
    this.center.x = rand(-0.85, 0.85);
    this.vel.x    = (Math.random() - 0.5) * 0.04;
    this.disp.x   = this.disp.y   = 0;
    this.dispVel.x = this.dispVel.y = 0;
  }

  draw(ctx, opacityMul = 1) {
    const alpha = this.opacity * opacityMul;
    if (alpha < 0.005) return;

    const sx = (this.pos.x * 0.5 + 0.5) * W;
    const sy = (this.pos.y * 0.5 + 0.5) * H;
    if (sx < -250 || sx > W + 250 || sy < -250 || sy > H + 250) return;

    const scale = (Math.min(W, H) / 900) * DPR;

    ctx.save();
    ctx.translate(sx, sy);
    ctx.scale(scale, scale);
    ctx.lineCap  = 'round';
    ctx.lineJoin = 'round';

    // Bezier-smoothed path — midpoint technique gives organic curves without
    // losing the wiggly character of the polyline skeleton.
    const stroke = () => {
      const p = this.path;
      ctx.beginPath();
      ctx.moveTo(p[0].x, p[0].y);
      for (let i = 1; i < p.length - 1; i++) {
        const mx = (p[i].x + p[i + 1].x) * 0.5;
        const my = (p[i].y + p[i + 1].y) * 0.5;
        ctx.quadraticCurveTo(p[i].x, p[i].y, mx, my);
      }
      ctx.lineTo(p[p.length - 1].x, p[p.length - 1].y);
      ctx.stroke();
    };

    const b = this.blur * DPR;
    // Wide atmospheric halo — the refractive diffusion of vitreous gel around strand
    ctx.save();
    ctx.filter      = `blur(${(b * 3.5).toFixed(1)}px)`;
    ctx.globalAlpha = alpha * 0.18;
    ctx.strokeStyle = 'rgba(235, 242, 255, 1)';
    ctx.lineWidth   = this.lineW * 3.5;
    stroke();
    ctx.restore();
    // Thin bright core — the strand itself, barely there
    ctx.save();
    ctx.filter      = `blur(${(b * 0.55).toFixed(1)}px)`;
    ctx.globalAlpha = alpha * 0.78;
    ctx.strokeStyle = 'rgba(255, 255, 255, 1)';
    ctx.lineWidth   = this.lineW * 0.55;
    stroke();
    ctx.restore();

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
const monitor = document.getElementById('eye-monitor');
const mctx = monitor.getContext('2d');

let landmarker = null;
let rawGaze = { x: 0, y: 0 };
let gaze = { x: 0, y: 0 };
let gazePrev = { x: 0, y: 0 };
let gazeVel = { x: 0, y: 0 };
// separate heavily-smoothed gaze used ONLY for background panning —
// decoupled from floater gaze so background stays stable while floaters
// react quickly to eye movements.
let bgGaze = { x: 0, y: 0 };
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

// ── tracking monitor — abstract gaze HUD ─────────────────────────────────────
// Apple-style schematic: no raw video, no ink outlines.
// Two almond eye shapes with live iris dots driven by the smoothed gaze signal.

function drawEyeMonitor() {
  const MW = monitor.width;
  const MH = monitor.height;
  const s  = MW / 220;

  mctx.clearRect(0, 0, MW, MH);

  // subtle top-highlight — gives the glass panel its Apple depth
  const sheen = mctx.createLinearGradient(0, 0, 0, MH * 0.55);
  sheen.addColorStop(0, 'rgba(255,255,255,0.07)');
  sheen.addColorStop(1, 'rgba(255,255,255,0.00)');
  mctx.fillStyle = sheen;
  mctx.fillRect(0, 0, MW, MH);

  const eyeY   = 36 * s;
  const eyeHW  = 38 * s;
  const eyeHH  = 18 * s;
  const leftX  = 63 * s;
  const rightX = 157 * s;

  const drawAlmond = (cx, cy, hw, hh) => {
    mctx.beginPath();
    mctx.moveTo(cx - hw, cy);
    mctx.bezierCurveTo(cx - hw * 0.42, cy - hh, cx + hw * 0.42, cy - hh, cx + hw, cy);
    mctx.bezierCurveTo(cx + hw * 0.42, cy + hh, cx - hw * 0.42, cy + hh, cx - hw, cy);
    mctx.closePath();
  };

  const openHH = eyeHH * Math.max(1 - blinkCoverage * 0.92, 0.04);

  mctx.save();
  mctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
  mctx.lineWidth   = 1.4 * s;
  drawAlmond(leftX,  eyeY, eyeHW, openHH); mctx.stroke();
  drawAlmond(rightX, eyeY, eyeHW, openHH); mctx.stroke();
  mctx.restore();

  const irisR   = 7 * s;
  const maxOffX = (eyeHW - irisR) * 0.60;
  const maxOffY = Math.max(openHH - irisR, 0) * 0.82;
  const ix = clamp(gaze.x, -1, 1) * maxOffX;
  const iy = clamp(gaze.y, -1, 1) * maxOffY;

  if (openHH > irisR * 0.6) {
    mctx.save();
    mctx.strokeStyle = 'rgba(255, 255, 255, 0.58)';
    mctx.lineWidth   = 1.2 * s;
    for (const cx of [leftX, rightX]) {
      mctx.beginPath();
      mctx.arc(cx + ix, eyeY + iy, irisR, 0, Math.PI * 2);
      mctx.stroke();
    }
    mctx.restore();

    mctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
    for (const cx of [leftX, rightX]) {
      mctx.beginPath();
      mctx.arc(cx + ix, eyeY + iy, 2.8 * s, 0, Math.PI * 2);
      mctx.fill();
    }
  }

  mctx.fillStyle = '#30D158';
  mctx.beginPath();
  mctx.arc(204 * s, 13 * s, 3 * s, 0, Math.PI * 2);
  mctx.fill();

  mctx.font         = (9 * s) + 'px -apple-system, "Helvetica Neue", sans-serif';
  mctx.fillStyle    = 'rgba(255, 255, 255, 0.28)';
  mctx.textAlign    = 'center';
  mctx.textBaseline = 'bottom';
  mctx.fillText('eye tracking', 110 * s, 72 * s);
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
      drawEyeMonitor();
    } else {
      mctx.clearRect(0, 0, monitor.width, monitor.height);
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
  blinkCoverage = 0;
  if (blinkAnimT >= 0) {
    blinkAnimT += dt;
    const tt = blinkAnimT / BLINK_DURATION;
    if (tt >= 1) {
      blinkAnimT = -1;
    } else {
      // asymmetric: snap closed (first 40%) then drift open (last 60%)
      blinkCoverage = tt < 0.4
        ? Math.sin((tt / 0.4) * Math.PI * 0.5)
        : Math.cos(((tt - 0.4) / 0.6) * Math.PI * 0.5);
      // at peak (tt≥0.5), apply queued scene — hidden under fully-closed lids
      if (tt >= 0.5 && pendingScene >= 0) {
        currentScene = pendingScene;
        pendingScene = -1;
        sceneFlashT  = 0; // flash starts as lids re-open, not at trigger
      }
    }
  }

  // smooth raw gaze — higher alpha = faster response = stronger floater coupling
  const a = 0.42;
  gaze.x += (rawGaze.x - gaze.x) * a;
  gaze.y += (rawGaze.y - gaze.y) * a;

  // background gaze tracks much more slowly (alpha=0.07 ≈ 15-frame lag),
  // so the photo pan is a gentle drift rather than jittery tracking.
  bgGaze.x += (rawGaze.x - bgGaze.x) * 0.07;
  bgGaze.y += (rawGaze.y - bgGaze.y) * 0.07;

  gazeVel.x = (gaze.x - gazePrev.x) / Math.max(dt, 0.001);
  gazeVel.y = (gaze.y - gazePrev.y) / Math.max(dt, 0.001);
  gazePrev.x = gaze.x;
  gazePrev.y = gaze.y;

  // saccade audio trigger — edge-detect rising past threshold so we play one
  // tone per saccade, not one per frame the gaze is moving fast
  const gazeSpeed = Math.hypot(gazeVel.x, gazeVel.y);
  if (gazeSpeed > SACCADE_AUDIO_TRIGGER && !saccadeFired) {
    audio.saccade(gazeSpeed);
    saccadeFired = true;
  } else if (gazeSpeed < SACCADE_AUDIO_RESET) {
    saccadeFired = false;
  }

  // ── background ──
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  if (bgImg.complete && bgImg.naturalWidth > 0) {
    const scale = Math.max(W / bgImg.width, H / bgImg.height) * 1.18;
    const drawW = bgImg.width  * scale;
    const drawH = bgImg.height * scale;
    const panX  = clamp(bgGaze.x, -1, 1) * (drawW - W) * 0.08;
    const panY  = clamp(bgGaze.y, -1, 1) * (drawH - H) * 0.14;
    ctx.drawImage(bgImg, (W - drawW) * 0.5 - panX, (H - drawH) * 0.5 - panY, drawW, drawH);
  } else {
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, '#b8d8f0'); grad.addColorStop(1, '#e8f4fd');
    ctx.fillStyle = grad; ctx.fillRect(0, 0, W, H);
  }

  // ── floaters ──
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  for (const f of floaters) {
    f.step(dt, gaze, gazeVel);
    f.draw(ctx, 1);
  }

  // ── film grain: per-frame breath, very low opacity ──
  if (!grainPattern) grainPattern = ctx.createPattern(grainTex, 'repeat');
  ctx.save();
  ctx.globalCompositeOperation = 'soft-light';
  ctx.globalAlpha = 0.12;
  ctx.translate(-Math.random() * grainTex.width, -Math.random() * grainTex.height);
  ctx.fillStyle = grainPattern;
  ctx.fillRect(0, 0, W + grainTex.width, H + grainTex.height);
  ctx.restore();

  // ── blink shutter flash — single bright spike that reads on screen recordings ──
  if (blinkFlashT >= 0) {
    blinkFlashT += dt;
    const flashDur = 0.10; // 100ms total — visible on video, imperceptible in person
    if (blinkFlashT >= flashDur) {
      blinkFlashT = -1;
    } else {
      ctx.save();
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 0.60 * (1 - blinkFlashT / flashDur);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }
  }

}

requestAnimationFrame(frame);
loadVoices(); // fetch real voices from Reddit in background; falls back silently

// ── entry / about / nav wiring ────────────────────────────────────────────────
const entry         = document.getElementById('entry');
const enterBtn      = document.getElementById('enterBtn');
const aboutEntryBtn = document.getElementById('aboutEntryBtn');
const aboutPanel    = document.getElementById('about-panel');
const closeAboutBtn = document.getElementById('closeAboutBtn');
const aboutLink     = document.getElementById('about-link');
const homeLink      = document.getElementById('home-link');
const soundLink     = document.getElementById('sound-link');
const nav           = document.getElementById('nav');

let navFadeTimer = null;
function scheduleNavFade() {
  clearTimeout(navFadeTimer);
  navFadeTimer = setTimeout(() => nav.classList.add('faded'), 3500);
}
function revealNav() {
  if (!nav.classList.contains('shown')) return;
  nav.classList.remove('faded');
  scheduleNavFade();
}
document.addEventListener('mousemove', revealNav);
document.addEventListener('touchstart', revealNav, { passive: true });

let started = false;
async function startExperience() {
  entry.classList.add('gone');
  nav.classList.add('shown');
  monitor.classList.add('shown');
  scheduleNavFade();
  audio.start();                        // user gesture — safe to init audio
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
  entry.classList.remove('gone');
  nav.classList.remove('shown');
  nav.classList.remove('faded');
  clearTimeout(navFadeTimer);
  monitor.classList.remove('shown');
}

function openAbout()  { aboutPanel.classList.add('open'); }
function closeAbout() { aboutPanel.classList.remove('open'); }

enterBtn.addEventListener('click', startExperience);
aboutEntryBtn.addEventListener('click', openAbout);
aboutLink.addEventListener('click', openAbout);
homeLink.addEventListener('click', backToLanding);
closeAboutBtn.addEventListener('click', closeAbout);
soundLink.addEventListener('click', () => {
  const muted = audio.toggleMute();
  soundLink.textContent = muted ? 'unmute' : 'mute';
});

// ── title drift ──────────────────────────────────────────────────────────────
// each letter of the title gets its own slow drift through sine waves of
// different periods, with a per-letter phase offset so the word shimmers like
// things suspended in fluid. cycles are slow so the motion reads as drift,
// not jitter.
const titleLetters = document.querySelectorAll('.title-drift > span');
function animateTitleDrift(now) {
  requestAnimationFrame(animateTitleDrift);
  if (entry.classList.contains('gone')) return; // skip work while hidden
  const t = now * 0.001;
  titleLetters.forEach((el, i) => {
    const phase = i * 0.85;
    const y   = Math.sin(t * 0.45 + phase)        * 7.0;
    const x   = Math.cos(t * 0.28 + phase * 1.3)  * 3.5;
    const rot = Math.sin(t * 0.35 + phase * 0.9)  * 1.4;
    el.style.transform = `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px) rotate(${rot.toFixed(2)}deg)`;
  });
}
requestAnimationFrame(animateTitleDrift);

aboutPanel.addEventListener('click', (e) => {
  if (e.target === aboutPanel) closeAbout();
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && aboutPanel.classList.contains('open')) closeAbout();
});
