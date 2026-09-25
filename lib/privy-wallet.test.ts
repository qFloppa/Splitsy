import assert from "node:assert/strict";
import { test } from "node:test";
import { WaitForTransactionReceiptTimeoutError } from "viem";
import {
  GAS_RESERVE_USDC,
  LOG_CHUNK,
  claimLanded,
  fateFromReads,
  isNonceCollision,
  logsToWalletTxs,
  matchesPrepared,
  quorumLabel,
  receiptToState,
  settledOrThrow,
  sweepAmountUsdc,
  verdictAfterWait,
  walletSpec,
} from "./privy-wallet.ts";
import { isCustodial } from "./privy-wallets-repo.ts";
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

// ── The claim ──────────────────────────────────────────────────────────────────
// claimLanded decides whether Splitsy still holds a key to a wallet, and that
// verdict is written into privy_wallets.claimed_at, which every other route trusts.
// A false "landed" tells a user we hold nothing while we can still spend their
// money — so these cases are about refusing to be optimistic.
const QUORUM = "kq_ours";

test("a claim lands only when no signer remains AND ownership moved", () => {
  assert.deepEqual(
    claimLanded({ ownerId: "kq_theirs", remainingSigners: 0, quorumStillSigns: false }, QUORUM),
    { ok: true },
  );
});

// The failure Privy would produce if it ignored `additional_signers: []`: a 200
// response, ownership moved, and our quorum still able to spend. It must not read
// as a claim.
test("our quorum still signing is NOT a claim, however the rest looks", () => {
  const verdict = claimLanded({ ownerId: "kq_theirs", remainingSigners: 1, quorumStillSigns: true }, QUORUM);
  assert.equal(verdict.ok, false);
});

// Any other signer is also disqualifying. We do not know whose it is, and a wallet
// with a third-party signer is not one we can promise is solely the user's.
test("a signer that is not ours is still a signer", () => {
  const verdict = claimLanded({ ownerId: "kq_theirs", remainingSigners: 1, quorumStillSigns: false }, QUORUM);
  assert.equal(verdict.ok, false);
});

// Ownership that never moved means the update did not do what was asked, and the
// wallet is still entirely ours.
test("ownership still on our quorum is not a claim", () => {
  const verdict = claimLanded({ ownerId: QUORUM, remainingSigners: 0, quorumStillSigns: false }, QUORUM);
  assert.equal(verdict.ok, false);
});

// A dropped owner_id would make `ownerId !== quorum` true and sail through a naive
// check — while describing a wallet with no owner at all, which nobody can sign for.
test("a missing owner fails rather than passing on a bare inequality", () => {
  const verdict = claimLanded({ ownerId: null, remainingSigners: 0, quorumStillSigns: false }, QUORUM);
  assert.equal(verdict.ok, false);
});

// isCustodial is the read side of the same fact, and the ambiguity it exists to
// kill: a row with an export key but no claim is the OLD shape, where ownership
// moved and our signer stayed. Splitsy can still sign for that wallet.
test("an exported-but-unclaimed wallet is still custodial", () => {
  assert.equal(isCustodial({ claimed_at: null }), true);
  assert.equal(isCustodial({ claimed_at: "2026-09-11T00:00:00Z" }), false);
});

// The quorum claim tightens claimLanded: when the caller MADE the owner quorum it
// knows which id should come back, so "not ours" is weaker than it can afford.
test("an owner that is neither ours nor the quorum we made is not a claim", () => {
  const result = { ownerId: "kq_someone_else", remainingSigners: 0, quorumStillSigns: false };
  // Without the expectation it passes — it is not our quorum, which is all the
  // older check could ask.
  assert.equal(claimLanded(result, QUORUM).ok, true);
  // With it, a wallet handed to a third party is caught.
  const verdict = claimLanded(result, QUORUM, "kq_the_one_we_created");
  assert.equal(verdict.ok, false);
});

