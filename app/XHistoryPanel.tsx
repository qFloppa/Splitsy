"use client";

import { ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";
import { looksLikeTxHash } from "@/lib/arc-explorer";
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
// shell + PaidBillStamp as the on-chain records so both stacks read as one
// document inside the paper trail. `onCount` reports total records up so the tab
// can show one empty state across social + wallet.
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
        <>
          <div className="bill-subhead">
            <span className="settle-label">Paid · settled from your wallet · {paid.length}</span>
          </div>
          <div>
            {paid.map((d) => {
              // On the privy stack paid_tx_hash IS the chain hash, so the link is
              // knowable from the stored value alone — no lookup to miss. The
              // wallet endpoint answers {transactions: []} for any error, for a
              // null wallet_address, and for a transfer outside its block window.
              const hash = looksLikeTxHash(d.paid_tx_hash)
                ? (d.paid_tx_hash as string)
                : d.paid_tx_hash
                  ? hashById[d.paid_tx_hash]
                  : undefined;
              return (
                <HistoryCard
                  key={d.id}
                  title={d.bill?.merchant ?? "Bill"}
                  // The creator rides the footnote rail rather than the line: on
                  // this page the merchant is what the record is, and who it was
                  // paid to is what qualifies it.
                  summary={
                    <>
                      <span>paid to</span>
                      <ProviderTag
                        person={{
                          provider: d.bill?.creator?.provider,
                          handle: d.bill?.creator?.handle,
                          avatarUrl: d.bill?.creator?.avatar_url,
                        }}
                        size={16}
                      />
                      <span className="amount-text">{d.amount_usdc} USDC</span>
                    </>
                  }
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
        </>
      ) : null}

      {created.length > 0 ? (
        <>
          <div className="bill-subhead">
            <span className="settle-label">You created · tagged by handle · {created.length}</span>
          </div>
          <div>
            {created.map((b) => {
              const paidCount = b.debts.filter((d) => d.status === "paid").length;
              const allPaid = b.debts.length > 0 && paidCount === b.debts.length;
              return (
                <HistoryCard
                  key={b.id}
                  title={b.merchant ?? "Bill"}
                  summary={
                    <>
                      <span>
                        {paidCount} of {b.debts.length} paid
                      </span>
                      <span className="amount-text">{b.total_usdc} USDC</span>
                    </>
                  }
                  badge={
                    allPaid ? <PaidBillStamp compact /> : <span className="settle-label" data-tone="warn">pending</span>
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
                            <span>{d.amount_usdc} USDC</span>
                            <span className="settle-label" data-tone={d.status === "paid" ? "ok" : "warn"}>
                              {d.status === "paid" ? "paid" : "pending"}
                            </span>
                          </span>
                        </div>
                      ))}
                    </div>
                  }
                />
              );
            })}
          </div>
        </>
      ) : null}
    </>
  );
}
