import assert from "node:assert/strict";
import { test } from "node:test";
import { sanitizeAmount } from "./amount-input.ts";

test("an ordinary amount is left alone", () => {
  assert.equal(sanitizeAmount("12.5"), "12.5");
  assert.equal(sanitizeAmount("0.01"), "0.01");
  assert.equal(sanitizeAmount("7"), "7");
  assert.equal(sanitizeAmount(""), "");
});

test("letters and symbols never reach the field", () => {
  assert.equal(sanitizeAmount("12abc"), "12");
  assert.equal(sanitizeAmount("$12.50"), "12.50");
  assert.equal(sanitizeAmount("-5"), "5");
  assert.equal(sanitizeAmount("1e9"), "19");
});

// A comma loses its comma and must NOT gain a decimal point it never had —
// "1,5" is fifteen here, not one-point-five, because nothing in this app types
// a comma as a decimal separator.
test("a comma is dropped, not promoted to a decimal point", () => {
  assert.equal(sanitizeAmount("1,5"), "15");
});

test("a second dot is swallowed rather than truncating the number", () => {
  assert.equal(sanitizeAmount("1.2.3"), "1.23");
  assert.equal(sanitizeAmount("1..5"), "1.5");
});

// USDC is six decimals. A seventh is dropped on chain, so a field that accepted
// one would show a figure that is not the one being sent.
test("decimals stop at six", () => {
  assert.equal(sanitizeAmount("1.1234567"), "1.123456");
  assert.equal(sanitizeAmount("1.123456"), "1.123456");
});

test("a paste cannot make the number unbounded", () => {
  assert.equal(sanitizeAmount("9".repeat(40)), "9".repeat(9));
  assert.equal(sanitizeAmount(`${"9".repeat(40)}.${"1".repeat(40)}`), `${"9".repeat(9)}.${"1".repeat(6)}`);
});

// Typing states that must survive, or the field fights the user mid-entry.
test("a partial entry stays typeable", () => {
  assert.equal(sanitizeAmount("."), ".");
  assert.equal(sanitizeAmount("0."), "0.");
  assert.equal(sanitizeAmount("12."), "12.");
});

// Whatever comes out must be something Number() can read, or it lands as NaN
// somewhere far from the field that accepted it.
test("every result is a number or empty", () => {
  for (const raw of ["12abc", "$12.50", "1,5", "1.2.3", "9".repeat(40), "1.1234567", "-5", "1e9"]) {
    const out = sanitizeAmount(raw);
    assert.ok(out === "" || Number.isFinite(Number(out)), `${JSON.stringify(raw)} -> ${JSON.stringify(out)}`);
  }
});
