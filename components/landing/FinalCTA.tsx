"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { MagneticButton } from "./MagneticButton";
import { useReveal } from "./useReveal";

// The close. It was a bordered, frosted, centred panel with a filled pill in it —
// the single most card-shaped thing on the page, at the end of a page that had
// stopped drawing cards. Now it is the last section of the poster: a rule, a line
// of display type, and the same borderless control the hero opened with.
export function FinalCTA() {
  const ref = useReveal<HTMLElement>("top 82%");

  return (
    <section aria-labelledby="cta-heading" className="bill-poster" data-last ref={ref}>
      <div className="lp-measure">
        <h2 className="lp-display max-w-4xl" data-reveal="lead" id="cta-heading">
          Stop chasing <span className="lp-headline-accent">IOUs.</span>
        </h2>
        <div className="bill-poster-foot">
          <MagneticButton>
            <Link className="settle-action lp-call" data-reveal="item" href="/app">
              Start splitting
              <ArrowRight aria-hidden size="0.6em" />
            </Link>
          </MagneticButton>
          <span className="settle-label" data-reveal="item">
            Arc Testnet · no real funds · nothing to install
          </span>
        </div>
      </div>
    </section>
  );
}
