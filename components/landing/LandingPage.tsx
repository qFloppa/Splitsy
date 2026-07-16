"use client";

import { useEffect } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import Lenis from "lenis";

import { TooltipProvider } from "@/components/ui/tooltip";
import { Nav } from "./Nav";
import { Hero } from "./Hero";
import { DemoSection } from "./DemoSection";
import { SectionAnyone } from "./SectionAnyone";
import { SectionOnchain } from "./SectionOnchain";
import { FinalCTA } from "./FinalCTA";

gsap.registerPlugin(ScrollTrigger);

// The landing is one continuous story, so scroll behavior is owned here:
// Lenis smooths the wheel, ScrollTrigger reads Lenis's scroll position, and
// GSAP's ticker drives Lenis so all three share a single clock. Every section
// below only *authors* its own timeline — it never touches scroll plumbing.
export default function LandingPage() {
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const lenis = new Lenis({ lerp: 0.12, wheelMultiplier: 1 });
    lenis.on("scroll", ScrollTrigger.update);
    const tick = (time: number) => lenis.raf(time * 1000);
    gsap.ticker.add(tick);
    gsap.ticker.lagSmoothing(0);

    return () => {
      gsap.ticker.remove(tick);
      lenis.destroy();
    };
  }, []);

  return (
    <TooltipProvider>
      <div className="lp-root">
        <Nav />
        <main id="main">
          <Hero />
          <DemoSection />
          <SectionAnyone />
          <SectionOnchain />
          <FinalCTA />
        </main>
      </div>
    </TooltipProvider>
  );
}
