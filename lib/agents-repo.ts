// Supabase access for the two settlement agents (see schema-agents.sql).
// Mirrors lib/reputation-repo.ts: thin, typed, no business logic — the rules
// live in lib/autopay.ts and lib/dunning.ts, which stay pure.
import type { AutopayDecision, AutopayGrant, MoneyMode } from "./autopay.ts";
import { REVIEW_UNAVAILABLE } from "./autopay-review.ts";
import type { DunningAction } from "./dunning.ts";
import { createSupabaseServerClient } from "./supabase.ts";
import type { AppUser } from "./types.ts";
import { getUserById } from "./users-repo.ts";

// Re-exported so consumers of the repo layer do not have to reach past it for
// the shape of a column it already hands them.
export type { MoneyMode };

export type AutopayGrantRow = AutopayGrant & {
  userId: string;
  // The linked browser wallet, or null. Not part of AutopayGrant because
  // decideAutopay has no use for it — it is how the ROUTE finds this row from a
  // chain address, not something the decision consults.
  debtorAddress: string | null;
  // Also outside AutopayGrant: the model review runs AFTER decideAutopay
  // returns `pay`, so the pure decision core never sees this flag.
  requireBillReview: boolean;
  // Outside AutopayGrant for the same reason as the two above: decideAutopay
  // never sees the mode. buildGrant reads it to choose which caps to hand over.
  moneyMode: MoneyMode;
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
    .select("user_id, max_per_bill_usdc, max_per_day_usdc, trusted_creators, min_creator_score, require_verified_hash, enabled, debtor_address, require_bill_review, money_mode")
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
    require_bill_review: boolean | null;
    money_mode: string | null;
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
    // Fails CLOSED at the read, not at the consumer: if the column was applied
    // by hand without `not null default true`, PostgREST hands back null, and a
    // null must read as "review required" — never as "review off".
    requireBillReview: row.require_bill_review !== false,
    // An unrecognised or absent value reads as 'mandate' — the mode where the
    // CHAIN enforces the caps. A missing column must never silently move a user
    // into the mode where only this server says no.
    moneyMode: row.money_mode === "funded" ? "funded" : "mandate",
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
      money_mode: grant.moneyMode,
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

// Which ACCOUNT holds this wallet, row and all. Two routes refuse a wallet that
// someone else already linked (POST /api/auth/wallet, POST /api/agents/link), and
// both have to name the holder in the refusal — otherwise the user is told to
// "sign in there" with no idea where "there" is. One lookup, one place.
export async function getWalletOwnerAccount(address: string): Promise<AppUser | null> {
  const owner = (await getGrantsByDebtorAddresses([address])).get(address.toLowerCase());
  if (!owner) return null;
  // Never fail the caller's own job over a missing holder row: both callers treat
  // "unknown" as "no collision to report", which is what the grant row without a
  // user would be anyway.
  return getUserById(owner.userId).catch(() => null);
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
  // The job this decision opened, once it exists. Null at claim time: the claim
  // is taken BEFORE createJob, which is what stops a redelivered webhook from
  // opening a second job for the same share.
  jobId?: string | null;
  jobStatus?: string | null;
  feeUsdc?: number;
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
    job_id: row.jobId ?? null,
    job_status: row.jobStatus ?? null,
    fee_usdc: row.feeUsdc ?? 0,
  });
  if (!error) return true;
  if (error.code === "23505") return reclaimUndecided(client, row);
  throw new Error(`Failed to claim autopay decision: ${error.message}`);
}

// The two skips that mean "the agent never got to judge this bill", as opposed
// to "the agent judged it and said no". Both are taken when the preimage row is
// missing — which, for a bill created through Splitsy, usually means it had not
// been published YET rather than never (lib/autopay-trigger.ts explains why the
// BillCreated event outruns the publish).
//
// Both spelled from their source of truth rather than as loose strings: this
// list going stale is the only way the fix silently stops working, and a rename
// on either side should break the build instead of the behaviour.
const UNDECIDED: string[] = ["unverifiable" satisfies AutopayDecision["reason"], REVIEW_UNAVAILABLE];

// The loser of the claim race gets one chance to overturn the winner, but only
// if the winner never actually reached a decision. Anything else — a real skip,
// or a pay — stands, which is what keeps this an idempotency key: a redelivered
// webhook still cannot pay twice.
//
// The `in(reason)` predicate is what makes it safe under concurrency. Postgres
// re-evaluates it against the updated row version, so if two runs overturn the
// same row at once the second matches nothing and loses.
async function reclaimUndecided(
  client: ReturnType<typeof requireClient>,
  row: AutopayLogRow,
): Promise<boolean> {
  const { data, error } = await client
    .from("autopay_log")
    .update({
      decision: row.decision,
      reason: row.reason,
      amount_usdc: row.amountUsdc,
      tx_hash: row.txHash,
      job_id: row.jobId ?? null,
      job_status: row.jobStatus ?? null,
      fee_usdc: row.feeUsdc ?? 0,
    })
    .eq("registry_address", row.registryAddress.toLowerCase())
    .eq("bill_id", row.billId)
    .eq("debtor_address", row.debtorAddress.toLowerCase())
    .in("reason", UNDECIDED)
    .select("id");
  if (error) throw new Error(`Failed to re-decide autopay row: ${error.message}`);
  return (data?.length ?? 0) > 0;
}

