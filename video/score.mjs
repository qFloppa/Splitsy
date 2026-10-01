#!/usr/bin/env node
/**
 * The Promo's score — music and sound design, synthesised, mixed and mastered
 * here into one 18-second stereo master.
 *
 *   node video/score.mjs           # writes public/audio/promo-score.wav
 *   node video/score.mjs --check   # renders and asserts the master is sane
 *
 * ── why one file instead of a cue sheet of wavs ──────────────────────────────
 * public/sfx/*.wav + <Sequence> per cue (what video/motion still uses) places
 * cues exactly, but Remotion can only sum them: no ducking under the hits, no
 * glue across the bus, no shared reverb, and no loudness target — the three
 * things that separate a teaser from a slideshow with beeps. Mixing here buys
 * all of them, and costs nothing in editability, because the cut is still data:
 * CUE frames below are the cue sheet, and moving one is still a one-line edit
 * followed by `node video/score.mjs`.
 *
 * ── what it inherits from out/6556.mp3 ───────────────────────────────────────
 * Analysis of the reference, feature by feature, and what carries over:
 *
 *   key          bass locked at 72–78 Hz = D2; partials at D4 G4 A4 D5 G5 A5 D6.
 *                No third anywhere (F# chroma 0.03, F 0.00) — it is deliberately
 *                SUSPENDED. C# sits at 0.47 as the tension note. That exact
 *                voicing is the pad here.
 *   arc          −40 dB at 4s climbing to −15 dB at 9s: a 25 dB crescendo, LRA
 *                14.5 LU. The score builds the same way, into the stamp.
 *   colour       energy is 60–1200 Hz (himid −21 dB, air −30 dB). Dark and
 *                heavy, not bright. Filters stay closed until the payoff.
 *   texture      the intro is dense IRREGULAR ticking, ~4.7 frames apart — a
 *                data readout, not a drum. The promo types a sentence on screen,
 *                so that texture is driven by the actual keystrokes (see CUT).
 *   space        tail decays 32 dB in 0.45s ≈ 0.9s RT60. A room, not a cathedral.
 *   width        side/mid −14 dB. Mostly centred; width is an accent.
 *
 * What it does NOT inherit is the tempo (the reference floats near 180; the
 * picture is cut to 120, see Promo.tsx) or the ending (the reference is chopped
 * off mid-tail; this has to land).
 *
 * ── the one musical idea ─────────────────────────────────────────────────────
 * The suspension is the story. A sus chord is a question — it has no third, so
 * it is neither major nor minor and cannot resolve on its own. The whole piece
 * sits on it, adds C# to sour it under the build, and only on the endcard drops
 * F# in to become D major. The chord settles when the payment does.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT = join(ROOT, "public/audio/promo-score.wav");

// ── the grid ────────────────────────────────────────────────────────────────
// 48k against 60fps is the reason for this whole file being frame-addressed:
// 48000/60 is exactly 800, so a frame is a whole number of samples and no cue
// ever lands between two of them.
const SR = 48000;
const FPS = 60;
const FRAMES = 1200; // 20.0s — must match video/index.tsx
const N = (FRAMES / FPS) * SR;
const SPF = SR / FPS;
const BEAT = 30; // frames, at the picture's 120bpm (a bar is four of these)

/** Frame → sample. */
const at = (f) => Math.round(f * SPF);

// ── notes ───────────────────────────────────────────────────────────────────
const STEP = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
/** "D2" → 73.42 Hz. Accepts one sharp: "C#5". */
const hz = (name) => {
  const [, letter, sharp, octave] = /^([A-G])(#?)(-?\d)$/.exec(name);
  const midi = (Number(octave) + 1) * 12 + STEP[letter] + (sharp ? 1 : 0);
  return 440 * 2 ** ((midi - 69) / 12);
};

// ── deterministic noise ─────────────────────────────────────────────────────
// Seeded, because a master that differs between two runs cannot be reviewed by
// diffing anything and cannot be reproduced from the repo.
const mulberry = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const rng = mulberry(20260929);
const noise = () => rng() * 2 - 1;

// ── curves ──────────────────────────────────────────────────────────────────
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
/** 0→1 across a frame window, clamped. */
const ramp = (f, a, b) => clamp01((f - a) / (b - a));
const mix = (a, b, t) => a + (b - a) * t;
/** Equal-power-ish fade in / fade out over 0→1, for pads that must not click. */
const window01 = (t, fadeIn, fadeOut) =>
  Math.min(1, t / fadeIn) * Math.min(1, (1 - t) / fadeOut);

/**
 * The picture's own easing, cubic-bezier(0.22, 1, 0.36, 1) — theme.ts `easeOut`.
 * Needed verbatim, not approximated: the note line's ghost text is revealed by
 * `ramp(frame, 296, 356)` through this curve, and the ticks under it are placed
 * on the frames where its character count actually increments. An approximation
 * puts a tick one frame off a letter, which is exactly the kind of near-miss
 * that reads as "the audio was added afterwards".
 */
const bezier = (x1, y1, x2, y2) => {
  const bx = (s) => 3 * (1 - s) ** 2 * s * x1 + 3 * (1 - s) * s * s * x2 + s ** 3;
  const by = (s) => 3 * (1 - s) ** 2 * s * y1 + 3 * (1 - s) * s * s * y2 + s ** 3;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 40; i++) {
      const s = (lo + hi) / 2;
      if (bx(s) < x) lo = s;
      else hi = s;
    }
    return by((lo + hi) / 2);
  };
};
const easeOut = bezier(0.22, 1, 0.36, 1);

// ── filters ─────────────────────────────────────────────────────────────────
/**
 * Zavalishin's TPT state-variable filter. Chosen over a biquad because every
 * interesting filter here is swept — the build is a cutoff opening from 500 Hz
 * to 3.5 kHz — and a biquad recomputed per sample goes unstable at the top of a
 * sweep where this one does not.
 */
