import { cookies } from "next/headers";
import { getSessionUser } from "@/lib/session";
import { verifyWalletUnlock, WALLET_UNLOCK_COOKIE } from "@/lib/session-core";
import { encodeRefund } from "@/lib/registry-calldata";
import { getSlotWalletForUser } from "@/lib/pending-wallets-repo";
import { refundSlotToOwner } from "@/lib/refund-slot";
import { userSignedLeg, type UserSignedBody } from "@/lib/user-signed";
import { executeContract } from "@/lib/wallet-provider";
import { REGISTRY_ADDRESS, getBillOnchain, getParticipantOnchain } from "@/lib/arc-read";
import { refundableNow } from "@/lib/treasury";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isBillId(v: string): boolean {
  return /^[0-9]+$/.test(v);
}

// The payer's exit from a failed all-or-nothing bill. The registry enforces every
// precondition itself; the checks below exist only to turn a revert the user
// cannot read into a sentence they can.
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

  const id = BigInt(billId);
  const bill = await getBillOnchain(id);
  const me = user.wallet_address as `0x${string}`;

  // WHOSE CONTRIBUTION IS BEING REFUNDED — their own wallet's, or their slot's.
  // A bill created before this person signed in names the slot as the participant,
  // and refund() pays msg.sender, so their own wallet cannot call it. The slot is
  // checked second so a debt they can refund directly is never shadowed by one they
  // cannot.
  let participant = await getParticipantOnchain(id, me);
  let slot = null as Awaited<ReturnType<typeof getSlotWalletForUser>>;
  if (!participant.exists) {
    slot = await getSlotWalletForUser(user).catch(() => null);
    if (slot) {
      const slotPart = await getParticipantOnchain(id, slot.wallet_address as `0x${string}`);
      if (slotPart.exists) participant = slotPart;
      else slot = null;
    }
  }

  if (!participant.exists) {
    return Response.json({ error: "You're not on this bill." }, { status: 403 });
  }

  // Same predicate the UI uses to decide whether to offer the button, re-run
  // here because the button's inputs are as old as the page.
  const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
  const refundable = refundableNow(bill, participant.paid, nowSeconds);

  if (refundable <= 0n) {
    const reason = !bill.escrowUntilFull
      ? "This bill doesn't hold funds — your payment went to the creator when you made it."
      : bill.totalPaid >= bill.totalOwed
        ? "Everyone paid, so this bill went through. There's nothing to refund."
        : participant.paid <= 0n
          ? "You haven't paid anything into this bill."
          : "This bill hasn't reached its due date yet — it can still be completed.";
    return Response.json({ error: reason }, { status: 409 });
  }

  try {
    // A DERIVED SLOT'S REFUND GOES THROUGH THE REGISTRY, not the user. The slot has
    // no key and never will, so there is nothing for them to sign; {refundSlot} is
    // permissionless to call and authorized by an attester signature that binds
    // the recipient, so the money lands on their real wallet in one transaction
    // with nothing left behind at the slot.
    if (slot) {
      const { txHash } = await refundSlotToOwner({
        registryAddress: REGISTRY_ADDRESS,
        billId: id,
        slot: slot.wallet_address,
        to: me,
      });
      return Response.json({ ok: true, txHash, amount: refundable.toString() });
    }

    const data = encodeRefund(id);
    // A claimed wallet signs for itself. `refundable` is computed from chain state
    // on both passes above, so the relay cannot be handed a refund for a bill whose
    // conditions no longer hold.
    const signed = await userSignedLeg({
      body: (await request.json().catch(() => null)) as UserSignedBody | null,
      walletId: user.circle_wallet_id,
      userId: user.id,
      to: REGISTRY_ADDRESS,
      data,
      context: `bill-refund:${billId}`,
    });
    if (signed && "response" in signed) return signed.response;

    const tx = signed ? signed.tx : await executeContract(user.circle_wallet_id, REGISTRY_ADDRESS, data);
    return Response.json({ ok: true, txHash: tx.txHash, amount: refundable.toString() });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "refund failed" }, { status: 502 });
  }
}
