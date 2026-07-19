"use client";

import { useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";
import type { IdentityProvider } from "@/lib/types";

type Rep =
  | { status: "none" }
  | { status: "scored"; count: number; avgScore: number; lastPaidAt: string | null };

const looksLikeAddress = (v: string) => /^0x[a-fA-F0-9]{40}$/.test(v.trim());
const looksLikeEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());

// On-chain payment reputation for a tagged payer (ERC-8004, /api/reputation).
// Debounced so it queries settled input, not every keystroke. Renders nothing
// until an answer arrives; "no history" renders as a neutral note — under the
// consent policy an empty profile means "new here", never "bad payer".
export function ReputationBadge({ provider, value }: { provider: IdentityProvider; value: string }) {
  // Answers are keyed by the input they were fetched for, so an edited handle
  // stops showing the previous person's badge without a setState-in-effect reset.
  const [answer, setAnswer] = useState<{ key: string; rep: Rep } | null>(null);

  const trimmed = value.trim();
  useEffect(() => {
    if (trimmed.length < 3) return;

    const query = looksLikeAddress(trimmed)
      ? `address=${encodeURIComponent(trimmed)}`
      : `provider=${looksLikeEmail(trimmed) ? "email" : provider}&handle=${encodeURIComponent(trimmed)}`;

    const abort = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const res = await fetch(`/api/reputation?${query}`, { signal: abort.signal });
        if (!res.ok) return;
        setAnswer({ key: trimmed, rep: (await res.json()) as Rep });
      } catch {
        // Badge is decorative — a failed lookup just stays blank.
      }
    }, 500);
    return () => {
      window.clearTimeout(timer);
      abort.abort();
    };
  }, [trimmed, provider]);

  const rep = answer?.key === trimmed ? answer.rep : null;
  if (!rep) return null;
  if (rep.status === "none") {
    return <span className="text-xs text-[var(--text-muted)]">No payment history yet</span>;
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-[var(--text)]">
      <ShieldCheck size={13} className="text-emerald-500" aria-hidden="true" />
      Paid {rep.count} {rep.count === 1 ? "bill" : "bills"} in full on Arc
    </span>
  );
}
