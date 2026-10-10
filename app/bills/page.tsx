"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { typableAmount } from "@/lib/iou";
import type { IdentityProvider } from "@/lib/types";
import { ProviderTag } from "@/app/ProviderTag";

// Shapes returned by GET /api/bills (Supabase nested selects).
//
// A person arrives as the PARTS of an identity — provider, bare handle, the
// avatar when the sign-in gave us one — because which providers wear a leading
// "@" is lib/provider-display.ts's rule and it can only apply it to a bare
// handle. The debtor's `users` row exists only once they have signed in; until
// then the debt's own snapshot columns are the only name they have.
type Person = { provider?: IdentityProvider; handle: string; avatar_url?: string | null } | null;
type IOwe = {
  id: string;
  amount_usdc: string;
  status: string;
  bill: { merchant: string | null; creator: Person } | null;
};
type OwedToMe = {
  id: string;
  merchant: string | null;
  total_usdc: string;
  debts: {
    id: string;
    debtor_provider?: IdentityProvider;
    debtor_handle: string;
    debtor: Person;
    amount_usdc: string;
    status: string;
  }[];
};
type Row = { provider: IdentityProvider; handle: string; amount: string };

// A Supabase row's snake_case into the tag's own shape. No address: this page
// reads the app-side bills table, which records who a debt is against rather
// than which wallet pays it — so the tag links to the person's public profile
// where there is one, instead of to Arc.
const personOf = (p: NonNullable<Person>) => ({
  provider: p.provider,
  handle: p.handle,
  avatarUrl: p.avatar_url ?? null,
});