const svf = () => {
  let ic1 = 0;
  let ic2 = 0;
  return (x, cutoff, q = 0.7) => {
    const g = Math.tan((Math.PI * Math.min(cutoff, SR * 0.45)) / SR);
    const k = 1 / q;
    const a1 = 1 / (1 + g * (g + k));
    const a2 = g * a1;
    const a3 = g * a2;
    const v3 = x - ic2;
    const v1 = a1 * ic1 + a2 * v3;
    const v2 = ic2 + a2 * ic1 + a3 * v3;
    ic1 = 2 * v1 - ic1;
    ic2 = 2 * v2 - ic2;
    return { lp: v2, bp: v1, hp: x - k * v1 - v2 };
  };
};

/**
 * PolyBLEP saw. A naive ramp aliases badly on the pad's upper voices; the
 * correction is six lines and removes the fizz that makes cheap synths cheap.
 */
const sawStep = (phase, dt) => {
  let s = 2 * phase - 1;
  if (phase < dt) {
    const t = phase / dt;
    s -= t + t - t * t - 1;
  } else if (phase > 1 - dt) {
    const t = (phase - 1) / dt;
    s -= t * t + t + t + 1;
  }
  return s;
};

// ── buses ───────────────────────────────────────────────────────────────────
// `music` is everything that sustains and therefore everything that has to get
// out of the way of a hit. `fx` is transients, which must not duck themselves.
// `send` is the shared room — one reverb for the whole piece, because two
// different rooms on the same cut is the loudest possible tell that the sound
// was assembled rather than mixed.
const buf = () => [new Float64Array(N), new Float64Array(N)];
const music = buf();
const fx = buf();
const send = buf();
const duck = new Float64Array(N).fill(1);

/**
 * The fader ride — the macro shape of the piece, in dB, keyed to frames.
 *
 * This exists because per-layer levels cannot produce a crescendo. Setting the
 * pad a little louder here and the bass a little louder there gives a mix that
 * measures flat: the first version of this file sat between −15 and −19 dB for
 * the entire body, which is a loop, not a teaser. Real mixes separate the two
 * jobs — static levels decide how loud the pad is *relative to* the bass, and a
 * fader ride decides how loud the moment is. Everything below is the ride; the
 * per-layer levels above it are balance only.
 *
 * The shape is the reference's: a quiet open, a genuine drop behind the lockup
 * as it leaves, then a climb into the stamp, which is the single loudest frame
 * in the piece. Nothing before the payoff is allowed near it — an opening hit as
 * big as the closing one is why most product videos feel front-loaded and flat.
 *
 * Two things the numbers forced, which intuition got wrong:
 *
 * The ride is much flatter than the loudness it produces. Content density rides
 * on top of it — the arp enters at 486, the pulse doubles to quarter notes, the
 * riser runs from 690 — so a ride climbing 8 dB between 480 and 840 measured as
 * a 13 dB climb. The first version put the ride's own climb where it wanted the
 * *result*, and the piece hit maximum at 12.6s, four seconds before the stamp,
 * then sat there. So the 480→800 stretch is now nearly level and the density
 * does the building.
 *
 * And there is a deliberate pull-back at 822–838, immediately before the hit.
 * A crescendo that runs flat into its own payoff has nothing left to pay off
 * with; dropping 8 dB for a fifth of a second is what buys the stamp its impact,
 * and it costs nothing because the riser is on the effects bus and rides at only
 * 0.55 of this curve, so the tension keeps climbing through the hole.
 */
const CONTOUR = [
  [0, -17], //     the pedal alone, under a dark screen
  [30, -11], //    the lockup wiping in
  [48, -10], //    it lands
  [70, -17], //    and the room empties behind it —
  [92, -20], //    the reference's breath, before anything is typed
  [128, -17], //   the sentence starts printing
  [240, -16], //   the amount, the rule
  [330, -15], //   the verb flips
  [420, -13],
  [480, -12], //   four namespaces — the arp and the quarter pulse arrive here,
  [600, -11.5], // so the fader stays out of the way and lets them do it
  [700, -11], //   the build is running on the riser, not on this
  [770, -9.5], //  the press
  [800, -8.5], //  the blocks leave the button
  [822, -10.5], // ← the pull-back
  [838, -10.5],
  [840, 0], //     THE HIT
  [864, -3], //    and the space after it, cleared fast so the loud stretch is
  [896, -9], //    one moment and not the three seconds it used to be
  [924, -14], //   the room empties out behind the composer
  [936, -10], //   the mainnet card lands
  [1000, -8], //   and swells across its own bar
  [1068, -7],
  [1080, -6], //   the endcard. Held well under the stamp on purpose: this is
  [1150, -8], //   sustained where the stamp is a transient, and sustained
  [1200, -20], //  material at the same number measures far louder.
];

/** Smoothstep between the ride's points, per sample, as a linear gain. */
const rideAt = (depth) => {
  const out = new Float64Array(N);
  for (let k = 0; k < CONTOUR.length - 1; k++) {
    const [f0, d0] = CONTOUR[k];
    const [f1, d1] = CONTOUR[k + 1];
    const s0 = at(f0);
    const s1 = k === CONTOUR.length - 2 ? N : at(f1);
    for (let i = s0; i < s1 && i < N; i++) {
      const t = (i - s0) / (at(f1) - s0);
      out[i] = 10 ** ((mix(d0, d1, t * t * (3 - 2 * t)) * depth) / 20);
    }
  }
  return out;
};
const ride = rideAt(1);
// Transients ride at just over half depth. A hit that follows the fader all the
// way down stops reading as a hit in the quiet passages; one that ignores it
// entirely pokes out of them. Somewhere near half is where both stay true.
const rideFx = rideAt(0.55);

