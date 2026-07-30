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
