"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { IdentityProvider } from "@/lib/types";
import { providerDisplay } from "@/lib/provider-display";

// Shapes returned by GET /api/bills (Supabase nested selects).
type IOwe = {
  id: string;
  amount_usdc: string;
  status: string;
  bill: { merchant: string | null; creator: { provider?: IdentityProvider; handle: string } | null } | null;
};
type OwedToMe = {
  id: string;
  merchant: string | null;
  total_usdc: string;
  debts: { id: string; debtor_provider?: IdentityProvider; debtor_handle: string; amount_usdc: string; status: string }[];
};
type Row = { provider: IdentityProvider; handle: string; amount: string };

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
              onChange={(e) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, amount: e.target.value } : r)))}
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
              <span>
                {d.bill?.merchant ?? "Bill"} — to{" "}
                {(() => {
                  const c = providerDisplay({ provider: d.bill?.creator?.provider, handle: d.bill?.creator?.handle });
                  return `${c.prefix}${c.label}`;
                })()}
              </span>
              <span style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
                <strong>{d.amount_usdc} USDC</strong>
                {d.status === "paid" ? (
                  <span style={{ color: "#16a34a" }}>✓ paid</span>
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
              {b.debts.map((debt) => {
                const p = providerDisplay({ provider: debt.debtor_provider, handle: debt.debtor_handle });
                return (
                  <span key={debt.id} style={{ fontSize: "0.85rem", opacity: 0.8 }}>
                    {p.prefix}
                    {p.label}: {debt.amount_usdc} {debt.status === "paid" ? "✓ paid" : "· pending"}
                  </span>
                );
              })}
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
