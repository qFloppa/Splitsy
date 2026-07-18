import { cookies } from "next/headers";
import { getSessionUser } from "@/lib/session";
import { verifyWalletUnlock, WALLET_UNLOCK_COOKIE } from "@/lib/session-core";
import { encodeTabClaim } from "@/lib/registry-calldata";
import { executeContractOnArc } from "@/lib/circle-dcw";
import { verifyFactoryTab, getTabRecipientOnchain, getTabClaimableOnchain } from "@/lib/recurring-read";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isAddress(v: string): v is `0x${string}` {
  return /^0x[a-fA-F0-9]{40}$/.test(v);
}

// A social recipient (their Circle DCW created the tab) withdraws the tab's
// collected funds. RecurringTab.claim() sends the whole claimable balance to the
// immutable recipient — no amount argument. PIN-gated, like the one-off claim.
export async function POST(_request: Request, { params }: { params: Promise<{ tabAddress: string }> }) {
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

  if (!(await verifyFactoryTab(tabAddress))) {
    return Response.json({ error: "Not a recognized recurring tab." }, { status: 404 });
  }

  const recipient = await getTabRecipientOnchain(tabAddress);
  if (recipient.toLowerCase() !== (user.wallet_address as string).toLowerCase()) {
    return Response.json({ error: "You aren't the recipient of this tab." }, { status: 403 });
  }
  const claimable = await getTabClaimableOnchain(tabAddress);
  if (claimable <= 0n) return Response.json({ error: "Nothing to claim yet." }, { status: 409 });

  try {
    const tx = await executeContractOnArc(user.circle_wallet_id, tabAddress, encodeTabClaim());
    return Response.json({ ok: true, txHash: tx.txHash });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "claim failed" }, { status: 502 });
  }
}
