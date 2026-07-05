"use client";

import { CheckCircle2 } from "lucide-react";
import { useEffect, useState } from "react";

// Paid off-chain @handle bills for the signed-in X user, shown in History.
type IOwe = {
  id: string;
  amount_usdc: string;
  status: string;
  paid_at: string | null;
  bill: { merchant: string | null; creator: { x_handle: string } | null } | null;
};

export default function XHistoryPanel() {
  const [paid, setPaid] = useState<IOwe[]>([]);

  useEffect(() => {
    let active = true;
    fetch("/api/bills")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("not signed in"))))
      .then((data: { iOwe?: IOwe[] }) => {
        if (active) setPaid((data.iOwe ?? []).filter((d) => d.status === "paid"));
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
        <CheckCircle2 size={19} className="text-[#17a56b]" />
        <h3 className="text-base font-semibold">Paid via X</h3>
      </div>
      <div className="mt-4 space-y-2">
        {paid.map((d) => (
          <div
            key={d.id}
            className="flex items-center justify-between rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-muted)] p-3"
          >
            <span className="flex items-center gap-2 text-sm">
              <CheckCircle2 size={16} className="text-[#17a56b]" />
              {d.bill?.merchant ?? "Bill"} — to @{d.bill?.creator?.x_handle ?? "?"}
            </span>
            <span className="flex items-center gap-3">
              <span className="status-dot status-ok">Paid</span>
              <strong className="amount-text">{d.amount_usdc} USDC</strong>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
