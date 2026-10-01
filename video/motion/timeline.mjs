/**
 * The cut, as data.
 *
 * Nothing here touches the DOM or the renderer: this is the timing sheet a
 * motion designer would pin to the wall, and both the scene and the renderer
 * read it. Keeping it separate is what lets the timing be tested without
 * rendering 900 frames to check that two shots overlap by four frames.
 */

export const FPS = 60;
/** 15.0s. Long enough to say "send or request, to anyone", short enough to loop. */
export const TOTAL_FRAMES = 900;

/**
 * Five shots. Each runs to the next one's first frame — the tile test below
 * pins that, because a one-frame gap is a black flash on a cut.
 */
export const PHASES = [
  { name: "hook", start: 0, end: 132 },
  { name: "anywhere", start: 132, end: 324 },
  { name: "send", start: 324, end: 504 },
  { name: "request", start: 504, end: 684 },
  { name: "endcard", start: 684, end: TOTAL_FRAMES },
];

/**
 * The two legs of the money rail.
 *
 * The whole point of the piece is that the same rail carries money both ways,
 * so the legs are declared as mirror images rather than as two hand-written
 * shots — `direction` is what the scene flips its geometry on.
 */
export const RAIL_LEGS = [
  { direction: "send", start: 324, end: 504 },
  { direction: "request", start: 504, end: 684 },
];

/** The phase containing `frame`, or null past either edge of the cut. */
export const phaseAt = (frame) => PHASES.find((p) => frame >= p.start && frame < p.end) ?? null;

/** 0 → 1 across a phase, 0 at the first frame and 1 only once the phase is over. */
export const progress = (frame, phase) => (frame - phase.start) / (phase.end - phase.start);

/** 0 → 1 across an absolute frame window, clamped at both ends. */
export const range = (frame, from, to) =>
  Math.max(0, Math.min(1, to === from ? (frame >= to ? 1 : 0) : (frame - from) / (to - from)));

/** Linear blend, no clamping — callers clamp with `range`. */
export const mix = (a, b, t) => a + (b - a) * t;

/**
 * The curve family the whole piece moves on. The app's own --ease-out is a
 * bezier(0.22, 1, 0.36, 1); these are its cubic approximations, kept as plain
 * functions so they can be sampled per frame without pulling in a library.
 */
export const easeOut = (t) => 1 - Math.pow(1 - t, 3);
export const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/**
 * Sound cues, in frames. Levels are the per-cue fader; the wavs themselves
 * (public/sfx/) are synthesised by video/sfx.sh and are deliberately conservative
 * because these stack.
 *
 * The cue sheet doubles as the cut's rhythm: one hit per shot, a tick per
 * keystroke, a `zip` each time the money leaves.
 */
export const CUES = [
  { src: "swell", frame: 0, volume: 0.5 },
  { src: "impact", frame: 26, volume: 0.5 },
  ...[54, 70, 86, 102].map((frame) => ({ src: "tick", frame, volume: 0.2 })),
  { src: "shimmer", frame: 118, volume: 0.26 },

  // 02 · anywhere — one swish per namespace snapping in
  { src: "whoosh", frame: 132, volume: 0.3, rate: 0.9 },
  { src: "swish", frame: 158, volume: 0.26, rate: 0.94 },
  { src: "swish", frame: 182, volume: 0.26, rate: 1.0 },
  { src: "swish", frame: 206, volume: 0.26, rate: 1.06 },
  { src: "swish", frame: 230, volume: 0.26, rate: 1.12 },
  { src: "toggle", frame: 296, volume: 0.5 },

  // 03 · send — the money leaves
  { src: "press", frame: 344, volume: 0.6 },
  { src: "zip", frame: 362, volume: 0.4, rate: 1.1 },
  { src: "zip", frame: 398, volume: 0.34, rate: 1.0 },
  { src: "zip", frame: 434, volume: 0.3, rate: 0.92 },
  { src: "stamp", frame: 470, volume: 0.5 },

  // 04 · request — the same rail, run backwards
  { src: "toggle", frame: 504, volume: 0.55 },
  { src: "swish", frame: 528, volume: 0.26, rate: 1.0 },
  { src: "zip", frame: 556, volume: 0.4, rate: 0.86 },
  { src: "zip", frame: 592, volume: 0.34, rate: 0.78 },
  { src: "press", frame: 646, volume: 0.56 },
  { src: "stamp", frame: 662, volume: 0.48, rate: 0.94 },

  // 05 · endcard
  { src: "resolve", frame: 800, volume: 0.44 },
];