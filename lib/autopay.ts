// The debtor-side agent's decision core: given one debt and the user's standing
// rules, should the agent spend their money on it?
//
// Pure — no I/O, no clock, no chain reads. Every fact the decision needs is an
// input field the route resolved first (same shape as lib/scout/decide.ts).
// That is what makes the rules testable, and what makes a skip explainable:
// the agent can always say which rule declined and why.
//
// Money: `remaining` is USDC base units (bigint, 6dp) because it came from
// chain. The caps are the user's own numbers in USDC, compared through
// lib/x402/spend.ts's atomic-unit helpers rather than a second float path.
import { billMetadataHash, type BillPreimage } from "./bill-metadata.ts";
import { canSpend } from "./x402/spend.ts";

export type AutopayGrant = {
  enabled: boolean;
  maxPerBillUsdc: number; // 0 = nothing passes; "off", not "unlimited"
  maxPerDayUsdc: number; // 0 = nothing passes
  trustedCreators: string[]; // lowercase addresses; EMPTY = anyone
  minCreatorScore: number; // 0 = off
  requireVerifiedHash: boolean;
};

// Where BILL money comes from. Not where the FEE comes from — the job fee is
// always the user's agent's, in both modes.
export type MoneyMode = "mandate" | "funded";

export type AutopayInput = {
  grant: AutopayGrant | null;
  remaining: bigint; // the debtor's unpaid share, USDC base units, read from chain
  creator: string; // the bill's splitter
  creatorScore: number | null; // ERC-8004 average; null = no history yet
  spentTodayUsdc: number; // already spent by this agent for this user in the window
  onchainMetadataHash: `0x${string}`;
  preimage: BillPreimage | null; // null = nothing published to verify against
};

export type AutopayDecision = {
  pay: boolean;
  amount: bigint; // always the full remaining share, or 0n
  reason:
    | "ok"
    | "disabled"
    | "nothing_owed"
    | "over_bill_cap"
    | "over_daily_cap"
    | "untrusted_creator"
    | "low_creator_score"
    | "hash_mismatch"
    | "unverifiable";
};

const skip = (reason: AutopayDecision["reason"]): AutopayDecision => ({ pay: false, amount: 0n, reason });

// Base units → USDC as a number, only for comparing against the user's own
// caps. The amount that actually moves is never round-tripped through this.
const toUsdc = (units: bigint) => Number(units) / 1_000_000;

export function decideAutopay(input: AutopayInput): AutopayDecision {
  const { grant } = input;

  if (!grant || !grant.enabled) return skip("disabled");
  if (input.remaining <= 0n) return skip("nothing_owed");

  const owedUsdc = toUsdc(input.remaining);

  if (owedUsdc > grant.maxPerBillUsdc) return skip("over_bill_cap");
  if (!canSpend(input.spentTodayUsdc, owedUsdc, grant.maxPerDayUsdc)) return skip("over_daily_cap");

  if (grant.trustedCreators.length > 0) {
    const allowed = grant.trustedCreators.map((a) => a.toLowerCase());
    if (!allowed.includes(input.creator.toLowerCase())) return skip("untrusted_creator");
  }

  // "No history" is neutral, never bad — the same rule the reputation badge
  // follows. This is the one check that fails open, because the alternative is
  // an agent that never pays a first-time creator.
  if (grant.minCreatorScore > 0 && input.creatorScore !== null && input.creatorScore < grant.minCreatorScore) {
    return skip("low_creator_score");
  }

  if (grant.requireVerifiedHash) {
    // Fail closed. Without a published preimage the agent cannot tell what it
    // is about to pay for, and "probably fine" is not a spending rule.
    if (!input.preimage) return skip("unverifiable");
    if (billMetadataHash(input.preimage).toLowerCase() !== input.onchainMetadataHash.toLowerCase()) {
      return skip("hash_mismatch");
    }
  }

  return { pay: true, amount: input.remaining, reason: "ok" };
}

// AutopayMandate.mandates(debtor), as lib/arc-read.ts returns it. Null = the
// user has written no mandate on this wallet.
export type MandateFacts = {
  // Whose agent the mandate names. buildGrant does NOT check it against the
  // caller's agent — the caller must, or one user's agent will spend on another
  // user's mandate.
  agent: string;
  maxPerBill: bigint; // USDC base units
  maxPerDay: bigint; // USDC base units
  allowedCreators: string[];
} | null;

// The autopay_grants row. Null = the user has never touched autopay.
export type MirrorRules = {
  enabled: boolean;
  maxPerBillUsdc: number;
  maxPerDayUsdc: number;
  trustedCreators: string[];
  minCreatorScore: number;
  requireVerifiedHash: boolean;
} | null;

