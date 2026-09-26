import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";

import { C, easeOut } from "./theme";

/**
 * The liquid-glass ground, rebuilt from .app-backdrop in app/globals.css.
 *
 * Read it bottom-up and it is a sheet of glass over coloured liquid: the app's
 * mist (#eef3f6), three overlapping accent blooms that are the liquid, then a
 * translucent white pane that frosts them — bright along the top lip, thinning
 * through the body, settling again at the foot. No backdrop-filter, for the
 * same reason the app doesn't use one here: with nothing behind the page there
 * is nothing to sample, and a white pane over saturated blooms IS what
 * frosting does to colour.
 *
 * Two things are added for video and are not in the app: the blooms drift, and
 * the whole frame creeps in by 3% across the 18 seconds. A backdrop that is
 * pixel-identical for 1080 frames reads as a screenshot with text on top.
 */

// Each bloom's box is derived from the app's `radial-gradient(RX RY at CX CY)`:
// left = CX − RX, top = CY − RY, width = 2·RX, height = 2·RY. Percentages so
// this holds at any composition size.
//
// The alphas are ~1.5× the app's, and the white pane below is thinner than the
// app's, for one reason: h264 crushes low-amplitude gradients. At the CSS
// values the blooms survive on a monitor but quantise to flat grey in the
// encode — the first render of this file proved it. Same three blooms, same
// hue, same geometry; only the amplitude is raised to clear the codec floor.
const BLOOMS = [
  // radial-gradient(62% 48% at 6% 2%, accent 38%)
  { left: "-56%", top: "-46%", width: "124%", height: "96%", alpha: 0.58, period: 540, drift: 26 },
  // radial-gradient(48% 42% at 92% 8%, accent 26%)
  { left: "44%", top: "-34%", width: "96%", height: "84%", alpha: 0.42, period: 700, drift: 34 },
  // radial-gradient(70% 52% at 72% 96%, accent 28%)
  { left: "2%", top: "44%", width: "140%", height: "104%", alpha: 0.46, period: 620, drift: 30 },
] as const;

// The app's own dither, verbatim — feTurbulence at baseFrequency 0.6 over a
// 180px tile. It matters more here than on the web: h264 quantises smooth
// gradients into visible bands, and grain is what breaks them up.
const NOISE =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.6' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")";

export const Glass: React.FC<{
  /** Frames over which the blooms swell and the pane sweeps down. 0 = already settled. */
  introFrames?: number;
}> = ({ introFrames = 0 }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();

  const intro = introFrames
    ? interpolate(frame, [0, introFrames], [0, 1], { extrapolateRight: "clamp", easing: easeOut })
    : 1;

  // 1.00 → 1.03 across the whole piece. Slow enough to be felt, not seen.
  const creep = interpolate(frame, [0, durationInFrames], [1, 1.03]);

  return (
    <AbsoluteFill style={{ backgroundColor: C.ground, overflow: "hidden" }}>
      <AbsoluteFill style={{ transform: `scale(${creep})` }}>
        {BLOOMS.map((bloom, i) => {
          // Prime-ish periods that never re-sync, which is the whole trick: three
          // blooms on one period is a pulse, three on different ones is liquid.
          const t = (frame / bloom.period) * Math.PI * 2;
          const dx = Math.sin(t + i * 2.1) * bloom.drift;
          const dy = Math.cos(t * 0.72 + i * 1.3) * bloom.drift * 0.6;
          // Staggered swell on the cold open, back to front.
          const enter = interpolate(intro, [i * 0.12, 0.55 + i * 0.12], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          });

          return (
            <div
              key={i}
              style={{
                position: "absolute",
                left: bloom.left,
                top: bloom.top,
                width: bloom.width,
                height: bloom.height,
                opacity: enter,
                transform: `translate(${dx}px, ${dy}px) scale(${interpolate(enter, [0, 1], [0.55, 1])})`,
                background: `radial-gradient(closest-side, rgba(39, 117, 202, ${bloom.alpha}), rgba(39, 117, 202, 0) 72%)`,
              }}
            />
          );
        })}
      </AbsoluteFill>

      {/* The frosting. Sweeps down over the blooms on the cold open. */}
      <AbsoluteFill
        style={{
          transform: `translateY(${interpolate(intro, [0, 1], [-14, 0])}%)`,
          opacity: interpolate(intro, [0.15, 0.85], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          }),
          background:
            "linear-gradient(180deg, rgba(255,255,255,0.58), rgba(255,255,255,0.06) 16%, rgba(255,255,255,0.14) 60%, rgba(255,255,255,0.40))",
        }}
      />

      <AbsoluteFill style={{ opacity: 0.06, backgroundImage: NOISE }} />

      {/* Video-only: pulls the corners down a touch so the eye lands on the
          sentence rather than wandering the frame. Far too subtle to read as
          a vignette, which is the point. */}
      <AbsoluteFill
        style={{
          background: "radial-gradient(68% 62% at 50% 46%, rgba(7,20,33,0) 55%, rgba(7,20,33,0.07))",
        }}
      />
    </AbsoluteFill>
  );
};
