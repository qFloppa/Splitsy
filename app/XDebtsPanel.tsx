"use client";

import { AnimatePresence, motion } from "framer-motion";
import { CheckCircle2, Loader2, Wallet, XCircle } from "lucide-react";
import confetti from "canvas-confetti";
import { useEffect, useState } from "react";

// Unpaid debts owed by the signed-in X user (off-chain @handle bills). Renders
// nothing when not signed in with X or nothing is owed.
type IOwe = {
  id: string;
  amount_usdc: string;
  status: string;
  bill: { merchant: string | null; creator: { x_handle: string } | null } | null;
};

type Flow = { debt: IOwe; phase: "confirm" | "paying" | "success" | "error"; message?: string };

function celebrate() {
  if (typeof window === "undefined") return;
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  void confetti({
    particleCount: 110,
    spread: 68,
    startVelocity: 36,
    origin: { y: 0.5 },
    colors: ["#2775ca", "#3ee6d6", "#17a56b"],
  });
}

export default function XDebtsPanel() {
  const [debts, setDebts] = useState<IOwe[]>([]);
  const [flow, setFlow] = useState<Flow | null>(null);

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

  async function runPayment(debt: IOwe) {
    setFlow({ debt, phase: "paying" });
    try {
      const res = await fetch(`/api/debts/${debt.id}/pay`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setFlow({ debt, phase: "error", message: data.error ?? "Payment failed." });
        return;
      }
      setFlow({ debt, phase: "success" });
      celebrate();
      setTimeout(() => {
        setFlow(null);
        void load();
      }, 1900);
    } catch {
      setFlow({ debt, phase: "error", message: "Network error — please try again." });
    }
  }

  return (
    <>
      {debts.length > 0 ? (
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
              <motion.div
                key={d.id}
                layout
                exit={{ opacity: 0, x: 24, transition: { duration: 0.25 } }}
                className="flex items-center justify-between rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-muted)] p-3"
              >
                <span className="text-sm">
                  {d.bill?.merchant ?? "Bill"} — to @{d.bill?.creator?.x_handle ?? "?"}
                </span>
                <span className="flex items-center gap-3">
                  <strong className="amount-text">{d.amount_usdc} USDC</strong>
                  <button className="primary-button" onClick={() => setFlow({ debt: d, phase: "confirm" })} type="button">
                    Pay
                  </button>
                </span>
              </motion.div>
            ))}
          </div>
        </div>
      ) : null}

      <AnimatePresence>
        {flow ? (
          <motion.div
            className="fixed inset-0 z-[60] flex items-center justify-center bg-black/45 p-4 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => (flow.phase === "paying" ? null : setFlow(null))}
          >
            <motion.div
              className="w-full max-w-sm rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-muted)] p-6 text-center shadow-2xl"
              initial={{ scale: 0.9, opacity: 0, y: 12 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.95, opacity: 0 }}
              transition={{ type: "spring", stiffness: 320, damping: 26 }}
              onClick={(e) => e.stopPropagation()}
            >
              <PaymentDialog flow={flow} onConfirm={() => runPayment(flow.debt)} onClose={() => setFlow(null)} />
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </>
  );
}

function PaymentDialog({ flow, onConfirm, onClose }: { flow: Flow; onConfirm: () => void; onClose: () => void }) {
  const to = `@${flow.debt.bill?.creator?.x_handle ?? "?"}`;
  const amount = `${flow.debt.amount_usdc} USDC`;

  if (flow.phase === "confirm") {
    return (
      <>
        <IconCircle tone="brand">
          <Wallet size={26} />
        </IconCircle>
        <h3 className="mt-4 text-lg font-semibold">Pay {to}</h3>
        <p className="mt-1 text-sm text-[var(--text-muted)]">
          Send <strong className="amount-text text-[var(--text)]">{amount}</strong> from your Splitsy wallet on Arc
          Testnet?
        </p>
        <div className="mt-5 flex gap-2">
          <button type="button" className="secondary-button flex-1 justify-center" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="primary-button flex-1 justify-center" onClick={onConfirm}>
            Confirm &amp; pay
          </button>
        </div>
      </>
    );
  }

  if (flow.phase === "paying") {
    return (
      <>
        <IconCircle tone="brand">
          <Loader2 size={26} className="animate-spin" />
        </IconCircle>
        <h3 className="mt-4 text-lg font-semibold">Sending USDC on Arc…</h3>
        <p className="mt-1 text-sm text-[var(--text-muted)]">
          Paying {amount} to {to}. This takes a few seconds.
        </p>
      </>
    );
  }

  if (flow.phase === "success") {
    return (
      <>
        <motion.div initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ type: "spring", stiffness: 400, damping: 18 }}>
          <IconCircle tone="success">
            <CheckCircle2 size={28} />
          </IconCircle>
        </motion.div>
        <h3 className="mt-4 text-lg font-semibold">Paid!</h3>
        <p className="mt-1 text-sm text-[var(--text-muted)]">
          {amount} sent to {to}. It&apos;ll show in your History.
        </p>
      </>
    );
  }

  return (
    <>
      <IconCircle tone="error">
        <XCircle size={28} />
      </IconCircle>
      <h3 className="mt-4 text-lg font-semibold">Payment failed</h3>
      <p className="mt-1 text-sm text-[var(--text-muted)]">{flow.message}</p>
      <div className="mt-5 flex gap-2">
        <button type="button" className="secondary-button flex-1 justify-center" onClick={onClose}>
          Close
        </button>
        <button type="button" className="primary-button flex-1 justify-center" onClick={onConfirm}>
          Try again
        </button>
      </div>
    </>
  );
}

function IconCircle({ tone, children }: { tone: "brand" | "success" | "error"; children: React.ReactNode }) {
  const bg =
    tone === "success" ? "bg-[#17a56b]/15 text-[#17a56b]" : tone === "error" ? "bg-red-500/15 text-red-500" : "bg-[#2775ca]/15 text-[#2775ca]";
  return <div className={`mx-auto flex h-14 w-14 items-center justify-center rounded-full ${bg}`}>{children}</div>;
}
