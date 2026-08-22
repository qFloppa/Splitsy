"use client";

import { useEffect } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import Lenis from "lenis";

import { TooltipProvider } from "@/components/ui/tooltip";
import { Nav } from "./Nav";
import { Hero } from "./Hero";
import { DemoSection } from "./DemoSection";
import { SectionAgent } from "./SectionAgent";
import { SectionAutopay } from "./SectionAutopay";
import { SectionMarket } from "./SectionMarket";
import { SectionAnyone } from "./SectionAnyone";
import { SectionOnchain } from "./SectionOnchain";
import { SectionTreasury } from "./SectionTreasury";
import { SectionStack } from "./SectionStack";
import { SectionDevTeaser } from "./SectionDevTeaser";
import { FinalCTA } from "./FinalCTA";

gsap.registerPlugin(ScrollTrigger);

// The landing is one continuous story, so scroll behavior is owned here:
// Lenis smooths the wheel, ScrollTrigger reads Lenis's scroll position, and
// GSAP's ticker drives Lenis so all three share a single clock. Every section
// below only *authors* its own timeline — it never touches scroll plumbing.
//
// `.lp-paper` is the whole redesign in one class: it hands the page the app's
// poster ground (--pay-poster-bg / -fg), which is all the spec-sheet system needs
// to resolve here. Every section below is a .bill-poster, every label a
// .settle-label, every tab a .bill-toggle, every call a .settle-action — the same
// classes the five app tabs are built from, not lookalikes of them.
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
      <div className="lp-paper">
        <Nav />
        <main id="main">
          <Hero />
          <DemoSection />
          <SectionAgent />
          <SectionAutopay />
          <SectionMarket />
          <SectionDevTeaser />
          <SectionAnyone />
          <SectionOnchain />
          <SectionTreasury />
          <SectionStack />
          <FinalCTA />
        </main>
      </div>
    </TooltipProvider>
  );
}
