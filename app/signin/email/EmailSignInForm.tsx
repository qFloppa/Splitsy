"use client";

import { ArrowLeft, Loader2, Mail } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useState } from "react";

// Dedicated Email-OTP sign-in flow (its own page, not a header popup). Two steps:
// enter email → enter the 6-digit code. On success /api/auth/email/verify sets
// the session cookie and we hard-navigate home so the app re-reads the session.
// The email identity is the same one Google sign-in resolves to.
type Phase = "email" | "code";

export default function EmailSignInForm() {
  const [phase, setPhase] = useState<Phase>("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function sendCode() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/auth/email/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Could not send the code.");
        return;
      }
      setPhase("code");
      setNotice(`We sent a 6-digit code to ${email}.`);
    } catch {
      setError("Network error — please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function verifyCode() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/email/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, code }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "Incorrect code.");
        return;
      }
      // Session cookie is set — hard-navigate so the app re-reads it.
      window.location.href = "/";
    } catch {
      setError("Network error — please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-[70vh] w-full max-w-md flex-col justify-center px-6 py-16">
      <Link href="/" className="mb-8 inline-flex items-center gap-2 text-sm font-semibold text-[var(--text-muted)] no-underline transition hover:text-[var(--text)]">
        <ArrowLeft size={16} />
        Back to Splitsy
      </Link>

      <div className="rounded-3xl border border-[var(--border)] bg-[var(--surface)] p-7 shadow-2xl">
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--accent)]/12 text-[var(--accent)]">
          <Mail size={22} />
        </span>
        <h1 className="mt-4 text-xl font-semibold text-[var(--text)]">Sign in with email</h1>
        <p className="mt-1 text-sm text-[var(--text-muted)]">
          {phase === "email"
            ? "Enter your email and we'll send you a one-time code — no password needed."
            : "Enter the 6-digit code we just emailed you."}
        </p>

        {phase === "email" ? (
          <div className="mt-6">
            <label className="block text-sm font-medium text-[var(--text-soft)]">
              Email address
              <input
                type="email"
                inputMode="email"
                autoFocus
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder="name@email.com"
                value={email}
                onChange={(e) => setEmail(e.target.value.trim())}
                onKeyDown={(e) => e.key === "Enter" && email && sendCode()}
                className="field-control"
              />
            </label>
            <button
              type="button"
              onClick={sendCode}
              disabled={busy || !email}
              className="primary-button mt-4 w-full justify-center disabled:opacity-50"
            >
              {busy ? <Loader2 size={16} className="animate-spin" /> : <Mail size={16} />}
              Email me a code
            </button>
          </div>
        ) : (
          <div className="mt-6">
            <label className="block text-sm font-medium text-[var(--text-soft)]">
              6-digit code
              <input
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                maxLength={6}
                placeholder="123456"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                onKeyDown={(e) => e.key === "Enter" && code.length === 6 && verifyCode()}
                className="field-control text-center text-lg tracking-[0.5em]"
              />
            </label>
            <button
              type="button"
              onClick={verifyCode}
              disabled={busy || code.length !== 6}
              className="primary-button mt-4 w-full justify-center disabled:opacity-50"
            >
              {busy ? <Loader2 size={16} className="animate-spin" /> : null}
              Verify &amp; sign in
            </button>
            <button
              type="button"
              onClick={() => {
                setPhase("email");
                setCode("");
                setError(null);
                setNotice(null);
              }}
              className="mt-3 w-full text-center text-xs font-medium text-[var(--text-muted)] underline"
            >
              Use a different email
            </button>
          </div>
        )}

        {notice ? <p className="mt-4 text-xs text-[var(--text-muted)]">{notice}</p> : null}
        {error ? <p className="mt-3 text-xs font-medium text-[var(--warning-text)]">{error}</p> : null}
      </div>

      <p className="mt-6 flex items-center justify-center gap-2 text-xs text-[var(--text-muted)]">
        <Image src="/splitsy.png" alt="" width={14} height={14} className="rounded" />
        Splitsy · Arc Testnet demo
      </p>
    </main>
  );
}