/** Write one sample, pan −1..1, with a reverb send. */
const put = (bus, i, s, pan = 0, sendAmt = 0) => {
  if (i < 0 || i >= N || !s) return;
  // The ride sits before the send, so a quiet passage gets less room too —
  // which is what stops the open from sounding like it was recorded in a bigger
  // building than the payoff.
  const g = s * (bus === music ? ride[i] : rideFx[i]);
  const l = g * Math.cos(((pan + 1) * Math.PI) / 4);
  const r = g * Math.sin(((pan + 1) * Math.PI) / 4);
  bus[0][i] += l;
  bus[1][i] += r;
  if (sendAmt) {
    send[0][i] += l * sendAmt;
    send[1][i] += r * sendAmt;
  }
};

/**
 * Carve a dip in the music bus so a transient can land in silence.
 * This is the single biggest difference between these stems summed and these
 * stems mixed: without it the stamp fights a pad that is already using the
 * same 200 Hz, and both lose.
 */
const sidechain = (frame, depthDb, holdFrames, releaseFrames) => {
  const start = at(frame);
  const depth = 10 ** (depthDb / 20);
  const hold = at(holdFrames);
  const rel = at(releaseFrames);
  for (let i = 0; i < hold + rel; i++) {
    const j = start + i;
    if (j < 0 || j >= N) continue;
    const g = i < hold ? depth : mix(depth, 1, easeOut((i - hold) / rel));
    if (g < duck[j]) duck[j] = g;
  }
};

// ── instruments ─────────────────────────────────────────────────────────────

/**
 * The pad. Three detuned saw voices per note through a swept lowpass.
 * Detune is what gives it a body — one saw per note is an organ, three at ±6
 * cents beat against each other slowly and read as an ensemble.
 */
const pad = (notes, f0, f1, opts = {}) => {
  const { level = 0.06, cut0 = 600, cut1 = 1600, q = 0.9, send: sendAmt = 0.42, fade = 0.3, out = 0.45, width = 0.34 } = opts;
  const s0 = at(f0);
  const len = at(f1) - s0;
  notes.forEach((note, n) => {
    const base = hz(note);
    for (let v = 0; v < 3; v++) {
      const det = base * 2 ** (((v - 1) * 6) / 1200);
      const pan = (((n % 2 === 0 ? -1 : 1) * (0.3 + v * 0.25)) % 1) * width;
      const f = svf();
      let phase = rng();
      const dt = det / SR;
      // Slow, prime-ish LFO per voice so the three never line back up.
      const lfo = 0.12 + v * 0.037 + n * 0.011;
      for (let i = 0; i < len; i++) {
        const t = i / len;
        const s = sawStep(phase, dt);
        phase = (phase + dt * (1 + 0.0009 * Math.sin((2 * Math.PI * lfo * i) / SR))) % 1;
        const cut = mix(cut0, cut1, easeOut(t));
        const env = window01(t, fade, out) * level;
        put(music, s0 + i, f(s, cut, q).lp * env, pan, sendAmt);
      }
    }
  });
};

/**
 * Sub and bass — the same generator, because the only real difference is
 * register. Pure sine with a touch of second harmonic: a saw down here is mud,
 * and the reference's low end is a clean 73 Hz tone, nothing more.
 */
const bass = (note, f0, f1, opts = {}) => {
  const { level = 0.3, fade = 0.12, out = 0.35, drive = 0.25, h2 = 0.12 } = opts;
  const s0 = at(f0);
  const len = at(f1) - s0;
  const w = (2 * Math.PI * hz(note)) / SR;
  for (let i = 0; i < len; i++) {
    const t = i / len;
    const s = Math.sin(w * i) + h2 * Math.sin(2 * w * i);
    const env = window01(t, fade, out) * level;
    // Saturation, not clipping: adds harmonics so the note survives on a phone
    // speaker that cannot reproduce 73 Hz at all.
    put(music, s0 + i, Math.tanh(s * (1 + drive)) * env, 0, 0.05);
  }
};

/**
 * The pulse. A filtered sine thump rather than a kick drum: the picture is a
 * sentence being typed, and a four-on-the-floor kick under it would turn a
 * product teaser into a club edit.
 */
const thump = (f0, level = 0.5, note = "D2") => {
  const s0 = at(f0);
  const len = at(22);
  const f = hz(note);
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    const env = Math.exp(-16 * t);
    // Pitch drop across the hit is what makes it read as weight.
    const s = Math.sin(2 * Math.PI * (f * t - f * 0.22 * t * t));
    put(music, s0 + i, s * env * level, 0, 0.08);
  }
};

/**
 * A keystroke. 25ms, mostly noise, pitched only enough to sit in D.
 * `seed` varies pitch and level per hit: thirty identical ticks in a row comb
 * into a tone, and the reference's ticking is conspicuously irregular.
 */
const tick = (f0, level = 0.11, seed = 0) => {
  const s0 = at(f0);
  const len = at(2.2);
  const f = svf();
  const jitter = 0.85 + mulberry(seed + 7)() * 0.4;
  const pan = (mulberry(seed + 13)() - 0.5) * 0.5;
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    const env = Math.exp(-260 * t);
    const s = noise() * 0.8 + Math.sin(2 * Math.PI * hz("D6") * jitter * t) * 0.35;
    put(fx, s0 + i, f(s, 2200 * jitter, 1.4).bp * env * level * jitter, pan, 0.14);
  }
};

/** The heavier relative of `tick`: a word setting into the sentence. */
const print = (f0, level = 0.2) => {
  const s0 = at(f0);
  const len = at(10);
  const f = svf();
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    const env = Math.exp(-42 * t);
    const s = noise() * 0.5 + Math.sin(2 * Math.PI * hz("D3") * t) * 0.9;
    put(fx, s0 + i, f(s, 1400, 0.9).lp * env * level, 0, 0.2);
  }
};

/**
 * Transition whoosh. Pink-ish noise through a bandpass that sweeps; `dir` −1
 * sweeps down, which is what an exit or a pull-back wants.
 */
