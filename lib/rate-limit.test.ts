import test from "node:test";
import assert from "node:assert/strict";
import {
  pinLockMs,
  pinRetryAfterMs,
  PIN_FREE_ATTEMPTS,
  PIN_BASE_DELAY_MS,
  PIN_MAX_DELAY_MS,
} from "./rate-limit.ts";

// The escalation schedule is the whole defence on a 4-digit PIN, so it is worth
// pinning down rather than eyeballing. Everything here is pure — no database.

test("the free attempts cost nothing", () => {
  for (let i = 0; i <= PIN_FREE_ATTEMPTS; i++) {
    assert.equal(pinLockMs(i), 0, `attempt ${i} should be free`);
  }
});

test("the first failure past the allowance starts at the base delay", () => {
  assert.equal(pinLockMs(PIN_FREE_ATTEMPTS + 1), PIN_BASE_DELAY_MS);
});

test("each further failure doubles the wait", () => {
  assert.equal(pinLockMs(PIN_FREE_ATTEMPTS + 2), PIN_BASE_DELAY_MS * 2);
  assert.equal(pinLockMs(PIN_FREE_ATTEMPTS + 3), PIN_BASE_DELAY_MS * 4);
});

test("the wait is capped, and a huge count does not overflow to NaN", () => {
  assert.equal(pinLockMs(1_000), PIN_MAX_DELAY_MS);
  assert.equal(pinLockMs(Number.MAX_SAFE_INTEGER), PIN_MAX_DELAY_MS);
});

test("exhausting a 4-digit PIN would take decades", () => {
  // The property the numbers above exist to produce, summed over the ACTUAL
  // schedule rather than assumed: 10,000 candidates, the first few free, the
  // rest escalating to the daily cap. Most of the total is that cap.
  let totalMs = 0;
  for (let i = 1; i <= 10_000; i++) totalMs += pinLockMs(i);
  const years = totalMs / (365.25 * 24 * 3_600_000);
  assert.ok(years > 20, `expected decades, got ${years.toFixed(1)} years`);
});

test("no recorded failures means no wait", () => {
  assert.equal(pinRetryAfterMs(null, 1_000_000), 0);
});

test("the wait runs from the last attempt, not the first", () => {
  const now = 1_000_000_000;
  // Five failures: the window opened long ago, the last one was a minute back.
  const state = {
    count: PIN_FREE_ATTEMPTS + 1,
    windowStartMs: now - 10 * 3_600_000,
    lastAtMs: now - 60_000,
  };
  assert.equal(pinRetryAfterMs(state, now), PIN_BASE_DELAY_MS - 60_000);
});

test("the wait expires once it has been served", () => {
  const now = 1_000_000_000;
  const state = {
    count: PIN_FREE_ATTEMPTS + 1,
    windowStartMs: now - PIN_BASE_DELAY_MS * 2,
    lastAtMs: now - PIN_BASE_DELAY_MS - 1,
  };
  assert.equal(pinRetryAfterMs(state, now), 0);
});
