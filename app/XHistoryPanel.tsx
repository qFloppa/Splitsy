"use client";

import Image from "next/image";
import { ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";

// Paid off-chain @handle bills for the signed-in X user, shown in History.
type IOwe = {
  id: string;
  amount_usdc: string;
  status: string;
  paid_at: string | null;
  paid_tx_hash: string | null;
  bill: { merchant: string | null; creator: { x_handle: string } | null } | null;
};

type WalletTx = { id: string; txHash: string | null };

export default function XHistoryPanel() {
  const [paid, setPaid] = useState<IOwe[]>([]);
  // Map Circle tx id (stored in paid_tx_hash) -> on-chain hash, for explorer links.
  const [hashById, setHashById] = useState<Record<string, string>>({});
  const [explorer, setExplorer] = useState("https://testnet.arcscan.app");

  useEffect(() => {
    let active = true;
    fetch("/api/bills")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("not signed in"))))
      .then((data: { iOwe?: IOwe[] }) => {
        if (active) setPaid((data.iOwe ?? []).filter((d) => d.status === "paid"));
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

  if (paid.length === 0) return null;

  return (
    <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-5">
      <div className="flex items-center gap-2">
        <Image src="/paid.png" alt="Paid" width={18} height={18} />
        <h3 className="text-base font-semibold">Paid via X</h3>
      </div>
      <div className="mt-4 space-y-2">
        {paid.map((d) => {
          const hash = d.paid_tx_hash ? hashById[d.paid_tx_hash] : undefined;
          return (
            <div
              key={d.id}
              className="flex items-center justify-between rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-muted)] p-3"
            >
              <span className="flex items-center gap-2 text-sm">
                <Image src="/paid.png" alt="" width={22} height={22} className="opacity-90" />
                {d.bill?.merchant ?? "Bill"} — to @{d.bill?.creator?.x_handle ?? "?"}
              </span>
              <span className="flex items-center gap-3">
                <strong className="amount-text">{d.amount_usdc} USDC</strong>
                {hash ? (
                  <a
                    href={`${explorer}/tx/${hash}`}
                    target="_blank"
                    rel="noreferrer"
                    aria-label="View transaction"
                    className="inline-flex items-center gap-1 text-xs font-semibold text-[#1d9bf0]"
                  >
                    <ExternalLink size={12} /> TX
                  </a>
                ) : null}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