const whoosh = (f0, frames, level = 0.18, dir = 1, pan = 0) => {
  const s0 = at(f0);
  const len = at(frames);
  const f = svf();
  let pink = 0;
  for (let i = 0; i < len; i++) {
    const t = i / len;
    pink = pink * 0.94 + noise() * 0.06;
    const c = dir > 0 ? mix(320, 5200, easeOut(t)) : mix(5200, 320, easeOut(t));
    const env = Math.sin(Math.PI * t) ** 1.4;
    put(fx, s0 + i, f(pink * 6, c, 1.1).bp * env * level, pan * (1 - 2 * t), 0.4);
  }
};

/** The short, dry relative of `whoosh` — one namespace wiping to the next. */
const swish = (f0, level = 0.12, rate = 1, pan = 0) => {
  const s0 = at(f0);
  const len = at(14 / rate);
  const f = svf();
  for (let i = 0; i < len; i++) {
    const t = i / len;
    const env = Math.sin(Math.PI * t) ** 1.6;
    put(fx, s0 + i, f(noise(), mix(900, 4200, t) * rate, 1.3).bp * env * level, pan, 0.22);
  }
};

/**
 * The verb toggle — a switch being thrown. Two clicks 4 frames apart, the
 * second higher, over a rising blip. The gesture is the interval, not the
 * timbre: down-then-up is what a toggle sounds like in every interface.
 */
const toggle = (f0, level = 0.3, up = true) => {
  const s0 = at(f0);
  const [a, b] = up ? [hz("A4"), hz("D5")] : [hz("D5"), hz("A4")];
  for (const [delay, f, amp] of [[0, a, 1], [4, b, 0.9]]) {
    const len = at(4);
    for (let i = 0; i < len; i++) {
      const t = i / SR;
      const env = Math.exp(-150 * t);
      put(fx, s0 + at(delay) + i, (Math.sin(2 * Math.PI * f * t) * 0.7 + noise() * 0.4) * env * level * amp, 0, 0.18);
    }
  }
  const len = at(16);
  const flt = svf();
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    const g = up ? 1 : -1;
    const s = Math.sin(2 * Math.PI * (hz("D5") * t + g * 900 * t * t));
    put(fx, s0 + at(4) + i, flt(s, 4000, 0.8).lp * Math.exp(-22 * t) * level * 0.4, 0, 0.3);
  }
};

/**
 * The button submit. The one sound in the piece that has to feel physical:
 * a click for the contact, a 200→70 Hz drop for the travel, and a short noise
 * body so it has mass. Everything else in the mix ducks under it.
 */
const press = (f0, level = 0.55) => {
  const s0 = at(f0);
  const len = at(30);
  const f = svf();
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    const body = Math.sin(2 * Math.PI * (200 * t - 130 * t * t)) * Math.exp(-7 * t);
    const click = i < at(2) ? noise() * Math.exp(-220 * t) * 0.8 : 0;
    put(fx, s0 + i, (f(body, 900, 0.8).lp + click) * level, 0, 0.16);
  }
};

/** Money leaving the button: a rising zip, one per block. */
const zip = (f0, level = 0.22, rate = 1) => {
  const s0 = at(f0);
  const len = at(22);
  const f = svf();
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    const s = Math.sin(2 * Math.PI * (hz("D4") * rate * t + 2400 * rate * t * t));
    const air = f(noise(), mix(1800, 6000, i / len) * rate, 1.2).bp * 0.5;
    put(fx, s0 + i, (s * 0.7 + air) * Math.exp(-9 * t) * level, mix(-0.35, 0.5, i / len), 0.3);
  }
};

/**
 * An impact. Sub drop plus a noise transient plus a tuned tail — the tail is
 * what stops three impacts in one cut from sounding like the same sample three
 * times, and keeps them inside the key.
 */
const impact = (f0, level = 0.5, note = "D1") => {
  const s0 = at(f0);
  const len = at(70);
  const f = svf();
  const base = hz(note);
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    const drop = Math.sin(2 * Math.PI * (base * 1.9 * t - base * 0.75 * t * t)) * Math.exp(-5.5 * t);
    const crack = i < at(4) ? f(noise(), 4200, 0.7).lp * Math.exp(-90 * t) * 0.9 : 0;
    const tail = Math.sin(2 * Math.PI * base * 2 * t) * Math.exp(-2.2 * t) * 0.35;
    put(fx, s0 + i, (drop + crack + tail) * level, 0, 0.3);
  }
};

/**
 * A tuned chime. Used for the logo sparkle, the confirmation rings and the
 * endcard. Always built from notes of the chord that is playing underneath it,
 * which is the whole reason it is a function taking notes rather than a wav.
 */
const chime = (f0, notes, level = 0.1, decay = 3.2, pan = 0) => {
  const s0 = at(f0);
  const len = Math.min(at(180), N - s0);
  notes.forEach((note, k) => {
    const f = hz(note);
    const amp = level / (1 + k * 0.55);
    for (let i = 0; i < len; i++) {
      const t = i / SR;
      const env = Math.exp(-decay * t) * Math.min(1, t * 400);
      put(fx, s0 + i, Math.sin(2 * Math.PI * f * t) * env * amp, pan + k * 0.08, 0.5);
    }
  });
};

/**
 * The build into the stamp. Rising filtered noise plus a rising tone, with the
 * amplitude curve doing most of the work — this is the reference's 25 dB
 * crescendo, compressed into the three seconds before the payoff.
 */
const riser = (f0, f1, level = 0.16) => {
  const s0 = at(f0);
  const len = at(f1) - s0;
  const f = svf();
  const g = svf();
  let pink = 0;
  for (let i = 0; i < len; i++) {
    const t = i / len;
    const e = easeOut(t * 0.55) + t * t * 0.6;
    pink = pink * 0.95 + noise() * 0.05;
    const air = f(pink * 7, mix(600, 9000, t ** 1.7), 0.9).bp;
    const tone = g(Math.sin(2 * Math.PI * (hz("D3") * (1 + t * 0.9) * i) / SR), 3000, 1.2).lp;
    put(fx, s0 + i, (air * 0.8 + tone * 0.35) * e * level, Math.sin(t * 9) * 0.3, 0.45);
  }
};

