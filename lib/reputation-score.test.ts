import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GRACE_SECONDS,
  scorePaymentTiming,
  TAG_PAID_IN_FULL,
  TAG_PAID_LATE,
  TAG_PAID_ON_TIME,
  weightedAverageScore,
} from "./reputation-score.ts";

const DAY = 24 * 60 * 60;
const DUE = 1_800_000_000; // arbitrary fixed Unix second (no Date.now in tests)

test("no due date scores a clean 100, tagged paid_in_full", () => {
  assert.deepEqual(scorePaymentTiming(0, DUE), { score: 100, tag: TAG_PAID_IN_FULL, daysLate: 0 });
  assert.deepEqual(scorePaymentTiming(-1, DUE), { score: 100, tag: TAG_PAID_IN_FULL, daysLate: 0 });
});

test("paid before the due date is on time", () => {
  const r = scorePaymentTiming(DUE, DUE - DAY);
  assert.equal(r.score, 100);
  assert.equal(r.tag, TAG_PAID_ON_TIME);
});

test("paid within the grace window is still on time", () => {
  const r = scorePaymentTiming(DUE, DUE + GRACE_SECONDS - 1);
  assert.equal(r.score, 100);
  assert.equal(r.tag, TAG_PAID_ON_TIME);
  assert.equal(r.daysLate, 0);
});

test("one day past the grace window loses one day of penalty", () => {
  const r = scorePaymentTiming(DUE, DUE + GRACE_SECONDS + DAY);
  assert.equal(r.tag, TAG_PAID_LATE);
  assert.equal(r.daysLate, 1);
  assert.equal(r.score, 95);
});

test("partial days past grace round up to a whole day late", () => {
  const r = scorePaymentTiming(DUE, DUE + GRACE_SECONDS + 1);
  assert.equal(r.daysLate, 1);
  assert.equal(r.score, 95);
});

test("very late payments floor at 50, never below", () => {
  const r = scorePaymentTiming(DUE, DUE + GRACE_SECONDS + 100 * DAY);
  assert.equal(r.score, 50);
  assert.equal(r.tag, TAG_PAID_LATE);
});

test("weightedAverageScore returns null for no rows", () => {
  assert.equal(weightedAverageScore([]), null);
});

test("weightedAverageScore weights by share so a big late bill drags harder", () => {
  // A $5 bill (5e6 units) scored 100, a $500 bill (500e6 units) scored 60.
  // Plain mean would be 80; weighted skews toward the big bill's 60.
  const avg = weightedAverageScore([
    { score: 100, shareUnits: 5_000_000 },
    { score: 60, shareUnits: 500_000_000 },
  ]);
  // (100*5 + 60*500) / 505 = 60.4 → 60
  assert.equal(avg, 60);
});

test("weightedAverageScore falls back to plain mean when all shares are 0", () => {
  const avg = weightedAverageScore([
    { score: 100, shareUnits: 0 },
    { score: 50, shareUnits: 0 },
  ]);
  assert.equal(avg, 75);
});