export default function BillsPage() {
  const [iOwe, setIOwe] = useState<IOwe[]>([]);
  const [owedToMe, setOwedToMe] = useState<OwedToMe[]>([]);
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [merchant, setMerchant] = useState("");
  const [rows, setRows] = useState<Row[]>([{ provider: "x", handle: "", amount: "" }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [payingId, setPayingId] = useState<string | null>(null);

  function apply(data: { iOwe?: IOwe[]; owedToMe?: OwedToMe[] }) {
    setAuthed(true);
    setIOwe(data.iOwe ?? []);
    setOwedToMe(data.owedToMe ?? []);
  }

  // Used by submit() to refresh after creating a bill (not an effect).
  async function load() {
    const res = await fetch("/api/bills");
    if (res.status === 401) {
      setAuthed(false);
      return;
    }
    apply(await res.json());
  }

  useEffect(() => {
    let active = true;
    fetch("/api/bills")
      .then((res) => (res.status === 401 ? Promise.reject(new Error("401")) : res.json()))
      .then((data) => {
        if (active) apply(data);
      })
      .catch(() => {
        if (active) setAuthed(false);
      });
    return () => {
      active = false;
    };
  }, []);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const debts = rows
        .filter((r) => r.handle.trim() && r.amount.trim())
        .map((r) => ({ provider: r.provider, handle: r.handle, amount: Number(r.amount) }));
      const res = await fetch("/api/bills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ merchant, debts }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Could not create the bill.");
        return;
      }
      setMerchant("");
      setRows([{ provider: "x", handle: "", amount: "" }]);
      await load();
    } finally {
      setBusy(false);
    }
  }

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

  if (authed === false) {
    return (
      <main style={{ maxWidth: 640, margin: "4rem auto", padding: "0 1rem", textAlign: "center" }}>
        <p>Sign in to split and view bills.</p>
        <div style={{ display: "flex", gap: "1rem", justifyContent: "center", marginTop: "0.5rem" }}>
          <a href="/api/auth/twitter" style={{ color: "#1d9bf0", fontWeight: 600 }}>
            Sign in with X
          </a>
          <a href="/api/auth/discord" style={{ color: "#5865f2", fontWeight: 600 }}>
            Sign in with Discord
          </a>
        </div>
      </main>
    );
  }

  return (
    <main style={{ maxWidth: 720, margin: "2rem auto", padding: "0 1rem", display: "grid", gap: "2rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1 style={{ fontSize: "1.5rem", fontWeight: 700 }}>Bills</h1>
        <Link href="/app" style={{ color: "#5aa9ff" }}>
          ← App
        </Link>
      </div>

      <section style={{ border: "1px solid var(--border)", borderRadius: 12, padding: "1.25rem" }}>
        <h2 style={{ fontWeight: 600, marginBottom: "0.75rem" }}>Split a new bill</h2>
        <input
          placeholder="Merchant (optional)"
          value={merchant}
          onChange={(e) => setMerchant(e.target.value)}
          style={inputStyle}
        />
        {rows.map((row, i) => (
          <div key={i} style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem" }}>
            <select
              value={row.provider}
              onChange={(e) =>
                setRows((rs) => rs.map((r, j) => (j === i ? { ...r, provider: e.target.value as IdentityProvider } : r)))
              }
              style={{ ...inputStyle, flex: "0 0 auto", width: "auto" }}
              aria-label="Provider"
            >
              <option value="x">X</option>
              <option value="discord">Discord</option>
              <option value="email">Email</option>
            </select>
            <input
              placeholder={row.provider === "discord" ? "username" : row.provider === "email" ? "name@email.com" : "@handle"}
              value={row.handle}
              onChange={(e) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, handle: e.target.value } : r)))}
              style={{ ...inputStyle, flex: 2 }}
            />
            <input
              placeholder="USDC"
              inputMode="decimal"
              value={row.amount}
              // Gated live with the app's one amount rule (lib/iou.ts). This
              // field took any string at all and handed it to the split maths.
              onChange={(e) =>
                typableAmount(e.target.value) &&
                setRows((rs) => rs.map((r, j) => (j === i ? { ...r, amount: e.target.value } : r)))
              }
              style={{ ...inputStyle, flex: 1 }}
            />
          </div>
        ))}
        <div style={{ display: "flex", gap: "0.75rem", marginTop: "0.75rem", alignItems: "center" }}>
          <button type="button" onClick={() => setRows((rs) => [...rs, { provider: "x", handle: "", amount: "" }])} style={linkBtn}>
            + person
          </button>
          <button type="button" onClick={submit} disabled={busy} style={primaryBtn}>
            {busy ? "Saving…" : "Create bill"}
          </button>
          {error ? <span style={{ color: "#dc2626", fontSize: "0.85rem" }}>{error}</span> : null}
        </div>
      </section>

      <section>
        <h2 style={{ fontWeight: 600, marginBottom: "0.75rem" }}>You owe</h2>
        {iOwe.length === 0 ? (
          <p style={{ opacity: 0.6 }}>Nothing owed.</p>
        ) : (
          iOwe.map((d) => (
            <div key={d.id} style={cardStyle}>
              {/* A plain inline span, not a flex row: `.ptag` is inline-flex and
                  baseline-aligned, so it sits inside the sentence rather than
                  needing a row of its own — and the colon in the debtor rows
                  below stays attached to the amount it introduces. */}
              <span>
                {d.bill?.merchant ?? "Bill"} — to{" "}
                {d.bill?.creator ? <ProviderTag person={personOf(d.bill.creator)} /> : "someone"}
              </span>
              <span style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
                <strong>{d.amount_usdc} USDC</strong>
                {d.status === "paid" ? (
                  <span style={{ color: "#16a34a" }}>✓ paid</span>
                ) : d.status === "settling" ? (
                  <span style={{ color: "#ca8a04" }}>⏳ settling…</span>
                ) : (
                  <button type="button" onClick={() => pay(d.id)} disabled={payingId === d.id} style={primaryBtn}>
                    {payingId === d.id ? "Paying…" : "Pay"}
                  </button>
                )}
              </span>
            </div>
          ))
        )}
      </section>

      <section>
        <h2 style={{ fontWeight: 600, marginBottom: "0.75rem" }}>Owed to you</h2>
        {owedToMe.length === 0 ? (
          <p style={{ opacity: 0.6 }}>No bills created yet.</p>
        ) : (
          owedToMe.map((b) => (
            <div key={b.id} style={{ ...cardStyle, flexDirection: "column", alignItems: "stretch", gap: "0.35rem" }}>
              <strong>
                {b.merchant ?? "Bill"} — {b.total_usdc} USDC
              </strong>
              {b.debts.map((debt) => (
                <span key={debt.id} style={{ fontSize: "0.85rem", opacity: 0.8 }}>
                  {/* The live users row wins over the debt's creation-time
                      snapshot — it is the handle as it is now — and it is also
                      the only side that carries an avatar. */}
                  <ProviderTag
                    person={personOf(debt.debtor ?? { provider: debt.debtor_provider, handle: debt.debtor_handle })}
                  />
                  : {debt.amount_usdc}{" "}
                  {debt.status === "paid" ? "✓ paid" : debt.status === "settling" ? "⏳ settling" : "· pending"}
                </span>
              ))}
            </div>
          ))
        )}
      </section>
    </main>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "0.5rem 0.75rem",
  borderRadius: 8,
  border: "1px solid var(--border)",
  background: "transparent",
  color: "inherit",
};
const cardStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  // A gap as well as space-between: the row's two halves touch once the name is
  // long enough to fill the card, and a tagged name is wider than the bare
  // handle that used to sit here.
  gap: "0.75rem",
  padding: "0.75rem 1rem",
  border: "1px solid var(--border)",
  borderRadius: 10,
  marginBottom: "0.5rem",
};
const primaryBtn: React.CSSProperties = {
  background: "#1d9bf0",
  color: "#fff",
  fontWeight: 600,
  padding: "0.5rem 1rem",
  borderRadius: 9999,
  border: "none",
  cursor: "pointer",
};
const linkBtn: React.CSSProperties = {
  background: "transparent",
  color: "#5aa9ff",
  border: "none",
  cursor: "pointer",
  fontSize: "0.9rem",
};
