import { cookies } from "next/headers";
import { getSessionUser } from "@/lib/session";
import { verifyWalletUnlock, WALLET_UNLOCK_COOKIE } from "@/lib/session-core";
import { isShareToken } from "@/lib/pay-link";
import { getPreimageByShareToken } from "@/lib/onchain-bill-preimage-repo";
import { encodeApprove, encodePayDebtFor } from "@/lib/registry-calldata";
import { executeContractOnArc, InsufficientFundsError } from "@/lib/circle-dcw";
import { REGISTRY_ADDRESS, getParticipantsOnchain } from "@/lib/arc-read";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 1 approval + up to MAX_ROWS legs, each polled sequentially by
// executeContractOnArc. The default budget can kill this mid-batch AFTER money
// has moved, returning no `results` at all. Mirrors app/api/agents/autopay.
export const maxDuration = 300;

const ARC_USDC_ADDRESS = process.env.ARC_TESTNET_USDC_ADDRESS ?? "0x3600000000000000000000000000000000000000";
const MAX_ROWS = 20;

// POST /api/pay/<token>/social — cover other people's shares from the caller's
// Circle wallet. The client names WHO to cover; the amounts come from chain.
//
// No ERC-8004 feedback here, unlike /api/onchain-bills/[billId]/pay. That route
// scores a wallet for settling its OWN share, where the payment is the debtor's
// consent to be scored. Paying on someone's behalf is not their consent and is
// not their creditworthiness.
export async function POST(request: Request, ctx: RouteContext<"/api/pay/[token]/social">) {
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

  const { token } = await ctx.params;
  if (!isShareToken(token)) return Response.json({ error: "not_found" }, { status: 404 });

  const body = (await request.json().catch(() => null)) as { debtors?: unknown } | null;
  const requested = Array.isArray(body?.debtors) ? body.debtors : null;
  if (!requested || requested.length === 0) {
    return Response.json({ error: "Pick at least one person to cover." }, { status: 400 });
  }
  if (requested.length > MAX_ROWS) {
    return Response.json({ error: `Cover at most ${MAX_ROWS} people at a time.` }, { status: 400 });
  }
  if (!requested.every((d): d is string => typeof d === "string" && /^0x[0-9a-fA-F]{40}$/.test(d))) {
    return Response.json({ error: "bad debtor address" }, { status: 400 });
  }
  // De-duplicate before reading: the same address twice would pay the first
  // leg, then revert the second on a now-zero remaining and report a failure
  // for a row that is actually settled.
  const debtors = [...new Map(requested.map((d) => [d.toLowerCase(), d])).values()] as `0x${string}`[];

  const preimage = await getPreimageByShareToken(token);
  if (!preimage) return Response.json({ error: "not_found" }, { status: 404 });
  // Same stale-registry guard as the read route: a v1 token must not be able to
  // aim a payment at a different bill that happens to share its id.
  if (preimage.registryAddress.toLowerCase() !== REGISTRY_ADDRESS.toLowerCase()) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  const billId = BigInt(preimage.billId);

  // Amounts come from chain, never from the client.
  const reads = await getParticipantsOnchain(debtors.map((addr) => ({ billId, addr })));
  const legs: { address: `0x${string}`; amount: bigint }[] = [];
  for (const [i, addr] of debtors.entries()) {
    const read = reads[i];
    if (!read || !read.exists) continue;
    const remaining = read.owed > read.paid ? read.owed - read.paid : 0n;
    if (remaining > 0n) legs.push({ address: addr, amount: remaining });
  }
  if (legs.length === 0) {
    return Response.json({ error: "Those shares are already settled." }, { status: 409 });
  }

  const total = legs.reduce((sum, leg) => sum + leg.amount, 0n);

  // One approval covering every leg, then one payDebtFor per person. The
  // registry has no batch pay-for-others: settle() batches, but its pay loop is
  // hardcoded to msg.sender's own debts (BillSplitRegistry.sol:589).
  try {
    await executeContractOnArc(user.circle_wallet_id, ARC_USDC_ADDRESS, encodeApprove(REGISTRY_ADDRESS, total));
  } catch (err) {
    if (err instanceof InsufficientFundsError) return Response.json({ error: "insufficient_funds" }, { status: 402 });
    return Response.json({ error: err instanceof Error ? err.message : "approval failed" }, { status: 502 });
  }

  // Sequential, and each leg reports its own outcome. A failure partway through
  // leaves the earlier legs paid — which is the truth, so it is what we return
  // rather than a single ok/failed for the whole batch.
  const results: { address: string; ok: boolean; txHash?: string; error?: string }[] = [];
  for (const leg of legs) {
    try {
      const tx = await executeContractOnArc(
        user.circle_wallet_id,
        REGISTRY_ADDRESS,
        encodePayDebtFor(billId, leg.address, leg.amount),
      );
      results.push({ address: leg.address, ok: true, txHash: tx.txHash ?? undefined });
    } catch (err) {
      results.push({
        address: leg.address,
        ok: false,
        error: err instanceof InsufficientFundsError ? "insufficient_funds" : err instanceof Error ? err.message : "payment failed",
      });
    }
  }

  return Response.json({ results });
}
