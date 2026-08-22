"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { PRICES } from "@/lib/x402/pricing";

import { useReveal } from "./useReveal";

const NEW_ENDPOINTS = [
  { path: "/api/agents/queue",           price: PRICES["/api/agents/queue"],           method: "GET"  },
  { path: "/api/reputation",             price: PRICES["/api/reputation"],             method: "GET"  },
  { path: "/api/agents/netting",         price: PRICES["/api/agents/netting"],         method: "POST" },
  { path: "/api/agents/dunning/verdict", price: PRICES["/api/agents/dunning/verdict"], method: "POST" },
] as const;

const FLOW = ["Probe", "Parse", "Sign", "Retry"];

export function SectionDevTeaser() {
  const ref = useReveal<HTMLElement>("top 74%");

  return (
    <section aria-labelledby="devapi-heading" className="bill-poster scroll-mt-24" ref={ref}>
      <div className="lp-measure">
        <div className="bill-poster-head">
          <span className="settle-label" data-reveal="item">
            <span className="lp-step">05</span> Open to any agent
          </span>
          <div className="bill-poster-marks" data-reveal="item">
            {/* The handshake, as four caps words on a baseline — the same rail the
                app sets its own options on. It used to be four bordered pills,
                which is a lot of chrome for four words in a fixed order. */}
            {FLOW.map((step, index) => (
              <span className="settle-label" key={step}>
                <span className="lp-step-num">{String(index + 1).padStart(2, "0")}</span> {step}
              </span>
            ))}
          </div>
        </div>
        <h2 className="lp-display-lg mt-4 max-w-4xl" data-reveal="lead" id="devapi-heading">
          Seven APIs. <span className="lp-headline-accent">Any agent.</span>
        </h2>
        <p className="lp-lede mt-5 max-w-2xl" data-reveal="lead">
          Every endpoint answers HTTP&nbsp;402 with a Circle Gateway challenge. Sign one offchain
          EIP-3009 authorisation — no Splitsy account, no API key, no gas — and you&apos;re in.
        </p>

        <div className="lp-rows bill-poster-body">
          {NEW_ENDPOINTS.map((endpoint) => (
            <div
              className="lp-row grid-cols-[auto_minmax(0,1fr)_auto]"
              data-reveal="item"
              key={endpoint.path}
            >
              <span className="settle-label">{endpoint.method}</span>
              <span className="mono min-w-0 truncate text-[0.92rem] text-[var(--pay-poster-fg)]">
                {endpoint.path}
              </span>
              <span className="bill-figure-sm">{endpoint.price}</span>
            </div>
          ))}
        </div>

        <div className="bill-poster-foot">
          <Link className="settle-action lp-call" data-reveal="item" href="/api">
            Read the API docs
            <ArrowRight aria-hidden size="0.6em" />
          </Link>
          <span className="bill-poster-fact" data-reveal="item">
            + three existing endpoints · full reference and a working client
          </span>
        </div>
      </div>
    </section>
  );
}
