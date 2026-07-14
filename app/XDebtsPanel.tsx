"use client";

import { AnimatePresence, motion } from "framer-motion";
import { CheckCircle2, ExternalLink, KeyRound, Loader2, Wallet, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import confetti from "canvas-confetti";
import { type ProviderPerson } from "@/lib/provider-display";
import { ProviderTag } from "./ProviderTag";

// Unpaid debts owed by the signed-in user (off-chain handle bills). Renders
// nothing when not signed in or nothing is owed.
type Creator = { provider?: ProviderPerson["provider"]; handle: string; avatar_url: string | null } | null;
type IOwe = {
  id: string;
  amount_usdc: string;
  status: string;
  bill: { merchant: string | null; creator: Creator } | null;
};

type Flow = {
  debt: IOwe;
  phase: "confirm" | "unlock" | "paying" | "success" | "error";
  message?: string;
  insufficient?: boolean;
};

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

export default function XDebtsPanel({ onCount }: { onCount?: (n: number) => void }) {
  const [debts, setDebts] = useState<IOwe[]>([]);
  const [flow, setFlow] = useState<Flow | null>(null);

  // Report the unpaid count up so the parent can render one merged pending
  // window whose heading sums social + wallet debts.
  useEffect(() => {
    onCount?.(debts.length);
  }, [debts.length, onCount]);

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

  // Begin payment: if the wallet is already unlocked, pay straight away;
  // otherwise ask for the PIN first (the unlock step gates the transfer).
  async function beginPayment(debt: IOwe) {
    try {
      const res = await fetch("/api/wallet/pin");
      const data = await res.json().catch(() => ({}));
      if (data.unlocked) {
        void runPayment(debt);
      } else {
        setFlow({ debt, phase: "unlock" });
      }
    } catch {
      setFlow({ debt, phase: "unlock" });
    }
  }

  async function runPayment(debt: IOwe) {
    setFlow({ debt, phase: "paying" });
    try {
      const res = await fetch(`/api/debts/${debt.id}/pay`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (res.status === 403 || data.error === "locked") {
        // Unlock expired between confirm and pay — re-prompt for the PIN.
        setFlow({ debt, phase: "unlock", message: "Your wallet locked. Enter your PIN to continue." });
        return;
      }
      if (res.status === 402 || data.error === "insufficient_funds") {
        setFlow({ debt, phase: "error", insufficient: true });
        return;
      }
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
      {debts.map((d) => (
        <motion.div
          key={d.id}
          layout
          exit={{ opacity: 0, x: 24, transition: { duration: 0.25 } }}
          className="flex items-center justify-between rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-muted)] p-3"
        >
          <span className="flex items-center gap-1.5 text-sm">
            {d.bill?.merchant ?? "Bill"} — to <CreatorTag creator={d.bill?.creator} />
          </span>
          <span className="flex items-center gap-3">
            <strong className="amount-text">{d.amount_usdc} USDC</strong>
            <button className="primary-button" onClick={() => setFlow({ debt: d, phase: "confirm" })} type="button">
              Pay
            </button>
          </span>
        </motion.div>
      ))}

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
              <PaymentDialog
                flow={flow}
                onConfirm={() => beginPayment(flow.debt)}
                onUnlocked={() => runPayment(flow.debt)}
                onClose={() => setFlow(null)}
              />
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </>
  );
}

function PaymentDialog({
  flow,
  onConfirm,
  onUnlocked,
  onClose,
}: {
  flow: Flow;
  onConfirm: () => void;
  onUnlocked: () => void;
  onClose: () => void;
}) {
  const creator = flow.debt.bill?.creator;
  const to = <CreatorTag creator={creator} />;
  const amount = `${flow.debt.amount_usdc} USDC`;

  if (flow.phase === "confirm") {
    return (
      <>
        <IconCircle tone="brand">
          <Wallet size={26} />
        </IconCircle>
        <h3 className="mt-4 text-lg font-semibold">Pay {to}</h3>
        <p className="mt-1 text-sm text-[var(--text-muted)]">
          Send <strong className="amount-text text-[var(--text)]">{amount}</strong> from your wallet on Arc Testnet?
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

  if (flow.phase === "unlock") {
    return <UnlockStep message={flow.message} onUnlocked={onUnlocked} onClose={onClose} />;
  }

  if (flow.phase === "paying") {
    return (
      <>
        <IconCircle tone="brand">
          <Loader2 size={26} className="animate-spin" />
        </IconCircle>
        <h3 className="mt-4 text-lg font-semibold">Sending USDC on Arc…</h3>
        <p className="mt-1 text-sm text-[var(--text-muted)]">
          Paying {amount} to {to}.
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

  // Insufficient funds gets its own friendly prompt with a faucet link.
  if (flow.insufficient) {
    return (
      <>
        <IconCircle tone="error">
          <XCircle size={28} />
        </IconCircle>
        <h3 className="mt-4 text-lg font-semibold">Not enough USDC</h3>
        <p className="mt-1 text-sm text-[var(--text-muted)]">
          Your wallet needs at least <strong className="text-[var(--text)]">{amount}</strong> (plus a little for gas) on
          Arc Testnet. Top it up with free test USDC.
        </p>
        <a
          href="https://faucet.circle.com"
          target="_blank"
          rel="noreferrer"
          className="mt-4 inline-flex items-center gap-1.5 rounded-full bg-[#2775ca] px-4 py-2 text-sm font-semibold text-white"
        >
          <ExternalLink size={14} /> Get test USDC · faucet.circle.com
        </a>
        <button type="button" className="secondary-button mt-3 w-full justify-center" onClick={onClose}>
          Close
        </button>
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

// Creditor's avatar + platform badge + handle, shown inline wherever we
// reference them. ProviderTag links to the public profile when the provider has
// one (X does; Discord/Email don't).
function CreatorTag({ creator }: { creator?: Creator }) {
  return <ProviderTag person={{ provider: creator?.provider, handle: creator?.handle, avatarUrl: creator?.avatar_url }} />;
}

// PIN entry before a payment. Verifies via /api/wallet/unlock (which sets the
// 5-minute unlock cookie), then proceeds to the actual transfer.
function UnlockStep({
  message,
  onUnlocked,
  onClose,
}: {
  message?: string;
  onUnlocked: () => void;
  onClose: () => void;
}) {
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(message ?? null);

  async function unlock() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/wallet/unlock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error === "No PIN set" ? "Set a wallet PIN from the wallet panel first." : data.error ?? "Incorrect PIN.");
        setBusy(false);
        return;
      }
      onUnlocked();
    } catch {
      setError("Network error — please try again.");
      setBusy(false);
    }
  }

  return (
    <>
      <IconCircle tone="brand">
        <KeyRound size={26} />
      </IconCircle>
      <h3 className="mt-4 text-lg font-semibold">Enter your wallet PIN</h3>
      <p className="mt-1 text-sm text-[var(--text-muted)]">
        Paying requires your PIN. It stays unlocked for 5 minutes.
      </p>
      <input
        value={pin}
        onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
        type="password"
        inputMode="numeric"
        maxLength={8}
        autoFocus
        placeholder="Wallet PIN"
        onKeyDown={(e) => e.key === "Enter" && pin && !busy && unlock()}
        className="mt-3 w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-2 text-center text-lg tracking-[0.4em]"
      />
      {error ? <p className="mt-2 text-xs text-[var(--warning-text)]">{error}</p> : null}
      <div className="mt-4 flex gap-2">
        <button type="button" className="secondary-button flex-1 justify-center" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="primary-button flex-1 justify-center disabled:opacity-50"
          disabled={busy || !pin}
          onClick={unlock}
        >
          {busy ? <Loader2 size={15} className="animate-spin" /> : null}
          Unlock &amp; pay
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
