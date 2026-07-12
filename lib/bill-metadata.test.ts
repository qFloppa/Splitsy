import assert from "node:assert/strict";
import { test } from "node:test";
import { billMetadataHash, verifyBillPreimage, type BillPreimage } from "./bill-metadata.ts";

const preimage: BillPreimage = {
  merchant: "Joe's Diner",
  currency: "USD",
  total: 24.5,
  participantLabels: ["Alice", "Bob"],
};

test("verifyBillPreimage accepts the exact preimage", () => {
  const hash = billMetadataHash(preimage);
  assert.equal(verifyBillPreimage(preimage, hash), true);
});

test("verifyBillPreimage is case-insensitive on the hash", () => {
  const hash = billMetadataHash(preimage);
  assert.equal(verifyBillPreimage(preimage, hash.toUpperCase() as `0x${string}`), true);
});

test("any altered field flips verification to false", () => {
  const hash = billMetadataHash(preimage);
  assert.equal(verifyBillPreimage({ ...preimage, merchant: "Jane's Diner" }, hash), false);
  assert.equal(verifyBillPreimage({ ...preimage, total: 24.51 }, hash), false);
  assert.equal(verifyBillPreimage({ ...preimage, currency: "EUR" }, hash), false);
  assert.equal(verifyBillPreimage({ ...preimage, participantLabels: ["Alice", "Bob", "Carol"] }, hash), false);
  assert.equal(verifyBillPreimage({ ...preimage, participantLabels: ["Bob", "Alice"] }, hash), false);
});

test("hash is stable/deterministic across calls", () => {
  assert.equal(billMetadataHash(preimage), billMetadataHash({ ...preimage }));
});
