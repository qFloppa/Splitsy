import test from "node:test";
import assert from "node:assert/strict";
import { describeDailyCeiling, describeHoldWindow } from "./security-facts.ts";

// The /security page prints both of these as promises to a reader deciding
// whether to trust the escrow with money. A units mistake here is the same class
// of bug scripts/deploy-handle-escrow.ts documents having already shipped once —
// a ceiling of 2000 base units ($0.002) typed where 2000 USDC was meant — except
// on the page it reads as a reassurance rather than as a revert.

test("the ceiling is printed in USDC, not in the token's base units", () => {
  assert.equal(describeDailyCeiling(10_000_000_000n), "10,000 USDC");
  assert.equal(describeDailyCeiling(1_000_000n), "1 USDC");
});

// The exact failure the deploy script's floors exist to reject. If an escrow were
// ever deployed with it, the page must say what the contract will actually do —
// refuse almost every deposit — not flatter it by a millionfold.
test("a ceiling typed in base units reads as the tiny number it is", () => {
  assert.equal(describeDailyCeiling(2000n), "0.002 USDC");
});

test("a fractional ceiling keeps its cents and drops trailing zeros", () => {
  assert.equal(describeDailyCeiling(2_500_500_000n), "2,500.50 USDC");
  assert.equal(describeDailyCeiling(2_500_000_000n), "2,500 USDC");
});

test("whole days are printed as days, and one day is singular", () => {
  assert.equal(describeHoldWindow(2_592_000n), "30 days");
  assert.equal(describeHoldWindow(86_400n), "1 day");
  assert.equal(describeHoldWindow(604_800n), "7 days");
});

// Rounding UP rather than down, deliberately. The page's claim is "after this,
// the only way out is back to you" — a window printed shorter than it really is
// would promise the release path closes sooner than it does, which is the error
// that flatters us. Hours rather than a rounded-up day because "2 days" for 25
// hours overstates by a factor nobody would read as honest either.
test("a window that is not whole days is printed in hours, rounded up", () => {
  assert.equal(describeHoldWindow(90_000n), "25 hours");
  assert.equal(describeHoldWindow(90_001n), "26 hours");
  assert.equal(describeHoldWindow(172_800n + 3_600n), "49 hours");
});

// Below the 1-day floor scripts/deploy-handle-escrow.ts refuses to deploy under.
// That floor exists because "30 days" typed as `30` once shipped, and an escrow
// carrying it would render here as a confident "1 hour". Dropping the figure is
// the honest output: the page says "a fixed window" and prints no number it
// cannot stand behind.
test("a window below the deploy floor is treated as unread rather than printed", () => {
  assert.equal(describeHoldWindow(3_600n), null);
  assert.equal(describeHoldWindow(30n), null);
});

// A failed or unconfigured read must leave the sentence without a number rather
// than print a default. The page has no business inventing either bound: both are
// immutable constructor arguments, and the whole point of reading them live is
// that the page cannot drift from the deployment.
test("nothing read means nothing printed", () => {
  assert.equal(describeHoldWindow(null), null);
  assert.equal(describeDailyCeiling(null), null);
  assert.equal(describeHoldWindow(0n), null);
  assert.equal(describeDailyCeiling(0n), null);
});