test("the quorum we created is accepted", () => {
  const result = { ownerId: "kq_the_one_we_created", remainingSigners: 0, quorumStillSigns: false };
  assert.deepEqual(claimLanded(result, QUORUM, "kq_the_one_we_created"), { ok: true });
});

// ── The sweep ──────────────────────────────────────────────────────────────────
// Arc charges gas in USDC, so sweeping the FULL balance always reverts: nothing
// is left to pay for the transfer. These are the two ways the arithmetic can be
// wrong in a way no type checker sees — a negative amount, and a dust transfer
// that costs more gas than it moves.
test("a balance at or below the gas reserve sweeps nothing, and never a negative", () => {
  // Exactly the reserve: the boundary, and the one most likely to be written as <.
  assert.equal(sweepAmountUsdc(GAS_RESERVE_USDC), 0);
  assert.equal(sweepAmountUsdc(GAS_RESERVE_USDC - 0.000001), 0);
  assert.equal(sweepAmountUsdc(0), 0);
  // A negative balance cannot happen on chain, but a subtraction that produced
  // one would be handed to parseUnits as a transfer amount.
  assert.equal(sweepAmountUsdc(-5), 0);
  // Non-finite, because usdcBalanceOf goes through Number() on a formatted string.
  assert.equal(sweepAmountUsdc(Number.NaN), 0);
  assert.equal(sweepAmountUsdc(Number.POSITIVE_INFINITY), 0);
});

test("a balance above the reserve sweeps the rest, truncated to USDC's 6 decimals", () => {
  assert.equal(sweepAmountUsdc(1), 0.95);
  assert.equal(sweepAmountUsdc(10.5), 10.45);
  // Truncated DOWN, never rounded up: asking for one micro-USDC more than the
  // wallet holds reverts, and parseUnits throws on more than 6 decimals.
  assert.equal(sweepAmountUsdc(0.0500005), 0);
  assert.equal(sweepAmountUsdc(0.051234567), 0.001234);
  // The reserve is a parameter so a caller can prove the boundary moves with it.
  assert.equal(sweepAmountUsdc(1, 0.25), 0.75);
  assert.equal(sweepAmountUsdc(0.25, 0.25), 0);
});

// ── The quorum label ───────────────────────────────────────────────────────────
// Privy caps display_name at 50 characters and answers 400 when it is longer. The
// cost of getting this wrong is not a bad label: createOwnerQuorum is the first
// call of the setup ceremony, so it fails AFTER the user has created a passkey and
// typed a password twice, and before any wallet exists to show for it.
test("a quorum label is never longer than Privy's 50-character cap", () => {
  // The provisioning caller, which is what actually blew the limit: "splitsy "
  // plus "user:" plus a 36-character UUID is 49 before truncation... and 56 with
  // the old "splitsy wallet " prefix, which is the 400 this test exists for.
  const uuid = "0e9d4e6e-9a1d-4b3a-9c2f-1a2b3c4d5e6f";
  assert.ok(quorumLabel(`user:${uuid}`).length <= 50);
  // The claim caller, which fits untruncated and must keep reading as it did.
  assert.equal(quorumLabel("wallet y43uwrgbf7i2gfgcmeir6lqp"), "splitsy wallet y43uwrgbf7i2gfgcmeir6lqp");
  // Nothing a caller can pass gets through: the clamp is here, not at the call
  // site, so a new caller cannot reintroduce this.
  assert.ok(quorumLabel("x".repeat(500)).length <= 50);
  assert.ok(quorumLabel("").length <= 50);
});

// ── matchesPrepared ───────────────────────────────────────────────────────────
// The only thing standing between a browser-signed transaction and a ledger row,
// once Privy's UI rather than our authorization payload is what the user approves.
// broadcastSigned proves WHO signed; this proves WHAT.

