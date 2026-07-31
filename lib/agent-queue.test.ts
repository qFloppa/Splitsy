import test from "node:test";
import assert from "node:assert/strict";
import { shapeQueue } from "./agent-queue.ts";

const base = {
  creator: "0xabc",
  creatorScore: 80,
  verified: true,
  preimage: null,
};

test("only bills the contract would actually pay survive", () => {
  const entries = shapeQueue([
    { billId: "1", spendable: 2_500_000n, ...base },
    { billId: "2", spendable: 0n, ...base },
    { billId: "3", spendable: 1_000_000n, ...base },
  ]);
  assert.deepEqual(entries.map((e) => e.billId), ["1", "3"]);
});

test("base units are converted to USDC for the feed", () => {
  const entries = shapeQueue([{ billId: "1", spendable: 2_500_000n, ...base }]);
  assert.equal(entries[0].amountUsdc, 2.5);
});

test("an empty candidate list is an empty feed, not an error", () => {
  assert.deepEqual(shapeQueue([]), []);
});

test("the creator's facts are carried through for the agent to judge", () => {
  const entries = shapeQueue([
    { billId: "1", spendable: 1_000_000n, creator: "0xdef", creatorScore: null, verified: false, preimage: null },
  ]);
  assert.equal(entries[0].creator, "0xdef");
  assert.equal(entries[0].creatorScore, null);
  assert.equal(entries[0].verified, false);
});
