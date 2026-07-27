import assert from "node:assert/strict";
import test from "node:test";
import { billDiscount, normalizeParsedBill, retotalBill } from "./snapsplit.ts";

// A scanned bill whose total is $5 below its own breakdown: the receipt applied
// a discount the OCR didn't itemize.
const discounted = normalizeParsedBill({ subtotal: 100, tax: 8, tip: 10, total: 113 });

test("a total below subtotal + tax + tip reads as a discount", () => {
  assert.equal(billDiscount(discounted), 5);
  assert.equal(billDiscount(normalizeParsedBill({ subtotal: 100, tax: 8, tip: 10, total: 118 })), 0);
});

test("editing a component moves the total and keeps the discount", () => {
  const edited = retotalBill(discounted, { ...discounted, tip: 20 });
  assert.equal(edited.total, 123);
  assert.equal(billDiscount(edited), 5);
});

test("an unlisted-charge bill (total above the parts) gains no phantom discount", () => {
  const surcharged = normalizeParsedBill({ subtotal: 100, tax: 0, tip: 0, total: 110 });
  assert.equal(retotalBill(surcharged, { ...surcharged, tax: 9 }).total, 109);
});

test("a total-only bill keeps its total when a component is filled in", () => {
  const totalOnly = normalizeParsedBill({ total: 50 });
  assert.equal(retotalBill(totalOnly, { ...totalOnly, tax: 4 }).total, 50);
});

test("a discount larger than the remaining parts floors the total at zero", () => {
  const edited = retotalBill(discounted, { ...discounted, subtotal: 0, tax: 0, tip: 0 });
  assert.equal(edited.total, 0);
});
