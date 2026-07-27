import { createSupabaseServerClient } from "../supabase.ts";

export type X402Direction = "earned" | "spent";

export async function recordPayment(p: {
  direction: X402Direction;
  endpoint: string;
  counterparty: string;
  amountUsdc: string;
  gatewayTx: string | null;
  billRef?: string | null;
  confidence?: number | null;
}): Promise<void> {
  const supabase = createSupabaseServerClient();
  if (!supabase) return; // no-DB dev mode: skip silently
  const { error } = await supabase.from("x402_payments").insert({
    direction: p.direction,
    endpoint: p.endpoint,
    counterparty: p.counterparty,
    amount_usdc: p.amountUsdc,
    gateway_tx: p.gatewayTx,
    bill_ref: p.billRef ?? null,
    confidence: p.confidence ?? null,
  });
  // Never throw: a ledger miss must not fail a payment that already settled.
  if (error) console.error("[x402] recordPayment failed:", error.message);
}

// Today's spend, used as the denominator of the daily cap.
//
// A read failure returns Infinity, not 0: this number gates real money, so an
// unreadable ledger must look like "cap exhausted" (Scout degrades to the
// unpaid direct parse) rather than "nothing spent yet" (Scout spends without a
// ceiling on every request). No DB configured at all is a different case — dev
// mode, where 0 lets the paid path be exercised.
export async function sumSpentTodayUsd(): Promise<number> {
  const supabase = createSupabaseServerClient();
  if (!supabase) return 0;
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  const { data, error } = await supabase
    .from("x402_payments")
    .select("amount_usdc")
    .eq("direction", "spent")
    .gte("created_at", since.toISOString());
  if (error || !data) {
    console.error("[x402] sumSpentTodayUsd failed, treating budget as spent:", error?.message);
    return Number.POSITIVE_INFINITY;
  }
  return data.reduce((sum, r) => sum + Number(r.amount_usdc), 0);
}

/**
 * The cumulative x402 ledger, or null when there is no database to read it
 * from. The distinction is not pedantic: these figures are shown as real money
 * on a public page, and "nothing has settled yet" and "we cannot see the
 * ledger" are different claims. Returning zeros for the second would let an
 * unconfigured deploy present fabricated figures as a live reading.
 */
export async function getAgentStats(): Promise<{
  earnedUsd: number;
  spentUsd: number;
  callsServed: number;
  callsPaid: number;
} | null> {
  const supabase = createSupabaseServerClient();
  if (!supabase) return null;
  const { data } = await supabase.from("x402_payments").select("direction, amount_usdc");
  const rows = (data ?? []) as Array<{ direction: X402Direction; amount_usdc: string }>;
  const sum = (d: X402Direction) =>
    rows.filter((r) => r.direction === d).reduce((s, r) => s + Number(r.amount_usdc), 0);
  return {
    earnedUsd: sum("earned"),
    spentUsd: sum("spent"),
    callsServed: rows.filter((r) => r.direction === "earned").length,
    callsPaid: rows.filter((r) => r.direction === "spent").length,
  };
}
