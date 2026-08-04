import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SHARE_TOKEN_LENGTH,
  isShareToken,
  newShareToken,
  coveredByOthers,
  payableRows,
  selectionTotalUnits,
} from "./pay-link.ts";

test("generated tokens are base62 and the declared length", () => {
  for (let i = 0; i < 200; i += 1) {
    const token = newShareToken();
    assert.equal(token.length, SHARE_TOKEN_LENGTH);
    assert.match(token, /^[A-Za-z0-9]+$/);
    assert.equal(isShareToken(token), true);
  }
});

test("generated tokens do not repeat", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 500; i += 1) seen.add(newShareToken());
  assert.equal(seen.size, 500);
});

test("the validator rejects everything that is not a plausible token", () => {
  assert.equal(isShareToken("short"), false);              // under 16
  assert.equal(isShareToken(""), false);
  assert.equal(isShareToken("a".repeat(65)), false);       // over 64
  assert.equal(isShareToken("has-a-dash-in-it-here"), false);
  assert.equal(isShareToken("has a space in it xx"), false);
  assert.equal(isShareToken("../../etc/passwd/aaaa"), false);
  assert.equal(isShareToken(null), false);
  assert.equal(isShareToken(12345678901234567890), false);
  assert.equal(isShareToken("a".repeat(16)), true);        // boundary
  assert.equal(isShareToken("a".repeat(64)), true);        // boundary
});

test("selection total sums only the selected rows, in base units", () => {
  const rows = [
    { address: "0xAAA", remainingUnits: "42500000" },
    { address: "0xBBB", remainingUnits: "18000000" },
    { address: "0xCCC", remainingUnits: "36000000" },
  ];
  assert.equal(selectionTotalUnits(rows, ["0xAAA", "0xCCC"]), 78500000n);
  assert.equal(selectionTotalUnits(rows, []), 0n);
  assert.equal(selectionTotalUnits(rows, ["0xAAA", "0xBBB", "0xCCC"]), 96500000n);
});

test("selection matching is case-insensitive on both sides", () => {
  const rows = [{ address: "0xAbCdEf", remainingUnits: "1000000" }];
  assert.equal(selectionTotalUnits(rows, ["0xabcdef"]), 1000000n);
  assert.equal(selectionTotalUnits([{ address: "0xabcdef", remainingUnits: "1000000" }], ["0xABCDEF"]), 1000000n);
});

test("an address that is not a row contributes nothing", () => {
  const rows = [{ address: "0xAAA", remainingUnits: "5000000" }];
  assert.equal(selectionTotalUnits(rows, ["0xZZZ"]), 0n);
});

test("odd cents survive the round trip with no float drift", () => {
  const rows = [
    { address: "0x1", remainingUnits: "3333333" }, // $3.333333
    { address: "0x2", remainingUnits: "3333333" },
    { address: "0x3", remainingUnits: "3333334" },
  ];
  assert.equal(selectionTotalUnits(rows, ["0x1", "0x2", "0x3"]), 10000000n);
});

test("payable rows exclude anything already settled", () => {
  const rows = [
    { address: "0xAAA", remainingUnits: "42500000" },
    { address: "0xBBB", remainingUnits: "0" },
    { address: "0xCCC", remainingUnits: "36000000" },
  ];
  assert.deepEqual(payableRows(rows).map((r) => r.address), ["0xAAA", "0xCCC"]);
  assert.deepEqual(payableRows([{ address: "0xD", remainingUnits: "0" }]), []);
});

test("a failed row that is now settled reads as covered by someone else", () => {
  // The row we tried to pay went to zero while we were signing — someone else
  // got there first. The other failure is a genuine one: still owed.
  const afterRun = [
    { address: "0xAAA", remainingUnits: "0" },
    { address: "0xBBB", remainingUnits: "1990000" },
    { address: "0xCCC", remainingUnits: "0" },
  ];
  assert.deepEqual(coveredByOthers(afterRun, ["0xAAA", "0xBBB"]), ["0xAAA"]);
  // Case cannot decide the outcome: the API renders checksummed addresses and
  // the social route echoes back whatever casing the client sent.
  assert.deepEqual(coveredByOthers(afterRun, ["0xaaa"]), ["0xaaa"]);
  // A row that never failed is never reported, settled or not.
  assert.deepEqual(coveredByOthers(afterRun, []), []);
  // No fresh read (the refetch itself failed) → nothing is claimed as covered.
  assert.deepEqual(coveredByOthers([], ["0xAAA"]), []);
});
