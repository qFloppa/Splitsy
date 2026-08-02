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

export type PaymentRow = {
  direction: X402Direction;
  endpoint: string;
  counterparty: string;
  amountUsdc: number;
  gatewayTx: string | null;
  billRef: string | null;
  createdAt: string;
};

const toPaymentRow = (r: Record<string, unknown>): PaymentRow => ({
  direction: r.direction as X402Direction,
  endpoint: String(r.endpoint),
  counterparty: String(r.counterparty),
  amountUsdc: Number(r.amount_usdc),
  gatewayTx: (r.gateway_tx as string | null) ?? null,
  billRef: (r.bill_ref as string | null) ?? null,
  createdAt: String(r.created_at),
});

const PAYMENT_COLUMNS = "direction, endpoint, counterparty, amount_usdc, gateway_tx, bill_ref, created_at";

// The individual payments behind the totals. Null, like getAgentStats, when
// there is no ledger to read — an empty list would claim nothing has settled.
export async function listPayments(limit = 12): Promise<PaymentRow[] | null> {
  const supabase = createSupabaseServerClient();
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("x402_payments")
    .select(PAYMENT_COLUMNS)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error || !data) {
    console.error("[x402] listPayments failed:", error?.message);
    return null;
  }
  return (data as Record<string, unknown>[]).map(toPaymentRow);
}

// Every x402 payment tagged with one bill — today that is the Auditor's review,
// bought before the agent settles. Rows written before buyReview started passing
// billRef have none, so an older settlement shows an empty list rather than
// somebody else's payment.
export async function listPaymentsForBill(billRef: string): Promise<PaymentRow[]> {
  const supabase = createSupabaseServerClient();
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("x402_payments")
    .select(PAYMENT_COLUMNS)
    .eq("bill_ref", billRef)
    .order("created_at", { ascending: true });
  if (error || !data) {
    console.error("[x402] listPaymentsForBill failed:", error?.message);
    return [];
  }
  return (data as Record<string, unknown>[]).map(toPaymentRow);
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

// Endpoints where both the buyer and the seller are Splitsy's own agents. The
// rows are real payments with a real Gateway tx, but the money never crossed the
// app's boundary: the Auditor's review fee is paid by the Settler out of income
// Splitsy already had. Counting it would add to "earned" money nobody outside
// paid, and once the matching 'spent' row lands it would inflate both totals from
// a single internal transfer.
// ponytail: one internal endpoint, matched by literal. Make it a column on x402_payments when a second internal trade appears.
const INTERNAL_ENDPOINTS = ["/api/agents/review"];

/**
 * The cumulative x402 ledger, or null when there is no database to read it
 * from. The distinction is not pedantic: these figures are shown as real money
 * on a public page, and "nothing has settled yet" and "we cannot see the
 * ledger" are different claims. Returning zeros for the second would let an
 * unconfigured deploy present fabricated figures as a live reading.
 *
 * Internal agent-to-agent trades are excluded, so "earned" stays a true claim
 * about money that came from outside Splitsy.
 */
export async function getAgentStats(): Promise<{
  earnedUsd: number;
  spentUsd: number;
  callsServed: number;
  callsPaid: number;
} | null> {
  const supabase = createSupabaseServerClient();
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("x402_payments")
    .select("direction, amount_usdc, endpoint");
  if (error || !data) {
    console.error("[x402] getAgentStats failed, reporting no reading:", error?.message);
    return null;
  }
  const rows = (
    data as Array<{ direction: X402Direction; amount_usdc: string; endpoint: string }>
  ).filter((r) => !INTERNAL_ENDPOINTS.includes(r.endpoint));
  const sum = (d: X402Direction) =>
    rows.filter((r) => r.direction === d).reduce((s, r) => s + Number(r.amount_usdc), 0);
  return {
    earnedUsd: sum("earned"),
    spentUsd: sum("spent"),
    callsServed: rows.filter((r) => r.direction === "earned").length,
    callsPaid: rows.filter((r) => r.direction === "spent").length,
  };
}