/** A reverse swell, ending exactly on `f1`. Announces a hit before it lands. */
const swell = (f1, frames, level = 0.14) => {
  const s0 = at(f1 - frames);
  const len = at(frames);
  const f = svf();
  let pink = 0;
  for (let i = 0; i < len; i++) {
    const t = i / len;
    pink = pink * 0.93 + noise() * 0.07;
    put(fx, s0 + i, f(pink * 6, mix(900, 6500, t), 1).bp * t ** 2.2 * level, 0, 0.35);
  }
};

/** 16th-note motion under the four namespaces. Texture, not melody. */
const arp = (notes, f0, f1, level = 0.035) => {
  let k = 0;
  for (let f = f0; f < f1; f += BEAT / 4, k++) {
    const note = notes[k % notes.length];
    const s0 = at(f);
    const len = at(BEAT / 4 + 4);
    const w = (2 * Math.PI * hz(note)) / SR;
    const flt = svf();
    const pan = k % 2 ? 0.45 : -0.45;
    for (let i = 0; i < len; i++) {
      const t = i / SR;
      const env = Math.exp(-11 * t) * Math.min(1, t * 900);
      put(music, s0 + i, flt(Math.sin(w * i) * 0.6 + noise() * 0.1, 2600, 1.1).lp * env * level, pan, 0.4);
    }
  }
};

// ── the cut ─────────────────────────────────────────────────────────────────
/**
 * Every keystroke in the picture, derived rather than transcribed.
 *
 * Promo.tsx types its sentence with `typing()` and reveals the note line with
 * an eased ramp. Both are mirrored below and then sampled frame by frame, so a
 * tick exists exactly where a character appears. Hand-listing those eighty-odd
 * frames would be the same sound today and silently wrong the first time
 * anybody retimes a word.
 */
const HANDLE = "dani";
const EMAIL = "dani@gmail.com";
const ADDRESS = "0xEE42a492B183CdFf04439F2Cb6A9c49F857F70AC";
const ADDRESS_SHORT = "0xEE42…70AC";
const AMOUNT = "42";
const REASON = "last night's ramen";

const typing = (frame, text, from, perChar) => {
  const n = Math.floor((frame - from) / Math.abs(perChar));
  if (frame < from) return perChar > 0 ? "" : text;
  const shown = perChar > 0 ? n : text.length - n;
  return text.slice(0, Math.max(0, Math.min(text.length, shown)));
};

const whoAt = (frame) => {
  if (frame < 516) return typing(frame, HANDLE, 160, 15);
  if (frame < 528) return typing(frame, HANDLE, 516, -3);
  if (frame < 564) return typing(frame, HANDLE, 528, 3);
  if (frame < 570) return "";
  if (frame < 636) return typing(frame, EMAIL, 570, 2.4);
  if (frame < 642) return "";
  if (frame < 690) return typing(frame, ADDRESS, 642, 1.15);
  return ADDRESS_SHORT;
};

/** Total characters on screen at `frame`, across all three typed fields. */
const charsAt = (frame) =>
  whoAt(frame).length +
  (frame < 248 ? 0 : typing(frame, AMOUNT, 248, 14).length) +
  Math.floor(easeOut(ramp(frame, 296, 356)) * REASON.length);

/**
 * Keystroke frames, thinned to 3 frames apart.
 *
 * The wallet address is 42 characters in 48 frames. One tick each is 52 per
 * second, which stops being a rhythm and becomes a 52 Hz buzz — a pitch, and
 * not one in D. Thinning caps it near 20/s, which still reads as a machine
 * reading out data but stays a texture. The burst under it (see CUES) carries
 * the density instead.
 */
const keystrokes = (() => {
  const out = [];
  let prev = charsAt(0);
  for (let f = 1; f <= FRAMES; f++) {
    const now = charsAt(f);
    if (now !== prev && (out.length === 0 || f - out[out.length - 1] >= 3)) out.push(f);
    prev = now;
  }
  return out;
})();

// ── arrangement ─────────────────────────────────────────────────────────────
// Act boundaries are Promo.tsx's own constants. Bars are 120 frames.
//
//   bar 1   0   cold open, the lockup wipes in
//   bar 2  120  the sentence prints and types
//   bar 3  240  the amount, the rule, the note line
//   bar 4  360  the verb flips — sus4 arrives
//   bar 5  480  four namespaces
//   bar 6  600  the address, C# sours the chord, the build starts
//   bar 7  720  settle: the press and the send
//   bar 8  840  THE HIT — the stamp lands on the downbeat
//   bar 9  960  the endcard — F# finally resolves it to D major

// The floor. One D pedal under the entire piece; the reference never leaves it.
// One note, not two: window01 fades are a fraction of the note's own length,
// so a 630-frame pedal at fade 0.5 is triangular — it peaked in the middle and
// then faded *against* the build. And two D2s overlapping arrive 169 degrees
// apart, which is most of the way to cancelling. One long note, short fade in,
// level held flat, and the ride does the dynamics.
bass("D2", 0, 726, { level: 0.16, fade: 0.14, out: 0.3 });
bass("D2", 720, 848, { level: 0.16, fade: 0.2, out: 0.2 });
// The drop at the stamp: an octave down, which is the only octave left. It is
// held past the pad's tail and into the endcard's own bass, because the 24
// frames where neither was sounding read as the audio having failed rather than
// as a rest.
bass("D1", 840, 960, { level: 0.17, fade: 0.05, out: 0.62, drive: 0.4 });
// D is the root of both the suspension and the chord it resolves to, so the
// closing two bars are one unbroken D2 rather than a note per card — which also
// sidesteps the same-frequency cancellation that split pedals caused earlier.
bass("D2", 920, 1200, { level: 0.15, fade: 0.1, out: 0.45 });

