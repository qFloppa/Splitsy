import { test } from "node:test";
import assert from "node:assert/strict";
import { assessImage, shouldPayAgain, pickBetterParse, CONFIDENCE_THRESHOLD } from "./decide.ts";

test("assessImage rejects tiny files", () => {
  assert.equal(assessImage(2_000, 1000, 1000).ok, false);
});
test("assessImage rejects tiny dimensions", () => {
  assert.equal(assessImage(500_000, 80, 80).ok, false);
});
test("assessImage accepts a real photo", () => {
  assert.equal(assessImage(500_000, 1200, 1600).ok, true);
});
test("shouldPayAgain only when low confidence AND affordable", () => {
  assert.equal(shouldPayAgain(CONFIDENCE_THRESHOLD - 0.1, true), true);
  assert.equal(shouldPayAgain(CONFIDENCE_THRESHOLD - 0.1, false), false);
  assert.equal(shouldPayAgain(CONFIDENCE_THRESHOLD + 0.1, true), false);
});
test("pickBetterParse takes higher confidence", () => {
  assert.equal(pickBetterParse({ confidence: 0.6 }, { confidence: 0.9 }).confidence, 0.9);
});
