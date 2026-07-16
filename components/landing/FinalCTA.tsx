"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import gsap from "gsap";
import { ArrowRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { MagneticButton } from "./MagneticButton";

export function FinalCTA() {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const root = rootRef.current;
    if (!root) return;

    const ctx = gsap.context(() => {
      gsap.from("[data-cta-item]", {
        y: 30,
        autoAlpha: 0,
        duration: 0.85,
        ease: "expo.out",
        stagger: 0.1,
        scrollTrigger: { trigger: root, start: "top 72%" },
      });
    }, root);

    return () => ctx.revert();
  }, []);

  return (
    <section aria-labelledby="cta-heading" className="mx-auto w-full max-w-[80rem] px-4 pb-[var(--lp-section-y)] sm:px-6 lg:px-8">
      <div
        className="flex flex-col items-center rounded-[calc(var(--radius)+8px)] border border-[var(--border)] bg-[var(--surface)] px-6 py-16 text-center shadow-[var(--shadow-soft)] backdrop-blur-xl sm:py-20"
        ref={rootRef}
      >
        <h2 className="lp-display-lg" data-cta-item id="cta-heading">
          Stop chasing IOUs.
        </h2>
        <p className="lp-lede mt-4 max-w-md" data-cta-item>
          Test USDC, real workflow. Try the whole thing in two minutes.
        </p>
        <div className="mt-9" data-cta-item>
          <MagneticButton>
            <Button asChild className="group h-13 px-7 text-base" size="lg">
              <Link href="/app">
                Start splitting
                <ArrowRight className="transition-transform duration-[var(--dur-2)] group-hover:translate-x-1" size={18} />
              </Link>
            </Button>
          </MagneticButton>
        </div>
        <p className="mt-5 text-xs font-medium text-[var(--text-muted)]" data-cta-item>
          Arc Testnet · no real funds · nothing to install
        </p>
      </div>
    </section>
  );
}