// The chord, in five stages. Cutoffs open across the piece: dark to bright is
// the build, and doing it with a filter rather than with volume is why it can
// gain 25 dB without simply getting louder.
pad(["D4", "A4", "D5"], 88, 344, { level: 0.085, cut0: 420, cut1: 900, fade: 0.28, out: 0.35 });
pad(["D4", "G4", "A4", "D5"], 330, 500, { level: 0.09, cut0: 700, cut1: 1300, fade: 0.2, out: 0.3 });
pad(["D4", "G4", "A4", "D5", "G5"], 480, 664, { level: 0.09, cut0: 900, cut1: 1700, fade: 0.2, out: 0.3 });
// C# — the reference's tension note, held only while the build is running.
pad(["D4", "G4", "A4", "C#5", "D5", "G5"], 648, 848, { level: 0.095, cut0: 1000, cut1: 2400, fade: 0.22, out: 0.12 });
// The payoff voicing is the reference's, partial for partial, C# now gone.
pad(["D4", "G4", "A4", "D5", "G5", "A5", "D6"], 840, 966, { level: 0.105, cut0: 2600, cut1: 1400, fade: 0.02, out: 0.45 });
// The mainnet card is still SUSPENDED. Answering it here would spend the
// resolution one card early and leave the endcard with nothing to do.
pad(["D4", "G4", "A4", "D5", "G5"], 930, 1082, { level: 0.09, cut0: 1100, cut1: 2100, fade: 0.16, out: 0.2 });
// The resolution. F# arrives and the question the whole piece has been asking
// turns into D major.
// fade kept short so the suspension hands over without a hole: at 0.22 the
// two pads were both part-way down at 1073 and the mix thinned by 3.4 dB
// right on the cut, which reads as a hiccup rather than as a breath.
pad(["D4", "F#4", "A4", "D5", "F#5", "A5"], 1074, 1200, { level: 0.105, cut0: 900, cut1: 2200, fade: 0.13, out: 0.55, width: 0.75 });

// The heartbeat. Half notes to start, quarters once the namespaces are moving.
for (let f = 240; f < 480; f += BEAT * 2) thump(f, 0.34);
for (let f = 480; f < 720; f += BEAT) thump(f, 0.34);
for (let f = 720; f < 840; f += BEAT) thump(f, 0.38);
arp(["D5", "A4", "D4", "G4"], 486, 700);

// ── cues ────────────────────────────────────────────────────────────────────
// Frames are Promo.tsx's. Each comment is the thing on screen at that frame;
// if the picture moves, the number moves with it and nothing else changes.

// 01 · cold open — the lockup wipes in (clip-path 4→44), reveal completes 62
swell(44, 42, 0.1);
impact(44, 0.34, "D1");
sidechain(44, -7, 8, 34);
chime(46, ["D5", "A5", "D6"], 0.075, 3.4);
whoosh(58, 34, 0.1, -1); // the lockup leaving, 56→92

// 02 · the composer arrives at 90, its four words print 100/116/134/226
whoosh(84, 26, 0.12, 1);
for (const f of [100, 116, 134, 226]) print(f, 0.17);
thump(120, 0.34); // bar 2 downbeat, under the first word landing

// every keystroke in the sentence
keystrokes.forEach((f, i) => tick(f, f >= 642 && f < 692 ? 0.08 : 0.12, i * 31));

// the wallet address typing at 42 characters in 48 frames — carried by one
// burst rather than by 42 ticks, for the reason given at `keystrokes`
whoosh(642, 48, 0.09, 1, 0.2);

// 03 · the rule draws 280→320, then the verb is tapped
swish(280, 0.1, 0.7, -0.3);
toggle(348, 0.32, true); //            the switch itself
whoosh(354, 30, 0.14, 1, -0.4); //     the sentence flipping, spring 354→398
sidechain(348, -4, 6, 26);
chime(402, ["A4", "D5"], 0.05, 4.5); // "Ask for it, or send it" at 400

// 04 · four namespaces — the row in at 486, then three switches
whoosh(476, 30, 0.14, 1);
thump(480, 0.34);
swish(488, 0.13, 1.1, 0.35);
// X → Discord: four backspaces at 519/522/525/528, then the retype
swish(516, 0.14, 0.86, -0.4);
toggle(516, 0.16, false);
// → Email
swish(570, 0.14, 1, 0.3);
toggle(570, 0.18, true);
// → Wallet
swish(642, 0.15, 1.14, -0.25);
toggle(642, 0.2, true);
// the address collapses to 0xEE42…70AC at 690 and the sentence springs back
zip(688, 0.16, 1.3);
swish(700, 0.12, 0.8, 0.4); // the row leaving, 700→720

// 05 · settle — the build, the press, the send, the stamp
riser(690, 838, 0.15);
whoosh(720, 30, 0.16, 1);
thump(720, 0.4);
whoosh(726, 28, 0.12, 1, 0.35); // the verb flipping back, spring 726→766
press(770, 0.55); //               THE button submit, press peaks 776
sidechain(770, -6, 7, 30);
zip(778, 0.2, 1); //               the three blocks leaving, 778 / 786 / 794
zip(786, 0.18, 1.09);
zip(794, 0.16, 1.18);
swell(840, 30, 0.2);
// the stamp reads at 838 and the bar turns at 840: the transient leads the
// musical hit by two frames, which is how a hit is made to feel bigger than it
// measures — the ear takes the pair as one event and credits it to the music.
impact(838, 0.8, "D1");
sidechain(838, -9, 10, 46);
chime(840, ["D5", "A5", "D6"], 0.1, 2.4);
// the two confirmation rings, 834 and 844
chime(834, ["A5"], 0.035, 5);
chime(844, ["D6"], 0.03, 5);

// 06 · outro into the mainnet card — the composer blurs out at 900, the card
//      lands at 930, its live dot ignites at 944
whoosh(898, 44, 0.15, -1);
thump(960, 0.26); //                    bar 9's downbeat, under the card
chime(930, ["D5", "A5"], 0.05, 3.2); //  the dot lighting up, ahead of the type
// One whisper per word as it slides up out of its mask. Four ticks would be
// too literal and four whooshes too heavy; a swish at a twentieth of its usual
// level is just enough to make the type feel like it weighs something.
[942, 948, 954, 960].forEach((f, i) => swish(f, 0.055, 0.9 + i * 0.07, i % 2 ? 0.3 : -0.3));
swish(968, 0.07, 0.75, 0.25); //         the rule drawing out from the centre

