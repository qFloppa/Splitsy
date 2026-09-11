import { cookies } from "next/headers";
import { relayGuard } from "@/lib/privy-wallet";
import { getSessionUser } from "@/lib/session";
import { verifyWalletUnlock, WALLET_UNLOCK_COOKIE } from "@/lib/session-core";
import {
  InsufficientFundsError,
  prepareUserSignedTransfer,
  sendUserSignedTransfer,
  transferUsdc,
  walletProviderName,
} from "@/lib/wallet-provider";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Send USDC from the signed-in user's wallet to any Arc address. Requires an active
// wallet-unlock (via POST /api/wallet/unlock with the PIN) rather than a PIN per
// transfer.
//
// THREE BODY SHAPES, one gate. The gate runs first and once — session, provisioned,
// PIN unlock — and what differs afterwards is who signs:
//
//   {to, amount}                        the server signs with its own quorum. This
//                                       is the path every user without an export
//                                       password takes, and it is unchanged.
//   {to, amount, prepare: true}         returns the UNSIGNED transaction, for a
//                                       browser that holds an owner key.
//   {to, amount, transaction, signature}relays a transaction the USER authorized.
//
// The two-round-trip shape is forced, not chosen: the nonce and the gas are chain
// reads against an endpoint that may be keyed (ARC_TESTNET_RPC is env-driven for
// exactly that reason), so they cannot happen in a browser.
export async function POST(request: Request) {
  const user = await getSessionUser();
  if (!user) {
    return Response.json({ error: "Not signed in" }, { status: 401 });
  }
  if (!user.circle_wallet_id) {
    return Response.json({ error: "Your wallet isn't provisioned yet." }, { status: 409 });
  }

  const secret = process.env.SESSION_SECRET ?? "";
  const unlockToken = (await cookies()).get(WALLET_UNLOCK_COOKIE)?.value ?? "";
  if (verifyWalletUnlock(unlockToken, secret, Date.now()) !== user.id) {
    return Response.json({ error: "locked" }, { status: 403 });
  }

  const body = (await request.json().catch(() => null)) as {
    to?: unknown;
    amount?: unknown;
    prepare?: unknown;
    transaction?: unknown;
    signature?: unknown;
  } | null;
  const to = String(body?.to ?? "").trim();
  const amount = Number(body?.amount);

  if (!/^0x[a-fA-F0-9]{40}$/.test(to)) {
    return Response.json({ error: "Enter a valid Arc (0x…) address." }, { status: 400 });
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    return Response.json({ error: "Enter a positive amount." }, { status: 400 });
  }

  // A user-signed send is a Privy-only capability — Circle DCW keys are not
  // exportable, so no Circle user can hold an owner key to sign with. 404 rather
  // than 403, matching how the export route answers the same question
  // (app/api/wallet/export/route.ts:71-75): the capability does not exist here.
  const wantsUserSignature = body?.prepare === true || body?.transaction !== undefined;
  if (wantsUserSignature && walletProviderName() !== "privy") {
    return Response.json({ error: "Export is not available on this wallet stack." }, { status: 404 });
  }

  if (body?.prepare === true) {
    try {
      const prepared = await prepareUserSignedTransfer(user.circle_wallet_id, to, amount.toFixed(6));
      return Response.json({
        transaction: prepared.transaction,
        walletId: user.circle_wallet_id,
        // Not a secret: it is in every Privy request the browser's signature covers,
        // and the browser cannot build that signature without it.
        appId: process.env.PRIVY_APP_ID,
      });
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Could not prepare the transfer" }, { status: 502 });
    }
  }

  if (body?.transaction !== undefined) {
    const relaying = relayGuard(to, amount, body.transaction, body.signature);
    if ("error" in relaying) return Response.json({ error: relaying.error }, { status: 400 });
    try {
      const tx = await sendUserSignedTransfer(user.circle_wallet_id, relaying.transaction, relaying.signature);
      return done(tx, "you");
    } catch (err) {
      return failed(err);
    }
  }

  try {
    const tx = await transferUsdc(user.circle_wallet_id, to, amount.toFixed(6));
    return done(tx, "splitsy");
  } catch (err) {
    return failed(err);
  }
}

// THE BINDING CHECK lives in lib/privy-wallet.ts beside the calldata it re-encodes
// (relayGuard there, with the reasoning). Moved out of this file because a route
// that imports next/headers cannot be imported by a test — and this is the one check
// here whose absence would be silent, so it is the one that most needs one.

// Which signer produced the transaction, reported to the user. False precision
// either way — claiming a user signature for a quorum-signed send would make the
// trust claim unverifiable by the person it is for.
function done(tx: { id: string; state: string }, signedBy: "you" | "splitsy") {
  if (tx.state === "FAILED" || tx.state === "DENIED" || tx.state === "CANCELLED") {
    return Response.json({ error: `Transfer ${tx.state.toLowerCase()}` }, { status: 502 });
  }
  return Response.json({ ok: true, txId: tx.id, state: tx.state, signedBy });
}

function failed(err: unknown) {
  if (err instanceof InsufficientFundsError) {
    return Response.json({ error: "insufficient_funds" }, { status: 402 });
  }
  return Response.json({ error: err instanceof Error ? err.message : "Transfer failed" }, { status: 502 });
}
