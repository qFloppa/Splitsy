import React from "react";
import {
  AbsoluteFill,
  Img,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

import { Glass } from "./Glass";
import { Action, Composer, Ghost, type Provider } from "./Sentence";
import { C, CLASH, easeIn, easeOut, labelStyle, T, WORD_SPACING } from "./theme";

/**
 * 18 seconds of the IOU composer, cut on a 120bpm grid.
 *
 * 60fps, so one beat is exactly 30 frames and every shot boundary below lands
 * on one. That is deliberate: there is no soundtrack yet, and when one is added
 * (drop an mp3 in public/ and one <Audio> tag here) the cuts are already in
 * time with it. Nothing else depends on the grid, so it costs nothing.
 *
 * The composer itself is NOT wrapped in <Sequence>. Its state is one continuous
 * function of the absolute frame, because the sentence is meant to read as a
 * single unbroken take from the first keystroke to the settled stamp — a
 * Sequence per shot would remount it and lose that.
 */

const COLD_OPEN = 0;
const TYPE = 90; //  1.5s — the sentence writes itself
const FLIP = 330; //  5.5s — the verb is tapped
const ANYONE = 480; //  8.0s — four namespaces
const SETTLE = 720; // 12.0s — money moves
const OUTRO = 900; // 15.0s — escrow, then the endcard
const END = 1080; // 18.0s

/** The composer column's left edge, and the rail's inset. */
const MARGIN = 150;

const HANDLE = "dani";
const EMAIL = "dani@gmail.com";
const ADDRESS = "0xEE42a492B183CdFf04439F2Cb6A9c49F857F70AC";
/** What .iou-compact draws in the full address's place. The value is untouched. */
const ADDRESS_SHORT = "0xEE42…70AC";
const AMOUNT = "42";
/** One of the real REASONS from app/IouClient.tsx. */
const REASON = "last night's ramen";

const NAMESPACES: { key: Provider; label: string }[] = [
  { key: "x", label: "X" },
  { key: "discord", label: "Discord" },
  { key: "email", label: "Email" },
  { key: "wallet", label: "Wallet" },
];

/** 0 → 1 across a frame range, clamped both ends. */
const ramp = (frame: number, from: number, to: number, easing = easeOut) =>
  interpolate(frame, [from, to], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing,
  });

/** Reveals `text` one character at a time. Negative `perChar` deletes it instead. */
const typing = (frame: number, text: string, from: number, perChar: number) => {
  const n = Math.floor((frame - from) / Math.abs(perChar));
  if (frame < from) return perChar > 0 ? "" : text;
  const shown = perChar > 0 ? n : text.length - n;
  return text.slice(0, Math.max(0, Math.min(text.length, shown)));
};

/**
 * Which namespace the who-slot is holding, and what is typed into it.
 *
 * The app clears a field by select-all-and-overtype for anything long, and
 * backspaces short values; both are reproduced, because a 42-character address
 * deleted one character at a time would eat two full seconds of an 18-second cut.
 */
const whoAt = (frame: number): { provider: Provider; target: string } => {
  if (frame < 516) return { provider: "x", target: typing(frame, HANDLE, 160, 15) };
  // X → Discord: backspaced, because four characters is quick
  if (frame < 528) return { provider: "x", target: typing(frame, HANDLE, 516, -3) };
  if (frame < 564) return { provider: "discord", target: typing(frame, HANDLE, 528, 3) };
  // Discord → email: select-all, overtype
  if (frame < 570) return { provider: "discord", target: "" };
  // Typed fast enough to land on the complete address well before the cut. An
  // email frozen mid-domain reads as a typo'd TLD rather than as typing.
  if (frame < 636) return { provider: "email", target: typing(frame, EMAIL, 570, 2.4) };
  if (frame < 642) return { provider: "email", target: "" };
  // The address types out in full, which is what forces the sentence to scale
  // down to hold it — then .iou-compact collapses it and the sentence springs back.
  if (frame < 690) return { provider: "wallet", target: typing(frame, ADDRESS, 642, 1.15) };
  return { provider: "wallet", target: ADDRESS_SHORT };
};

