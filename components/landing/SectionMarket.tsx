"use client";

import { ArrowUpRight } from "lucide-react";

import { PRICES } from "@/lib/x402/pricing";

import { useReveal } from "./useReveal";

// The rate card. Prices are IMPORTED, never restated — same discipline as
// demo/agent-script.ts — so this page cannot advertise a price the seller does
// not charge. lib/x402/pricing.ts is pure, so it is safe on the client.
//
// No live figures here on purpose. getAgentStats() excludes /api/agents/review
// from the earned/spent totals (INTERNAL_ENDPOINTS in lib/x402/payments-repo.ts)
// because both sides of that trade are Splitsy's own agents. A "live" tile for
// it would either be fabricated or would need that exclusion loosened, and the
// exclusion is the honest half of the ledger.
const ENDPOINTS = [
  {
    path: "/api/ocr",
    price: PRICES["/api/ocr"],
    seller: "Splitsy",
    buyer: "Scout",
    when: "per receipt scan",
  },
  {
    path: "/api/fx",
    price: PRICES["/api/fx"],
    seller: "Splitsy",
    buyer: "Scout",
    when: "non-USD receipts only",
  },
  {
    path: "/api/agents/review",
    price: PRICES["/api/agents/review"],
    seller: "The Auditor",
    buyer: "The Settler",
    when: "before every settlement",
  },
  {
    path: "/api/agents/queue",
    price: PRICES["/api/agents/queue"],
    seller: "Splitsy",
    buyer: "any agent",
    when: "fetch payable bills for a debtor wallet",
  },
  {
    path: "/api/reputation",
    price: PRICES["/api/reputation"],
    seller: "Splitsy",
    buyer: "any agent",
    when: "ERC-8004 reputation lookup",
  },
  {
    path: "/api/agents/netting",
    price: PRICES["/api/agents/netting"],
    seller: "Splitsy",
    buyer: "any agent",
    when: "minimum-transfer settlement solver",
  },
  {
    path: "/api/agents/dunning/verdict",
    price: PRICES["/api/agents/dunning/verdict"],
    seller: "Splitsy",
    buyer: "any creditor agent",
    when: "nudge / escalate / collect decision",
  },
];

export function SectionMarket() {
  const ref = useReveal<HTMLElement>("top 78%");

  return (
    <section aria-labelledby="market-heading" className="bill-poster scroll-mt-24" id="market" ref={ref}>
      <div className="lp-measure">
        <div className="bill-poster-head">
          <span className="settle-label" data-reveal="item">
            <span className="lp-step">04</span> The market
          </span>
          <span className="bill-poster-fact" data-reveal="item">
            no account · no API key · no gas
          </span>
        </div>
        <h2 className="lp-display-lg mt-4 max-w-4xl" data-reveal="lead" id="market-heading">
          Seven endpoints. <span className="lp-headline-accent">Priced in half-cents.</span>
        </h2>
        <p className="lp-lede mt-5 max-w-2xl" data-reveal="lead">
          Splitsy&apos;s paid APIs answer HTTP 402 with their own terms. Any agent that signs an offchain
          EIP-3009 authorization gets served, because Circle&apos;s facilitator settles the payment in a
          batch rather than a transaction.
        </p>

        {/* The rate card, as a rate card: a path, what it costs, and who buys it
            from whom — three columns on one rule apiece. It used to be a frosted
            panel of bordered rows, which is a table pretending not to be one. */}
        <div className="lp-rows bill-poster-body">
          {ENDPOINTS.map((endpoint) => (
            <div
              className="lp-row grid-cols-[minmax(0,1fr)_auto] lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)_auto]"
              data-reveal="item"
              key={endpoint.path}
            >
              <span className="mono min-w-0 truncate text-[0.92rem] text-[var(--pay-poster-fg)]">
                {endpoint.path}
              </span>
              <p className="lp-row-body col-span-2 lg:col-span-1 lg:col-start-2">
                <span className="text-[var(--pay-poster-fg)]">{endpoint.seller}</span>
                <span aria-hidden="true"> → </span>
                <span className="sr-only"> sells to </span>
                <span className="text-[var(--pay-poster-fg)]">{endpoint.buyer}</span>, {endpoint.when}
              </p>
              <span className="bill-figure-sm col-start-2 row-start-1 justify-self-end lg:col-start-3">
                {endpoint.price}
              </span>
            </div>
          ))}
        </div>

        <div className="mt-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <p className="bill-options-hint" data-reveal="item">
            All of them are open to anyone who pays. That is what makes them a market rather than an
            internal call. The review row is Splitsy&apos;s own two agents trading with each other, so it is
            deliberately <span className="text-[var(--pay-poster-fg)]">left out</span> of the earned and
            spent totals above the fold: nobody outside paid it, and counting it would inflate both sides
            of the ledger from a single internal transfer.
          </p>
          <a
            className="iou-provider bill-toggle inline-flex shrink-0 items-baseline gap-1 no-underline"
            data-reveal="item"
            href="https://developers.circle.com/gateway/nanopayments/concepts/x402"
            rel="noopener noreferrer"
            target="_blank"
          >
            How x402 works
            <ArrowUpRight className="lp-row-out self-center" size={13} />
          </a>
        </div>
      </div>
    </section>
  );
}
