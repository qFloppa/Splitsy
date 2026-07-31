// Supabase access for the two settlement agents (see schema-agents.sql).
// Mirrors lib/reputation-repo.ts: thin, typed, no business logic — the rules
// live in lib/autopay.ts and lib/dunning.ts, which stay pure.
import type { AutopayGrant } from "./autopay.ts";
import type { DunningAction } from "./dunning.ts";
import { createSupabaseServerClient } from "./supabase.ts";

export type AutopayGrantRow = AutopayGrant & {
  userId: string;
  // The linked browser wallet, or null. Not part of AutopayGrant because
  // decideAutopay has no use for it — it is how the ROUTE finds this row from a
  // chain address, not something the decision consults.
  debtorAddress: string | null;
  // Also outside AutopayGrant: the model review runs AFTER decideAutopay
  // returns `pay`, so the pure decision core never sees this flag.
  requireBillReview: boolean;
};

function requireClient() {
  const client = createSupabaseServerClient();
  if (!client) throw new Error("Supabase is not configured");
  return client;
}

// A missing row is a missing grant, which decideAutopay reads as "disabled" —
// the safe default. Never invent an enabled grant.
export async function getAutopayGrant(userId: string): Promise<AutopayGrantRow | null> {
  const client = requireClient();
  const { data, error } = await client
    .from("autopay_grants")
    .select("user_id, max_per_bill_usdc, max_per_day_usdc, trusted_creators, min_creator_score, require_verified_hash, enabled, debtor_address, require_bill_review")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(`Failed to read autopay grant: ${error.message}`);
  if (!data) return null;

  const row = data as {
    user_id: string;
    max_per_bill_usdc: string | number;
    max_per_day_usdc: string | number;
    trusted_creators: string[] | null;
    min_creator_score: number;
    require_verified_hash: boolean;
    enabled: boolean;
    debtor_address: string | null;
    require_bill_review: boolean;
  };
  return {
    userId: row.user_id,
    enabled: row.enabled,
    maxPerBillUsdc: Number(row.max_per_bill_usdc),
    maxPerDayUsdc: Number(row.max_per_day_usdc),
    trustedCreators: (row.trusted_creators ?? []).map((a) => a.toLowerCase()),
    minCreatorScore: row.min_creator_score,
    requireVerifiedHash: row.require_verified_hash,
    debtorAddress: row.debtor_address ? row.debtor_address.toLowerCase() : null,
    requireBillReview: row.require_bill_review,
  };
}

