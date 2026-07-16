import Link from "next/link";

// Render at request time so the nonce-based CSP (see proxy.ts) is applied.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "X login test",
  robots: { index: false, follow: false },
};

// Temporary stage-1 harness: a single button that kicks off Sign in with X so
// we can confirm the OAuth handshake works before wiring identity into the app.
export default function AuthTestPage() {
  return (
    <main
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        padding: "2rem",
      }}
    >
      <div style={{ width: "min(560px, 100%)", textAlign: "center" }}>
        <p style={{ textTransform: "uppercase", letterSpacing: "0.08em", fontSize: "0.8rem", opacity: 0.6 }}>
          Internal · stage 1
        </p>
        <h1 style={{ fontSize: "1.6rem", margin: "0.5rem 0 1rem" }}>Sign in with X — connection test</h1>
        <p style={{ opacity: 0.75, lineHeight: 1.6, marginBottom: "2rem" }}>
          Starts the OAuth 2.0 + PKCE handshake and exchanges the code for a token. This does not call any billed X
          endpoint, so it is free to run. On success you&apos;ll see the token details.
        </p>
        <a
          href="/api/auth/twitter"
          style={{
            display: "inline-block",
            background: "#1d9bf0",
            color: "#fff",
            fontWeight: 700,
            padding: "0.85rem 1.75rem",
            borderRadius: "9999px",
            textDecoration: "none",
          }}
        >
          Sign in with X
        </a>
        <p style={{ marginTop: "2rem", fontSize: "0.85rem" }}>
          <Link href="/app" style={{ color: "#5aa9ff" }}>
            ← Back to Splitsy
          </Link>
        </p>
      </div>
    </main>
  );
}
