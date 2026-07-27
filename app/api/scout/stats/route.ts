import { getAgentStats, sumSpentTodayUsd } from "@/lib/x402/payments-repo";
import { remainingBudget } from "@/lib/x402/spend";
import { DAILY_CAP_USD } from "@/lib/scout/deps";
import { getScout } from "@/lib/scout/wallet";

export const runtime = "nodejs";

export async function GET() {
  const [stats, spentToday] = await Promise.all([getAgentStats(), sumSpentTodayUsd()]);

  // Unconfigured Scout still yields stats — the seller side earns whether or not
  // this instance runs a buyer.
  let address: string | null = null;
  try {
    address = getScout().address;
  } catch {
    address = null;
  }

  return Response.json({
    // getAgentStats() is null when Supabase is unconfigured, and spreading null
    // contributes no keys — so the ledger block is absent rather than zeroed.
    // Consumers must treat a missing figure as "unknown", never as 0.
    ...stats,
    dailyCapUsd: DAILY_CAP_USD,
    budgetRemainingUsd: remainingBudget(spentToday, DAILY_CAP_USD),
    agent: { address, tokenId: process.env.SCOUT_ERC8004_TOKEN_ID ?? null },
  });
}
