import { test } from "node:test";
import assert from "node:assert/strict";
import { canSpend, remainingBudget } from "./spend.ts";

test("canSpend allows when under cap", () => {
  assert.equal(canSpend(0.01, 0.005, 0.05), true);
});
test("canSpend blocks when next would exceed cap", () => {
  assert.equal(canSpend(0.048, 0.005, 0.05), false);
});
test("canSpend allows exact fit to cap", () => {
  assert.equal(canSpend(0.045, 0.005, 0.05), true);
});
test("remainingBudget never negative", () => {
  assert.equal(remainingBudget(0.06, 0.05), 0);
  assert.equal(remainingBudget(0.02, 0.05), 0.03);
});
