"use client";

// Scout's x402 nanopayment ledger — section 04 of the agents tab, and the only
// section about an agent that is not the user's. Set as a poster like the three
// above it (see app/SettlementAgentsPanel.tsx and "the bill poster" in
// globals.css): Scout is the masthead, its net position is the hero figure, the
// ledger figures sit on the rail, and the payments themselves are the chrome-less
// disclosure the bills tab opens line items with.
import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import { motion } from "framer-motion";
import { PosterFact, SectionHead } from "./SpecCard";
import { AGENT_STEPS } from "./SettlementAgentsPanel";
import { PaymentLink } from "./JobTrail";

const EXPLORER = "https://testnet.arcscan.app";

// The four ledger figures are optional because /api/scout/stats omits them
// wholesale when there is no database to read them from. Absent means unknown,
// not zero — see getAgentStats in lib/x402/payments-repo.ts.
type Stats = {
  earnedUsd?: number;
  spentUsd?: number;
  callsServed?: number;
  callsPaid?: number;
  dailyCapUsd: number;
  budgetRemainingUsd: number;
  agent: { address: string | null; tokenId: string | null };
  // Null for the same reason the figures above are optional: no ledger to read.
  recent?: Payment[] | null;
};

type Payment = {
  direction: "earned" | "spent";
  endpoint: string;
  counterparty: string;
  amountUsdc: number;
  gatewayTx: string | null;
  createdAt: string;
};

type DecisionLogRow = {
  billId: string;
  debtorAddress: string;
  decision: "pay" | "skip";
  reason: string;
  amountUsdc: number;
  txHash: string | null;
  createdAt: string;
};

const usdc = (v: number) => `${v.toFixed(3)}`;
const short = (value: string) => (value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value);

export default function AgentEconomyPanel() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [decisionLog, setDecisionLog] = useState<DecisionLogRow[]>([]);

  useEffect(() => {
    fetch("/api/agents/autopay/log")
      .then((r) => r.json())
      .then((data) => {
        if (data.log) setDecisionLog(data.log);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    let live = true;
    const load = () =>
      fetch("/api/scout/stats")
        .then((r) => r.json())
        .then((s) => {
          if (live) setStats(s);
        })
        .catch(() => {});
    load();
    const timer = setInterval(load, 5000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);

  if (!stats) return null;

  // This panel *is* the ledger view, so with no ledger to read there is nothing
  // honest to show. The four figures are omitted together, but each is checked
  // rather than inferred from one another.
  const { earnedUsd, spentUsd, callsServed, callsPaid } = stats;
  if (
    earnedUsd === undefined ||
    spentUsd === undefined ||
    callsServed === undefined ||
    callsPaid === undefined
  ) {
    return null;
  }

  const net = earnedUsd - spentUsd;

  return (
    // The fourth section, so it arrives a beat after 03 — same 80ms ladder the
    // three above it climb, continued rather than restarted.
    <motion.section
      animate={{ opacity: 1, y: 0 }}
      className="bill-poster"
      initial={{ opacity: 0, y: 14 }}
      transition={{ delay: 0.24, duration: 0.42, ease: [0.22, 1, 0.36, 1] }}
    >
      <SectionHead
        marks={
          <>
            <span className="bill-poster-fact">
              <b>{callsServed}</b> served · <b>{callsPaid}</b> paid
            </span>
            {stats.agent.address ? (
              <a
                className="iou-row-tx"
                href={`${EXPLORER}/address/${stats.agent.address}`}
                rel="noreferrer"
                target="_blank"
              >
                {short(stats.agent.address)}
                {stats.agent.tokenId ? ` · #${stats.agent.tokenId}` : ""}
              </a>
            ) : null}
          </>
        }
        note="Scout charges per call over x402 and pays other agents the same way. Its own wallet, its own daily cap — none of your money moves in this section, and none of your rules apply to it."
        step={AGENT_STEPS[3]}
      />

      <div className="bill-poster-body">
        {/* The name in the slot a bill gives its merchant, because that is what
            this section is: one agent's books. Net is the figure you came for. */}
        <div className="bill-poster-lede">
          <div className="bill-cell">
            <span className="settle-label">Its ledger</span>
            {/* h4 under the section's own h3 — the section is named above, and
                this is which agent's books it is. */}
            <h4 className="bill-display">Scout</h4>
            <div className="bill-cell-rule" />
          </div>
          <div className="bill-cell" data-total>
            <span className="settle-label">Net USDC</span>
            <div className="bill-figure">
              <span className="bill-currency">{net < 0 ? "−" : ""}</span>
              {usdc(Math.abs(net))}
            </div>
            <div className="bill-cell-rule" />
          </div>
        </div>

        <div className="bill-poster-rail">
          <PosterFact label="Earned over x402" value={usdc(earnedUsd)} />
          <PosterFact label="Scout spent" value={usdc(spentUsd)} />
          <PosterFact
            label="Budget left today"
            // Its own cap, and the one figure here that is a limit rather than a
            // record — toned when it is nearly gone, because an exhausted Scout
            // stops reading receipts and the bills tab says so in step 01.
            tone={stats.budgetRemainingUsd <= stats.dailyCapUsd * 0.1 ? "warn" : undefined}
            value={usdc(stats.budgetRemainingUsd)}
          />
          <PosterFact label="Of a daily cap" value={usdc(stats.dailyCapUsd)} />
        </div>

        {decisionLog.length > 0 ? (
          <details className="bill-items">
            <summary>
              <span className="settle-label">autopay decisions across every account</span>
              <span className="bill-items-total">
                last {decisionLog.length}
                <ChevronDown className="bill-items-chevron" size={16} />
              </span>
            </summary>
            {decisionLog.map((d, i) => (
              <div className="bill-item" key={`${d.billId}-${d.debtorAddress}-${i}`}>
                <i>{d.decision === "pay" ? "✓" : "⊗"}</i>
                <span>
                  Bill #{d.billId} · {short(d.debtorAddress)} · {d.reason.replace(/_/g, " ")}
                </span>
                {d.txHash ? (
                  <a
                    className="iou-row-tx"
                    href={`${EXPLORER}/tx/${d.txHash}`}
                    rel="noreferrer"
                    target="_blank"
                  >
                    {usdc(d.amountUsdc)}
                  </a>
                ) : (
                  <b>—</b>
                )}
              </div>
            ))}
          </details>
        ) : null}

        {/* The payments behind the figures. Every one links to Circle's own
            receipt for it — these settle in batches, so there is no per-payment
            transaction on chain to point at, only the batch that carried it. */}
        {stats.recent?.length ? (
          <details className="bill-items">
            <summary>
              <span className="settle-label">x402 payments · circle receipts</span>
              <span className="bill-items-total">
                last {stats.recent.length}
                <ChevronDown className="bill-items-chevron" size={16} />
              </span>
            </summary>
            {stats.recent.map((p) => (
              <div className="bill-item" key={`${p.createdAt}-${p.direction}-${p.endpoint}`}>
                <i>{p.direction === "earned" ? "+" : "−"}</i>
                <span>
                  {p.endpoint} · {usdc(p.amountUsdc)} USDC
                </span>
                <PaymentLink gatewayTx={p.gatewayTx} />
              </div>
            ))}
          </details>
        ) : null}
      </div>
    </motion.section>
  );
}
