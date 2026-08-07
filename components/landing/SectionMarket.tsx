"use client";

import { useEffect, useRef } from "react";
import gsap from "gsap";
import { ArrowUpRight } from "lucide-react";

import { PRICES } from "@/lib/x402/pricing";

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
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const root = rootRef.current;
    if (!root) return;

    const ctx = gsap.context(() => {
      gsap.from("[data-market-heading]", {
        y: 26,
        autoAlpha: 0,
        duration: 0.8,
        ease: "expo.out",
        scrollTrigger: { trigger: root, start: "top 78%" },
      });
      gsap.from("[data-market-row]", {
        y: 18,
        autoAlpha: 0,
        duration: 0.6,
        ease: "expo.out",
        stagger: 0.09,
        scrollTrigger: { trigger: root, start: "top 68%" },
      });
    }, root);

    return () => ctx.revert();
  }, []);

  return (
    <section
      aria-labelledby="market-heading"
      className="mx-auto w-full max-w-[80rem] scroll-mt-24 px-4 pt-[var(--lp-section-y)] sm:px-6 lg:px-8"
      id="market"
      ref={rootRef}
    >
      <p
        className="text-[0.62rem] font-extrabold uppercase tracking-[0.08em] text-[var(--text-muted)]"
        data-market-heading
      >
        The market
      </p>
      <h2 className="lp-display-lg mt-3 max-w-3xl" data-market-heading id="market-heading">
        Seven endpoints. <span className="lp-headline-accent">Priced in half-cents.</span>
      </h2>
      <p className="lp-lede mt-5 max-w-2xl" data-market-heading>
        Splitsy&apos;s paid APIs answer HTTP 402 with their own terms. Any agent that signs an offchain
        EIP-3009 authorization gets served: no account, no API key, and no gas, because Circle&apos;s
        facilitator settles the payment in a batch rather than a transaction.
      </p>

      <div className="lp-glass mt-12 overflow-hidden">
        <ul className="list-none p-0">
          {/* Path and price share the first line at every width — the price is
              the claim, and pushing it onto a wrapped line separates it from what
              it prices. Seller → buyer sits under them, free to wrap. */}
          {ENDPOINTS.map((endpoint, index) => (
            <li
              className={index === 0 ? "p-5" : "border-t border-[var(--border)] p-5"}
              data-market-row
              key={endpoint.path}
            >
              <div className="flex items-baseline justify-between gap-4">
                <span className="mono min-w-0 truncate text-sm font-bold text-[var(--text)]">
                  {endpoint.path}
                </span>
                <span className="amount-text shrink-0 text-base font-bold text-[var(--accent)]">
                  {endpoint.price}
                </span>
              </div>
              <p className="mt-1.5 text-sm text-[var(--text-muted)]">
                <span className="font-semibold text-[var(--text-soft)]">{endpoint.seller}</span>
                <span aria-hidden="true"> → </span>
                <span className="sr-only"> sells to </span>
                <span className="font-semibold text-[var(--text-soft)]">{endpoint.buyer}</span>, {endpoint.when}
              </p>
            </li>
          ))}
        </ul>
      </div>

      <div className="mt-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <p className="max-w-2xl text-xs text-[var(--text-muted)]">
          All three are open to anyone who pays. That is what makes them a market rather than an internal
          call. The last row is Splitsy&apos;s own two agents trading with each other, so it is deliberately{" "}
          <span className="font-semibold text-[var(--text-soft)]">left out</span> of the earned and spent
          totals above: nobody outside paid it, and counting it would inflate both sides of the ledger from a
          single internal transfer.
        </p>
        <a
          className="group flex shrink-0 items-center gap-1 text-xs font-semibold text-[var(--accent)] no-underline"
          href="https://developers.circle.com/gateway/nanopayments/concepts/x402"
          rel="noopener noreferrer"
          target="_blank"
        >
          How x402 works
          <ArrowUpRight
            className="transition-transform duration-[var(--dur-2)] group-hover:-translate-y-0.5 group-hover:translate-x-0.5"
            size={13}
          />
        </a>
      </div>
    </section>
  );
}
