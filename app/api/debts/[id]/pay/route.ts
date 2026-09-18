import { cookies } from "next/headers";
import { getSessionUser } from "@/lib/session";
import { getDebtForSettlement, markDebtPaid, markDebtSettling, revertDebtByTxId } from "@/lib/bills-repo";
import { prepareForUser, relayForUser, userMustSign } from "@/lib/user-signed";
import {
  broadcastTxHash,
  isBroadcast,
  settlingVerdict,
  transferUsdc,
  txFate,
  InsufficientFundsError,
} from "@/lib/wallet-provider";
import { verifyWalletUnlock, WALLET_UNLOCK_COOKIE } from "@/lib/session-core";
import { encodeFunctionData, erc20Abi, getAddress, parseUnits } from "viem";
import { ARC_USDC } from "@/lib/x402/constants";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Pay a debt from the debtor's own wallet.
//
// TWO SIGNERS, ONE SET OF GUARDS. A custodial wallet is signed by the server, as
// it always was. A CLAIMED wallet has no server key at all, so the payment becomes
// prepare → the browser signs → relay, and this route is entered twice for one
// payment. Everything above the send runs on BOTH passes — the debt must still be
// unpaid, still this user's, still not in flight when the relay arrives — because
// minutes can pass between the two and the second visit is the one that spends.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) {
    return Response.json({ error: "Not signed in" }, { status: 401 });
  }

  // Spending requires an active wallet unlock (PIN entered within the last 5
  // minutes). This is the second factor a hijacked X login alone can't satisfy.
  const secret = process.env.SESSION_SECRET ?? "";
  const unlockToken = (await cookies()).get(WALLET_UNLOCK_COOKIE)?.value ?? "";
  if (verifyWalletUnlock(unlockToken, secret, Date.now()) !== user.id) {
    return Response.json({ error: "locked" }, { status: 403 });
  }

  const { id } = await params;
  const debt = await getDebtForSettlement(id);
  if (!debt) {
    return Response.json({ error: "Debt not found" }, { status: 404 });
  }
  if (debt.debtor_user_id !== user.id) {
    return Response.json({ error: "This isn't your debt to pay" }, { status: 403 });
  }
  if (debt.status === "paid") {
    return Response.json({ error: "Already paid" }, { status: 409 });
  }
  if (debt.status === "settling") {
    // NOTHING ELSE FLIPS settling → paid ON THE PRIVY STACK. /api/webhooks/circle is
    // what does that, and no webhook is coming for a Privy transfer
    // (docs/deployments.md:63-69) — so without this re-read, the guard that stops a
    // second press would be a dead end for the debt the catch below now parks here
    // on purpose.
    //
    // txFate answers off the SHAPE of the stored reference, not off WALLET_PROVIDER:
    // the circle stack stores a Circle transaction UUID, which is not 0x + 64 hex, so
    // it answers "unknown" with no RPC call and no backend loaded, keeps this 409
    // exactly as it is, and leaves its webhook the only thing that resolves one.
    const ref = debt.paid_tx_hash ?? "";
    const verdict = settlingVerdict(await txFate(ref));
    if (verdict === "paid") {
      // Confirmed on chain. Record it rather than asking the user to press Pay for a
      // debt that is settled — the same answer the branch above gives, because by now
      // it is the same fact.
      await markDebtPaid(id, ref);
      return Response.json({ error: "Already paid" }, { status: 409 });
    }
    if (verdict === "wait") {
      return Response.json({ error: "Payment already in flight — waiting for confirmation." }, { status: 409 });
    }
    // "retry": mined and reverted, or its nonce spent by different bytes. Either way
    // nothing moved and nothing ever will, so clear the reference — the webhook's own
    // repair, keyed on the same column — and let this press pay.
    await revertDebtByTxId(ref);
  }

  const creatorWallet = debt.bill?.creator?.wallet_address;
  if (!creatorWallet) {
    return Response.json({ error: "The bill creator has no wallet yet." }, { status: 409 });
  }
  if (!user.circle_wallet_id) {
    return Response.json({ error: "Your wallet isn't provisioned yet. Log in again." }, { status: 409 });
  }

  let tx: { id: string; state: string };
  try {
    // WHO SIGNS. A claimed wallet has no server key — Privy refuses us outright —
    // so the payment runs as prepare/sign/relay with the user's own key. The debt
    // guards above have already run on this pass either way, which is what makes
    // it safe for the relay to be a second entry into this handler.
    if (await userMustSign(user.circle_wallet_id)) {
      const body = (await request.json().catch(() => null)) as
        | { prepare?: unknown; ticket?: unknown; signature?: unknown; signedTransaction?: unknown }
        | null;

      // The amount is re-read from the debt row on BOTH passes and never taken
      // from the client, exactly as it was when the server signed. The ticket then
      // binds these bytes, so the relay cannot be handed a different transfer.
      const data = encodeFunctionData({
        abi: erc20Abi,
        functionName: "transfer",
        args: [getAddress(creatorWallet), parseUnits(String(debt.amount_usdc), 6)],
      });

      if (body?.prepare === true) {
        return Response.json(
          await prepareForUser({
            walletId: user.circle_wallet_id,
            userId: user.id,
            to: ARC_USDC,
            data,
            // The debt id, so a ticket prepared for one debt cannot be relayed
            // while another is marked paid. This is the binding that a shared
            // relay helper cannot infer for itself.
            context: `debt:${id}`,
          }),
        );
      }

      const relayed = await relayForUser({
        ticket: body?.ticket,
        signature: body?.signature,
        signedTransaction: body?.signedTransaction,
        userId: user.id,
        walletId: user.circle_wallet_id,
        context: `debt:${id}`,
      });
      if ("error" in relayed) return Response.json({ error: relayed.error }, { status: relayed.status });
      tx = relayed.tx;
    } else {
      tx = await transferUsdc(user.circle_wallet_id, creatorWallet, debt.amount_usdc);
    }
  } catch (err) {
    if (err instanceof InsufficientFundsError) {
      return Response.json({ error: "insufficient_funds" }, { status: 402 });
    }
    // BROADCAST BUT UNCONFIRMED — the transfer may still mine. A 502 here leaves the
    // debt `pending`, so the user presses Pay again, and this route has NO on-chain
    // idempotency to stop the second one: autopay re-reads getParticipantOnchain
    // first, while a bare transfer carries only an amount and a recipient, so nothing
    // downstream can tell a duplicate from a second real payment. Parking it in
    // `settling` puts it behind the guard above, which re-reads the hash on the next
    // press and finishes the job whichever way it went.
    //
    // Gated on the HASH, not on the tag: the circle backend tags its poll failure the
    // same way but has no chain hash to attach (lib/circle-dcw.ts:145), so that stack
    // keeps this 502, keeps the debt pending, and keeps its webhook as the only thing
    // that ever writes `settling`.
    const inFlight = isBroadcast(err) ? broadcastTxHash(err) : null;
    if (inFlight) {
      // A failed write must not become a 500 that says nothing. The user has to hear
      // that money may have left, or they will press Pay again for certain.
      await markDebtSettling(id, inFlight).catch((e) => {
        console.error(`pay: could not park debt ${id} as settling for tx ${inFlight}:`, e);
      });
      return Response.json(
        {
          error: "Payment sent but not confirmed yet — it may still land. Give it a moment and reload.",
          settling: true,
          txHash: inFlight,
        },
        { status: 409 },
      );
    }
    return Response.json(
      { error: err instanceof Error ? err.message : "Transfer failed" },
      { status: 502 },
    );
  }

  if (tx.state === "FAILED" || tx.state === "DENIED" || tx.state === "CANCELLED") {
    return Response.json({ error: `Transfer ${tx.state.toLowerCase()}` }, { status: 502 });
  }

  // With webhooks: mark "settling" now and let /api/webhooks/circle flip it to
  // paid on COMPLETE (or back to pending on FAILED). Without them (local dev,
  // no public URL for Circle to call): the old optimistic mark, since nothing
  // would ever deliver the confirmation.
  if (process.env.CIRCLE_WEBHOOKS_ENABLED === "true") {
    await markDebtSettling(id, tx.id);
    return Response.json({ ok: true, txId: tx.id, state: tx.state, settling: true });
  }
  await markDebtPaid(id, tx.id);
  return Response.json({ ok: true, txId: tx.id, state: tx.state });
}
