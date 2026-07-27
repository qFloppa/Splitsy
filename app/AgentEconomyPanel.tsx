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
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <span className="text-[var(--accent)]">
            <Bot size={19} />
          </span>
          Agent economy
        </h2>
        {stats.agent.address ? (
          <a
            className="inline-flex items-center gap-1 text-xs text-[var(--text-muted)] underline"
            href={`https://testnet.arcscan.app/address/${stats.agent.address}`}
            target="_blank"
            rel="noreferrer"
          >
            Scout {stats.agent.address.slice(0, 6)}…{stats.agent.address.slice(-4)}
            {stats.agent.tokenId ? ` · ERC-8004 #${stats.agent.tokenId}` : ""}
            <ExternalLink size={12} />
          </a>
        ) : null}
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {tiles.map((t) => (
          <div
            key={t.label}
            className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-3"
          >
            <div className="amount-text text-xl font-semibold tabular-nums">{t.value}</div>
            <div className="mt-0.5 text-xs text-[var(--text-muted)]">{t.label}</div>
            <div className="text-xs text-[var(--text-muted)]">{t.sub}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
