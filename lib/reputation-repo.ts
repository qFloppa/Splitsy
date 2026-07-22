import { createSupabaseServerClient } from "./supabase.ts";
import { TAG_PAID_LATE, weightedAverageScore } from "./reputation-score.ts";

export type ReputationAgent = {
  wallet_address: string;
  agent_id: string | null; // null = an in-flight registration claim (see claimAgentRegistration)
  register_tx: string | null;
};

export type ReputationFeedbackRow = {
  wallet_address: string;
  agent_id: string;
  bill_id: string;
  score: number;
  tag: string;
  payment_tx: string;
  feedback_tx: string | null;
  // Timing + weight context (all optional so older callers still compile; the
  // columns default to 0). share_units weights the average by the payer's share;
  // due_date/paid_at record what the timing score was graded against.
  share_units?: number;
  due_date?: number;
  paid_at?: number;
};

// What the badge shows. `count === 0` means "no history" and must render as
// neutral/unknown — never as a bad score (see consent policy in
// schema-reputation.sql: an empty profile is indistinguishable from a new user).
//
// avgScore is amount-weighted (see weightedAverageScore): a large late bill
// pulls it down more than a small one. onTimeCount/lateCount break down the
// timeliness the average summarizes, so the badge can say "N paid, M late".
export type ReputationSummary = {
  agentId: string | null;
  count: number;
  avgScore: number | null;
  lateCount: number;
  lastPaidAt: string | null;
};

function requireClient() {
  const client = createSupabaseServerClient();
  if (!client) throw new Error("Supabase is not configured");
  return client;
}

export async function getAgentByWallet(walletAddress: string): Promise<ReputationAgent | null> {
  const client = requireClient();
  const { data, error } = await client
    .from("reputation_agents")
    .select("wallet_address, agent_id, register_tx")
    .eq("wallet_address", walletAddress.toLowerCase())
    .maybeSingle();
  if (error) throw new Error(`Failed to read reputation agent: ${error.message}`);
  return (data as ReputationAgent) ?? null;
}

// --- claim-based registration dedupe ----------------------------------------
// Two paths race to register the same wallet: a DCW payment fires both the
// pay route's after() hook and the DebtPaid webhook within seconds, and both
// used to mint an identity NFT. The PK on wallet_address makes inserting a
// claim row (agent_id null) an atomic mutex: exactly one caller wins and
// mints; losers wait for the winner to finalize. A claim left by a crashed
// winner is taken over once it is older than AGENT_CLAIM_STALE_MS.

const AGENT_CLAIM_STALE_MS = 120_000; // mint + Circle polling caps at ~60s; older = abandoned

export async function claimAgentRegistration(walletAddress: string): Promise<"won" | "inflight"> {
  const client = requireClient();
  const wallet = walletAddress.toLowerCase();
  const ins = await client.from("reputation_agents").insert({ wallet_address: wallet, agent_id: null });
  if (!ins.error) return "won";
  if (ins.error.code !== "23505") throw new Error(`Failed to claim registration: ${ins.error.message}`);

  // Row exists: either finalized (agent_id set) or someone else's claim. Take
  // over stale claims so a crashed winner can't block the wallet forever.
  const { data, error } = await client
    .from("reputation_agents")
    .select("agent_id, created_at")
    .eq("wallet_address", wallet)
    .maybeSingle();
  if (error) throw new Error(`Failed to read agent claim: ${error.message}`);
  const claim = data as { agent_id: string | null; created_at: string } | null;
  if (!claim || claim.agent_id) return "inflight"; // finalized (or gone) — caller re-reads
  if (Date.now() - new Date(claim.created_at).getTime() < AGENT_CLAIM_STALE_MS) return "inflight";

  await client.from("reputation_agents").delete().eq("wallet_address", wallet).is("agent_id", null);
  const retry = await client.from("reputation_agents").insert({ wallet_address: wallet, agent_id: null });
  if (!retry.error) return "won";
  if (retry.error.code === "23505") return "inflight"; // lost the takeover race
  throw new Error(`Failed to claim registration: ${retry.error.message}`);
}

export async function finalizeAgentRegistration(
  walletAddress: string,
  agentId: string,
  registerTx: string,
): Promise<void> {
  const client = requireClient();
  const { error } = await client
    .from("reputation_agents")
    .update({ agent_id: agentId, register_tx: registerTx })
    .eq("wallet_address", walletAddress.toLowerCase());
  if (error) throw new Error(`Failed to finalize registration: ${error.message}`);
}

