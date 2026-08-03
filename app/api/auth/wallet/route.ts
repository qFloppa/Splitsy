// Sign in with a browser wallet — an account minted from a signature instead of
// an OAuth round trip.
//
// Why an account is needed at all, when the wallet is right there: the settlement
// agent is per ACCOUNT, never per wallet. Its Circle wallet is derived from refId
// 'agent:<user.id>' (lib/user-agent.ts), its caps and its decision log are one
// autopay_grants row keyed on user_id, and every /api/agents/* route reads the
// session cookie. A connected wallet with no users row had nowhere to hang any of
// that, so the Agents tab could only tell it to go away. Everything downstream is
// unchanged by this route, because all of it keys on user.id.
//
// ONE AGENT PER WALLET is the invariant, and autopay_grants_debtor_idx — the
// partial unique index that already stops two accounts linking one address — is
// what holds it. A wallet that a social account has already linked is REFUSED
// here rather than handed a second account, with a second agent and a second
// balance to fund. That is the exact confusion linking exists to prevent.
import type { NextRequest } from "next/server";
import { getGrantsByDebtorAddresses, setGrantDebtorAddress } from "@/lib/agents-repo";
import { verifySigninSignature } from "@/lib/agent-link";
import { finishProviderLogin } from "@/lib/oauth-callback";
import { getSessionUser, signWalletProof, WALLET_PROOF_COOKIE, WALLET_PROOF_TTL } from "@/lib/session";
import { getOrCreateUserAgent } from "@/lib/user-agent";
import { getUserById, getUserByProviderHandle } from "@/lib/users-repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret || sessionSecret.length < 32) {
    return Response.json({ error: "Sign-in is not configured on this deployment." }, { status: 500 });
  }

  const body = (await request.json().catch(() => null)) as {
    address?: unknown;
    message?: unknown;
    signature?: unknown;
  } | null;
  if (!body) return Response.json({ error: "Expected a JSON body." }, { status: 400 });

  const address = String(body.address ?? "").toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(address)) {
    return Response.json({ error: "Expected a 0x wallet address." }, { status: 400 });
  }

  // The signature is the whole credential here — it is what makes this address
  // an account rather than a claim — so it is checked before anything is
  // written. The message is rebuilt from the address in the body, so the only
  // thing the client chooses is the timestamp.
  const verdict = await verifySigninSignature({
    address,
    message: String(body.message ?? ""),
    signature: String(body.signature ?? ""),
    nowMs: Date.now(),
  });
  if (!verdict.ok) return Response.json({ error: verdict.error }, { status: 400 });

  // Already somebody's linked wallet? Then an agent already covers its bills,
  // and it is on the other account. Refuse rather than mint a rival — and refuse
  // BEFORE the upsert, so a rejected sign-in leaves no stray row behind.
  //
  // Not a sign-in path for that account either: linking proved control of the
  // wallet to widen an account's reach, which is not consent for the key to
  // become a login for the social identity behind it.
  const owner = (await getGrantsByDebtorAddresses([address])).get(address);
  if (owner) {
    const holder = await getUserById(owner.userId).catch(() => null);
    const isOwnAccount = holder?.provider === "wallet" && holder.provider_user_id === address;
    if (holder && !isOwnAccount) {
      return Response.json(
        {
          error:
            `That wallet is already linked to a Splitsy account on ${holder.provider}. Sign in there — ` +
            `its agent already settles this wallet's bills.`,
        },
        { status: 409 },
      );
    }
  }

  // KEEP A SOCIAL SESSION. There is one session cookie, so signing this wallet in
  // would evict whatever it held — and someone whose social login is live is not
  // asking to be signed out of it. They are on the Agents tab, where a wallet
  // with no account of its own has no agent to show, and this is what gives it
  // one. The account is created either way; only the cookie differs.
  //
  // A WALLET session is replaced as normal: there is no second identity to
  // preserve, and the extension has already moved on to another address.
  const current = await getSessionUser().catch(() => null);
  const keepSession = !!current && current.provider !== "wallet";

  const response = await finishProviderLogin({
    provider: "wallet",
    // The address is both the id and the handle: it is the only name this
    // account has. providerDisplay shortens it for rendering.
    profile: { providerUserId: address, handle: address, name: null, avatarUrl: null },
    request,
    sessionSecret,
    mode: "json",
    setSession: !keepSession,
  });
  if (response.status !== 200) return response;

  // The signing address is this account's debtor address too. Written through
  // the SAME helper the link route uses, so the agent resolves these bills by
  // exactly the path it already resolves a linked wallet's — no second lookup in
  // the autopay route, and the unique index keeps holding the invariant.
  //
  // Re-run on every sign-in, not just the first: it is an idempotent upsert, so
  // a failure here self-heals the next time they sign in rather than leaving the
  // agent permanently blind to this wallet's bills.
  const user = await getUserByProviderHandle("wallet", address).catch(() => null);
  if (user) {
    await setGrantDebtorAddress(user.id, address).catch((err) => {
      console.error("wallet signin: could not record the debtor address (login continues):", err);
    });
    // Give the new account its agent NOW, on the keep-session path only. The
    // caller is the Agents tab, which is about to ask for this account's agent by
    // address — and that read deliberately never creates one for an account it is
    // not signed in as, so without this the card would still say "no agent" after
    // a signature the user just gave. An ordinary sign-in needs none of this: its
    // own next GET /api/agents/wallet creates the agent, as it always has.
    if (keepSession) {
      await getOrCreateUserAgent(user).catch((err) => {
        console.error("wallet signin: could not create the agent wallet (account exists):", err);
      });
      // The proof that lets the Agents tab show this account beside the session's
      // — its agent, its balance and its decisions. Issued HERE because this is
      // where the signature was verified: everything downstream then reads a
      // cookie instead of trusting an address from a client, which is the
      // difference between evidence and a claim about someone else's log.
      response.cookies.set(
        WALLET_PROOF_COOKIE,
        signWalletProof(user.id, Date.now() + WALLET_PROOF_TTL * 1000, sessionSecret),
        {
          httpOnly: true,
          secure: request.nextUrl.protocol === "https:",
          sameSite: "lax",
          path: "/",
          maxAge: WALLET_PROOF_TTL,
        },
      );
    }
  }

  return response;
}
