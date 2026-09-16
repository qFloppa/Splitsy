import assert from "node:assert/strict";
import { test } from "node:test";
import { gasTopUpUsdc } from "./slot-refund.ts";

// Arc charges gas in USDC, so a slot holding nothing cannot send the refund that
// would give it something. Both ways of getting the top-up wrong are silent: too
// little and the refund reverts for want of gas, too eager and the operator leaks a
// reserve on every retry.
const RESERVE = 0.05;

test("an empty slot is topped up to the whole reserve", () => {
  assert.equal(gasTopUpUsdc(0, RESERVE), 0.05);
});

test("a slot that can already pay gets nothing", () => {
  assert.equal(gasTopUpUsdc(0.05, RESERVE), 0);
  assert.equal(gasTopUpUsdc(12.5, RESERVE), 0);
});

test("a partly funded slot is topped up to the reserve, not by it", () => {
  // 0.05 - 0.02 is 0.030000000000000002 in float. The answer must be the clean
  // figure, because it goes straight into parseUnits.
  assert.equal(gasTopUpUsdc(0.02, RESERVE), 0.03);
});

test("the top-up is never short by a rounding error", () => {
  // One micro-USDC short of the reserve — the smallest real gap, since usdcBalanceOf
  // formats a bigint and can only ever land on a whole micro-USDC.
  const balance = 0.049999;
  const topUp = gasTopUpUsdc(balance, RESERVE);
  assert.equal(topUp, 0.000001);
  assert.ok(
    Math.round((balance + topUp) * 1e6) >= Math.round(RESERVE * 1e6),
    `${balance} + ${topUp} should reach ${RESERVE}`,
  );
});

test("a balance that cannot be read is treated as empty", () => {
  // usdcBalanceOf returning NaN must not become a NaN transfer amount.
  assert.equal(gasTopUpUsdc(Number.NaN, RESERVE), 0.05);
  assert.equal(gasTopUpUsdc(-1, RESERVE), 0.05);
});