// 07 · endcard — the lockup at 1080, its wipe 1086→1122
swell(1080, 36, 0.1);
impact(1080, 0.26, "D2");
sidechain(1080, -4, 8, 40);
chime(1086, ["D5", "F#5", "A5", "D6"], 0.075, 1.5); // the resolved chord, sparkled

// ── reverb ──────────────────────────────────────────────────────────────────
/**
 * Freeverb, tuned to the reference's ~0.9s tail. One room, shared by music and
 * effects, so the stamp and the pad sound like they are in the same building.
 * Comb lengths are the classic set, scaled from 44.1k to 48k.
 */
const reverb = (input, roomSize = 0.86, damp = 0.32) => {
  const k = SR / 44100;
  const combs = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617].map((d) => Math.round(d * k));
  const allpass = [556, 441, 341, 225].map((d) => Math.round(d * k));
  const feedback = roomSize * 0.28 + 0.7;
  const out = [new Float64Array(N), new Float64Array(N)];
  for (let ch = 0; ch < 2; ch++) {
    // 23 samples of stereo spread is Freeverb's own; it decorrelates the two
    // sides without smearing the centre.
    const offset = ch === 0 ? 0 : Math.round(23 * k);
    const acc = new Float64Array(N);
    for (const len of combs) {
      const d = len + offset;
      const line = new Float64Array(d);
      let idx = 0;
      let store = 0;
      for (let i = 0; i < N; i++) {
        const y = line[idx];
        acc[i] += y;
        store = y * (1 - damp) + store * damp;
        line[idx] = input[ch][i] + store * feedback;
        idx = idx + 1 === d ? 0 : idx + 1;
      }
    }
    let sig = acc;
    for (const len of allpass) {
      const d = len + offset;
      const line = new Float64Array(d);
      const next = new Float64Array(N);
      let idx = 0;
      for (let i = 0; i < N; i++) {
        const y = line[idx];
        next[i] = -sig[i] + y;
        line[idx] = sig[i] + y * 0.5;
        idx = idx + 1 === d ? 0 : idx + 1;
      }
      sig = next;
    }
    // High-passed: reverb on the sub is the classic way to turn a clean low end
    // into mud, and this low end is the whole point of the reference.
    const hp = svf();
    for (let i = 0; i < N; i++) out[ch][i] = hp(sig[i] * 0.055, 260, 0.7).hp;
  }
  return out;
};

// ── master ──────────────────────────────────────────────────────────────────
// The room is the same on every pass, so it is built once. The loudness loop
// below re-renders the master several times and this is most of its cost.
const room = reverb(send);

/**
 * Sum, glue, widen, then trim to the loudness target and limit.
 *
 * Order matters: the makeup trim sits AFTER the compressor and saturator and
 * before the limiter. Putting it at the front — the obvious place — feeds the
 * compressor a hotter signal, so it pulls most of the gain straight back out
 * and +4.5 dB of trim buys +2.3 dB of loudness. Trimming after the non-linear
 * stages makes trim and output very nearly 1:1, which is what lets the loop
 * below converge in two passes instead of ten.
 */
let limiting = { worst: 0, pct: 0 };
const master = (gainDb) => {
  const L = new Float64Array(N);
  const R = new Float64Array(N);
  // Side content is high-passed before it is widened: two decorrelated sub
  // signals cancel on anything that sums to mono, which on a phone in a pocket
  // is all of them. The low end stays dead centre.
  const sideHi = svf();
  // And everything below 30 Hz goes, on both channels. Nothing in the piece is
  // written down there — D1 is 36.7 Hz — so it is all rumble from impact
  // pitch-drops, and it costs limiter headroom that the audible band wants.
  const subCut = [svf(), svf()];
  for (let i = 0; i < N; i++) {
    const l = music[0][i] * duck[i] + fx[0][i] + room[0][i];
    const r = music[1][i] * duck[i] + fx[1][i] + room[1][i];
    const mid = (l + r) / 2;
    // 0.5 on the sides lands near the reference's −14 dB side/mid.
    const side = sideHi((l - r) / 2, 180, 0.7).hp * 0.5;
    L[i] = subCut[0](mid + side, 30, 0.7).hp;
    R[i] = subCut[1](mid - side, 30, 0.7).hp;
  }
  // Glue, deliberately weak: 1.6:1 over −9 dBFS, 30ms attack so transients keep
  // their edge, 200ms release so it breathes with the build. A busier setting
  // (this was 2:1 over −18) levels the fader ride straight back out — the
  // compressor cannot tell a crescendo from a mistake, so it must be kept above
  // the body of the piece and left to catch only the payoff.
  let envelope = 0;
  const thr = 10 ** (-9 / 20);
  const atk = Math.exp(-1 / (0.03 * SR));
  const rel = Math.exp(-1 / (0.2 * SR));
  const g = 10 ** (gainDb / 20);
  for (let i = 0; i < N; i++) {
    const peak = Math.max(Math.abs(L[i]), Math.abs(R[i]));
    envelope = peak > envelope ? atk * envelope + (1 - atk) * peak : rel * envelope + (1 - rel) * peak;
    const over = envelope / thr;
    const gr = over > 1 ? over ** -0.38 : 1;
    // Saturation gentle enough to be unity below about −6 dBFS: it is here to
    // round the loudest transients, not to be an effect.
    L[i] = (Math.tanh(L[i] * gr * 1.2) / 1.2) * g;
    R[i] = (Math.tanh(R[i] * gr * 1.2) / 1.2) * g;
  }
  // Brickwall with 5ms of lookahead, ceiling −1.2 dBFS so that a lossy encode
  // downstream still lands under −1 dBTP.
  const look = Math.round(0.005 * SR);
  const ceiling = 10 ** (-1.2 / 20);
  const gain = new Float64Array(N).fill(1);
  for (let i = 0; i < N; i++) {
    const peak = Math.max(Math.abs(L[i]), Math.abs(R[i]));
    if (peak > ceiling) {
      const need = ceiling / peak;
      for (let j = Math.max(0, i - look); j <= i; j++) if (need < gain[j]) gain[j] = need;
    }
  }
  let held = 1;
  const lrel = Math.exp(-1 / (0.06 * SR));
  let worst = 1;
  let clamped = 0;
  for (let i = 0; i < N; i++) {
    held = gain[i] < held ? gain[i] : lrel * held + (1 - lrel) * gain[i];
    if (held < worst) worst = held;
    if (held < 0.995) clamped++;
    L[i] *= held;
    R[i] *= held;
  }
  // Reported because it is the thing that silently undoes a fader ride: past
  // about 3 dB of reduction the limiter is no longer catching peaks, it is
  // compressing the payoff, and the crescendo stops arriving.
  limiting = { worst: 20 * Math.log10(worst), pct: (100 * clamped) / N };
  return [L, R];
};

