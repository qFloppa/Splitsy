import { NextResponse, type NextRequest } from "next/server";
import { upsertUserFromProvider, setUserWallet } from "@/lib/users-repo";
import { resolveDebtsForHandle } from "@/lib/bills-repo";
import { releaseEscrowForHandle } from "@/lib/escrow-release";
import { getOrCreateWallet, walletProviderName } from "@/lib/wallet-provider";
import { getPendingWallet, deletePendingWallet } from "@/lib/pending-wallets-repo";
import { signSession, SESSION_COOKIE_NAME, SESSION_MAX_AGE } from "@/lib/session";
import type { AccountProvider } from "@/lib/types";

// Shared tail of every sign-in provider's OAuth callback (X, Discord, …). Each
// provider's route does its own token exchange + profile fetch, normalizes the
// result into a NormalizedProfile, then hands off here for the identical
// "persist → link debts → set session" sequence. Keeping this in one place means
// a new provider is just an OAuth module + a thin route.
//
// WALLET PROVISIONING IS NO LONGER PART OF THAT SEQUENCE ON THE PRIVY STACK — see
// the note where it used to happen unconditionally.

export type NormalizedProfile = {
  providerUserId: string;
  handle: string;
  name: string | null;
  avatarUrl: string | null;
};

// Persist the user, link any pending debts tagged with their (provider, handle),
// and return a redirect into the app carrying the signed session cookie. On a DB
// failure returns an error page instead. Debt-linking and the Circle stack's
// wallet provisioning are best-effort and never block login.
export async function finishProviderLogin(params: {
  provider: AccountProvider;
  profile: NormalizedProfile;
  request: NextRequest;
  sessionSecret: string;
  // OAuth callbacks are top-level browser navigations, so they want a redirect
  // back into the app ("redirect", default). Email-OTP verify is a fetch from an
  // inline panel, so it wants a JSON body it can read ("json"); the session
  // cookie is set the same way on either response.
  mode?: "redirect" | "json";
  // Provision the account but leave the CALLER SIGNED IN AS WHOEVER THEY ARE.
  //
  // There is one session cookie, so setting it evicts whatever it held. A browser
  // wallet proving itself while a social login is live is not a request to be
  // signed out of that login — it only needs the account to exist, so the wallet
  // has an agent of its own to show. See /api/auth/wallet.
  setSession?: boolean;
  // Path to redirect to after successful login, defaults to /app
  returnTo?: string;
  // The wallet this login landed on, when the caller already knows it. Only the
  // Privy route does: it links the embedded wallet itself, before calling this.
  // The OAuth routes leave it undefined and the escrow release reads the user
  // row instead, which is set for every returning user — see the call site for
  // what a brand-new one on the Circle stack gets.
  walletAddress?: string | null;
}): Promise<NextResponse> {
  const { provider, profile, request, sessionSecret, mode = "redirect", setSession = true, returnTo } = params;

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
  //
  // Skipped for a wallet sign-in: bill_debts is tagged by HANDLE, and a wallet
  // has no handle namespace — a bill aimed at a raw address is on chain against
  // that address, not pending in this table under it.
  if (provider !== "wallet") {
    try {
      await resolveDebtsForHandle(appUser.id, provider, appUser.handle);
    } catch (resolveErr) {
      console.error("Debt resolution failed (login continues):", resolveErr);
    }

    // The same sentence resolveDebtsForHandle just said — "you proved who you
    // are, take what is tagged with your handle" — with money attached. Anything
    // escrowed for this handle can now be paid out, because a wallet exists and
    // login is the only moment the handle is proven.
    //
    // Best-effort, like the linking above: a release that fails is retried by the
    // next sign-in, and blocking the login over it would cost the user their
    // session for something they cannot act on. Skipped for a wallet sign-in for
    // the same reason the debt linking is — escrow rows are keyed by HANDLE, and
    // a wallet has no handle namespace.
    //
    // params.walletAddress is what the Privy route just linked. The OAuth routes
    // pass nothing and fall back to the row, which covers every RETURNING user —
    // and a brand-new one on the Circle stack still reads null here, because the
    // provisioning below runs after this. That costs a delay, not the money: the
    // row stays 'open' and the next sign-in releases it.
    try {
      await releaseEscrowForHandle(
        appUser.id,
        provider,
        appUser.handle,
        params.walletAddress ?? appUser.wallet_address,
      );
    } catch (releaseErr) {
      console.error("Escrow release failed (login continues):", releaseErr);
    }
  }

  // NO PRIVY WALLET IS MINTED HERE ANY MORE, and that is the point.
  //
  // This used to mint one — ours, owned and signed by our key quorum — because
  // login is the first moment we know who someone is. But no browser exists at
  // this point, so no key of THEIRS can exist either, and a wallet minted here is
  // necessarily one Splitsy could export. Every later ceremony was then a
  // handover, and a handover concedes the window was real.
  //
  // The wallet is now minted at first visit by POST /api/wallet/provision, from
  // keys the browser makes first, under a quorum we hold no member of. Between
  // signing in and finishing that, the user genuinely has no wallet: the routes
  // that answer "your wallet isn't provisioned yet" are telling the truth, and
  // app/XAuthControl.tsx shows the setup ceremony instead of the panel.
  //
  // THE PENDING WALLET IS NOT ADOPTED EITHER. A wallet pre-minted for a tagged
  // handle is one we hold the key to, so adopting it would hand the user a wallet
  // that was ours — the same problem in a different order. The provision route
  // SWEEPS it into their own wallet instead and abandons the address. The row is
  // therefore left in place here for that route to find.
  //
  // THE CIRCLE STACK STILL MINTS AT LOGIN, and must: it is the DEFAULT stack
  // (walletProviderName() answers "circle" for any unset WALLET_PROVIDER), and
  // /api/wallet/provision answers 404 there because a Circle DCW has no key a
  // browser could ever own. Removing this for both stacks left a Circle user with
  // no wallet and no route that would give them one. Nothing is conceded by
  // keeping it: on that stack Circle holds the keys either way, so there is no
  // window to close — the non-custodial story is Privy's alone.
  if (!appUser.wallet_address && walletProviderName() !== "privy") {
    try {
      // Prefer ADOPTING a wallet pre-minted when this handle was tagged on an
      // on-chain bill: that DCW may already hold an escrow position, so it has to
      // become this user's wallet. Only mint fresh when there is none.
      const pending = provider === "wallet" ? null : await getPendingWallet(provider, appUser.handle);
      if (pending) {
        await setUserWallet(appUser.id, pending.wallet_address, pending.circle_wallet_id);
        // Deleted by the row's OWN key rather than the session's provider: the
        // row is what proves this was a taggable identity in the first place.
        await deletePendingWallet(pending.provider, pending.handle);
      } else {
        const wallet = await getOrCreateWallet(provider, profile.providerUserId);
        if (wallet) await setUserWallet(appUser.id, wallet.address, wallet.walletId);
      }
    } catch (walletErr) {
      console.error("Wallet provisioning/adoption failed (login continues):", walletErr);
    }
  }

  const redirectPath = returnTo && returnTo.startsWith("/") ? returnTo : "/app";
  const response =
    mode === "json"
      ? NextResponse.json({ ok: true })
      : NextResponse.redirect(new URL(redirectPath, request.nextUrl.origin));
  // Untouched rather than cleared when setSession is false: the browser keeps the
  // session it already had. Clearing would be its own kind of sign-out.
  if (setSession) {
    response.cookies.set(SESSION_COOKIE_NAME, signSession(appUser.id, sessionSecret), {
      httpOnly: true,
      secure: request.nextUrl.protocol === "https:",
      sameSite: "lax",
      path: "/",
      maxAge: SESSION_MAX_AGE,
    });
  }
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
  backHref = "/app",
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
