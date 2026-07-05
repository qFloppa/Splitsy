import { getSessionUser } from "@/lib/session";
import { getDebtForSettlement, markDebtPaid } from "@/lib/bills-repo";
import { transferUsdcOnArc } from "@/lib/circle-dcw";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) {
    return Response.json({ error: "Not signed in" }, { status: 401 });
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
    return Response.json(
      { error: err instanceof Error ? err.message : "Transfer failed" },
      { status: 502 },
    );
  }

  // ponytail: optimistic — mark paid once the transfer is accepted (not FAILED).
  // Arc settles fast on testnet; wire a Circle webhook to confirm COMPLETE if it matters.
  if (tx.state === "FAILED" || tx.state === "DENIED" || tx.state === "CANCELLED") {
    return Response.json({ error: `Transfer ${tx.state.toLowerCase()}` }, { status: 502 });
  }
  await markDebtPaid(id, tx.id);
  return Response.json({ ok: true, txId: tx.id, state: tx.state });
}
