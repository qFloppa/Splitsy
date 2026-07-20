"use client";

import { useEffect, useRef } from "react";
import Image from "next/image";
import gsap from "gsap";
import SplitType from "split-type";

// Headline reveal: SplitType splits into masked lines and words, then each
// word slides up out of its line's clip with a 2° settle rotation — the page
// "prints" itself rather than fading in. Runs once, after fonts load, so the
// split measures the real glyphs and never reflows mid-animation.
export function Hero() {
  const headlineRef = useRef<HTMLHeadingElement>(null);
  const ledeRef = useRef<HTMLParagraphElement>(null);
  const stampRef = useRef<HTMLSpanElement>(null);

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

      timeline = gsap
        .timeline({ defaults: { ease: "expo.out" } })
        .to(words, {
          yPercent: 0,
          rotate: 0,
          duration: 1.05,
          stagger: { each: 0.075, from: "start" },
        })
        .from(ledeRef.current, { y: 18, autoAlpha: 0, duration: 0.8 }, "-=0.65")
        .from(stampRef.current, { scale: 0.8, autoAlpha: 0, duration: 0.5, ease: "back.out(2.2)" }, "-=0.6")
        .add(() => { headline.dataset.revealed = ""; });
    });

    return () => {
      cancelled = true;
      timeline?.kill();
      split?.revert();
    };
  }, []);

  return (
    <section aria-labelledby="hero-heading" className="relative mx-auto w-full max-w-[88rem] px-4 sm:px-6 lg:px-8">
      <div className="flex min-h-[62vh] flex-col items-start justify-center pb-10 pt-16 sm:pt-24 lg:pb-14 lg:pt-28">
        <span className="network-stamp" ref={stampRef}>
          Arc Testnet
        </span>
        <h1 className="lp-display lp-hero-headline mt-6" id="hero-heading" ref={headlineRef}>
          <Image alt="S" className="lp-hero-s" data-hero-s height={429} preload src="/splitsy2.png" width={323} />plit any receipt.
          <br />
          <span className="lp-headline-accent">Anyone. Anywhere.</span>
        </h1>
        <p className="lp-lede mt-7 max-w-xl" ref={ledeRef}>
          Scan a receipt, tag friends by X, Discord, email, or wallet, then settle the split in USDC on Arc.
          One click.
        </p>
      </div>
    </section>
  );
}
