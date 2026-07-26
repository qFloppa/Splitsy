import test from "node:test";
import assert from "node:assert/strict";
import { resolveLedger, SCRIPTED_LEDGER } from "./landing-ledger.ts";
import { priceUsd } from "./x402/pricing.ts";

test("the scripted figures are the scripted transcript's own spend", () => {
  // The tiles render beside a transcript that quotes these prices, so derive
  // them from the price table rather than restate them: a typo here, or an OCR
  // price change, must fail loudly instead of contradicting the text next to it.
  const scripted = (priceUsd("/api/ocr") * 2 + priceUsd("/api/fx")).toFixed(3);
  assert.equal(SCRIPTED_LEDGER.earnedUsdc, scripted);
  assert.equal(SCRIPTED_LEDGER.spentUsdc, scripted);
  assert.equal(SCRIPTED_LEDGER.callsServed, "3");
  assert.equal(SCRIPTED_LEDGER.live, false);
});

test("falls back to the scripted figures when there is no payload", () => {
  assert.deepEqual(resolveLedger(null), SCRIPTED_LEDGER);
  assert.deepEqual(resolveLedger(undefined), SCRIPTED_LEDGER);
  assert.deepEqual(resolveLedger("nope"), SCRIPTED_LEDGER);
  assert.deepEqual(resolveLedger(42), SCRIPTED_LEDGER);
});

test("falls back when any single field is missing or unusable", () => {
  // A partial response is worse than none: mixing a real earned figure with a
  // scripted spent one produces two numbers that do not reconcile.
  assert.deepEqual(resolveLedger({ earnedUsd: 1, spentUsd: 1 }), SCRIPTED_LEDGER);
  assert.deepEqual(resolveLedger({ earnedUsd: 1, spentUsd: 1, callsServed: null }), SCRIPTED_LEDGER);
  assert.deepEqual(resolveLedger({ earnedUsd: "1", spentUsd: 1, callsServed: 3 }), SCRIPTED_LEDGER);
  assert.deepEqual(resolveLedger({ earnedUsd: NaN, spentUsd: 1, callsServed: 3 }), SCRIPTED_LEDGER);
  assert.deepEqual(resolveLedger({ earnedUsd: -1, spentUsd: 1, callsServed: 3 }), SCRIPTED_LEDGER);
});

test("formats a complete payload to three decimals and marks it live", () => {
  const tiles = resolveLedger({ earnedUsd: 0.0625, spentUsd: 0.041, callsServed: 18 });
  assert.equal(tiles.earnedUsdc, "0.063");
  assert.equal(tiles.spentUsdc, "0.041");
  assert.equal(tiles.callsServed, "18");
  assert.equal(tiles.live, true);
});

test("an all-zero ledger is still live, not a fallback", () => {
  // A fresh deploy has genuinely served nothing. Showing zeros is honest;
  // showing the scripted figures next to a 'live' dot would not be.
  const tiles = resolveLedger({ earnedUsd: 0, spentUsd: 0, callsServed: 0 });
  assert.equal(tiles.earnedUsdc, "0.000");
  assert.equal(tiles.callsServed, "0");
  assert.equal(tiles.live, true);
});

test("ignores extra fields the stats route also returns", () => {
  const tiles = resolveLedger({
    earnedUsd: 0.01,
    spentUsd: 0.005,
    callsServed: 2,
    callsPaid: 1,
    dailyCapUsd: 0.05,
    agent: { address: null, tokenId: null },
  });
  assert.equal(tiles.live, true);
  assert.equal(tiles.spentUsdc, "0.005");
});
