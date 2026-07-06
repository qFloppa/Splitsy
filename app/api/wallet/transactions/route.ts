import { getSessionUser } from "@/lib/session";
import { listWalletTransactions } from "@/lib/circle-dcw";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EXPLORER = process.env.ARC_TESTNET_EXPLORER_URL ?? "https://testnet.arcscan.app";

export async function GET() {
  const user = await getSessionUser();
  if (!user) {
    return Response.json({ error: "Not signed in" }, { status: 401 });
  }
  if (!user.circle_wallet_id || !user.wallet_address) {
    return Response.json({ transactions: [] });
  }

  try {
    const txs = await listWalletTransactions(user.circle_wallet_id, user.wallet_address);
    return Response.json({ transactions: txs, explorer: EXPLORER });
  } catch {
    return Response.json({ transactions: [] });
  }
}
