"use client";

import { useReveal } from "./useReveal";

// The DeFi half of the story, deliberately three quiet stations so it supports
// the agent stage above rather than competing with it.
//
// The arithmetic is buildTreasury()'s own: grossTxCount = 2 * payLegCount +
// claimLegCount, so 5 bills you owe plus 4 you are owed is 2*5 + 4 = 14. If the
// station copy changes, that identity has to keep holding.
//
// The footnote is not hedging. lib/treasury.ts and DashboardPanel both state that
// the net figure is exposure, not a transfer, and that batching removes
// transactions rather than USDC moved. The landing page must not contradict the
// product a judge can go and read.
const STATIONS = [
  {
    label: "The open ledger",
    body: "Shares scattered across every bill you joined or created.",
    proof: "5 bills you owe · 4 you're owed",
  },
  {
    label: "One net position",
    body: "Everything owed in both directions, collapsed per counterparty.",
    proof: "−12.40 Alex · +8.00 Sam · −0.60 0x9f…",
    tone: "accent" as const,
  },
  {
    label: "One settlement",
    body: "Every approval, payment and claim lands together, or none of it does.",
    proof: "1 atomic tx instead of 14",
    tone: "ok" as const,
  },
];

export function SectionTreasury() {
  const ref = useReveal<HTMLElement>("top 76%");

  return (
    <section aria-labelledby="treasury-heading" className="bill-poster scroll-mt-24" id="treasury" ref={ref}>
      <div className="lp-measure">
        <div className="bill-poster-head">
          <span className="settle-label" data-reveal="item">
            <span className="lp-step">08</span> Netting
          </span>
          <span className="bill-poster-fact" data-reveal="item">
            <b data-count>14</b> transactions become <b>1</b>
          </span>
        </div>
        <h2 className="lp-display-lg mt-4 max-w-4xl" data-reveal="lead" id="treasury-heading">
          Many debts. <span className="lp-headline-accent">One position.</span>
        </h2>
        <p className="lp-lede mt-5 max-w-2xl" data-reveal="lead">
          Every share you owe and are owed collapses into one net figure per person. Settling fires them as
          a batch — one atomic transaction on a Circle wallet instead of an approve and a payment per bill.
        </p>

        <ol className="bill-contents list-none">
          {STATIONS.map((station, index) => (
            <li className="bill-cell" data-reveal="item" key={station.label}>
              <span className="settle-label">
                <span className="lp-step-num">{String(index + 1).padStart(2, "0")}</span> {station.label}
              </span>
              <span className="bill-contents-label">{station.body}</span>
              <div className="bill-cell-rule lp-rule" data-rule />
              <p className="lp-row-proof mt-2" data-tone={station.tone}>
                {station.proof}
              </p>
            </li>
          ))}
        </ol>

        <p className="bill-options-hint" data-reveal="item">
          Netting is a view, not a transfer. Each bill escrows its own USDC on Arc, so every debt is still
          paid to its own bill — batching removes transactions, never the money owed, and it never collects
          what someone else still owes you.
        </p>
      </div>
    </section>
  );
}
