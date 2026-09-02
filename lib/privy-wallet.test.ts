import assert from "node:assert/strict";
import { test } from "node:test";
import { isNonceCollision, logsToWalletTxs, receiptToState } from "./privy-wallet.ts";

const SELF = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const log = (from: string, to: string, value: bigint, block: bigint, hash: string) => ({
  transactionHash: hash,
  blockNumber: block,
  args: { from, to, value },
});

test("a reverted receipt is FAILED, so callers checking Circle's states still work", () => {
  assert.equal(receiptToState("success"), "COMPLETE");
  assert.equal(receiptToState("reverted"), "FAILED");
});

test("direction is read from our own address, not from the log order", () => {
  const txs = logsToWalletTxs(
    [log(SELF, OTHER, 2_500_000n, 10n, "0xaa"), log(OTHER, SELF, 1_000_000n, 11n, "0xbb")],
    SELF,
  );
  assert.equal(txs[0]?.direction, "in", "newest block first");
  assert.equal(txs[0]?.amount, "1");
  assert.equal(txs[0]?.address, OTHER);
  assert.equal(txs[1]?.direction, "out");
  assert.equal(txs[1]?.amount, "2.5");
});

test("a self-transfer counts once as outgoing rather than twice", () => {
  const txs = logsToWalletTxs([log(SELF, SELF, 1n, 1n, "0xcc")], SELF);
  assert.equal(txs.length, 1);
  assert.equal(txs[0]?.direction, "out");
});

test("case never decides direction — an address is an address", () => {
  const txs = logsToWalletTxs([log(OTHER.toUpperCase(), SELF.toUpperCase(), 1_000_000n, 1n, "0xdd")], SELF);
  assert.equal(txs[0]?.direction, "in");
});

// "nonce too low" is Arc Testnet's own words, copied from a real rejection off
// https://rpc.testnet.arc.network ("nonce too low: next nonce 5, tx nonce 0") —
// what a send gets when the pending nonce it read had already been overtaken.
// "replacement transaction underpriced" is the geth family's answer to the same
// mistake and was NOT observed on Arc, which drops a racing loser instead of
// refusing it; it is matched anyway in case a keyed endpoint fronts such a node.
test("a nonce collision retries; anything else must not", () => {
  assert.equal(isNonceCollision(new Error("Details: nonce too low: next nonce 5, tx nonce 0")), true);
  assert.equal(isNonceCollision(new Error("Details: replacement transaction underpriced")), true);
  assert.equal(isNonceCollision(new Error("NONCE TOO LOW")), true, "case must not decide");
  // Retrying either of these just burns the same failure again.
  assert.equal(isNonceCollision(new Error("insufficient funds for gas * price + value")), false);
  assert.equal(isNonceCollision(new Error("execution reverted")), false);
  assert.equal(isNonceCollision(undefined), false);
});
