import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { broadcastTxHash, looksLikeTxHash, settlingVerdict, txFate, walletProviderName } from "./wallet-provider.ts";

const original = process.env.WALLET_PROVIDER;
afterEach(() => {
  if (original === undefined) delete process.env.WALLET_PROVIDER;
  else process.env.WALLET_PROVIDER = original;
});

test("circle is the default, so an unset var can never silently pick Privy", () => {
  delete process.env.WALLET_PROVIDER;
  assert.equal(walletProviderName(), "circle");
});

test("only the exact string 'privy' selects Privy", () => {
  process.env.WALLET_PROVIDER = "privy";
  assert.equal(walletProviderName(), "privy");
  for (const wrong of ["Privy", "privy ", "prvy", "", "true"]) {
    process.env.WALLET_PROVIDER = wrong;
    assert.equal(walletProviderName(), "circle", `${JSON.stringify(wrong)} must not select Privy`);
  }
});

test("a tx hash is 0x + 64 hex; a Circle transaction id is not", () => {
  assert.equal(looksLikeTxHash(`0x${"a".repeat(64)}`), true);
  assert.equal(looksLikeTxHash(`0x${"A".repeat(64)}`), true);
  // A real Circle id, which is what paid_tx_hash holds on the circle stack.
  assert.equal(looksLikeTxHash("6f8a1d3e-1b2c-4d5e-8f90-1234567890ab"), false);
  assert.equal(looksLikeTxHash(`0x${"a".repeat(63)}`), false);
  assert.equal(looksLikeTxHash(`0x${"z".repeat(64)}`), false);
  assert.equal(looksLikeTxHash(null), false);
});

const HASH = `0x${"a".repeat(64)}`;
const CIRCLE_ID = "6f8a1d3e-1b2c-4d5e-8f90-1234567890ab";

// Both backends tag a broadcast-but-unconfirmed throw with the same `broadcast`
// flag, and only ONE of them can name the transaction: lib/circle-dcw.ts:145 tags
// the poll error and has no chain hash to add, while lib/privy-wallet.ts attaches
// the hash it broadcast. That difference is the whole reason
// app/api/debts/[id]/pay/route.ts can park a Privy transfer in `settling` — where
// its own guard re-reads it — while leaving the circle stack's 502 untouched.
test("only a throw carrying a chain hash can park a debt in settling", () => {
  assert.equal(broadcastTxHash(Object.assign(new Error("poll failed"), { broadcast: true })), null);
  assert.equal(broadcastTxHash(Object.assign(new Error("indeterminate"), { broadcast: true, txHash: HASH })), HASH);
  // A Circle transaction id is not something the chain can be asked about.
  assert.equal(broadcastTxHash(Object.assign(new Error("x"), { broadcast: true, txHash: CIRCLE_ID })), null);
  assert.equal(broadcastTxHash(new Error("nothing was ever sent")), null);
  assert.equal(broadcastTxHash(undefined), null);
});

// What to do with a debt stuck at `settling`. Nothing else moves it on the Privy
// stack — /api/webhooks/circle is what flips one to paid and there is no Privy
// webhook to send it — so a wrong answer here either strands the debt for ever or
// hands the user a second Pay for money that already left.
test("a settling debt is only reopened once the chain proves nothing moved", () => {
  assert.equal(settlingVerdict("success"), "paid");
  // Reverted or dropped both mean it can never settle, so a retry is safe.
  assert.equal(settlingVerdict("reverted"), "retry");
  assert.equal(settlingVerdict("dropped"), "retry");
  // Absence is never proof: an unconfirmed transfer keeps today's 409.
  assert.equal(settlingVerdict("unknown"), "wait");
});

// The circle stack must not enter the re-check AT ALL: its settling rows hold a
// Circle transaction UUID, which names no chain transaction and which the Privy
// backend would be asked about for nothing. Answering off the shape of the ref
// costs no RPC call and loads no Privy SDK, so that stack keeps exactly the 409 it
// has today and its webhook stays the only thing that resolves one.
test("a Circle transaction id never reaches the chain", async () => {
  assert.equal(await txFate(CIRCLE_ID), "unknown");
  assert.equal(await txFate(null), "unknown");
  assert.equal(settlingVerdict(await txFate(CIRCLE_ID)), "wait", "the circle stack keeps its 409");
});
