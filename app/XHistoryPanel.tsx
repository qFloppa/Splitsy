"use client";

import { ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";
import { type ProviderPerson } from "@/lib/provider-display";
import { ProviderTag } from "./ProviderTag";
import { HistoryCard, PaidBillStamp } from "./HistoryCard";

type Person = { provider?: ProviderPerson["provider"]; handle: string; avatar_url: string | null } | null;

// Debts the signed-in user owes (paid ones shown in history).
type IOwe = {
  id: string;
  amount_usdc: string;
  status: string;
  paid_tx_hash: string | null;
  bill: { merchant: string | null; creator: Person } | null;
};

// Bills the signed-in user created, each with its debtors.
type OwedToMe = {
  id: string;
  merchant: string | null;
  total_usdc: string;
  created_at: string;
  debts: {
    id: string;
    debtor_provider?: ProviderPerson["provider"];
    debtor_handle: string;
    amount_usdc: string;
    status: string;
    debtor: Person;
  }[];
};

type WalletTx = { id: string; txHash: string | null };

// Off-chain (handle) history, rendered headerless with the same HistoryCard
// shell + PaidBillStamp as the on-chain records so both look identical inside
// the shared History panel. `onCount` reports total records up so the panel can
// show one empty state across social + wallet.
export default function XHistoryPanel({ onCount }: { onCount?: (n: number) => void }) {
  const [paid, setPaid] = useState<IOwe[]>([]);
  const [created, setCreated] = useState<OwedToMe[]>([]);
  const [hashById, setHashById] = useState<Record<string, string>>({});
  const [explorer, setExplorer] = useState("https://testnet.arcscan.app");

  useEffect(() => {
    let active = true;
    fetch("/api/bills")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("not signed in"))))
      .then((data: { iOwe?: IOwe[]; owedToMe?: OwedToMe[] }) => {
        if (!active) return;
        setPaid((data.iOwe ?? []).filter((d) => d.status === "paid"));
        setCreated(data.owedToMe ?? []);
      })
      .catch(() => {});
    fetch("/api/wallet/transactions")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("auth"))))
      .then((d: { transactions: WalletTx[]; explorer?: string }) => {
        if (!active) return;
        if (d.explorer) setExplorer(d.explorer);
        const map: Record<string, string> = {};
        for (const t of d.transactions ?? []) if (t.txHash) map[t.id] = t.txHash;
        setHashById(map);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    onCount?.(paid.length + created.length);
  }, [paid.length, created.length, onCount]);

  return (
    <>
      {paid.length > 0 ? (
        <div className="space-y-2">
          <p className="text-sm font-semibold text-[var(--text-muted)]">
            Paid bill{paid.length === 1 ? "" : "s"} — settled from your wallet
          </p>
          <div className="space-y-2">
            {paid.map((d) => {
              const hash = d.paid_tx_hash ? hashById[d.paid_tx_hash] : undefined;
              return (
                <HistoryCard
                  key={d.id}
                  title={
                    <span className="flex items-center gap-1.5">
                      {d.bill?.merchant ?? "Bill"} — to{" "}
                      <ProviderTag
                        person={{
                          provider: d.bill?.creator?.provider,
                          handle: d.bill?.creator?.handle,
                          avatarUrl: d.bill?.creator?.avatar_url,
                        }}
                      />
                    </span>
                  }
                  summary={<span className="amount-text">{d.amount_usdc} USDC</span>}
                  badge={<PaidBillStamp compact />}
                  detail={
                    hash ? (
                      <a
                        href={`${explorer}/tx/${hash}`}
                        target="_blank"
                        rel="noreferrer"
                        className="history-tx-link inline-flex items-center gap-1"
                      >
                        <ExternalLink size={12} /> View transaction
                      </a>
                    ) : undefined
                  }
                />
              );
            })}
          </div>
        </div>
      ) : null}

      {created.length > 0 ? (
        <div className="space-y-2">
          <p className="text-sm font-semibold text-[var(--text-muted)]">
            Bill{created.length === 1 ? "" : "s"} you created — tagged by handle
          </p>
          <div className="space-y-2">
            {created.map((b) => {
              const paidCount = b.debts.filter((d) => d.status === "paid").length;
              const allPaid = b.debts.length > 0 && paidCount === b.debts.length;
              return (
                <HistoryCard
                  key={b.id}
                  title={b.merchant ?? "Bill"}
                  summary={
                    <>
                      {paidCount}/{b.debts.length} paid ·{" "}
                      <span className="amount-text">{b.total_usdc} USDC</span>
                    </>
                  }
                  badge={
                    allPaid ? <PaidBillStamp compact /> : <span className="status-dot status-warn">Pending</span>
                  }
                  detail={
                    <div className="space-y-1">
                      {b.debts.map((d) => (
                        <div key={d.id} className="flex items-center justify-between text-xs">
                          <ProviderTag
                            person={{
                              provider: d.debtor?.provider ?? d.debtor_provider,
                              handle: d.debtor?.handle ?? d.debtor_handle,
                              avatarUrl: d.debtor?.avatar_url,
                            }}
                            size={16}
                          />
                          <span className="flex items-center gap-2">
                            <span className="text-[var(--text-muted)]">{d.amount_usdc} USDC</span>
                            {d.status === "paid" ? (
                              <span className="status-dot status-ok">Paid</span>
                            ) : (
                              <span className="status-dot status-warn">Pending</span>
                            )}
                          </span>
                        </div>
                      ))}
                    </div>
                  }
                />
              );
            })}
          </div>
        </div>
      ) : null}
    </>
  );
}
