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