// The ONE new branch in the agent-economy design, and it is a pure function so
// it can be tested without a network.
//
// decideAutopay does not learn about modes — its signature and its purity are
// load-bearing. Only its INPUT changes, and this is what chooses the input:
//
//   'mandate' — the caps come from AutopayMandate, the contract that will
//               revert on its own numbers regardless of what this server
//               believes. No mandate means no permission: null.
//   'funded'  — the mandate is not in the path at all, so the caps come from
//               the Postgres mirror and are enforced HERE. That is a genuine
//               weakening and the UI has to say so: in this mode the only
//               ceiling the chain enforces is the agent's own balance.
//               ponytail: funded mode enforces caps server-side; upgrade path
//               is a mandate.
//
// The two rules a contract can never evaluate — the ERC-8004 score floor and
// the verified-hash check — come from Postgres in BOTH modes, because Postgres
// is their only home. Both default to the closed direction when the row is
// missing: score floor off, hash check ON.
export function buildGrant(mode: MoneyMode, mandate: MandateFacts, rules: MirrorRules): AutopayGrant | null {
  const minCreatorScore = rules?.minCreatorScore ?? 0;
  const requireVerifiedHash = rules?.requireVerifiedHash ?? true;

  if (mode === "funded") {
    if (!rules || !rules.enabled) return null;
    return {
      enabled: true,
      maxPerBillUsdc: rules.maxPerBillUsdc,
      maxPerDayUsdc: rules.maxPerDayUsdc,
      trustedCreators: rules.trustedCreators,
      minCreatorScore,
      requireVerifiedHash,
    };
  }

  if (!mandate) return null;
  return {
    enabled: true,
    maxPerBillUsdc: toUsdc(mandate.maxPerBill),
    maxPerDayUsdc: toUsdc(mandate.maxPerDay),
    trustedCreators: mandate.allowedCreators,
    minCreatorScore,
    requireVerifiedHash,
  };
}

// Which money mode a deployment falls back to when the user has no row yet.
//
// NOT a preference. The circle stack's DCWs are SCAs, so `mandate` works there
// and is the safer default: the contract reverts on its own numbers regardless
// of what this server believes. Privy embedded wallets are EOAs, and
// encodeExecuteBatch sends executeBatch calldata to the wallet's own address —
// which an EOA does not execute and, measured on Arc rather than assumed, does
// not revert on either: the transaction SUCCEEDS, burns ~25k gas and does
// nothing (tx 0x5870…dadf95). So defaulting a Privy deployment to `mandate`
// would not fail loudly, it would report an armed mandate that does not exist.
// It defaults to `funded` instead, and the enclave policy is what caps the spend
// in place of the contract.
export function defaultMoneyMode(provider: "circle" | "privy"): MoneyMode {
  return provider === "privy" ? "funded" : "mandate";
}

// How far the settlement got before the ceremony threw. The route fills this in
// as it goes, because only the route can see it: a hash in hand means the send
// was accepted, and `broadcast` means it left but nothing confirmed it.
export type SettlementProgress = {
  settlementTx: string | null;
  broadcast: boolean;
  // The job opened at step 1. Carried onto the failure row so an operator can
  // find the job they must complete or expire by hand — a settled_incomplete
  // row without it names a problem nobody can act on.
  jobId: string | null;
};

// What went wrong, classified by the route so this module never has to import
// the Circle SDK's error classes to ask.
export type FailureKind = "insufficient_funds" | "wallet_unavailable" | "job" | "other";

// The autopay_log row a failed ceremony should leave behind.
export type SettlementRow = {
  decision: "pay" | "skip";
  reason: string;
  amountUsdc: number;
  txHash: string | null;
  jobId: string | null;
  jobStatus: string;
};

// The one question a failed settlement has to answer: DID THE MONEY MOVE?
//
// Getting it wrong in the cheap-looking direction is a real overspend. A row
// written 'skip' with amount 0 is invisible to sumAutopaySpentTodayUsdc, which
// only sums decision='pay' — so in Funded mode, where the log is the ONLY record
// of the day's spend, a settlement that succeeded on chain but broke afterwards
// would silently hand the user their whole daily cap back. Two 8 USDC bills
// against a 10 USDC cap both pay, and 16 USDC is gone.
//
// So the rule is: anything that might have moved money is logged 'pay' for the
// full amount. That direction is fail-closed — it can cost a user headroom they
// were entitled to, which is recoverable, rather than spending money they had
// already capped, which is not.
//
// `reason` stays the failure slug in every case, including the 'pay' ones. The
// row is meant to be read as "this is what we must assume was spent, and this is
// what went wrong"; jobStatus carries which of those two things happened.
export function settlementRowFor(
  progress: SettlementProgress,
  kind: FailureKind,
  amountUsdc: number,
): SettlementRow {
  const reason =
    kind === "insufficient_funds"
      ? "agent_unfunded"
      : kind === "wallet_unavailable"
        ? "agent_wallet_unavailable"
        : kind === "job"
          ? "job_failed"
          : "tx_failed";

  // The settlement landed and something after it broke — submit or complete.
  // The debt is paid; only the escrow ceremony is unfinished.
  if (progress.settlementTx) {
    return {
      decision: "pay",
      reason,
      amountUsdc,
      txHash: progress.settlementTx,
      jobId: progress.jobId,
      jobStatus: "settled_incomplete",
    };
  }

  // Sent, but nothing ever confirmed it: Circle's poll timed out with no hash,
  // or settlerWrite went indeterminate. It may still mine, so it must count
  // against the cap. No hash to record, which is exactly what makes this row
  // the one a reconciliation sweep has to revisit.
  if (progress.broadcast) {
    return {
      decision: "pay",
      reason,
      amountUsdc,
      txHash: null,
      jobId: progress.jobId,
      jobStatus: "settlement_unconfirmed",
    };
  }

  // Nothing was ever broadcast — the ceremony broke before step 4, or the send
  // itself was rejected. No money moved and none can.
  return { decision: "skip", reason, amountUsdc: 0, txHash: null, jobId: progress.jobId, jobStatus: "failed" };
}
