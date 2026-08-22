"use client";

import { useEffect, useRef } from "react";
import Image from "next/image";
import Link from "next/link";
import gsap from "gsap";
import { ArrowRight } from "lucide-react";
import SplitType from "split-type";

import { MagneticButton } from "./MagneticButton";

// The three facts a visitor needs before they will scroll, set as the app's own
// figures rail: caps label, figure, hairline. Not a feature grid — a spec sheet,
// which is what the product's every screen already is.
const FACTS = [
  { label: "Settles on", figure: "Arc", note: "USDC-native L1 · sub-second finality" },
  { label: "Ways to tag someone", figure: "4", note: "X · Discord · email · wallet" },
  { label: "Paid agent APIs", figure: "7", note: "x402 · from half a cent a call" },
];

/**
 * The hero.
 *
 * Type: .lp-display is Clash 300 at −0.032em — .bill-display's weight and
 * tracking, which is the voice the app sets a scanned receipt's merchant in. The
 * headline and the product's own masthead are now the same typeface at the same
 * weight, one very large and one merely large.
 *
 * Motion: SplitType splits into masked lines and words, then each word slides up
 * out of its line's clip with a 2° settle rotation — the page "prints" itself
 * rather than fading in. Runs once, after fonts load, so the split measures the
 * real glyphs and never reflows mid-animation. The rail's hairlines draw
 * themselves left to right at the end of the same timeline, so the spec sheet
 * assembles under the headline instead of arriving with it.
 *
 * Everything below is authored in its FINAL state and the timeline is built from
 * .from() tweens, so under prefers-reduced-motion — where the effect returns
 * before building anything — the resting frame is the correct one.
 */
export function Hero() {
  const headlineRef = useRef<HTMLHeadingElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const ledeRef = useRef<HTMLParagraphElement>(null);
  const stampRef = useRef<HTMLSpanElement>(null);
  const callRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const headline = headlineRef.current;
    if (!headline) return;

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      headline.dataset.ready = "";
      return;
    }

    let split: SplitType | null = null;
    let timeline: gsap.core.Timeline | null = null;
    let cancelled = false;

    document.fonts.ready.then(() => {
      if (cancelled) return;

      split = new SplitType(headline, { types: "lines,words" });
      const words = split.words ?? [];
      // SplitType leaves the S logo as its own sibling in the first line; fold
      // it into the first word ("plit") so logo and letters slide up as one.
      const sLogo = headline.querySelector("[data-hero-s]");
      if (sLogo && words[0]) words[0].prepend(sLogo);
      gsap.set(words, { yPercent: 118, rotate: 2.1 });
      headline.dataset.ready = "";

      const rail = railRef.current;
      const rules = rail?.querySelectorAll("[data-rule]") ?? [];
      const cells = rail?.querySelectorAll("[data-rail-cell]") ?? [];

      timeline = gsap
        .timeline({ defaults: { ease: "expo.out" } })
        .from(stampRef.current, { autoAlpha: 0, duration: 0.5 }, 0)
        .to(
          words,
          { yPercent: 0, rotate: 0, duration: 1.05, stagger: { each: 0.075, from: "start" } },
          0.12,
        )
        .from(ledeRef.current, { y: 18, autoAlpha: 0, duration: 0.8 }, "-=0.65")
        .from(callRef.current, { y: 14, autoAlpha: 0, duration: 0.7 }, "-=0.55")
        // The rail assembles last and in two passes: the labels and figures come
        // up, then the rule under each is drawn. A rule that arrives with its
        // figure is a border; a rule drawn after it is an underline.
        .from(cells, { y: 16, autoAlpha: 0, duration: 0.6, stagger: 0.08 }, "-=0.45")
        .from(rules, { scaleX: 0, duration: 0.9, stagger: 0.08 }, "<0.1")
        .add(() => {
          headline.dataset.revealed = "";
        });
    });

    return () => {
      cancelled = true;
      timeline?.kill();
      split?.revert();
    };
  }, []);

  return (
    <section aria-labelledby="hero-heading" className="lp-measure relative">
      <div className="flex flex-col items-start justify-center pt-14 pb-[clamp(2rem,1rem+2.5vw,4rem)] sm:pt-20 lg:pt-24">
        <span className="settle-label app-network" ref={stampRef}>
          Arc Testnet · live
        </span>
        <h1 className="lp-display lp-hero-headline mt-5" id="hero-heading" ref={headlineRef}>
          {/* The S is the logo, inked for the ground it sits on. Both files ship
              and CSS shows one, because the theme lives on <html data-theme> and
              only the header's toggle writes it — reading it back here would mean
              a second copy of that state. fetchPriority rather than preload:
              preloading both would fetch the S nobody sees. sizes, because the
              slot is ~1em of display type (≤116px) whatever the source measures. */}
          <span data-hero-s>
            <Image alt="S" className="lp-hero-s lp-hero-s-light" fetchPriority="high" height={1310} sizes="120px" src="/splitsy-dark.png" width={1200} />
            <Image alt="S" className="lp-hero-s lp-hero-s-dark" fetchPriority="high" height={429} sizes="120px" src="/splitsy2.png" width={323} />
          </span>
          plit any receipt
          <br />
          {/* Two sibling spans with a <br> between them, rather than one span
              containing the break: this is the structure SplitType already
              splits correctly for the line above. */}
          <span className="lp-headline-accent">Anyone</span>
          <br />
          <span className="lp-headline-accent">Or their agent</span>
        </h1>
        <p className="lp-lede mt-8 max-w-xl" ref={ledeRef}>
          Scan a receipt, tag friends by X, Discord, email, or wallet, and settle in USDC on Arc. Or fund
          an agent and let it settle your share for you, under ceilings you set.
        </p>

        <div className="mt-10" ref={callRef}>
          <MagneticButton>
            {/* .settle-action is the /pay poster's signature control — the
                borderless display word that moves money. The landing's call is
                the same control, one register down. */}
            <Link className="settle-action lp-call" href="/app">
              Start splitting
              <ArrowRight aria-hidden size="0.6em" />
            </Link>
          </MagneticButton>
        </div>

        <div className="bill-poster-rail lp-hero-rail mt-[clamp(3rem,2rem+4vw,5.5rem)] w-full" ref={railRef}>
          {FACTS.map((fact) => (
            <div className="bill-cell" data-rail-cell key={fact.label}>
              <span className="settle-label">{fact.label}</span>
              <div className="bill-figure-sm">{fact.figure}</div>
              <div className="bill-cell-rule lp-rule" data-rule />
              <p className="lp-row-body mt-2">{fact.note}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