// ── output ──────────────────────────────────────────────────────────────────
/** 16-bit PCM with TPDF dither, from its own PRNG so the bytes are stable. */
const wav = ([L, R]) => {
  const dust = mulberry(1);
  const data = Buffer.alloc(N * 4);
  for (let i = 0; i < N; i++) {
    for (const [ch, src] of [[0, L], [1, R]]) {
      const dither = (dust() + dust() - 1) / 32768;
      const v = Math.max(-1, Math.min(1, src[i] + dither));
      data.writeInt16LE(Math.round(v * 32767), i * 4 + ch * 2);
    }
  }
  const head = Buffer.alloc(44);
  head.write("RIFF", 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write("WAVE", 8);
  head.write("fmt ", 12);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(2, 22);
  head.writeUInt32LE(SR, 24);
  head.writeUInt32LE(SR * 4, 28);
  head.writeUInt16LE(4, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36);
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
};

/**
 * Integrated loudness of a rendered file, via ffmpeg — which prints its
 * summary on stderr, hence spawnSync rather than execFileSync's stdout.
 */
const lufs = (path) => {
  const { stderr } = spawnSync("ffmpeg", ["-nostats", "-i", path, "-af", "ebur128", "-f", "null", "-"], {
    encoding: "utf8",
  });
  const found = /Integrated loudness:\s+I:\s*(-?[\d.]+)/.exec(stderr);
  if (!found) throw new Error(`could not read loudness from ffmpeg:\n${stderr.slice(-800)}`);
  return Number(found[1]);
};

/**
 * −14 LUFS is what social players normalise to, and it is the wrong target for
 * this piece.
 *
 * Hitting it needed +6.6 dB of makeup, which drove the payoff 3.1 dB into the
 * limiter on 5% of samples. A limiter working that hard is a compressor on the
 * crescendo: the body and the stamp arrived within 2 dB of each other, the
 * 12–15s stretch sat at maximum for three seconds, and the whole build stopped
 * reading. Every extra dB of loudness was being paid for out of the dynamics.
 *
 * −16.5 is quieter than the platforms' ceiling and that is the point: music-only
 * content with one big hit wants the range more than the level, and players
 * attenuate what is too loud rather than lifting what is not.
 */
const TARGET = -16.5;

/**
 * Render, measure, correct, repeat. The chain is non-linear, so the trim that
 * hits the target cannot be calculated — only converged on. Two passes is the
 * normal case; the loop exists for the day somebody rebalances the arrangement.
 */
mkdirSync(dirname(OUT), { recursive: true });
let trim = 0;
let measured = 0;
let final;
for (let pass = 1; pass <= 6; pass++) {
  final = master(trim);
  writeFileSync(OUT, wav(final));
  measured = lufs(OUT);
  if (Math.abs(measured - TARGET) < 0.15) break;
  trim += TARGET - measured;
}

let peak = 0;
for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(final[0][i]), Math.abs(final[1][i]));

console.log(`wrote ${OUT}`);
console.log(`  ${(N / SR).toFixed(2)}s · ${FRAMES} frames @ ${FPS}fps · ${SR / 1000}kHz stereo`);
console.log(`  ${measured.toFixed(1)} LUFS (target ${TARGET}, makeup ${trim >= 0 ? "+" : ""}${trim.toFixed(1)} dB)`);
console.log(`  peak ${(20 * Math.log10(peak)).toFixed(2)} dBFS · ${keystrokes.length} keystroke cues`);
console.log(`  limiter: ${limiting.worst.toFixed(1)} dB worst, active on ${limiting.pct.toFixed(1)}% of samples`);

if (process.argv.includes("--check")) {
  const ok = (cond, msg) => {
    if (!cond) throw new Error(`score check failed: ${msg}`);
  };
  ok(N === FRAMES * SPF, "master length must be exactly the composition length");
  ok(final[0].every(Number.isFinite) && final[1].every(Number.isFinite), "NaN in master");
  ok(peak <= 10 ** (-1 / 20), `peak ${(20 * Math.log10(peak)).toFixed(2)} dBFS exceeds -1 dBFS`);
  ok(Math.abs(measured - TARGET) < 0.6, `integrated ${measured} off target ${TARGET}`);
  // The build has to actually build: the settle must be louder than the open.
  const rms = (f0, f1) => {
    let s = 0;
    for (let i = at(f0); i < at(f1); i++) s += final[0][i] ** 2 + final[1][i] ** 2;
    return 10 * Math.log10(s / (at(f1) - at(f0)) / 2 + 1e-12);
  };
  ok(rms(840, 900) - rms(90, 240) > 8, "the stamp is not meaningfully louder than the open");
  ok(keystrokes.length > 40 && keystrokes.length < 120, `keystroke count ${keystrokes.length} implausible`);
  ok(keystrokes.every((f) => f > 90 && f < 700), "a keystroke cue landed outside the typing");
  console.log("  check: ok");
}
