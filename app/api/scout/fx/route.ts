import { buildScoutDeps, scoutBaseUrl } from "@/lib/scout/deps";
import { FX_PRICE } from "@/lib/scout/scan";
import { canSpend } from "@/lib/x402/spend";
import { quoteUsd } from "@/lib/fx-core";

export const runtime = "nodejs";

// Browser-facing currency quote. /api/fx itself is x402-paywalled, so Scout buys
// the quote here on the user's behalf — the same nanopayment an external agent
// would make. Falls back to the unpaid lookup whenever paying isn't possible, so
// hand-editing a currency in the UI can never dead-end on a payment problem.
export async function POST(request: Request) {
  const { amount, fromCurrency } = (await request.json()) as {
    amount?: number;
    fromCurrency?: string;
  };
  const numericAmount = Number(amount);

  if (!Number.isFinite(numericAmount) || numericAmount < 0) {
    return Response.json({ error: "Amount must be a non-negative number." }, { status: 400 });
  }

  try {
    const deps = buildScoutDeps(scoutBaseUrl(request));
    if (canSpend(await deps.spentTodayUsd(), FX_PRICE, deps.dailyCapUsd)) {
      const paid = await deps.pay("/api/fx", { amount: numericAmount, fromCurrency });
      await deps.record("spent", "/api/fx", paid.amountUsd, paid.tx);
      return Response.json({ ...paid.result, paid: { amountUsd: paid.amountUsd, tx: paid.tx } });
    }
  } catch {
    // Fall through to the unpaid lookup below.
  }

  try {
    return Response.json({ ...(await quoteUsd(numericAmount, fromCurrency)), degraded: true });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "FX conversion failed." },
      { status: 502 },
    );
  }
}
