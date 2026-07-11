import { NextResponse, type NextRequest } from "next/server";
import { upsertUserFromProvider, setUserWallet } from "@/lib/users-repo";
import { resolveDebtsForHandle } from "@/lib/bills-repo";
import { getOrCreateArcWallet } from "@/lib/circle-dcw";
import { signSession, SESSION_COOKIE_NAME, SESSION_MAX_AGE } from "@/lib/session";
import type { IdentityProvider } from "@/lib/types";

// Shared tail of every sign-in provider's OAuth callback (X, Discord, …). Each
// provider's route does its own token exchange + profile fetch, normalizes the
// result into a NormalizedProfile, then hands off here for the identical
// "persist → link debts → provision wallet → set session" sequence. Keeping this
// in one place means a new provider is just an OAuth module + a thin route.

export type NormalizedProfile = {
  providerUserId: string;
  handle: string;
  name: string | null;
  avatarUrl: string | null;
};

// Persist the user, link any pending debts tagged with their (provider, handle),
// provision a Circle wallet on first login, and return a redirect into the app
// carrying the signed session cookie. On a DB failure returns an error page
// instead. Debt-linking and wallet provisioning are best-effort and never block
// login.
export async function finishProviderLogin(params: {
  provider: IdentityProvider;
  profile: NormalizedProfile;
  request: NextRequest;
  sessionSecret: string;
}): Promise<NextResponse> {
  const { provider, profile, request, sessionSecret } = params;

  let appUser;
  try {
    appUser = await upsertUserFromProvider({
      provider,
      providerUserId: profile.providerUserId,
      handle: profile.handle,
      name: profile.name,
      avatarUrl: profile.avatarUrl,
    });
  } catch (dbCaught) {
    return resultPage({
      ok: false,
      status: 500,
      title: "Could not save your account",
      lines: [dbCaught instanceof Error ? dbCaught.message : "Unexpected database error."],
    });
  }

  // Link any pending debts tagged with this (provider, handle) now that we know
  // who they are. Best-effort — don't block login if it fails.
  try {
    await resolveDebtsForHandle(appUser.id, provider, appUser.handle);
  } catch (resolveErr) {
    console.error("Debt resolution failed (login continues):", resolveErr);
  }

  // Provision a Circle DCW on first login (idempotent). Never block login if
  // Circle is down/unconfigured — wallet_address stays null and retries next time.
  if (!appUser.wallet_address) {
    try {
      const wallet = await getOrCreateArcWallet(provider, profile.providerUserId);
      if (wallet) await setUserWallet(appUser.id, wallet.address, wallet.walletId);
    } catch (walletErr) {
      console.error("DCW provisioning failed (login continues):", walletErr);
    }
  }

  const response = NextResponse.redirect(new URL("/", request.nextUrl.origin));
  response.cookies.set(SESSION_COOKIE_NAME, signSession(appUser.id, sessionSecret), {
    httpOnly: true,
    secure: request.nextUrl.protocol === "https:",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE,
  });
  return response;
}

// Expire the two short-lived OAuth round-trip cookies. Names differ per provider
// so both flows can be in flight without clobbering each other.
export function clearOauthCookies(
  response: NextResponse,
  stateCookie: string,
  verifierCookie: string,
): NextResponse {
  response.cookies.set(stateCookie, "", { path: "/", maxAge: 0 });
  response.cookies.set(verifierCookie, "", { path: "/", maxAge: 0 });
  return response;
}

// Minimal self-contained HTML so an error is readable in the browser without
// pulling in the app shell. No inline scripts, so the CSP is unaffected.
export function resultPage({
  ok,
  status,
  title,
  lines,
  backHref = "/",
  backLabel = "← Back to Splitsy",
}: {
  ok: boolean;
  status: number;
  title: string;
  lines: string[];
  backHref?: string;
  backLabel?: string;
}) {
  const accent = ok ? "#16a34a" : "#dc2626";
  const body = lines.map((line) => escapeHtml(line)).join("\n");
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
    font-family: ui-sans-serif, system-ui, sans-serif; background:#0d1b2a; color:#e6edf3; padding:2rem; }
  main { width:min(640px,100%); background:#0f2438; border:1px solid #1e3a52;
    border-radius:16px; padding:2rem; box-shadow:0 10px 40px rgba(0,0,0,.35); }
  h1 { margin:0 0 1rem; font-size:1.35rem; border-left:4px solid ${accent}; padding-left:.75rem; }
  pre { margin:0 0 1.5rem; padding:1rem; background:#0a1826; border-radius:10px;
    white-space:pre-wrap; word-break:break-word; font-size:.9rem; line-height:1.5; }
  a { color:#5aa9ff; text-decoration:none; font-weight:600; }
  a:hover { text-decoration:underline; }
</style>
</head>
<body>
<main>
  <h1>${escapeHtml(title)}</h1>
  <pre>${body}</pre>
  <a href="${escapeHtml(backHref)}">${escapeHtml(backLabel)}</a>
</main>
</body>
</html>`;

  return new NextResponse(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

export function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