// The exact shape prepareTransfer builds (lib/privy-wallet.ts): snake_case, hex
// quantities, chain id as a number, no `value` because every call is a contract call.
const PREPARED = {
  to: "0x3600000000000000000000000000000000000000",
  data: "0xa9059cbb0000000000000000000000002222222222222222222222222222222222222222000000000000000000000000000000000000000000000000000000000007a120",
  nonce: "0x5",
  chain_id: 5042002,
  type: 2,
  gas_limit: "0xea60",
  max_fee_per_gas: "0x59682f00",
  max_priority_fee_per_gas: "0x3b9aca00",
};
// What viem's parseTransaction hands back for bytes signed against it.
const SIGNED = {
  to: PREPARED.to,
  data: PREPARED.data,
  nonce: 5,
  chainId: 5042002,
  value: undefined as bigint | undefined,
};

test("the transaction the server prepared matches itself", () => {
  assert.equal(matchesPrepared(SIGNED, PREPARED), true);
});

test("casing is not a difference — the chain does not care and neither may this", () => {
  assert.equal(matchesPrepared({ ...SIGNED, to: PREPARED.to.toUpperCase().replace("0X", "0x"), data: PREPARED.data.toUpperCase().replace("0X", "0x") }, PREPARED), true);
});

test("a different recipient, payload, nonce or chain is refused", () => {
  assert.equal(matchesPrepared({ ...SIGNED, to: "0x2222222222222222222222222222222222222222" }, PREPARED), false);
  assert.equal(matchesPrepared({ ...SIGNED, data: "0xdeadbeef" }, PREPARED), false);
  assert.equal(matchesPrepared({ ...SIGNED, nonce: 6 }, PREPARED), false);
  assert.equal(matchesPrepared({ ...SIGNED, chainId: 1 }, PREPARED), false);
});

// The substitution the check exists to stop: sign anything at all from your own
// wallet, hand it back against a ticket for a debt, and have the route mark that
// debt paid. Same signer, same wallet, so the recovery check would wave it through.
test("an unrelated transaction signed by the same wallet is refused", () => {
  assert.equal(
    matchesPrepared({ to: "0x9999999999999999999999999999999999999999", data: "0x", nonce: 5, chainId: 5042002 }, PREPARED),
    false,
  );
});

test("native value is refused, because nothing this app prepares carries any", () => {
  assert.equal(matchesPrepared({ ...SIGNED, value: 0n }, PREPARED), true);
  assert.equal(matchesPrepared({ ...SIGNED, value: 1n }, PREPARED), false);
});

test("missing fields are refused rather than treated as a match", () => {
  assert.equal(matchesPrepared({ ...SIGNED, nonce: undefined }, PREPARED), false);
  assert.equal(matchesPrepared({ ...SIGNED, to: null }, PREPARED), false);
  assert.equal(matchesPrepared({ ...SIGNED, chainId: undefined }, PREPARED), false);
});

// Gas is free on purpose: a signer that re-estimates upward settles the same
// transfer out of the user's own gas, and one that estimates too low reverts and
// is refused by the receipt check instead.
test("a different gas estimate is not a mismatch", () => {
  assert.equal(matchesPrepared(SIGNED, { ...PREPARED, gas_limit: "0x1d4c0", max_fee_per_gas: "0x77359400" }), true);
});

// THE BUG THIS GUARDS: LOG_CHUNK sat at 20_000n while Arc's node had quietly
// dropped its eth_getLogs cap, so the FIRST chunk of every history walk threw and
// the wallet panel showed "couldn't read the chain" for every user — a stale
// constant, visible only as a vague message. fromBlock..toBlock is inclusive, so
// the range asked for is LOG_CHUNK + 1 blocks.
//
// Measured 2026-09-25 against https://rpc.testnet.arc.network: 9_000 is served,
// 10_000 is refused with "requested range too large". Widening this means
// re-measuring, not guessing — the last guess cost a working history tab.
test("the history chunk fits the eth_getLogs range Arc actually serves", () => {
  assert.ok(LOG_CHUNK <= 9_000n, `LOG_CHUNK ${LOG_CHUNK} exceeds Arc's measured 9k getLogs cap`);
});
