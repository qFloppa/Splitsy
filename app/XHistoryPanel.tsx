"use client";

import Image from "next/image";
import { ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";

// Debts the signed-in user owes (paid ones shown in history).
type IOwe = {
  id: string;
  amount_usdc: string;
  status: string;
  paid_tx_hash: string | null;
  bill: { merchant: string | null; creator: { x_handle: string; x_avatar_url: string | null } | null } | null;
};

// Bills the signed-in user created, each with its debtors.
type OwedToMe = {
  id: string;
  merchant: string | null;
  total_usdc: string;
  created_at: string;
  debts: {
    id: string;
    debtor_handle: string;
    amount_usdc: string;
    status: string;
    debtor: { x_handle: string; x_avatar_url: string | null } | null;
  }[];
};

type WalletTx = { id: string; txHash: string | null };

function Avatar({ url, size = 18 }: { url: string | null | undefined; size?: number }) {
  if (!url) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={url} alt="" width={size} height={size} className="rounded-full" style={{ width: size, height: size }} />
  );
}

export default function XHistoryPanel() {
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

  if (paid.length === 0 && created.length === 0) return null;

  return (
    <div className="space-y-5">
      {paid.length > 0 ? (
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
                    {d.bill?.merchant ?? "Bill"} — to <Avatar url={d.bill?.creator?.x_avatar_url} />@
                    {d.bill?.creator?.x_handle ?? "?"}
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
      ) : null}

      {created.length > 0 ? (
        <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-5">
          <div className="flex items-center gap-2">
            <Image src="/x.png" alt="" width={16} height={16} />
            <h3 className="text-base font-semibold">Bills you created</h3>
          </div>
          <div className="mt-4 space-y-3">
            {created.map((b) => {
              const paidCount = b.debts.filter((d) => d.status === "paid").length;
              return (
                <div key={b.id} className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-muted)] p-3">
                  <div className="flex items-center justify-between">
                    <strong className="text-sm">{b.merchant ?? "Bill"}</strong>
                    <span className="flex items-center gap-2">
                      <span className="text-xs text-[var(--text-muted)]">
                        {paidCount}/{b.debts.length} paid
                      </span>
                      <strong className="amount-text">{b.total_usdc} USDC</strong>
                    </span>
                  </div>
                  <div className="mt-2 space-y-1">
                    {b.debts.map((d) => (
                      <div key={d.id} className="flex items-center justify-between text-xs">
                        <span className="flex items-center gap-1.5">
                          <Avatar url={d.debtor?.x_avatar_url} size={16} />@{d.debtor?.x_handle ?? d.debtor_handle}
                        </span>
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
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
