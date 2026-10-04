import React from "react";
import { measureText } from "@remotion/layout-utils";
import { interpolateColors } from "remotion";
import { Mail, Wallet } from "lucide-react";

import { C, CLASH, DISCORD_PATH, easeIn, easeOut, sentenceStyle, T, WORD_SPACING } from "./theme";

/**
 * The IOU composer's sentence, rebuilt from app/IouClient.tsx + .iou-sentence.
 *
 * The app lays this out with flexbox and animates the re-order with a FLIP
 * (measure, mutate, measure, play the difference). Here the whole sentence is
 * one timeline, so it is simpler and more exact to skip the mutation entirely:
 * both layouts are computed up front from measured glyph widths, and every
 * token's x is interpolated between them by a single `flip` value. Same motion,
 * no reflow, and it scrubs backwards for free.
 */

export type Provider = "x" | "discord" | "email" | "wallet";

/** .iou-sentence's `gap: 0.1em 0.3em` — the column half. */
const GAP = 0.3 * T.sentence;
/** .iou-avatar / .iou-mark: `height: 0.58em; margin-right: 0.16em`. */
const MARK = 0.58 * T.sentence;
const MARK_GAP = 0.16 * T.sentence;

/** How wide the sentence is allowed to get before it scales down to fit. */
export const FIT_WIDTH = 1500;

const measure = (text: string) =>
  text === ""
    ? 0
    : measureText({
        text,
        fontFamily: CLASH,
        fontSize: T.sentence,
        fontWeight: 300,
        letterSpacing: "-0.03em",
      }).width;

/** X handles carry an "@"; Discord, email and wallets do not. Same rule as providerDisplay. */
const prefixFor = (p: Provider) => (p === "x" ? "@" : "");

/** Width of the whole who-token: mark + "@" + whatever is currently typed. */
const whoWidth = (provider: Provider, shown: string) =>
  MARK + MARK_GAP + measure(prefixFor(provider)) + measure(shown);

export type ComposerState = {
  /** 0 = "I owe @dani $42", 1 = "@dani owes me $42". Interpolate for the flip. */
  flip: number;
  provider: Provider;
  /** The full target. Slice it yourself to type it in. */
  target: string;
  amount: string;
  /** 0 → 1, the hairline drawing left to right. */
  rule: number;
  /** Fades the whole group — used for the cold open and the settle lift. */
  opacity?: number;
  /** Lifts the group, in px. The settle beat rises. */
  lift?: number;
  caret?: boolean;
  /** Under-token hairline on the verb, 0 → 1. The app draws this on focus. */
  verbFocus?: number;
  /** Per-token print-in, 0 → 1. Order: subject, verb, who, money. */
  print?: [number, number, number, number];
};

const VERB_A = "owe";
const VERB_B = "owes me";

/** The provider glyph. Sized in em so it reads as a letter in the word, not a badge beside it. */
const Mark: React.FC<{ provider: Provider }> = ({ provider }) => {
  const box: React.CSSProperties = {
    width: MARK,
    height: MARK,
    marginRight: MARK_GAP,
    flexShrink: 0,
    display: "block",
  };

  if (provider === "x") {
    // A neutral disc, not a real face. The app loads the handle's actual avatar
    // from X's CDN; a promo cannot, and inventing someone's photograph to sit
    // beside a debt is the one thing this frame must not do.
    return (
      <div
        style={{
          ...box,
          borderRadius: "50%",
          background: `linear-gradient(145deg, ${C.accent}, ${C.cyan})`,
        }}
      />
    );
  }
  if (provider === "discord") {
    return (
      <svg style={box} viewBox="0 0 127.14 96.36" fill={C.discord}>
        <path d={DISCORD_PATH} />
      </svg>
    );
  }
  const Icon = provider === "email" ? Mail : Wallet;
  return <Icon style={box} strokeWidth={1.25} color={C.ink} />;
};