export const Promo: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const { provider, target } = whoAt(frame);

  // The flip, both ways. Heavily damped — a sentence that bounces reads as a
  // toy, and this one is moving money.
  const flipOut = spring({ frame, fps, delay: 354, durationInFrames: 44, config: { damping: 200 } });
  const flipBack = spring({ frame, fps, delay: 726, durationInFrames: 40, config: { damping: 200 } });
  const flip = flipOut * (1 - flipBack);

  const amount = frame < 248 ? "" : typing(frame, AMOUNT, 248, 14);

  // The settle press, and what it throws out.
  const press = interpolate(frame, [770, 776, 790], [0, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: easeOut,
  });
  const settled = ramp(frame, 832, 852);

  const exit = ramp(frame, OUTRO, OUTRO + 26, easeIn);
  const composerOpacity = frame < TYPE ? 0 : 1 - exit;
  const actionLabel = flip > 0.5 ? "send the ask" : "settle";

  // The camera. A slow push across the whole take, plus a small punch-in on
  // the settle press, anchored on the sentence so the push moves toward the
  // words, not toward empty glass. The exit pulls back and blurs, which hands
  // off to the headline instead of cutting to it.
  const push = interpolate(frame, [TYPE, OUTRO], [1, 1.045], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const punch = spring({ frame, fps, delay: 772, durationInFrames: 36, config: { damping: 14, mass: 0.6 } });
  const punchScale = 1 + punch * 0.018 * (1 - ramp(frame, 800, 860));
  const camera = push * punchScale * (1 - exit * 0.06);

  // The pulse from the stamp: two rings in --success, the way a confirmation
  // lands on a payment sheet.
  const pulse = (delay: number) => ramp(frame, 834 + delay, 894 + delay, easeOut);

  return (
    <AbsoluteFill style={{ backgroundColor: C.ground }}>
      <Glass introFrames={90} />

      {/* ── 01 · cold open ──────────────────────────────────────────────── */}
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
        <Img
          src={staticFile("splitsy-dark.png")}
          style={{
            height: 300,
            opacity: ramp(frame, 8, 44) * (1 - ramp(frame, 62, 92, easeIn)),
            transform: `scale(${interpolate(
              frame,
              [8, 44, 62, 92],
              [1.28, 1, 1, 0.9],
              { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: easeOut },
            )}) translateY(${-ramp(frame, 62, 92, easeIn) * 70}px)`,
          }}
        />
      </AbsoluteFill>

      {/* ── the composer, frames 90 → 900 ───────────────────────────────── */}
      <AbsoluteFill
        style={{
          opacity: composerOpacity,
          // Origin on the sentence, not the frame centre: a push anchored at
          // 50% 50% drifts the type off to the left as it grows.
          transformOrigin: "22% 46%",
          transform: `scale(${camera})`,
          filter: exit > 0 ? `blur(${exit * 10}px)` : undefined,
        }}
      >
        {/* .iou-rail — "← receipts" one side, the network the other. Both are the
            app's own strings; the right-hand one is what a mainnet build says. */}
        <div
          style={{
            position: "absolute",
            top: 60,
            left: MARGIN,
            right: MARGIN,
            display: "flex",
            justifyContent: "space-between",
            opacity: ramp(frame, 92, 124),
            ...labelStyle(),
          }}
        >
          <span>← receipts</span>
          <span>usdc on arc</span>
        </div>

        <div style={{ position: "absolute", top: 410, left: MARGIN }}>
          <Composer
            flip={flip}
            provider={provider}
            target={target}
            amount={amount}
            rule={ramp(frame, 280, 320)}
            lift={-ramp(frame, 820, 844) * 26}
            caret={frame > 150 && frame < 700 && Math.floor(frame / 24) % 2 === 0}
            verbFocus={ramp(frame, 338, 352) * (1 - ramp(frame, 440, 462))}
            print={[
              ramp(frame, 100, 122),
              ramp(frame, 116, 138),
              ramp(frame, 134, 156),
              ramp(frame, 226, 248),
            ]}
          />
        </div>

        {/* the note line's ghost — the app writes it per character, so this does
            too. It stays up through the settle: the app never clears it, and
            dropping it early left a dead band between the rule and the action. */}
        <div style={{ position: "absolute", top: 636, left: MARGIN }}>
          <Ghost text={REASON} chars={Math.floor(ramp(frame, 296, 356) * REASON.length)} />
        </div>

        {/* .iou-meta — "on x" only while the target does not already name its own
            namespace, which is exactly the app's rule: an email and a 0x address do. */}
        <div
          style={{
            position: "absolute",
            top: 710,
            left: MARGIN,
            display: "flex",
            gap: 40,
            opacity: ramp(frame, 250, 280),
            ...labelStyle(),
          }}
        >
          {provider === "x" || provider === "discord" ? <span>on {provider}</span> : null}
          <span>as @you</span>
        </div>

        <div style={{ position: "absolute", top: 776, left: MARGIN }}>
          <Action label={actionLabel} opacity={ramp(frame, 258, 288)} press={press} />
          {/* The blocks the send throws out. They travel along the action's own
              baseline, starting clear of the word: a block crossing the letters
              reads as a glitch, not as a send. */}
          {[0, 1, 2].map((i) => {
            const go = ramp(frame, 778 + i * 8, 846 + i * 8, easeOut);
            return (
              <div
                key={i}
                style={{
                  position: "absolute",
                  top: T.action * 0.44,
                  left: 370,
                  width: 14,
                  height: 14,
                  background: C.accent,
                  opacity: go > 0 && go < 1 ? 1 : 0,
                  transform: `translateX(${go * 420}px)`,
                }}
              />
            );
          })}
        </div>

        {/* ── 04 · the four namespaces ─────────────────────────────────── */}
        <div
          style={{
            position: "absolute",
            top: 890,
            left: MARGIN,
            display: "flex",
            gap: 46,
            opacity: ramp(frame, 486, 516) * (1 - ramp(frame, 700, 720)),
          }}
        >
          {NAMESPACES.map((ns) => (
            <span key={ns.key} style={labelStyle(ns.key === provider ? C.ink : C.rule)}>
              {ns.label}
            </span>
          ))}
        </div>

        {/* ── 05 · settled ─────────────────────────────────────────────── */}
        <div style={{ position: "absolute", top: 890, left: MARGIN, opacity: settled }}>
          {/* Two confirmation rings off the stamp as it lands */}
          {[0, 10].map((d) => (
            <div
              key={d}
              style={{
                position: "absolute",
                left: 140 - 60,
                top: 22 - 60,
                width: 120,
                height: 120,
                borderRadius: "50%",
                border: `2px solid ${C.success}`,
                opacity: pulse(d) > 0 && pulse(d) < 1 ? (1 - pulse(d)) * 0.7 : 0,
                transform: `scale(${0.4 + pulse(d) * 3.2})`,
              }}
            />
          ))}
          {/* .settlement-stamp, verbatim: −7°, a 2px success keyline, 850 weight */}
          <div
            style={{
              width: "fit-content",
              transform: `rotate(-7deg) scale(${interpolate(settled, [0, 1], [2.4, 1])})`,
              border: `2px solid ${C.success}`,
              borderRadius: 6,
              color: C.success,
              padding: "8px 16px",
              fontFamily: CLASH,
              wordSpacing: WORD_SPACING,
              fontWeight: 700,
              fontSize: T.label,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
            }}
          >
            Settled on Arc
          </div>
          {/* .iou-ledger-head — a label on the left, the net on the right, with the
              width between them. Set side by side they read as one phrase ("open
              square"), which is not what a ledger says. "square" is genuinely the
              app's word for a net of zero. */}
          <div
            style={{
              marginTop: 30,
              width: 560,
              display: "flex",
              justifyContent: "space-between",
              opacity: ramp(frame, 856, 886),
              ...labelStyle(),
            }}
          >
            <span>open</span>
            <span style={{ color: C.ink }}>square</span>
          </div>
        </div>
      </AbsoluteFill>

      {/* ── 03 · what the flip means, for a muted viewer ────────────────── */}
      <div
        style={{
          position: "absolute",
          top: 890,
          left: MARGIN,
          opacity: ramp(frame, 400, 428) * (1 - ramp(frame, 468, 486)),
          ...labelStyle(C.ink),
        }}
      >
        Ask for it, or send it
      </div>

      {/* ── 06 · no wallet, then the endcard ───────────────────────────── */}
      <AbsoluteFill style={{ justifyContent: "center", paddingLeft: MARGIN, paddingRight: MARGIN }}>
        {/* SectionAnyone's real headline and its real fact line */}
        <div
          style={{
            opacity: ramp(frame, 922, 952) * (1 - ramp(frame, 1000, 1022, easeIn)),
            transform: `translateY(${(1 - ramp(frame, 922, 952)) * 34 - ramp(frame, 1000, 1022, easeIn) * 34}px)`,
          }}
        >
          <div
            style={{
              fontFamily: CLASH,
              wordSpacing: WORD_SPACING,
              fontWeight: 300,
              fontSize: 112,
              letterSpacing: "-0.03em",
              lineHeight: 1,
              color: C.ink,
            }}
          >
            No wallet? <span style={{ color: C.accent }}>No problem.</span>
          </div>
          <div style={{ marginTop: 34, ...labelStyle() }}>escrowed on Arc until they claim it</div>
        </div>
      </AbsoluteFill>

      <AbsoluteFill
        style={{
          alignItems: "center",
          justifyContent: "center",
          opacity: ramp(frame, 1016, 1046),
        }}
      >
        <div
          style={{
            transform: `translateY(${(1 - ramp(frame, 1016, 1046)) * 40}px)`,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
          }}
        >
          {/* The navy mark, not splitsy.png: that wordmark is a pale glass
              treatment made for dark and photographic grounds, and on this
              light pane it all but disappears. Mark + name set in Clash is the
              lockup that holds up at thumbnail size in a timeline. */}
          <div style={{ display: "flex", alignItems: "center", gap: 34 }}>
            <Img
              src={staticFile("splitsy-dark.png")}
              style={{
                height: 170,
                transform: `rotate(${(1 - ramp(frame, 1016, 1056)) * -14}deg) scale(${interpolate(
                  ramp(frame, 1016, 1056),
                  [0, 1],
                  [0.8, 1],
                )})`,
              }}
            />
            <div
              style={{
                fontFamily: CLASH,
                wordSpacing: WORD_SPACING,
                fontWeight: 500,
                fontSize: 150,
                letterSpacing: "-0.035em",
                lineHeight: 1,
                color: C.ink,
                clipPath: `inset(0 ${(1 - ramp(frame, 1024, 1060)) * 100}% 0 0)`,
              }}
            >
              Splitsy
            </div>
          </div>
          <div style={{ marginTop: 50, ...labelStyle(C.ink, 30) }}>programmable money on Arc</div>
          <div style={{ marginTop: 20, ...labelStyle(C.accentStrong, 26) }}>splitsy.xyz</div>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
