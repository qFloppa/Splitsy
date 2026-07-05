"use client";

import { useEffect, useState } from "react";

// Unpaid debts owed by the signed-in X user (off-chain @handle bills). Renders
// nothing when not signed in with X or nothing is owed, so it can sit safely at
// the top of the bills tab alongside the wallet-based DebtWorkspace.
type IOwe = {
  id: string;
  amount_usdc: string;
  status: string;
  bill: { merchant: string | null; creator: { x_handle: string } | null } | null;
};

export default function XDebtsPanel() {
  const [debts, setDebts] = useState<IOwe[]>([]);
  const [payingId, setPayingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function apply(list: IOwe[]) {
    setDebts(list.filter((d) => d.status !== "paid"));
  }

  async function load() {
    const res = await fetch("/api/bills");
    if (!res.ok) return;
    const data = await res.json();
    apply(data.iOwe ?? []);
  }

  useEffect(() => {
    let active = true;
    fetch("/api/bills")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("not signed in"))))
      .then((data) => {
        if (active) apply(data.iOwe ?? []);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  async function pay(debtId: string) {
    setPayingId(debtId);
    setError(null);
    try {
      const res = await fetch(`/api/debts/${debtId}/pay`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Payment failed.");
        return;
      }
      await load();
    } finally {
      setPayingId(null);
    }
  }

  if (debts.length === 0) {
    return null;
  }

  return (
    <div className="debt-alert p-4">
      <p className="text-sm font-semibold text-[var(--accent)]">Action needed</p>
      <h3 className="mt-1 text-[clamp(1.35rem,3vw,2.2rem)] font-semibold leading-tight">
        You have {debts.length} unpaid bill{debts.length === 1 ? "" : "s"}
      </h3>
      <p className="mt-2 text-sm text-[var(--text-muted)]">
        Tagged to your @handle. Pay from your Splitsy wallet, created when you signed in with X.
      </p>

      <div className="mt-4 space-y-3">
        {debts.map((d) => (
          <div
            key={d.id}
            className="flex items-center justify-between rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-muted)] p-3"
          >
            <span className="text-sm">
              {d.bill?.merchant ?? "Bill"} — to @{d.bill?.creator?.x_handle ?? "?"}
            </span>
            <span className="flex items-center gap-3">
              <strong className="amount-text">{d.amount_usdc} USDC</strong>
              <button className="primary-button" disabled={payingId === d.id} onClick={() => pay(d.id)} type="button">
                {payingId === d.id ? "Paying…" : "Pay"}
              </button>
            </span>
          </div>
        ))}
      </div>
      {error ? <p className="mt-3 text-sm text-[var(--warning-text)]">{error}</p> : null}
    </div>
  );
}