export async function releaseAgentClaim(walletAddress: string): Promise<void> {
  const client = requireClient();
  const { error } = await client
    .from("reputation_agents")
    .delete()
    .eq("wallet_address", walletAddress.toLowerCase())
    .is("agent_id", null);
  if (error) throw new Error(`Failed to release agent claim: ${error.message}`);
}

export async function hasFeedbackForBill(walletAddress: string, billId: string): Promise<boolean> {
  const client = requireClient();
  const { data, error } = await client
    .from("reputation_feedback")
    .select("id")
    .eq("wallet_address", walletAddress.toLowerCase())
    .eq("bill_id", billId)
    .maybeSingle();
  if (error) throw new Error(`Failed to read reputation feedback: ${error.message}`);
  return data != null;
}

// Claim (wallet, bill) for scoring by inserting the fully-graded row with
// feedback_tx still null; the unique (wallet_address, bill_id) is the lock.
// true → caller must send giveFeedback then setFeedbackTx (or release on
// failure). false → another path already recorded or is recording it. The old
// check-then-insert let the validator double-score raced payments on-chain
// (the mirror's unique key silently hid the duplicates).
export async function claimFeedback(row: ReputationFeedbackRow): Promise<boolean> {
  const client = requireClient();
  const { error } = await client
    .from("reputation_feedback")
    .insert({ ...row, wallet_address: row.wallet_address.toLowerCase(), feedback_tx: null });
  if (!error) return true;
  if (error.code === "23505") return false;
  throw new Error(`Failed to claim feedback: ${error.message}`);
}

export async function setFeedbackTx(
  walletAddress: string,
  billId: string,
  feedbackTx: string | null,
): Promise<void> {
  const client = requireClient();
  const { error } = await client
    .from("reputation_feedback")
    .update({ feedback_tx: feedbackTx })
    .eq("wallet_address", walletAddress.toLowerCase())
    .eq("bill_id", billId);
  if (error) throw new Error(`Failed to record feedback tx: ${error.message}`);
}

export async function releaseFeedbackClaim(walletAddress: string, billId: string): Promise<void> {
  const client = requireClient();
  const { error } = await client
    .from("reputation_feedback")
    .delete()
    .eq("wallet_address", walletAddress.toLowerCase())
    .eq("bill_id", billId)
    .is("feedback_tx", null);
  if (error) throw new Error(`Failed to release feedback claim: ${error.message}`);
}

export async function getReputationSummary(walletAddress: string): Promise<ReputationSummary> {
  return getReputationSummaryForWallets([walletAddress]);
}

// Reputation across one or more of a person's wallets (social DCW + non-custodial),
// scored as a single record: feedback is a per-payment fact, so a user's timeliness
// is the weighted average over every wallet they pay from. Dedupes addresses; an
// empty/all-blank list yields the zero summary without a query.
export async function getReputationSummaryForWallets(walletAddresses: string[]): Promise<ReputationSummary> {
  const addrs = [...new Set(walletAddresses.map((a) => a.toLowerCase()).filter(Boolean))];
  if (addrs.length === 0) {
    return { agentId: null, count: 0, avgScore: null, lateCount: 0, lastPaidAt: null };
  }

  const client = requireClient();
  const [agentRes, feedbackRes] = await Promise.all([
    client.from("reputation_agents").select("agent_id").in("wallet_address", addrs).limit(1).maybeSingle(),
    client
      .from("reputation_feedback")
      .select("score, tag, share_units, created_at")
      .in("wallet_address", addrs)
      .order("created_at", { ascending: false }),
  ]);
  if (agentRes.error) throw new Error(`Failed to read reputation agent: ${agentRes.error.message}`);
  if (feedbackRes.error) throw new Error(`Failed to read reputation feedback: ${feedbackRes.error.message}`);

  const rows = (feedbackRes.data ?? []) as Array<{
    score: number;
    tag: string;
    share_units: number | string | null;
    created_at: string;
  }>;
  const count = rows.length;
  // share_units arrives as a numeric string (Postgres numeric) — coerce to a
  // Number for weighting. 0/NaN falls back to neutral weight in the aggregator.
  const weighted = rows.map((r) => ({ score: r.score, shareUnits: Number(r.share_units) || 0 }));
  const lateCount = rows.filter((r) => r.tag === TAG_PAID_LATE).length;
  return {
    agentId: (agentRes.data as { agent_id: string } | null)?.agent_id ?? null,
    count,
    avgScore: weightedAverageScore(weighted),
    lateCount,
    lastPaidAt: rows[0]?.created_at ?? null,
  };
}
