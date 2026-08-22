"use client";

import { useReveal } from "./useReveal";

// The trust story, kept quiet: receipt bytes are hashed, the hash is committed in
// the BillCreated event, so any payer can verify the split matches the paper.
// Three stations as three spec entries on the app's own contents rail — label,
// one line, rule — rather than three cards with an arrow between them.
const STATIONS = [
  {
    label: "The receipt",
    body: "Scanned, itemized, and hashed byte for byte.",
    proof: "keccak256(receipt.jpg)",
  },
  {
    label: "The bill on Arc",
    body: "Every share and the fingerprint, committed in one event.",
    proof: "BillCreated(billId, metadataHash)",
  },
  {
    label: "The check",
    body: "Payers recompute the hash and confirm it matches before paying.",
    proof: "matches on-chain commitment",
    ok: true,
  },
];

export function SectionOnchain() {
  const ref = useReveal<HTMLElement>("top 76%");

  return (
    <section aria-labelledby="onchain-heading" className="bill-poster" ref={ref}>
      <div className="lp-measure">
        <div className="bill-poster-head">
          <span className="settle-label" data-reveal="item">
            <span className="lp-step">07</span> Verification
          </span>
          <span className="bill-poster-fact" data-reveal="item">
            the preimage is public · the hash is on-chain
          </span>
        </div>
        <h2 className="lp-display-lg mt-4 max-w-4xl" data-reveal="lead" id="onchain-heading">
          Don&apos;t trust the split. <span className="lp-headline-accent">Verify it.</span>
        </h2>
        <p className="lp-lede mt-5 max-w-2xl" data-reveal="lead">
          The receipt&apos;s fingerprint is written into the bill on Arc. Anyone tagged can check that what
          they&apos;re paying matches the paper before they pay.
        </p>

        <ol className="bill-contents list-none">
          {STATIONS.map((station, index) => (
            <li className="bill-cell" data-reveal="item" key={station.label}>
              <span className="settle-label">
                <span className="lp-step-num">{String(index + 1).padStart(2, "0")}</span> {station.label}
              </span>
              <span className="bill-contents-label">{station.body}</span>
              <div className="bill-cell-rule lp-rule" data-rule />
              <p className="lp-row-proof mt-2" data-tone={station.ok ? "ok" : undefined}>
                {station.ok ? "✓ " : ""}
                {station.proof}
              </p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
