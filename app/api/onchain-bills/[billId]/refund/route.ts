import { cookies } from "next/headers";
import { getSessionUser } from "@/lib/session";
import { verifyWalletUnlock, WALLET_UNLOCK_COOKIE } from "@/lib/session-core";
import { encodeRefund } from "@/lib/registry-calldata";
import { getSlotWalletsForUser } from "@/lib/pending-wallets-repo";
import { HandleBoundElsewhereError, refundSlotToOwner } from "@/lib/refund-slot";
import { handleHash } from "@/lib/handle-escrow";
import { slotForHandle } from "@/lib/handle-slot";
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

  // WHOSE CONTRIBUTION IS BEING REFUNDED — their own wallet's, or one of their
  // slots'. A bill created before this person signed in names the slot as the
  // participant, and refund() pays msg.sender, so their own wallet cannot call it.
  // The slots are checked second so a debt they can refund directly is never
  // shadowed by one they cannot.
  //
  // EVERY SLOT THIS ACCOUNT OWNS, because a handle rename leaves the old handle's
  // slot named on chain forever while `users.handle` moves on. Deriving one slot
  // from the current handle answered "you're not on this bill" for their own
  // money, and that money has no other exit: {refundSlot} pays the binding for
  // that exact hash and the registry has no reclaim.
  let participant = await getParticipantOnchain(id, me);
  let slot = null as Awaited<ReturnType<typeof getSlotWalletsForUser>>[number] | null;
  if (!participant.exists) {
    for (const candidate of await getSlotWalletsForUser(user).catch(() => [])) {
      const slotPart = await getParticipantOnchain(id, candidate.wallet_address as `0x${string}`);
      if (slotPart.exists) {
        participant = slotPart;
        slot = candidate;
        break;
      }
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
    // no key and never will, so there is nothing for them to sign. The handle is
    // bound to this wallet once (permanently), and {refundSlot} then pays the
    // binding with no signature and no destination parameter of its own.
    if (slot) {
      const hash = handleHash(slot.provider, slot.handle);

      // A LEGACY PRE-MINTED ROW IS NOT A DERIVED SLOT. Those rows name a Circle
      // DCW address that has no preimage, and {refundSlot} derives the slot from
      // the hash it is handed — so it would look up a participant that is not on
      // the bill. The table is documented as self-emptying tombstones that leave
      // on their owner's first login (lib/pending-wallets-repo.ts), so this is
      // unreachable in practice; it is an explicit error rather than a silent
      // NotParticipant revert if one ever survives.
      if (slotForHandle(slot.provider, slot.handle).toLowerCase() !== slot.wallet_address.toLowerCase()) {
        console.error("Legacy pre-minted slot cannot use refundSlot:", slot.provider, slot.handle);
        return Response.json(
          { error: "This refund needs a manual unwind — contact support with your bill id." },
          { status: 409 },
        );
      }

      const { txHash } = await refundSlotToOwner({
        registryAddress: REGISTRY_ADDRESS,
        billId: id,
        handleHash: hash,
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
    // The one cost of a write-once binding, in words the user can act on: the
    // money is not lost, it is payable to the wallet their handle was bound to.
    if (err instanceof HandleBoundElsewhereError) {
      return Response.json(
        {
          error: `This handle's refunds were already pointed at ${err.boundTo}, which cannot be changed. Sign in with that wallet to collect it.`,
          boundTo: err.boundTo,
        },
        { status: 409 },
      );
    }
    return Response.json({ error: err instanceof Error ? err.message : "refund failed" }, { status: 502 });
  }
}
