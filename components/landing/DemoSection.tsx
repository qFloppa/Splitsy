"use client";

import { useEffect, useRef } from "react";
import gsap from "gsap";

import { BrowserFrame } from "./BrowserFrame";
import { DemoStage } from "./demo/DemoStage";
import { useReveal } from "./useReveal";

// The demo's outer shell. The plate enters tilted back slightly (rotateX +
// scale, GPU-only) and docks flat as it scrolls into view — the "camera" pulling
// the visitor into the product. The inner choreography lives in DemoStage.
export function DemoSection() {
  const frameRef = useRef<HTMLDivElement>(null);
  const headRef = useReveal<HTMLDivElement>();

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const frame = frameRef.current;
    if (!frame) return;

    const tween = gsap.fromTo(
      frame,
      { rotateX: 9, scale: 0.955, y: 36, transformPerspective: 1200 },
      {
        rotateX: 0,
        scale: 1,
        y: 0,
        ease: "none",
        scrollTrigger: {
          trigger: frame,
          start: "top 92%",
          end: "top 38%",
          scrub: 0.6,
        },
      },
    );

    return () => {
      tween.scrollTrigger?.kill();
      tween.kill();
    };
  }, []);

  return (
    <section aria-labelledby="demo-heading" className="bill-poster scroll-mt-24" id="demo">
      <div className="lp-measure" ref={headRef}>
        <div className="bill-poster-head">
          <span className="settle-label" data-reveal="item">
            <span className="lp-step">01</span> The split
          </span>
          <span className="bill-poster-fact" data-reveal="item">
            running live · scroll to scrub, or pick a step
          </span>
        </div>
        <h2 className="lp-display-lg mt-4 max-w-4xl" data-reveal="lead" id="demo-heading">
          A photograph in
          <br />
          <span className="lp-headline-accent">Four settled shares out</span>
        </h2>
        <p className="lp-lede mt-5 max-w-2xl" data-reveal="lead">
          No sign-up to watch it. The receipt is scanned, each line is tagged to whoever ate it, and the
          whole split is written to Arc in one transaction.
        </p>
      </div>

      {/* data-demo-pin: what DemoStage pins and scrubs. The head above stays in
          normal flow so the pinned frame is all product. */}
      <div className="lp-measure bill-poster-body" data-demo-pin>
        <div ref={frameRef} style={{ transformStyle: "preserve-3d" }}>
          <BrowserFrame label="splitsy.xyz/app" note="Arc Testnet · no real funds">
            <DemoStage />
          </BrowserFrame>
        </div>
      </div>
    </section>
  );
}
