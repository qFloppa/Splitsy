import { loadFont } from "@remotion/fonts";
import { continueRender, delayRender, Easing, staticFile } from "remotion";

/**
 * The video's copy of the app's design tokens.
 *
 * Every value here is lifted verbatim from app/globals.css — this file is a
 * second CONSUMER of that palette, never a reinterpretation of it. If a token
 * moves there, move it here; a promo that drifts off-brand is worse than no
 * promo. The `--var` name each one came from is in the comment beside it so the
 * lookup is one grep, not a hunt.
 */
export const C = {
  ink: "#071421", // --ink-950, and --pay-poster-fg in light
  paper: "#f7f3ea", // --paper-50
  ground: "#eef3f6", // --background
  posterBg: "#f3f8fb", // --pay-poster-bg — what the dims mix against
  accent: "#2775ca", // --usdc-blue / --accent
  accentStrong: "#0a4f96", // --accent-strong
  cyan: "#3ee6d6", // --arc-cyan
  success: "#17a56b", // --settled-green / --success
  dim: "rgba(7, 20, 33, 0.75)", // --pay-poster-dim
  rule: "rgba(7, 20, 33, 0.14)", // --pay-poster-rule
  discord: "#5865f2", // the blurple .iou-mark is filled with

  // The spec-sheet system's dims are all `color-mix(in srgb, --pay-poster-fg
  // N%, --pay-poster-bg)`. Resolved to flat hex here, against #f3f8fb, because
  // interpolateColors() cannot read a color-mix() string — and the verb has to
  // travel from its receded colour to the accent as it is pressed.
  verb: "#616b74", // .iou-verb — fg 62%
  currencyOff: "#99a1a8", // .iou-currency, unfilled — fg 38%
  ghost: "#b1b8be", // .iou-ghost / ::placeholder — fg 28%
} as const;

/**
 * Copied rather than imported from app/ProviderTag.tsx: that module is
 * "use client" and pulls @/lib/provider-display through a tsconfig path alias
 * Remotion's bundler does not know about. One constant is a smaller price than
 * teaching a second webpack config about the alias.
 */
export const DISCORD_PATH =
  "M107.7 8.07A105.15 105.15 0 0 0 81.47 0a72.06 72.06 0 0 0-3.36 6.83 97.68 97.68 0 0 0-29.11 0A72.37 72.37 0 0 0 45.64 0a105.89 105.89 0 0 0-26.25 8.09C2.79 32.65-1.71 56.6.54 80.21a105.73 105.73 0 0 0 32.17 16.15 77.7 77.7 0 0 0 6.89-11.11 68.42 68.42 0 0 1-10.85-5.18c.91-.66 1.8-1.34 2.66-2a75.57 75.57 0 0 0 64.32 0c.87.71 1.76 1.39 2.66 2a68.68 68.68 0 0 1-10.87 5.19 77 77 0 0 0 6.89 11.1 105.25 105.25 0 0 0 32.19-16.14c2.64-27.38-4.51-51.11-18.9-72.15ZM42.45 65.69C36.18 65.69 31 60 31 53s5-12.74 11.43-12.74S54 46 53.89 53s-5.05 12.69-11.44 12.69Zm42.24 0C78.41 65.69 73.25 60 73.25 53s5-12.74 11.44-12.74S96.23 46 96.12 53s-5.04 12.69-11.43 12.69Z";

export const CLASH = "ClashDisplay";

/** --clash-word-spacing. Clash at −0.03em needs it or tokens touch. */
export const WORD_SPACING = "0.1em";

/** --ease-out: cubic-bezier(0.22, 1, 0.36, 1) — the app's only easing curve. */
export const easeOut = Easing.bezier(0.22, 1, 0.36, 1);
export const easeIn = Easing.bezier(0.55, 0, 1, 0.45);
export const easeInOut = Easing.bezier(0.65, 0, 0.35, 1);

/**
 * Type scale.
 *
 * NOT the app's rem values scaled by one factor. The app's caps labels are
 * 0.72rem against a 7rem sentence — a ratio that works when the reader is
 * 50cm from a monitor and falls apart in a muted timeline video played at
 * thumbnail size. So the sentence keeps its proportions and the labels are
 * pulled up relative to it. Ratios, not sizes, are what stays faithful.
 */
export const T = {
  sentence: 148, // .iou-sentence at its clamp ceiling, sized for 1080p
  action: 76, // .settle-action
  label: 24, // .settle-label / .iou-rail
  note: 38, // .iou-note
  caption: 30,
} as const;

/** .settle-label, as a style object. */
export const labelStyle = (color: string = C.dim, size: number = T.label) =>
  ({
    fontFamily: CLASH,
    wordSpacing: WORD_SPACING,
    fontWeight: 500,
    fontSize: size,
    letterSpacing: "0.18em",
    textTransform: "uppercase",
    color,
  }) as const;

/** .iou-sentence's shared type. Every token in the sentence inherits it. */
export const sentenceStyle = {
  fontFamily: CLASH,
  wordSpacing: WORD_SPACING,
  fontWeight: 300,
  fontSize: T.sentence,
  lineHeight: 0.98,
  letterSpacing: "-0.03em",
} as const;

// Block the render until Clash is actually parsed. measureText() in
// Sentence.tsx reads glyph metrics, and a measurement taken against the
// fallback face lays the whole sentence out wrong for the first frames — which
// on a 60fps render is a visible jump, not a flash.
const fontHandle = delayRender("Loading Clash Display");
loadFont({
  family: CLASH,
  url: staticFile("fonts/ClashDisplay-Variable.woff2"),
  format: "woff2",
  weight: "200 700",
})
  .then(() => continueRender(fontHandle))
  .catch((err) => {
    throw new Error(`Clash Display failed to load: ${err}`);
  });