export const Composer: React.FC<ComposerState> = ({
  flip,
  provider,
  target,
  amount,
  rule,
  opacity = 1,
  lift = 0,
  caret = false,
  verbFocus = 0,
  print = [1, 1, 1, 1],
}) => {
  const wI = measure("I");
  const wVerb = measure(flip < 0.5 ? VERB_A : VERB_B);
  const wWho = whoWidth(provider, target);
  const money = `$${amount === "" ? "0.00" : amount}`;
  const wMoney = measure(money);

  // Layout A — "I owe @dani $42"
  const aI = 0;
  const aVerb = aI + wI + GAP;
  const aWho = aVerb + measure(VERB_A) + GAP;
  const aMoney = aWho + wWho + GAP;
  const totalA = aMoney + wMoney;

  // Layout B — "@dani owes me $42"
  const bWho = 0;
  const bVerb = bWho + wWho + GAP;
  const bMoney = bVerb + measure(VERB_B) + GAP;
  const totalB = bMoney + wMoney;

  const at = (a: number, b: number) => a + (b - a) * flip;
  const total = at(totalA, totalB);

  // The app's clamp() does this against the viewport; here it is done against
  // the frame. A 42-character wallet address genuinely does not fit at 148px,
  // and shrinking to hold it is the honest behaviour — the app wraps instead,
  // which a 16:9 frame has no room for.
  const scale = Math.min(1, FIT_WIDTH / total);

  const tokenBase: React.CSSProperties = {
    ...sentenceStyle,
    position: "absolute",
    bottom: 0,
    whiteSpace: "pre",
    color: C.ink,
  };

  /** The print-in the hero uses: the word slides up out of its own clip with a 2° settle. */
  const printed = (p: number): React.CSSProperties => ({
    transform: `translateY(${(1 - p) * 118}%) rotate(${(1 - p) * 2.1}deg)`,
  });

  return (
    <div
      style={{
        position: "relative",
        height: T.sentence * 1.02,
        opacity,
        transform: `translateY(${lift}px) scale(${scale})`,
        transformOrigin: "left bottom",
      }}
    >
      {/* subject — layout A only, so it leaves as the sentence turns around */}
      <div
        style={{
          ...tokenBase,
          left: aI,
          opacity: (1 - flip) * print[0],
          overflow: "hidden",
        }}
      >
        <div style={printed(print[0])}>I</div>
      </div>

      {/* verb — the toggle. Both words ride one box whose width interpolates
          with them, so the focus hairline underneath spans the word actually
          showing rather than whichever one happens to be in normal flow. */}
      <div style={{ ...tokenBase, left: at(aVerb, bVerb) }}>
        <div
          style={{
            position: "relative",
            width: at(measure(VERB_A), measure(VERB_B)),
            height: T.sentence,
            ...printed(print[1]),
            opacity: print[1],
          }}
        >
          {/* .iou-verb is receded until pressed, then it lights to --accent-strong
              — and the hairline is drawn in currentColor, so it arrives already
              carrying that colour. */}
          {[
            { text: VERB_A, opacity: 1 - flip },
            { text: VERB_B, opacity: flip },
          ].map((v) => (
            <span
              key={v.text}
              style={{
                position: "absolute",
                left: 0,
                bottom: 0,
                opacity: v.opacity,
                color: interpolateColors(verbFocus, [0, 1], [C.verb, C.accentStrong]),
              }}
            >
              {v.text}
            </span>
          ))}
          {/* .iou-verb::after — drawn from the left, in currentColor */}
          <div
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              bottom: 0.03 * T.sentence,
              height: Math.max(1, 0.018 * T.sentence),
              background: C.accentStrong,
              transform: `scaleX(${verbFocus})`,
              transformOrigin: "left",
            }}
          />
        </div>
      </div>

      {/* who — mark, "@", and the slot that grows as you type */}
      <div style={{ ...tokenBase, left: at(aWho, bWho) }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            ...printed(print[2]),
            opacity: print[2],
          }}
        >
          <Mark provider={provider} />
          <span>{prefixFor(provider)}</span>
          <span>{target}</span>
          {caret ? (
            <span
              style={{
                width: Math.max(2, 0.02 * T.sentence),
                height: "0.72em",
                marginLeft: "0.04em",
                background: C.ink,
                alignSelf: "center",
              }}
            />
          ) : null}
        </div>
      </div>

      {/* money — "$" stays dim until there is a number to qualify */}
      <div style={{ ...tokenBase, left: at(aMoney, bMoney) }}>
        <div style={{ display: "flex", ...printed(print[3]), opacity: print[3] }}>
          <span
            style={{
              color: amount === "" ? C.currencyOff : C.ink,
            }}
          >
            $
          </span>
          <span style={{ fontVariantNumeric: "tabular-nums" }}>{amount === "" ? "0.00" : amount}</span>
        </div>
      </div>

      {/* .iou-rule — the hairline under the sentence */}
      <div
        style={{
          position: "absolute",
          left: 0,
          bottom: -0.22 * T.sentence,
          width: FIT_WIDTH / scale,
          height: 1 / scale,
          background: C.rule,
          transform: `scaleX(${rule})`,
          transformOrigin: "left",
        }}
      />
    </div>
  );
};

