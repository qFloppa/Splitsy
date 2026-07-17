import { formatUnits } from "viem";
import { getSessionUser } from "@/lib/session";
import { listWalletTransactions, type WalletTx } from "@/lib/circle-dcw";
import { readUsdcMovedInTx } from "@/lib/arc-read";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EXPLORER = process.env.ARC_TESTNET_EXPLORER_URL ?? "https://testnet.arcscan.app";

// Circle reports contract executions (approve / payDebt / claim) with no
// `amounts`, so those rows would render as $0 in the wallet history. For any
// mined zero-amount row, recover the real USDC moved from the tx receipt's
// Transfer logs — and fix the direction too (a claim() is "outbound" to Circle
// but the wallet *receives* USDC). Pure approvals move nothing and are dropped.
async function enrich(txs: WalletTx[], wallet: `0x${string}`): Promise<WalletTx[]> {
  const out = await Promise.all(
    txs.map(async (t) => {
      if (Number(t.amount) > 0 || !t.txHash) return t;
      try {
        const { sent, received } = await readUsdcMovedInTx(t.txHash as `0x${string}`, wallet);
        const net = received - sent;
        if (net === 0n) return null; // approve-only tx: no funds moved, skip the row
        return {
          ...t,
          direction: net > 0n ? ("in" as const) : ("out" as const),
          amount: formatUnits(net > 0n ? net : -net, 6),
        };
      } catch {
        return t; // receipt not available (yet) — keep the raw row
      }
    }),
  );
  return out.filter((t): t is WalletTx => t !== null);
}

export async function GET() {
  const user = await getSessionUser();
  if (!user) {
    return Response.json({ error: "Not signed in" }, { status: 401 });
  }
  if (!user.circle_wallet_id || !user.wallet_address) {
    return Response.json({ transactions: [] });
  }

  try {
    const txs = await listWalletTransactions(user.circle_wallet_id);
    const transactions = await enrich(txs, user.wallet_address as `0x${string}`);
    return Response.json({ transactions, explorer: EXPLORER });
  } catch {
    return Response.json({ transactions: [] });
  }
}
