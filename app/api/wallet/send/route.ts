import { cookies } from "next/headers";
import { getSessionUser } from "@/lib/session";
import { verifyWalletUnlock, WALLET_UNLOCK_COOKIE } from "@/lib/session-core";
import { prepareForUser, relayForUser, userMustSign } from "@/lib/user-signed";
import { InsufficientFundsError, transferUsdc, walletProviderName } from "@/lib/wallet-provider";
import { ARC_TESTNET_USDC } from "@/lib/x402/constants";
import { encodeFunctionData, erc20Abi, getAddress, parseUnits } from "viem";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Send USDC from the signed-in user's wallet to any Arc address. Requires an active
// wallet-unlock (via POST /api/wallet/unlock with the PIN) rather than a PIN per
// transfer.
//
// THREE BODY SHAPES, one gate. The gate runs first and once — session, provisioned,
// PIN unlock — and what differs afterwards is who signs:
//
//   {to, amount}                    the server signs with its own quorum. The path
//                                   every user whose wallet is still custodial takes.
//   {to, amount, prepare: true}     returns the unsigned transaction AND a ticket.
//   {to, amount, ticket, signature} relays the bytes the TICKET carries.
//
// The two-round-trip shape is forced, not chosen: the nonce and the gas are chain
// reads against an endpoint that may be keyed (ARC_TESTNET_RPC is env-driven for
// exactly that reason), so they cannot happen in a browser.
//
// THE TICKET REPLACED A RE-DERIVATION. This route used to verify a relayed
// transaction by re-encoding the calldata from {to, amount} and comparing. That was
// correct here and did not generalise — every other route would have needed its own
// version, and none of them checked the nonce or the gas at all. lib/tx-ticket.ts
// signs the prepared transaction instead, so the relay uses ITS OWN bytes and has
// nothing to compare. See that file for why this is the stronger check.
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
    ticket?: unknown;
    signature?: unknown;
    signedTransaction?: unknown;
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
  const wantsUserSignature = body?.prepare === true || body?.ticket !== undefined;
  if (wantsUserSignature && walletProviderName() !== "privy") {
    return Response.json({ error: "Export is not available on this wallet stack." }, { status: 404 });
  }

  // The amount is re-encoded here on BOTH passes and never taken from a client
  // transaction — the ticket then binds these exact bytes.
  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: "transfer",
    args: [getAddress(to), parseUnits(amount.toFixed(6), 6)],
  });
  // A bare transfer has no row to bind to, so the context IS the payment: this
  // recipient, this amount. A ticket prepared to send 1 USDC to A cannot be
  // relayed as a request to send 1 USDC to B — the transaction would not match.
  const context = `send:${to.toLowerCase()}:${amount.toFixed(6)}`;

  if (body?.prepare === true) {
    try {
      return Response.json(
        await prepareForUser({ walletId: user.circle_wallet_id, userId: user.id, to: ARC_TESTNET_USDC, data, context }),
      );
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Could not prepare the transfer" }, { status: 502 });
    }
  }

  if (body?.ticket !== undefined) {
    const relayed = await relayForUser({
      ticket: body.ticket,
      signature: body.signature,
      signedTransaction: body.signedTransaction,
      userId: user.id,
      walletId: user.circle_wallet_id,
      context,
    }).catch((err) => err as Error);
    if (relayed instanceof Error) return failed(relayed);
    if ("error" in relayed) return Response.json({ error: relayed.error }, { status: relayed.status });
    return done(relayed.tx, "you");
  }

  // A CLAIMED wallet cannot take this path — the server has no key and Privy would
  // refuse. Told plainly rather than left to surface as a 502 from the attempt,
  // because the remedy is the user signing, not a retry.
  if (await userMustSign(user.circle_wallet_id)) {
    return Response.json(
      { error: "This wallet is yours — enter your export password to sign this send." },
      { status: 409 },
    );
  }

  try {
    const tx = await transferUsdc(user.circle_wallet_id, to, amount.toFixed(6));
    return done(tx, "splitsy");
  } catch (err) {
    return failed(err);
  }
}

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
