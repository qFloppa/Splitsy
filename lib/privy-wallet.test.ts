import assert from "node:assert/strict";
import { test } from "node:test";
import { WaitForTransactionReceiptTimeoutError } from "viem";
import { isNonceCollision, logsToWalletTxs, receiptToState, verdictAfterWait } from "./privy-wallet.ts";

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

// listTransactions hands this the SAME log twice for a self-transfer — it comes
// back from both the `from` and the `to` filter — so the dedup has to live in here,
// not at the call site. Two rows would also be two React keys of the same value on
// the panel (app/XAuthControl.tsx:752).
test("a self-transfer counts once as outgoing rather than twice", () => {
  const one = log(SELF, SELF, 1n, 1n, "0xcc");
  const txs = logsToWalletTxs([one, one], SELF);
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

// The four ways a receipt wait can end, and what each one is allowed to tell a
// caller about the money. "dropped" is the only untagged answer and the only one
// that can be wrong in the unrecoverable direction: lib/autopay.ts:250 turns an
// untagged throw into `decision: "skip", amountUsdc: 0`, handing back a daily cap
// that was really spent, and app/api/debts/[id]/pay/route.ts leaves the debt
// pending so the user pays a second time. So it needs PROOF, not absence.
const timedOut = new WaitForTransactionReceiptTimeoutError({ hash: `0x${"a".repeat(64)}` });

test("a receipt that turned up wins over every other signal", () => {
  assert.equal(verdictAfterWait(timedOut, true, true), "mined");
  assert.equal(verdictAfterWait(timedOut, false, true), "mined");
  // Mined between the wait giving up and the nonce read: the slot is consumed by
  // OUR OWN transaction, which must never read as dropped.
  assert.equal(verdictAfterWait(new Error("some rpc failure"), true, true), "mined");
});

test("an exhausted wait plus a consumed nonce is the only dropped verdict", () => {
  assert.equal(verdictAfterWait(timedOut, true, false), "dropped");
});

test("an unconsumed nonce means the transaction can still mine", () => {
  assert.equal(verdictAfterWait(timedOut, false, false), "indeterminate");
});

test("anything but a timeout decides nothing — the wait never ran out", () => {
  // viem rejects immediately on any non-not-found error from the polled call
  // (waitForTransactionReceipt.js:195), and Arc answers -32011 "request limit
  // reached" under load. Seconds after a broadcast, unmined is the normal state.
  for (const err of [
    new Error("request limit reached"),
    new Error("socket hang up"),
    undefined,
    null,
    "not even an error",
  ]) {
    assert.equal(verdictAfterWait(err, true, false), "indeterminate", `${err} must not decide dropped`);
  }
});