export async function upsertAutopayGrant(grant: AutopayGrantRow): Promise<void> {
  const client = requireClient();
  const { error } = await client.from("autopay_grants").upsert(
    {
      user_id: grant.userId,
      max_per_bill_usdc: grant.maxPerBillUsdc,
      max_per_day_usdc: grant.maxPerDayUsdc,
      trusted_creators: grant.trustedCreators.map((a) => a.toLowerCase()),
      min_creator_score: grant.minCreatorScore,
      require_verified_hash: grant.requireVerifiedHash,
      require_bill_review: grant.requireBillReview,
      enabled: grant.enabled,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );
  if (error) throw new Error(`Failed to save autopay grant: ${error.message}`);
}

// The reverse lookup the autopay route needs: given the participant addresses on
// a bill, which of them are linked browser wallets, and whose? DCW addresses are
// resolved separately by getUsersByWallets — this covers the wallets that never
// appear in the `users` table at all.
export async function getGrantsByDebtorAddresses(
  addresses: string[],
): Promise<Map<string, { userId: string }>> {
  const result = new Map<string, { userId: string }>();
  const wanted = [...new Set(addresses.map((a) => a.toLowerCase()))].filter(Boolean);
  if (wanted.length === 0) return result;

  const client = requireClient();
  const { data, error } = await client
    .from("autopay_grants")
    .select("user_id, debtor_address")
    .in("debtor_address", wanted);
  if (error) throw new Error(`Failed to read linked wallets: ${error.message}`);

  for (const r of data ?? []) {
    const row = r as { user_id: string; debtor_address: string | null };
    if (!row.debtor_address) continue;
    result.set(row.debtor_address.toLowerCase(), { userId: String(row.user_id) });
  }
  return result;
}

// Link or unlink the browser wallet. Written only by POST/DELETE
// /api/agents/link, which proves control of the address first. The upsert
// creates the grant row if this is the user's first interaction with autopay —
// with every cap at 0, which is "off", never "unlimited".
export async function setGrantDebtorAddress(userId: string, address: string | null): Promise<void> {
  const client = requireClient();
  const { error } = await client.from("autopay_grants").upsert(
    {
      user_id: userId,
      debtor_address: address ? address.toLowerCase() : null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );
  if (error) throw new Error(`Failed to link wallet: ${error.message}`);
}

export type AutopayLogRow = {
  userId: string;
  registryAddress: string;
  billId: string;
  debtorAddress: string;
  decision: "pay" | "skip";
  reason: string;
  amountUsdc: number;
  txHash: string | null;
};

// Claim (registry, bill, debtor) BEFORE spending, by inserting the log row.
// The unique key is the lock, so a redelivered webhook loses the race and pays
// nothing. false = someone already decided this one.
//
// The contract's `remaining` cap would make a double payment revert anyway, but
// a revert is not an idempotency key — it is a failure we would then have to
// tell the user about.
export async function claimAutopayDecision(row: AutopayLogRow): Promise<boolean> {
  const client = requireClient();
  const { error } = await client.from("autopay_log").insert({
    user_id: row.userId,
    registry_address: row.registryAddress.toLowerCase(),
    bill_id: row.billId,
    debtor_address: row.debtorAddress.toLowerCase(),
    decision: row.decision,
    reason: row.reason,
    amount_usdc: row.amountUsdc,
    tx_hash: row.txHash,
  });
  if (!error) return true;
  if (error.code === "23505") return false;
  throw new Error(`Failed to claim autopay decision: ${error.message}`);
}

export async function finalizeAutopayDecision(
  registryAddress: string,
  billId: string,
  debtorAddress: string,
  patch: { decision?: "pay" | "skip"; reason?: string; amountUsdc?: number; txHash?: string | null },
): Promise<void> {
  const client = requireClient();
  const { error } = await client
    .from("autopay_log")
    .update({
      ...(patch.decision !== undefined ? { decision: patch.decision } : {}),
      ...(patch.reason !== undefined ? { reason: patch.reason } : {}),
      ...(patch.amountUsdc !== undefined ? { amount_usdc: patch.amountUsdc } : {}),
      ...(patch.txHash !== undefined ? { tx_hash: patch.txHash } : {}),
    })
    .eq("registry_address", registryAddress.toLowerCase())
    .eq("bill_id", billId)
    .eq("debtor_address", debtorAddress.toLowerCase());
  if (error) throw new Error(`Failed to finalize autopay decision: ${error.message}`);
}

// The rolling-window spend used to be summed from this log. It is now read from
// AutopayMandate's token bucket (lib/arc-read.ts, getAutopayMandateOnchain), so
// the figure the agent reasons about is the same one that will revert it. The
// sum-from-the-log version is gone rather than kept "just in case": two answers
// to "how much has been spent today" is one answer too many.

export type AutopayLogEntry = AutopayLogRow & { createdAt: string };

export async function listAutopayLog(userId: string, limit = 50): Promise<AutopayLogEntry[]> {
  const client = requireClient();
  const { data, error } = await client
    .from("autopay_log")
    .select("user_id, registry_address, bill_id, debtor_address, decision, reason, amount_usdc, tx_hash, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`Failed to read autopay log: ${error.message}`);
  return (data ?? []).map((r) => {
    const row = r as Record<string, unknown>;
    return {
      userId: String(row.user_id),
      registryAddress: String(row.registry_address),
      billId: String(row.bill_id),
      debtorAddress: String(row.debtor_address),
      decision: row.decision as "pay" | "skip",
      reason: String(row.reason),
      amountUsdc: Number(row.amount_usdc),
      txHash: (row.tx_hash as string | null) ?? null,
      createdAt: String(row.created_at),
    };
  });
}

// --- dunning ---------------------------------------------------------------

export async function listDunningActions(
  registryAddress: string,
  billId: string,
  debtorAddress: string,
): Promise<DunningAction[]> {
  const client = requireClient();
  const { data, error } = await client
    .from("dunning_log")
    .select("action")
    .eq("registry_address", registryAddress.toLowerCase())
    .eq("bill_id", billId)
    .eq("debtor_address", debtorAddress.toLowerCase());
  if (error) throw new Error(`Failed to read dunning log: ${error.message}`);
  return (data ?? []).map((r) => (r as { action: DunningAction }).action);
}

// Written BEFORE the nudge is sent or the pull is submitted: the unique index
// on (registry, bill, debtor, action) for nudge/escalate is what stops a cron
// overlap from double-nudging. false = another run already owns this action.
// 'collect' rows are append-only and always insert.
export async function claimDunningAction(row: {
  registryAddress: string;
  billId: string;
  debtorAddress: string;
  action: DunningAction;
  reason: string;
  amountUsdc: number;
}): Promise<boolean> {
  const client = requireClient();
  const { error } = await client.from("dunning_log").insert({
    registry_address: row.registryAddress.toLowerCase(),
    bill_id: row.billId,
    debtor_address: row.debtorAddress.toLowerCase(),
    action: row.action,
    reason: row.reason,
    amount_usdc: row.amountUsdc,
  });
  if (!error) return true;
  if (error.code === "23505") return false;
  throw new Error(`Failed to claim dunning action: ${error.message}`);
}

export async function setDunningTx(
  registryAddress: string,
  billId: string,
  debtorAddress: string,
  action: DunningAction,
  txHash: string,
): Promise<void> {
  const client = requireClient();
  const { error } = await client
    .from("dunning_log")
    .update({ tx_hash: txHash })
    .eq("registry_address", registryAddress.toLowerCase())
    .eq("bill_id", billId)
    .eq("debtor_address", debtorAddress.toLowerCase())
    .eq("action", action)
    .is("tx_hash", null);
  if (error) throw new Error(`Failed to record dunning tx: ${error.message}`);
}
