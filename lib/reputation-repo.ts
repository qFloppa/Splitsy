import { createSupabaseServerClient } from "./supabase.ts";

export type ReputationAgent = {
  wallet_address: string;
  agent_id: string;
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
};

// What the badge shows. `count === 0` means "no history" and must render as
// neutral/unknown — never as a bad score (see consent policy in
// schema-reputation.sql: an empty profile is indistinguishable from a new user).
export type ReputationSummary = {
  agentId: string | null;
  count: number;
  avgScore: number | null;
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

export async function insertAgent(row: ReputationAgent): Promise<void> {
  const client = requireClient();
  const { error } = await client.from("reputation_agents").upsert(
    { ...row, wallet_address: row.wallet_address.toLowerCase() },
    { onConflict: "wallet_address", ignoreDuplicates: true },
  );
  if (error) throw new Error(`Failed to insert reputation agent: ${error.message}`);
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

export async function insertFeedback(row: ReputationFeedbackRow): Promise<void> {
  const client = requireClient();
  const { error } = await client.from("reputation_feedback").upsert(
    { ...row, wallet_address: row.wallet_address.toLowerCase() },
    { onConflict: "wallet_address,bill_id", ignoreDuplicates: true },
  );
  if (error) throw new Error(`Failed to insert reputation feedback: ${error.message}`);
}

export async function getReputationSummary(walletAddress: string): Promise<ReputationSummary> {
  const client = requireClient();
  const addr = walletAddress.toLowerCase();
  const [agentRes, feedbackRes] = await Promise.all([
    client.from("reputation_agents").select("agent_id").eq("wallet_address", addr).maybeSingle(),
    client
      .from("reputation_feedback")
      .select("score, created_at")
      .eq("wallet_address", addr)
      .order("created_at", { ascending: false }),
  ]);
  if (agentRes.error) throw new Error(`Failed to read reputation agent: ${agentRes.error.message}`);
  if (feedbackRes.error) throw new Error(`Failed to read reputation feedback: ${feedbackRes.error.message}`);

  const rows = (feedbackRes.data ?? []) as Array<{ score: number; created_at: string }>;
  const count = rows.length;
  return {
    agentId: (agentRes.data as { agent_id: string } | null)?.agent_id ?? null,
    count,
    avgScore: count === 0 ? null : Math.round(rows.reduce((s, r) => s + r.score, 0) / count),
    lastPaidAt: rows[0]?.created_at ?? null,
  };
}
