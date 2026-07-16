"use client";

import { useEffect, useRef } from "react";
import gsap from "gsap";

import { BrowserFrame } from "./BrowserFrame";
import { DemoStage } from "./demo/DemoStage";

// The demo's outer shell. The browser window enters tilted back slightly
// (rotateX + scale, GPU-only) and docks flat as it scrolls into view — the
// "camera" pulling the visitor into the product. The inner choreography
// lives in DemoStage.
export function DemoSection() {
  const frameRef = useRef<HTMLDivElement>(null);

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
    <section aria-label="Product demo" className="mx-auto w-full max-w-[96rem] px-4 sm:px-6 lg:px-8" id="demo">
      <div ref={frameRef} style={{ transformStyle: "preserve-3d" }}>
        <BrowserFrame>
          <DemoStage />
        </BrowserFrame>
      </div>
    </section>
  );
}
