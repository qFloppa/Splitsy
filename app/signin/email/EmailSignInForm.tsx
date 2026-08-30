"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Turnstile, type TurnstileInstance } from "@marsidev/react-turnstile";

// Dedicated Email-OTP sign-in flow (its own page, not a header popup). Two steps:
// enter email → enter the 6-digit code. On success /api/auth/email/verify sets
// the session cookie and we hard-navigate home so the app re-reads the session.
// The email identity is the same one Google sign-in resolves to.
//
// The surface is /owe's composer, not a form: two steps, one value each, and the
// value is the whole screen. See the sign-in poster block in globals.css for why
// the card, the envelope-in-a-tinted-square and the two .field-control boxes it
// used to draw are gone.
type Phase = "email" | "code";

export default function EmailSignInForm() {
  const [phase, setPhase] = useState<Phase>("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  // null until the theme is known, which is also what gates the widget's first
  // mount — see the effect below.
  const [theme, setTheme] = useState<"light" | "dark" | null>(null);
  // The composer reveals on arrival the way /owe's does — armed by the client so
  // a page that never hydrates shows its poster instead of an empty one.
  const [revealed, setRevealed] = useState<boolean | null>(null);
  const turnstileRef = useRef<TurnstileInstance | undefined>(undefined);

  const siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;

  // Gated on the display face, the way /owe's composer is: Clash loads async, and
  // revealing before it is ready wipes the fallback into view and then reflows it.
  useEffect(() => {
    let live = true;
    void document.fonts.ready.then(() => {
      if (!live) return;
      // Turnstile is a cross-origin iframe and cannot read the page's tokens, so
      // it has to be told which theme to draw. Taken from the <html> attribute the
      // root layout's inline script resolves before first paint, not from
      // prefers-color-scheme, which misses the app's own stored override.
      //
      // Resolved here rather than in an effect of its own for two reasons: a
      // synchronous setState in an effect body is a cascading render, and the
      // widget can then mount once already in the right theme instead of drawing
      // dark and being torn down when the answer arrives.
      setTheme(document.documentElement.dataset.theme === "light" ? "light" : "dark");
      setRevealed(false);
      requestAnimationFrame(() => requestAnimationFrame(() => live && setRevealed(true)));
    });
    return () => {
      live = false;
    };
  }, []);

  async function sendCode() {
    if (!turnstileToken) {
      setError("Please complete the verification.");
      return;
    }

    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/auth/email/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, turnstileToken }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Could not send the code.");
        turnstileRef.current?.reset();
        setTurnstileToken(null);
        return;
      }
      setPhase("code");
      setNotice(`We sent a 6-digit code to ${email}.`);
    } catch {
      setError("Network error — please try again.");
      turnstileRef.current?.reset();
      setTurnstileToken(null);
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
      window.location.href = "/app";
    } catch {
      setError("Network error — please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="iou-page" data-signin>
      <div className="iou-rail">
        <Link href="/app">← splitsy</Link>
        <span className="iou-rail-end">sign in · arc testnet</span>
      </div>

      <div className="iou-composer" data-revealed={revealed === null ? undefined : revealed}>
        {phase === "email" ? (
          <>
            {/* The ordinal is this design's mark for a step. It replaces the
                numbered circle and the icon in a tinted square in one stroke: a
                serious document numbers its steps, it does not illustrate them. */}
            <p className="settle-label signin-step" data-reveal>
              <b>01</b> your email
            </p>

            {/* A bare input on a rule that lights, sized by the hidden mirror
                behind it — the same token the /owe sentence is built from, so the
                address you type is the largest thing on the screen. */}
            <div className="iou-sentence" data-reveal>
              <span className="iou-slot">
                <span aria-hidden className="iou-mirror">
                  {email || "name@email.com"}
                </span>
                <input
                  className="iou-field"
                  type="email"
                  inputMode="email"
                  autoFocus
                  autoCapitalize="none"
                  autoComplete="email"
                  autoCorrect="off"
                  spellCheck={false}
                  aria-label="Email address"
                  placeholder="name@email.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value.trim())}
                  onKeyDown={(e) => e.key === "Enter" && email && turnstileToken && sendCode()}
                />
              </span>
            </div>

            <div className="iou-rule" />

            <p className="lp-note" data-reveal>
              We send a one-time code — no password to choose, and none to forget. The same identity Google sign-in
              resolves to.
            </p>

            {siteKey && theme ? (
              <div className="signin-check" data-reveal>
                <Turnstile
                  ref={turnstileRef}
                  siteKey={siteKey}
                  onSuccess={setTurnstileToken}
                  onError={() => setTurnstileToken(null)}
                  onExpire={() => setTurnstileToken(null)}
                  options={{ theme, size: "normal" }}
                />
              </div>
            ) : null}

            <div className="iou-meta" data-reveal>
              {error ? (
                <p className="iou-error" role="status">
                  {error}
                </p>
              ) : null}
            </div>

            <button
              type="button"
              onClick={sendCode}
              disabled={busy || !email || !turnstileToken}
              className="settle-action"
              data-reveal
            >
              {busy ? "…" : "email me a code"} ›
            </button>
          </>
        ) : (
          <>
            <p className="settle-label signin-step" data-reveal>
              <b>02</b> the code we emailed you
            </p>

            {/* Six digits is the one value on this route that can take the full
                display scale — tracked out and tabular, so the count reads without
                being counted. */}
            <div className="iou-sentence" data-code data-reveal>
              <span className="iou-slot">
                <span aria-hidden className="iou-mirror">
                  {code || "000000"}
                </span>
                <input
                  className="iou-field"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  autoFocus
                  maxLength={6}
                  aria-label="6-digit code"
                  placeholder="000000"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                  onKeyDown={(e) => e.key === "Enter" && code.length === 6 && verifyCode()}
                />
              </span>
            </div>

            <div className="iou-rule" />

            {notice ? (
              <p className="lp-note" data-reveal>
                {notice} It expires in a few minutes.
              </p>
            ) : null}

            <div className="iou-meta" data-reveal>
              {error ? (
                <p className="iou-error" role="status">
                  {error}
                </p>
              ) : null}
              <button
                type="button"
                className="iou-provider"
                onClick={() => {
                  setPhase("email");
                  setCode("");
                  setError(null);
                  setNotice(null);
                  setTurnstileToken(null);
                  turnstileRef.current?.reset();
                }}
              >
                use a different email
              </button>
            </div>

            <button
              type="button"
              onClick={verifyCode}
              disabled={busy || code.length !== 6}
              className="settle-action"
              data-reveal
            >
              {busy ? "…" : "verify & sign in"} ›
            </button>
          </>
        )}
      </div>
    </main>
  );
}
