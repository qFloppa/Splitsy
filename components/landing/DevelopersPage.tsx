"use client";

import { useEffect } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import Lenis from "lenis";
import { ArrowUpRight } from "lucide-react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Nav } from "./Nav";
import { SectionApiDocs } from "./SectionApiDocs";

gsap.registerPlugin(ScrollTrigger);

// Mirrors LandingPage.tsx's scroll plumbing exactly — Lenis drives Lenis,
// GSAP's ticker drives Lenis, ScrollTrigger reads the Lenis position. Every
// scroll-reveal animation in SectionApiDocs is authored there; this component
// only owns the clock and the hero.
export function DevelopersPage() {
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const lenis = new Lenis({ lerp: 0.12, wheelMultiplier: 1 });
    lenis.on("scroll", ScrollTrigger.update);
    const tick = (time: number) => lenis.raf(time * 1000);
    gsap.ticker.add(tick);
    gsap.ticker.lagSmoothing(0);
    return () => { gsap.ticker.remove(tick); lenis.destroy(); };
  }, []);

  return (
    <TooltipProvider>
      <div className="lp-root">
        <Nav />
        <main id="main">

          {/* ── hero ─────────────────────────────────────────────────────── */}
          <section className="mx-auto w-full max-w-[88rem] px-4 pt-[var(--lp-section-y)] pb-0 sm:px-6 lg:px-8">
            <p className="text-[0.62rem] font-extrabold uppercase tracking-[0.14em] text-[var(--accent)]">
              Developer API
            </p>

            <h1 className="lp-display mt-4 max-w-4xl">
              Build on the{" "}
              <span className="lp-headline-accent">agent economy.</span>
            </h1>

            <p className="lp-lede mt-6 max-w-2xl">
              Seven HTTP 402-gated services open to any agent that can sign an
              EIP-3009 authorisation. No Splitsy account. No API key. No gas.
              Circle Gateway verifies and batches every payment on Arc.
            </p>

            <div className="mt-8 flex flex-wrap items-center gap-3">
              <a
                className="primary-button"
                href="/api/agents/catalog"
                target="_blank"
                rel="noopener noreferrer"
              >
                View catalog JSON
              </a>
              <a
                className="group secondary-button flex items-center gap-1.5"
                href="https://developers.circle.com/gateway/nanopayments/concepts/x402"
                target="_blank"
                rel="noopener noreferrer"
              >
                How x402 works
                <ArrowUpRight
                  size={14}
                  className="transition-transform duration-[var(--dur-2)] group-hover:-translate-y-0.5 group-hover:translate-x-0.5"
                />
              </a>
            </div>
          </section>

          {/* ── full interactive service explorer ────────────────────────── */}
          <SectionApiDocs />

        </main>
      </div>
    </TooltipProvider>
  );
}