/**
 * The note line's ghost, and the swap the app rotates its REASONS with.
 *
 * The app writes it per character rather than per word, because a stagger is
 * what makes a swap read as being written rather than crossfaded — so this does
 * the same. One gsap timeline per swap there: the outgoing characters stagger up
 * and out while the whole line blurs, and only once they are gone is the next
 * reason written and staggered up into place. Sequential, so one <Ghost> covers
 * a rotation — two lines are never on screen at once.
 *
 * Both staggers are `stagger: { amount }`, i.e. the spread is divided among
 * however many characters there are. "the bar tab" and "your half of the airbnb"
 * therefore take exactly as long as each other, which is the only reason a
 * rotation through mixed-length phrases reads as one gesture rather than a long
 * phrase crawling and a short one snapping.
 */

/** The out tween at 60fps: 0.28s, spread across a 0.18s stagger. */
export const GHOST_OUT = 28;
/** The in tween: 0.52s across 0.24s. A swap is the two back to back. */
export const GHOST_IN = 46;

/** Each window's stagger share; the remainder is one character's own tween. */
const OUT_SPREAD = 0.18 / 0.46;
const IN_SPREAD = 0.24 / 0.76;
/** `filter: blur(3px)`, tweened over 0.28s of the out and 0.44s of the in. */
const BLUR = 3;
const BLUR_IN = 0.28 / 0.46;
const BLUR_OUT = 0.44 / 0.76;
/** yPercent: ±70 — the travel, the same distance leaving as arriving. */
const TRAVEL = 70;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Character i's own 0 → 1 within a `stagger: { amount }` tween. */
const staggered = (p: number, i: number, n: number, spread: number) =>
  clamp01((p - (n > 1 ? (i / (n - 1)) * spread : 0)) / (1 - spread));

export const Ghost: React.FC<{
  /** The reason in the slot. */
  text: string;
  /** 0 → 1 over GHOST_IN, linear: the line arriving. The eases are applied here. */
  enter: number;
  /** 0 → 1 over GHOST_OUT, linear: that same line leaving, clearing the next one's way. */
  exit?: number;
}> = ({ text, enter, exit = 0 }) => {
  const chars = Array.from(text);
  // Blur the line, not each character: one filtered layer for the whole phrase
  // instead of twenty, and the phrase is what the eye tracks. Both halves live
  // in one expression so the resting state is exactly zero and the filter comes
  // off the layer entirely.
  const blur =
    BLUR * Math.max(easeIn(clamp01(exit / BLUR_IN)), 1 - easeOut(clamp01(enter / BLUR_OUT)));

  return (
    <div
      style={{
        fontFamily: CLASH,
        wordSpacing: WORD_SPACING,
        fontWeight: 300,
        fontSize: T.note,
        color: C.ghost,
        whiteSpace: "pre",
        display: "flex",
        filter: blur > 0.01 ? `blur(${blur}px)` : undefined,
      }}
    >
      {chars.map((ch, i) => {
        // The app's expo.out and power2.in, served by the app's own --ease-out
        // and its mirror: the video keeps one easing vocabulary.
        const into = easeOut(staggered(enter, i, chars.length, IN_SPREAD));
        const away = easeIn(staggered(exit, i, chars.length, OUT_SPREAD));
        return (
          <span
            key={i}
            style={{
              opacity: into * (1 - away),
              transform: `translateY(${(1 - into) * TRAVEL - away * TRAVEL}%)`,
            }}
          >
            {ch === " " ? " " : ch}
          </span>
        );
      })}
    </div>
  );
};

/** .settle-action — the borderless display word that moves money. */
export const Action: React.FC<{
  label: string;
  opacity?: number;
  press?: number;
  /** Tracking tightens on press, the way .settle-action:hover does. */
}> = ({ label, opacity = 1, press = 0 }) => (
  <div
    style={{
      fontFamily: CLASH,
      wordSpacing: WORD_SPACING,
      fontWeight: 300,
      fontSize: T.action,
      letterSpacing: `${0.14 - press * 0.04}em`,
      lineHeight: 1,
      color: press > 0.02 ? C.accentStrong : C.ink,
      opacity,
      whiteSpace: "pre",
    }}
  >
    {label} ›
  </div>
);
