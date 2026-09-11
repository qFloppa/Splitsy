import { cookies } from "next/headers";
import { getSessionUser } from "@/lib/session";
import { verifyWalletUnlock, WALLET_UNLOCK_COOKIE } from "@/lib/session-core";
import { encodeClaim } from "@/lib/registry-calldata";
import { userSignedLeg, type UserSignedBody } from "@/lib/user-signed";
import { executeContract } from "@/lib/wallet-provider";
import { REGISTRY_ADDRESS, getBillOnchain, getClaimableOnchain } from "@/lib/arc-read";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isBillId(v: string): boolean {
  return /^[0-9]+$/.test(v);
}

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

  // Only the splitter can claim, and only what's claimable.
  const bill = await getBillOnchain(BigInt(billId));
  if (bill.splitter.toLowerCase() !== (user.wallet_address as string).toLowerCase()) {
    return Response.json({ error: "You didn't create this bill." }, { status: 403 });
  }
  const claimable = await getClaimableOnchain(BigInt(billId));
  if (claimable <= 0n) return Response.json({ error: "Nothing to claim yet." }, { status: 409 });

  try {
    const data = encodeClaim(BigInt(billId), claimable);
    // A claimed wallet signs for itself. The claimable amount is re-read from
    // chain on both passes above, so the ticket binds an amount the client never
    // supplied — and the bill id in the context stops a ticket for one bill being
    // relayed against another.
    const signed = await userSignedLeg({
      body: (await request.json().catch(() => null)) as UserSignedBody | null,
      walletId: user.circle_wallet_id,
      userId: user.id,
      to: REGISTRY_ADDRESS,
      data,
      context: `bill-claim:${billId}`,
    });
    if (signed && "response" in signed) return signed.response;

    const tx = signed ? signed.tx : await executeContract(user.circle_wallet_id, REGISTRY_ADDRESS, data);
    return Response.json({ ok: true, txHash: tx.txHash });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "claim failed" }, { status: 502 });
  }
}
