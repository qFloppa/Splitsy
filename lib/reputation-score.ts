// Payment-reputation scoring — pure functions, no I/O, so both the scoring path
// (lib/erc8004) and the summary aggregation (lib/reputation-repo) share one
// source of truth and the curve can be unit-tested in isolation.
//
// Two layers, deliberately kept apart:
//   1. Per-bill timing score (0-100) — what gets written on-chain via
//      giveFeedback. Graded against the due date the creator committed into the
//      bill's metadataHash, using the payDebt block timestamp (authoritative and
//      identical across the DCW, webhook, and replay paths).
//   2. Amount-weighted aggregate — how the badge summarizes many bills. Each
//      bill keeps its clean timing score; the average weights by the payer's
//      share, so a large late bill drags harder than a small one. Weighting at
//      aggregation (not per-bill) keeps every on-chain score simple and
//      independently verifiable.

// Grace window after the due date in which payment still counts fully on time.
// Timezone slack + "paid the morning it was due" shouldn't cost anything.
export const GRACE_SECONDS = 2 * 24 * 60 * 60; // 2 days

// Gentle linear penalty past the grace window, and the floor it can't drop
// below. Paying is always positive: even very late, a completed payment is
// evidence of good faith, so the worst timing score is still a passing 50.
const PENALTY_PER_DAY = 5;
const MIN_TIMING_SCORE = 50;
const DAY_SECONDS = 24 * 60 * 60;

export const TAG_PAID_IN_FULL = "paid_in_full"; // no due date was set
export const TAG_PAID_ON_TIME = "paid_on_time"; // within due date + grace
export const TAG_PAID_LATE = "paid_late"; //       past the grace window

export type TimingScore = {
  score: number; // 0-100, clamped to [MIN_TIMING_SCORE, 100]
  tag: string;
  daysLate: number; // 0 when on time; whole days past the grace window otherwise
};

// Grade one payment by when it settled relative to its due date.
//
// dueDate/paidAt are Unix seconds. dueDate <= 0 means the bill had no deadline,
// which scores a clean 100 tagged paid_in_full — byte-identical treatment to
// how bills scored before due dates existed. With a deadline: full marks through
// due + grace, then -5 per whole day late down to a floor of 50.
export function scorePaymentTiming(dueDate: number, paidAt: number): TimingScore {
  if (!dueDate || dueDate <= 0) {
    return { score: 100, tag: TAG_PAID_IN_FULL, daysLate: 0 };
  }
  const lateBy = paidAt - dueDate - GRACE_SECONDS;
  if (lateBy <= 0) {
    return { score: 100, tag: TAG_PAID_ON_TIME, daysLate: 0 };
  }
  const daysLate = Math.ceil(lateBy / DAY_SECONDS);
  const score = Math.max(MIN_TIMING_SCORE, 100 - PENALTY_PER_DAY * daysLate);
  return { score, tag: TAG_PAID_LATE, daysLate };
}

export type WeightedRow = {
  score: number;
  shareUnits: number; // the payer's owed share, in USDC base units (6 dp)
};

// Amount-weighted mean of per-bill scores. Weight is the payer's share, so a
// $500 bill paid late moves the average far more than a $5 one. Falls back to a
// plain mean when every share is 0 (older rows recorded before shares were
// stored), so historical data still aggregates sensibly instead of vanishing.
export function weightedAverageScore(rows: WeightedRow[]): number | null {
  if (rows.length === 0) return null;
  const totalWeight = rows.reduce((sum, r) => sum + Math.max(0, r.shareUnits), 0);
  if (totalWeight <= 0) {
    return Math.round(rows.reduce((sum, r) => sum + r.score, 0) / rows.length);
  }
  const weighted = rows.reduce((sum, r) => sum + r.score * Math.max(0, r.shareUnits), 0);
  return Math.round(weighted / totalWeight);
}
