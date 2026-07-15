import { cookies } from "next/headers";
import { getSessionUser } from "@/lib/session";
import { verifyWalletUnlock, WALLET_UNLOCK_COOKIE } from "@/lib/session-core";
import { encodeApprove, encodePayDebt } from "@/lib/registry-calldata";
import { executeContractOnArc, InsufficientFundsError } from "@/lib/circle-dcw";
import { REGISTRY_ADDRESS, getParticipantOnchain } from "@/lib/arc-read";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ARC_USDC_ADDRESS = process.env.ARC_TESTNET_USDC_ADDRESS ?? "0x3600000000000000000000000000000000000000";

function isBillId(v: string): boolean {
  return /^[0-9]+$/.test(v);
}

export async function POST(_request: Request, { params }: { params: Promise<{ billId: string }> }) {
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

  // Read the debt from chain — never trust a client amount.
  const part = await getParticipantOnchain(BigInt(billId), user.wallet_address as `0x${string}`);
  if (!part.exists) return Response.json({ error: "You're not a participant on this bill." }, { status: 403 });
  const remaining = part.owed - part.paid;
  if (remaining <= 0n) return Response.json({ error: "Already paid" }, { status: 409 });

  // approve(registry, remaining) then payDebt(billId, remaining), both from the DCW.
  try {
    await executeContractOnArc(user.circle_wallet_id, ARC_USDC_ADDRESS, encodeApprove(REGISTRY_ADDRESS, remaining));
    const tx = await executeContractOnArc(user.circle_wallet_id, REGISTRY_ADDRESS, encodePayDebt(BigInt(billId), remaining));
    return Response.json({ ok: true, txHash: tx.txHash });
  } catch (err) {
    if (err instanceof InsufficientFundsError) return Response.json({ error: "insufficient_funds" }, { status: 402 });
    return Response.json({ error: err instanceof Error ? err.message : "payment failed" }, { status: 502 });
  }
}
