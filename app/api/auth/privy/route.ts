import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { finishProviderLogin } from "@/lib/oauth-callback";
import { deletePendingWallet, getPendingWallet } from "@/lib/pending-wallets-repo";
import { privyEmbeddedWallet, privyProfile, privyUserFromToken, upsertUserFromPrivy } from "@/lib/privy-identity";
import { insertPrivyWallet } from "@/lib/privy-wallets-repo";
import { setUserWallet } from "@/lib/users-repo";
import type { IdentityProvider } from "@/lib/types";
import { walletUiName } from "@/lib/wallet-provider";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The door on the Privy stack: a Privy access token in, a Splitsy session cookie
// out.
//
// WHY A ONE-TIME EXCHANGE RATHER THAN A PRIVY-TOKEN BRANCH IN getSessionUser().
// Around forty route handlers call getSessionUser(), and verifying a JWT against
// Privy's signing key on every one of them would put a network dependency in
// front of every request and expire the session every hour when the access token
// does. Exchanging once for the cookie the app already has leaves all forty
// untouched, keeps logout, the PIN unlock and the wallet-proof cookie working
// exactly as they do, and reuses finishProviderLogin's debt linking.
//
// NOTHING THE BROWSER SAYS IS TRUSTED. The token is the only input, it is
// verified against Privy before a field of it is read, and the identity comes
// from what Privy reports about that user — never from the request body. This is
// the mitigation for the risk Privy's own docs name: a client holding a valid
// token can reach Privy directly, so the server must decide who someone is.
export async function POST(request: NextRequest) {
  if (walletUiName() !== "privy") {
    // Not 403: with the app's own screens running, Privy login is not a thing a
    // caller could be forbidden from — it does not exist here.
    return Response.json({ error: "Privy sign-in is not available on this deployment." }, { status: 404 });
  }

  const sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret || sessionSecret.length < 32) {
    return Response.json({ error: "Sessions are not configured." }, { status: 502 });
  }

  const body = (await request.json().catch(() => null)) as { accessToken?: unknown } | null;
  const accessToken = typeof body?.accessToken === "string" ? body.accessToken : "";
  if (!accessToken) return Response.json({ error: "Expected a Privy access token." }, { status: 400 });

  const verified = await privyUserFromToken(accessToken).catch(() => null);
  if (!verified) return Response.json({ error: "That sign-in could not be verified." }, { status: 401 });

  const profile = privyProfile(verified.accounts);
  if (!profile) {
    // A Privy user with nothing Splitsy can key on — a wallet-only or passkey-only
    // login. Named plainly, because the remedy is to link one of the four.
    return Response.json(
      { error: "Link an X, Discord, Google or email account to your Privy login to use Splitsy." },
      { status: 409 },
    );
  }

  const appUser = await upsertUserFromPrivy(profile).catch(() => null);
  if (!appUser) return Response.json({ error: "Could not save your account." }, { status: 502 });

  // THE WALLET IS WHATEVER PRIVY SAYS IT IS. Not minted here, not swept, not
  // adopted by guesswork: the embedded wallet in Privy's own answer is the one the
  // browser can sign with, so it is the only address this row may point at. It
  // covers all three arrivals at once — a brand-new user whose wallet was created
  // at login, an existing Splitsy account getting its first embedded wallet, and a
  // stranger who was tagged before they joined and whose PREGENERATED wallet Privy
  // attached to their account on first login. Only the last one has a balance
  // already, and it needs no sweep because the address never changed hands.
  //
  // IT MAY NOT BE THERE YET, AND THAT IS NORMAL. `createOnLogin` builds the wallet
  // in the browser after authentication, so the first call of a fresh signup can
  // arrive before it exists. That is not an error and must not fail the login —
  // the caller sees `walletAddress: null`, and app/PrivyShell.tsx calls again once
  // Privy reports one. This route is idempotent precisely so it can.
  const wallet = privyEmbeddedWallet(verified.accounts);
  let linked: string | null = null;
  if (wallet) {
    try {
      // claimed_at is set from the first moment, and that is the honest record:
      // Splitsy is not a signer on an embedded wallet and never was, so
      // userMustSign (lib/user-signed.ts) has to answer true or every route would
      // send the server to Privy for a 401 it could have predicted.
      //
      // KEYED ON THE WALLET ID, not the Privy user id. The upsert ignores
      // duplicates, so a user-keyed row would be written once and then never
      // again — and a user whose embedded wallet is ever replaced would have
      // users.circle_wallet_id repointed while this row still named the old one.
      // getPrivyWalletByWalletId would then find nothing, userMustSign would read
      // the wallet as custodial, and the server would try to sign for a wallet it
      // holds no key to. Keying on the wallet means a new wallet is a new row.
      await insertPrivyWallet({
        namespace: "privy-ui",
        key: wallet.walletId,
        privy_user_id: verified.privyUserId,
        wallet_id: wallet.walletId,
        address: wallet.address.toLowerCase(),
        claimed_at: new Date().toISOString(),
        owner_kind: "privy_embedded",
      });
      await setUserWallet(appUser.id, wallet.address, wallet.walletId);
      linked = wallet.address.toLowerCase();

      // The pending row was a POINTER to this wallet, not a holding address, so
      // clearing it moves nothing. Only when the two agree: if they do not, the
      // pregenerated wallet is somewhere else and deleting the row would strand
      // whatever a bill already sent it.
      if (appUser.provider !== "wallet") {
        const pending = await getPendingWallet(appUser.provider as IdentityProvider, appUser.handle);
        if (pending && pending.wallet_address.toLowerCase() === wallet.address.toLowerCase()) {
          await deletePendingWallet(pending.provider, pending.handle);
        }
      }
    } catch (walletErr) {
      // Best-effort, exactly as the Circle stack's provisioning is: the session is
      // worth more than the wallet row, and the next sign-in re-runs all of this.
      console.error("Privy wallet link failed (login continues):", walletErr);
    }
  }

  // Reuses the shared tail — debt linking and the signed session cookie — so this
  // path and the OAuth ones cannot drift. The profile is passed again rather than
  // the row: upsertUserFromPrivy has already decided the key, and re-upserting
  // under it is what makes this idempotent.
  const loggedIn = await finishProviderLogin({
    provider: appUser.provider,
    profile: {
      providerUserId: appUser.provider_user_id,
      handle: profile.handle,
      name: profile.name,
      avatarUrl: profile.avatarUrl,
    },
    request,
    sessionSecret,
    mode: "json",
    // `linked` is null on the first call of a fresh signup — createOnLogin has not
    // built the wallet yet — and the escrow release no-ops on that. On the second
    // call, once Privy reports the address, it is what lets the release name a
    // real wallet instead of falling back to a row an earlier pass already wrote.
    walletAddress: linked,
  });

  // WHAT WAS LINKED, REPORTED BACK, and it is not decoration: it is the only thing
  // that tells the caller whether calling again would achieve anything. Without
  // it the bridge cannot distinguish "the wallet arrived, reload to show it" from
  // "still no wallet, reloading would just ask again" — and the second one is an
  // endless reload. Headers are carried over verbatim so the session cookie
  // finishProviderLogin just set survives being rewrapped.
  return NextResponse.json({ ok: true, walletAddress: linked }, { headers: loggedIn.headers });
}
