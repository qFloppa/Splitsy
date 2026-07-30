"use client";

import { useEffect, useState } from "react";
import { Bot, ExternalLink } from "lucide-react";

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
};

const usdc = (v: number) => `${v.toFixed(3)} USDC`;

export default function AgentEconomyPanel() {
  const [stats, setStats] = useState<Stats | null>(null);

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

  const tiles = [
    { label: "Earned (x402)", value: usdc(earnedUsd), sub: `${callsServed} calls served` },
    { label: "Scout spent", value: usdc(spentUsd), sub: `${callsPaid} calls paid` },
    {
      label: "Budget left today",
      value: usdc(stats.budgetRemainingUsd),
      sub: `of ${usdc(stats.dailyCapUsd)} cap`,
    },
    { label: "Net", value: usdc(earnedUsd - spentUsd), sub: "earned − spent" },
  ];

  return (
    <section className="spec-card">
      <div className="spec-head">
        <div className="min-w-0">
          <span className="spec-step">04 · Third-party agent</span>
          <h3 className="spec-title">Scout&rsquo;s x402 ledger</h3>
          <p className="spec-note">
            Scout charges per call over x402 and pays other agents the same way. Its own wallet, its own daily cap —
            none of your money moves here.
          </p>
        </div>
        {stats.agent.address ? (
          <a
            className="spec-chip no-underline"
            href={`https://testnet.arcscan.app/address/${stats.agent.address}`}
            rel="noreferrer"
            target="_blank"
          >
            <Bot size={12} />
            {stats.agent.address.slice(0, 6)}…{stats.agent.address.slice(-4)}
            {stats.agent.tokenId ? ` · #${stats.agent.tokenId}` : ""}
            <ExternalLink size={11} />
          </a>
        ) : null}
      </div>

      <div className="spec-body">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {tiles.map((t) => (
            <div className="spec-stat" key={t.label}>
              <div className="spec-stat-value">{t.value}</div>
              <div className="spec-stat-label">{t.label}</div>
              <div className="spec-stat-sub">{t.sub}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
