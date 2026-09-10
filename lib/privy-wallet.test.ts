import assert from "node:assert/strict";
import { test } from "node:test";
import { WaitForTransactionReceiptTimeoutError } from "viem";
import {
  fateFromReads,
  isNonceCollision,
  logsToWalletTxs,
  receiptToState,
  settledOrThrow,
  verdictAfterWait,
  walletSpec,
} from "./privy-wallet.ts";
import { isBroadcast } from "./wallet-provider.ts";

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

const MINED = `0x${"e".repeat(64)}` as const;

// A MINED RECEIPT IS NOT A SUCCESS, and handing one back as `state: "FAILED"` is
// only safe if every caller reads state. Three of them do; eight others answered
// `{ok: true, txHash}` for a reverted transaction, one of those committing an
// ERC-8004 paid_in_full score against it. Circle throws here
// (lib/circle-dcw.ts:158-162) and this is what makes both backends throw alike.
test("a reverted receipt throws rather than being handed back as a state", () => {
  assert.deepEqual(settledOrThrow(MINED, "success"), { id: MINED, state: "COMPLETE", txHash: MINED });
  assert.throws(
    () => settledOrThrow(MINED, "reverted"),
    (err: unknown) =>
      err instanceof Error &&
      err.message.includes(MINED) &&
      /revert/i.test(err.message) &&
      // UNTAGGED, exactly as Circle leaves a FAILED: a revert burned gas and moved
      // no USDC, so tagging it would charge the day's autopay cap for money that
      // never left (app/api/agents/autopay/route.ts:645-651) and would park a debt
      // in `settling` when the honest answer is "try again".
      !isBroadcast(err),
  );
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

// The same question asked from OUTSIDE a wait, by the two callers that hold a hash
// and no receipt: app/api/debts/[id]/pay/route.ts re-reading the transfer it parked
// in `settling` minutes ago, and send() after a broadcast whose ANSWER was lost.
// Same doctrine as verdictAfterWait — a receipt is proof, a consumed nonce with no
// receipt of ours is proof, and everything else is "unknown", the answer that
// invents neither a settlement nor a failure.
test("a receipt decides; a consumed nonce with no receipt is the only other proof", () => {
  assert.equal(fateFromReads("success", false), "success");
  assert.equal(fateFromReads("reverted", false), "reverted");
  // The receipt is read AFTER the nonce, so it beats it however that read came out.
  assert.equal(fateFromReads("success", true), "success");
  assert.equal(fateFromReads("reverted", true), "reverted");
  // The slot went to different bytes, so ours can never mine.
  assert.equal(fateFromReads(null, true), "dropped");
  // Unmined at a nonce nobody has spent: a perfectly live transaction looks like
  // this, and so does one the node never accepted. Neither is provable, so neither
  // is claimed.
  assert.equal(fateFromReads(null, false), "unknown");
});

// ── walletSpec ────────────────────────────────────────────────────────────────
// Creation-only properties get a test because creation is the only chance to set
// them. A wallet minted without owner_id is owned by a quorum Privy picked and
// nobody holds, which makes it permanently non-exportable — and scripts/privy-
// setup.ts shipped exactly that bug, silently, for the whole branch.
// setEnv, not Object.assign: assigning `undefined` onto process.env stores the
// STRING "undefined", which is truthy and would make an "unset" test silently
// assert nothing. Deleting is the only way to actually unset one.
const setEnv = (env: Record<string, string | undefined>) => {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
};

const withEnv = <T,>(env: Record<string, string | undefined>, fn: () => T): T => {
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  setEnv(env);
  try {
    return fn();
  } finally {
    setEnv(saved);
  }
};

test("every wallet is minted owned by the quorum AND signed by it", () => {
  const spec = withEnv({ PRIVY_KEY_QUORUM_ID: "q-1", PRIVY_AGENT_POLICY_ID: undefined }, () =>
    walletSpec("pay:x", "idem-1"),
  );
  // Owner is what makes the wallet exportable; the additional signer is what
  // keeps the server able to spend AFTER ownership moves to the user's key. The
  // whole export design rests on those being two different things.
  assert.equal(spec.owner_id, "q-1");
  assert.deepEqual(spec.additional_signers, [{ signer_id: "q-1" }]);
  assert.equal(spec.chain_type, "ethereum");
  assert.equal(spec.idempotency_key, "idem-1");
});

test("only the agent wallet carries the enclave policy", () => {
  const env = { PRIVY_KEY_QUORUM_ID: "q-1", PRIVY_AGENT_POLICY_ID: "pol-9" };
  const agent = withEnv(env, () => walletSpec("agent", "i"));
  assert.deepEqual(agent.additional_signers, [{ signer_id: "q-1", override_policy_ids: ["pol-9"] }]);
  // A pay wallet is only ever spent on a request the user made, so it gets no cap.
  const pay = withEnv(env, () => walletSpec("pay:twitter", "i"));
  assert.deepEqual(pay.additional_signers, [{ signer_id: "q-1" }]);
});

test("an unset quorum fails the mint instead of minting an unowned wallet", () => {
  // The failure mode this refuses: a wallet created with no owner is one Privy
  // assigns itself, and that is unrecoverable rather than merely broken.
  assert.throws(
    () => withEnv({ PRIVY_KEY_QUORUM_ID: undefined }, () => walletSpec("pay:x", "i")),
    /PRIVY_KEY_QUORUM_ID is not set/,
  );
  // Whitespace is not an id. Untrimmed, this padded value would mint wallets
  // whose owner never matches the quorum we compare against later.
  assert.throws(
    () => withEnv({ PRIVY_KEY_QUORUM_ID: "   " }, () => walletSpec("pay:x", "i")),
    /PRIVY_KEY_QUORUM_ID is not set/,
  );
});

test("the quorum id is trimmed, so a padded env var still matches Privy's owner", () => {
  const spec = withEnv({ PRIVY_KEY_QUORUM_ID: " q-1\n", PRIVY_AGENT_POLICY_ID: undefined }, () =>
    walletSpec("pay:x", "i"),
  );
  assert.equal(spec.owner_id, "q-1");
});
