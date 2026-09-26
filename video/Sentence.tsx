import React from "react";
import { measureText } from "@remotion/layout-utils";
import { interpolateColors } from "remotion";
import { Mail, Wallet } from "lucide-react";

import { C, CLASH, DISCORD_PATH, sentenceStyle, T, WORD_SPACING } from "./theme";

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
 * The note line's ghost. The app writes it per character rather than per word,
 * because a stagger is what makes a swap read as being written rather than
 * crossfaded — so this does the same.
 */
export const Ghost: React.FC<{ text: string; chars: number }> = ({ text, chars }) => (
  <div
    style={{
      fontFamily: CLASH,
      wordSpacing: WORD_SPACING,
      fontWeight: 300,
      fontSize: T.note,
      color: C.ghost,
      whiteSpace: "pre",
      display: "flex",
    }}
  >
    {Array.from(text).map((ch, i) => (
      <span
        key={i}
        style={{
          opacity: i < chars ? 1 : 0,
          transform: `translateY(${i < chars ? 0 : 0.3}em)`,
        }}
      >
        {ch === " " ? " " : ch}
      </span>
    ))}
  </div>
);

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
