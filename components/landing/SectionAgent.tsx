"use client";

import { PRICES } from "@/lib/x402/pricing";

import { BrowserFrame } from "./BrowserFrame";
import { AgentStage } from "./demo/AgentStage";
import { useReveal } from "./useReveal";

// Sits directly after the product demo on purpose: DemoStage's first act is a
// receipt sliding into a scan beam, and this section is what happens inside that
// beam and who paid for it. Same plate, so the two read as one continuous story
// rather than two demos.
export function SectionAgent() {
  const ref = useReveal<HTMLElement>("top 78%");

  return (
    <section aria-labelledby="agent-heading" className="bill-poster scroll-mt-24" id="agent" ref={ref}>
      <div className="lp-measure">
        <div className="bill-poster-head">
          <span className="settle-label" data-reveal="item">
            <span className="lp-step">02</span> Agents that buy
          </span>
          {/* ponytail: the price is imported, never restated — same discipline as
              SectionMarket and demo/agent-script.ts, so this page cannot
              advertise a price the seller does not charge. */}
          <span className="bill-poster-fact" data-reveal="item">
            one dollar a day · <b>{PRICES["/api/ocr"]}</b> a scan
          </span>
        </div>
        <h2 className="lp-display-lg mt-4 max-w-4xl" data-reveal="lead" id="agent-heading">
          Upload a receipt
          <br />
          <span className="lp-headline-accent">An agent goes shopping</span>
        </h2>
        <p className="lp-lede mt-5 max-w-2xl" data-reveal="lead">
          Scout has its own wallet, an ERC-8004 identity on Arc, and a daily budget of one dollar. It
          judges your photo before spending anything, pays Splitsy&apos;s own x402 endpoints per call, and
          buys a second opinion when the parse looks shaky — signing gasless authorizations that Circle
          Gateway batches and settles on Arc.
        </p>
      </div>

      <div className="lp-measure bill-poster-body">
        <BrowserFrame label="POST splitsy.xyz/api/ocr" note="x402 · HTTP 402 → signed → 200">
          <AgentStage />
        </BrowserFrame>
      </div>
    </section>
  );
}
