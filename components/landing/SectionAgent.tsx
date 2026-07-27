"use client";

import { useEffect, useRef } from "react";
import gsap from "gsap";

import { BrowserFrame } from "./BrowserFrame";
import { AgentStage } from "./demo/AgentStage";

// Sits directly after the product demo on purpose: DemoStage's first act is a
// receipt sliding into a scan beam, and this section is what happens inside
// that beam and who paid for it. The frame docks the same way DemoSection's
// does, so the two read as one continuous story rather than two demos.
export function SectionAgent() {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const root = rootRef.current;
    if (!root) return;

    const ctx = gsap.context(() => {
      gsap.from("[data-agent-heading]", {
        y: 26,
        autoAlpha: 0,
        duration: 0.8,
        ease: "expo.out",
        scrollTrigger: { trigger: root, start: "top 78%" },
      });
    }, root);

    return () => ctx.revert();
  }, []);

  return (
    <section
      aria-labelledby="agent-heading"
      className="mx-auto w-full max-w-[96rem] scroll-mt-24 px-4 pt-[var(--lp-section-y)] sm:px-6 lg:px-8"
      id="agent"
      ref={rootRef}
    >
      <h2 className="lp-display-lg max-w-3xl" data-agent-heading id="agent-heading">
        Upload a receipt. <span className="lp-headline-accent">An agent goes shopping.</span>
      </h2>
      <p className="lp-lede mt-5 max-w-2xl" data-agent-heading>
        Scout has its own wallet, an ERC-8004 identity on Arc, and a daily budget of one dollar. It
        judges your photo before spending anything, pays Splitsy&apos;s own x402 endpoints per call, and
        buys a second opinion when the parse looks shaky — signing gasless authorizations that Circle
        Gateway batches and settles on Arc.
      </p>

      <div className="mt-12">
        <BrowserFrame>
          <AgentStage />
        </BrowserFrame>
      </div>
    </section>
  );
}
