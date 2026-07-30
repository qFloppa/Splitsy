// The creditor-side agent's decision core: for one unpaid share of one bill,
// nudge, escalate, or pull?
//
// Pure, and `now` is a parameter rather than a Date.now() read inside — that is
// what makes the time-travel tests possible and what keeps the cron's behaviour
// reproducible.
//
// The ladder is exactly two rungs (nudge → escalate) plus collect. A third rung
// is a product decision nobody has made.

/// How far before the due date the first nudge goes out.
export const NUDGE_WINDOW_SECONDS = 3 * 86_400;

export type DunningAction = "none" | "nudge" | "escalate" | "collect";

export type DunningInput = {
  dueDate: number; // Unix seconds from the bill on chain; 0 = no deadline
  remaining: bigint; // the debtor's unpaid share, USDC base units
  hasMandate: boolean; // the debtor's per-bill collectMandate
  collectible: bigint; // what collectDebt would actually move, read from chain
  alreadyLogged: DunningAction[]; // actions already recorded for this (bill, debtor)
};

export type DunningDecision = {
  action: DunningAction;
  amount: bigint; // non-zero only for 'collect'
  reason: string;
};

const nothing = (reason: string): DunningDecision => ({ action: "none", amount: 0n, reason });

export function decideDunning(input: DunningInput, now: number): DunningDecision {
  if (input.remaining <= 0n) return nothing("nothing_owed");
  if (input.dueDate <= 0) return nothing("no_due_date");

  // `>=` matches the contract's _isDue exactly. Two copies of a timestamp rule
  // drift, so if one ever changes both must.
  const isDue = now >= input.dueDate;

  if (!isDue) {
    if (now < input.dueDate - NUDGE_WINDOW_SECONDS) return nothing("not_yet");
    if (input.alreadyLogged.includes("nudge")) return nothing("already_nudged");
    return { action: "nudge", amount: 0n, reason: "due_soon" };
  }

  if (input.hasMandate && input.collectible > 0n) {
    // Append-only: a partial collection can legitimately repeat as the debtor
    // tops up, so an earlier 'collect' is not a reason to stop.
    return { action: "collect", amount: input.collectible, reason: "mandate_and_funds" };
  }

  if (input.alreadyLogged.includes("escalate")) return nothing("already_escalated");

  // Either no mandate at all, or one we cannot draw on. Both end at the same
  // rung — the difference is only in what we tell the creditor.
  return {
    action: "escalate",
    amount: 0n,
    reason: input.hasMandate ? "no_funds" : "no_mandate",
  };
}
