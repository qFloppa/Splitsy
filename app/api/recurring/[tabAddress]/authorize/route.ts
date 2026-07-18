import { cookies } from "next/headers";
import { getSessionUser } from "@/lib/session";
import { verifyWalletUnlock, WALLET_UNLOCK_COOKIE } from "@/lib/session-core";
import { encodeApprove } from "@/lib/registry-calldata";
import { executeContractOnArc, InsufficientFundsError } from "@/lib/circle-dcw";
import { verifyFactoryTab, getTabMemberStandingOnchain } from "@/lib/recurring-read";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ARC_USDC_ADDRESS = (process.env.ARC_TESTNET_USDC_ADDRESS ??
  "0x3600000000000000000000000000000000000000") as `0x${string}`;

function isAddress(v: string): v is `0x${string}` {
  return /^0x[a-fA-F0-9]{40}$/.test(v);
}

// A social member's Circle DCW approves a recurring tab to pull their per-cycle
// USDC share. Approval is capped to what they can still ever owe on this tab
// (fixedShare * maxSettlements - collected), so the server never grants an
// allowance larger than the member's own committed exposure. PIN-gated, like
// the one-off pay route. Pass { revoke: true } to set the allowance to 0.
export async function POST(request: Request, { params }: { params: Promise<{ tabAddress: string }> }) {
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

  const { tabAddress } = await params;
  if (!isAddress(tabAddress)) return Response.json({ error: "bad tab address" }, { status: 400 });

  const body = (await request.json().catch(() => ({}))) as { revoke?: unknown };
  const revoke = body?.revoke === true;

  // Only ever act on a tab OUR factory deployed — never an arbitrary contract.
  if (!(await verifyFactoryTab(tabAddress))) {
    return Response.json({ error: "Not a recognized recurring tab." }, { status: 404 });
  }

  const standing = await getTabMemberStandingOnchain(tabAddress, user.wallet_address as `0x${string}`);
  if (!standing.isMember) {
    return Response.json({ error: "You're not a member of this tab." }, { status: 403 });
  }

  // Revoke → 0. Otherwise approve exactly the member's remaining lifetime debt,
  // so the tab can collect every outstanding cycle without over-approving.
  const amount = revoke ? 0n : standing.remainingTotal;
  if (!revoke && amount <= 0n) {
    return Response.json({ error: "Nothing left to authorize — this tab is fully paid." }, { status: 409 });
  }

  try {
    const tx = await executeContractOnArc(user.circle_wallet_id, ARC_USDC_ADDRESS, encodeApprove(tabAddress, amount));
    return Response.json({ ok: true, txHash: tx.txHash });
  } catch (err) {
    if (err instanceof InsufficientFundsError) return Response.json({ error: "insufficient_funds" }, { status: 402 });
    return Response.json({ error: err instanceof Error ? err.message : "authorize failed" }, { status: 502 });
  }
}