export async function finalizeAutopayDecision(
  registryAddress: string,
  billId: string,
  debtorAddress: string,
  patch: {
    decision?: "pay" | "skip";
    reason?: string;
    amountUsdc?: number;
    txHash?: string | null;
    jobId?: string | null;
    jobStatus?: string | null;
    feeUsdc?: number;
  },
): Promise<void> {
  const client = requireClient();
  const { error } = await client
    .from("autopay_log")
    .update({
      ...(patch.decision !== undefined ? { decision: patch.decision } : {}),
      ...(patch.reason !== undefined ? { reason: patch.reason } : {}),
      ...(patch.amountUsdc !== undefined ? { amount_usdc: patch.amountUsdc } : {}),
      ...(patch.txHash !== undefined ? { tx_hash: patch.txHash } : {}),
      ...(patch.jobId !== undefined ? { job_id: patch.jobId } : {}),
      ...(patch.jobStatus !== undefined ? { job_status: patch.jobStatus } : {}),
      ...(patch.feeUsdc !== undefined ? { fee_usdc: patch.feeUsdc } : {}),
    })
    .eq("registry_address", registryAddress.toLowerCase())
    .eq("bill_id", billId)
    .eq("debtor_address", debtorAddress.toLowerCase());
  if (error) throw new Error(`Failed to finalize autopay decision: ${error.message}`);
}

// The rolling-window spend used to be summed from this log. For MANDATE mode it
// is now read from AutopayMandate's token bucket (lib/arc-read.ts,
// getAutopayMandateOnchain), so the figure the agent reasons about is the same
// one that will revert it. Keeping a second log-derived answer for that mode
// would be one answer too many. Funded mode has no bucket at all, which is why
// sumAutopaySpentTodayUsdc below exists for it and only for it.

export type AutopayLogEntry = AutopayLogRow & {
  createdAt: string;
  jobId: string | null;
  jobStatus: string | null;
  feeUsdc: number;
};

// One account's decisions, or SEVERAL interleaved by time.
//
// Several, because one person can hold two accounts — a social login and the one
// a browser-wallet sign-in minted — each with its own agent writing its own rows.
// A log that shows one of them is not an audit trail: the decisions missing from
// it are exactly the ones the reader cannot otherwise see, since the other
// account's rules are unreachable from the session they are in.
//
// The `limit` applies to the MERGED result, which is what makes this one query
// rather than one per account: taking 50 from each and slicing here would drop
// recent rows from a busy account to keep old ones from a quiet one.
export async function listAutopayLog(
  userIds: string | string[],
  limit = 50,
): Promise<AutopayLogEntry[]> {
  const client = requireClient();
  const ids = (Array.isArray(userIds) ? userIds : [userIds]).filter(Boolean);
  if (ids.length === 0) return [];
  const { data, error } = await client
    .from("autopay_log")
    .select("user_id, registry_address, bill_id, debtor_address, decision, reason, amount_usdc, tx_hash, created_at, job_id, job_status, fee_usdc")
    .in("user_id", ids)
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
      jobId: (row.job_id as string | null) ?? null,
      jobStatus: (row.job_status as string | null) ?? null,
      feeUsdc: Number(row.fee_usdc ?? 0),
    };
  });
}

// The rolling daily spend for FUNDED mode only.
//
// Mandate mode reads this from AutopayMandate's token bucket (lib/arc-read.ts),
// because there the contract is the thing that will revert. Funded mode has no
// bucket — the mandate is not in the path — so the log is the only record of
// what this agent has already spent for this user. Each mode has exactly one
// source; this is not the two-answers problem the bucket comment warns about.
//
// A read failure returns Infinity, matching sumSpentTodayUsd in
// lib/x402/payments-repo.ts: an unreadable ledger must look like "cap
// exhausted", never like "nothing spent yet".
export async function sumAutopaySpentTodayUsdc(userId: string): Promise<number> {
  const client = requireClient();
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await client
    .from("autopay_log")
    .select("amount_usdc")
    .eq("user_id", userId)
    .eq("decision", "pay")
    .gte("created_at", since);
  if (error || !data) {
    console.error("[autopay] sumAutopaySpentTodayUsdc failed, treating the cap as spent:", error?.message);
    return Number.POSITIVE_INFINITY;
  }
  return data.reduce((sum, r) => sum + Number((r as { amount_usdc: string | number }).amount_usdc), 0);
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
