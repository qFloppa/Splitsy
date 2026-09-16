import { cookies } from "next/headers";
import { after } from "next/server";
import { getSessionUser } from "@/lib/session";
import { verifyWalletUnlock, WALLET_UNLOCK_COOKIE } from "@/lib/session-core";
import { encodeApprove, encodePayDebt, encodePayDebtFor } from "@/lib/registry-calldata";
import { getSlotWalletForUser } from "@/lib/pending-wallets-repo";
import { prepareForUser, relayForUser, userMustSign, type UserSignedBody } from "@/lib/user-signed";
import { executeContract, InsufficientFundsError } from "@/lib/wallet-provider";
import {
  REGISTRY_ADDRESS,
  getParticipantOnchain,
  getUsdcAllowanceOnchain,
  usdcShortfallMessage,
} from "@/lib/arc-read";
import { recordPaidFeedbackSafely } from "@/lib/erc8004";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ARC_USDC_ADDRESS = (process.env.ARC_TESTNET_USDC_ADDRESS ??
  "0x3600000000000000000000000000000000000000") as `0x${string}`;

function isBillId(v: string): boolean {
  return /^[0-9]+$/.test(v);
}

// Pay a share of an on-chain bill: approve(registry, remaining), then
// payDebt(billId, remaining).
//
// TWO LEGS, AND THE CHAIN IS THE STATE MACHINE. When the user signs, each leg is
// its own prepare/sign/relay round trip — the second cannot be prepared before the
// first has mined, because its nonce follows it. Rather than track which leg a
// browser is on, the route READS THE ALLOWANCE and answers with whichever leg is
// outstanding. That is stateless, survives the request landing on another
// instance, and is self-correcting: a browser that dies after the approve resumes
// at payDebt, and one that retries the approve gets the payDebt it actually needs.
export async function POST(request: Request, { params }: { params: Promise<{ billId: string }> }) {
  const user = await getSessionUser();
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });

  const secret = process.env.SESSION_SECRET ?? "";
  const unlockToken = (await cookies()).get(WALLET_UNLOCK_COOKIE)?.value ?? "";
  if (verifyWalletUnlock(unlockToken, secret, Date.now()) !== user.id) {
    return Response.json({ error: "locked" }, { status: 403 });
  }
  if (!user.circle_wallet_id || !user.wallet_address) {
    return Response.json({ error: "Your wallet isn't provisioned yet. Log in again." }, { status: 409 });
  }

  const { billId } = await params;
  if (!isBillId(billId)) return Response.json({ error: "bad bill id" }, { status: 400 });

  // WHICH ADDRESS OWES THIS BILL — their wallet, or the slot a bill named before
  // they had one. Read from chain either way; never trust a client amount.
  //
  // The slot is checked only when the wallet is not a participant, so a user who
  // owes the same bill from both cannot have the slot silently shadow the debt they
  // can settle directly. Paying a slot's share is `payDebtFor(billId, slot, …)`:
  // permissionless by design, funded by THIS wallet's USDC, and credited to the
  // slot — so the approve leg, the balance check and the gas are all the user's own,
  // and nothing has to be signed by an address nobody spends from.
  const me = user.wallet_address as `0x${string}`;
  let debtor = me;
  let part = await getParticipantOnchain(BigInt(billId), me);
  if (!part.exists) {
    const slot = await getSlotWalletForUser(user).catch(() => null);
    if (slot) {
      const slotAddr = slot.wallet_address as `0x${string}`;
      const slotPart = await getParticipantOnchain(BigInt(billId), slotAddr);
      if (slotPart.exists) {
        debtor = slotAddr;
        part = slotPart;
      }
    }
  }
  if (!part.exists) return Response.json({ error: "You're not a participant on this bill." }, { status: 403 });
  const remaining = part.owed - part.paid;
  if (remaining <= 0n) return Response.json({ error: "Already paid" }, { status: 409 });

  // One encoder for both cases: paying your own share is just funding yourself, and
  // payDebtFor credits `debtor` exactly as payDebt credits msg.sender. Keeping a
  // single call shape means the leg logic, the ticket context and the server-signed
  // path below cannot drift between a wallet debt and a slot debt.
  const payCalldata = () =>
    debtor === me ? encodePayDebt(BigInt(billId), remaining) : encodePayDebtFor(BigInt(billId), debtor, remaining);

  // Before spending gas on a payDebt that would revert with nothing to say for
  // itself. Sent as the message, not the "insufficient_funds" sentinel, because
  // the sentinel's generic client-side text is the vagueness being fixed.
  const shortfall = await usdcShortfallMessage(user.wallet_address as `0x${string}`, remaining);
  if (shortfall) return Response.json({ error: shortfall }, { status: 402 });

  // ERC-8004 reputation: this wallet just paid its full share, which is the
  // consent that permits scoring it (lib/erc8004). Runs after the response —
  // two more txs (register + giveFeedback) must not delay the payment UI —
  // and never turns a succeeded payment into an error.
  const scoreAfterPayment = (txHash: string | null) => {
    if (!txHash || !user.circle_wallet_id || !user.wallet_address) return;
    const payerWalletId = user.circle_wallet_id;
    const payerAddress = user.wallet_address;
    after(() => recordPaidFeedbackSafely({ payerAddress, payerWalletId, billId, paymentTxHash: txHash }));
  };

  // ── The user signs ──────────────────────────────────────────────────────────
  if (await userMustSign(user.circle_wallet_id)) {
    const body = (await request.json().catch(() => null)) as UserSignedBody | null;

    // WHICH LEG, decided by the chain rather than by the client. An allowance
    // already covering the debt means the approve has mined and payDebt is next.
    // Re-read on every pass, so a relay that arrives after someone else's approve
    // still does the right thing.
    const allowance = await getUsdcAllowanceOnchain(user.wallet_address as `0x${string}`, REGISTRY_ADDRESS);
    const leg = allowance >= remaining ? "pay" : "approve";
    const [to, data] =
      leg === "pay"
        ? ([REGISTRY_ADDRESS, payCalldata()] as const)
        : ([ARC_USDC_ADDRESS, encodeApprove(REGISTRY_ADDRESS, remaining)] as const);
    // The leg is IN THE CONTEXT, so an approve ticket cannot be relayed as a
    // payDebt or the other way round — they are different calldata for the same
    // bill and the same user, which the other bindings would not separate.
    // The DEBTOR is in the context too: a ticket prepared to fund a slot must not
    // be relayable as a payment of the signer's own share, or the other way round.
    const context = `bill-pay:${billId}:${debtor}:${remaining.toString()}:${leg}`;

    if (body?.prepare === true) {
      try {
        // `leg` and `done` tell the browser whether to come back. The loop ends
        // when the debt is settled, which the guard above reports as 409.
        return Response.json({ ...(await prepareForUser({
          walletId: user.circle_wallet_id,
          userId: user.id,
          to,
          data,
          context,
        })), leg, legsRemaining: leg === "approve" ? 2 : 1 });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Could not prepare this payment." }, { status: 502 });
      }
    }

    if (body?.ticket !== undefined) {
      try {
        const relayed = await relayForUser({
          ticket: body.ticket,
          signature: body.signature,
          signedTransaction: body.signedTransaction,
          userId: user.id,
          walletId: user.circle_wallet_id,
          context,
        });
        if ("error" in relayed) return Response.json({ error: relayed.error }, { status: relayed.status });
        // Only the LAST leg is a payment. Scoring the approve would record a
        // reputation event for a transaction that moved nothing.
        if (leg === "pay") {
          scoreAfterPayment(relayed.tx.txHash);
          return Response.json({ ok: true, txHash: relayed.tx.txHash });
        }
        // The approve landed; the browser prepares again and the read above will
        // hand it payDebt.
        return Response.json({ ok: true, txHash: relayed.tx.txHash, more: true });
      } catch (err) {
        if (err instanceof InsufficientFundsError) return Response.json({ error: "insufficient_funds" }, { status: 402 });
        return Response.json({ error: err instanceof Error ? err.message : "payment failed" }, { status: 502 });
      }
    }

    return Response.json(
      { error: "This wallet is yours — enter your export password to sign this payment." },
      { status: 409 },
    );
  }

  // ── The server signs, exactly as before ─────────────────────────────────────
  // approve(registry, remaining) then payDebt(billId, remaining), both from the DCW.
  try {
    await executeContract(user.circle_wallet_id, ARC_USDC_ADDRESS, encodeApprove(REGISTRY_ADDRESS, remaining));
    const tx = await executeContract(user.circle_wallet_id, REGISTRY_ADDRESS, payCalldata());
    scoreAfterPayment(tx.txHash);
    return Response.json({ ok: true, txHash: tx.txHash });
  } catch (err) {
    if (err instanceof InsufficientFundsError) return Response.json({ error: "insufficient_funds" }, { status: 402 });
    return Response.json({ error: err instanceof Error ? err.message : "payment failed" }, { status: 502 });
  }
}
