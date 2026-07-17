import { cookies } from "next/headers";
import { getSessionUser } from "@/lib/session";
import { getDebtForSettlement, markDebtPaid, markDebtSettling } from "@/lib/bills-repo";
import { transferUsdcOnArc, InsufficientFundsError } from "@/lib/circle-dcw";
import { verifyWalletUnlock, WALLET_UNLOCK_COOKIE } from "@/lib/session-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
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
    return Response.json({ error: "Payment already in flight — waiting for confirmation." }, { status: 409 });
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
    tx = await transferUsdcOnArc(user.circle_wallet_id, creatorWallet, debt.amount_usdc);
  } catch (err) {
    if (err instanceof InsufficientFundsError) {
      return Response.json({ error: "insufficient_funds" }, { status: 402 });
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
