import { getAgentStats, listPayments, sumSpentTodayUsd } from "@/lib/x402/payments-repo";
import { remainingBudget } from "@/lib/x402/spend";
import { DAILY_CAP_USD } from "@/lib/scout/deps";
import { getScout } from "@/lib/scout/wallet";

export const runtime = "nodejs";

export async function GET() {
  // The individual payments behind the totals, so each one can be opened at
  // Circle's own receipt. Unlike the totals these include the internal
  // agent-to-agent trades: excluded from "earned" because nobody outside paid
  // it, but it is still a real settled payment and hiding it from the list
  // would make the ledger look shorter than the ledger is.
  const [stats, spentToday, recent] = await Promise.all([
    getAgentStats(),
    sumSpentTodayUsd(),
    listPayments(),
  ]);

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
    recent,
    agent: { address, tokenId: process.env.SCOUT_ERC8004_TOKEN_ID ?? null },
  });
}
