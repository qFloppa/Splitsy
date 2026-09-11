// The ticket is the guard on every user-signed relay, so it is the thing that has
// to be hard to forge and impossible to repurpose.
//
// It replaced a per-route calldata re-derivation (the old relayGuard, and this
// file's previous contents). That check could only compare what it knew to look
// at — it never covered the nonce, the gas or the chain id — and it needed a fresh
// implementation per route. The ticket carries the server's own bytes instead, so
// these tests are about the ENVELOPE: forgery, expiry, and the three bindings that
// stop one legitimate ticket being spent as another.
import assert from "node:assert/strict";
import { test } from "node:test";
import { signTxTicket, verifyTxTicket, type TxTicket } from "./tx-ticket.ts";

const SECRET = "test-secret-at-least-32-chars-long-ok";
const NOW = 1_757_000_000_000;

const TX = {
  to: "0x3600000000000000000000000000000000000000",
  data: "0xa9059cbb0000000000000000000000000000000000000000000000000000000000000001",
  nonce: "0x0",
  chain_id: 5042002,
  type: 2,
  gas_limit: "0x5208",
  max_fee_per_gas: "0x3b9aca00",
  max_priority_fee_per_gas: "0x3b9aca00",
};

const ticket = (over: Partial<TxTicket> = {}): TxTicket => ({
  transaction: TX,
  userId: "user-1",
  walletId: "wal-1",
  context: "debt:abc",
  expiresAt: NOW + 60_000,
  ...over,
});

test("a ticket round-trips with its transaction intact", () => {
  const got = verifyTxTicket(signTxTicket(ticket(), SECRET), SECRET, NOW);
  assert.ok(got);
  // The WHOLE transaction, field for field. The relay hands this straight to
  // Privy, so a helper that dropped or reshaped a field would produce a
  // well-formed request that signs different bytes than the user approved.
  assert.deepEqual(got.transaction, TX);
  assert.equal(got.context, "debt:abc");
});

// THE FORGERY CASE. Without this the client could hand back any transaction it
// liked and the relay would sign it from the user's wallet.
test("a tampered payload does not verify", () => {
  const token = signTxTicket(ticket(), SECRET);
  const [payload, sig] = token.split(".");
  const evil = Buffer.from(
    JSON.stringify(ticket({ transaction: { ...TX, to: "0x1111111111111111111111111111111111111111" } })),
  ).toString("base64url");
  assert.equal(verifyTxTicket(`${evil}.${sig}`, SECRET, NOW), null);
  // And the original signature is not reusable for a different payload either way.
  assert.notEqual(payload, evil);
});

test("a ticket signed with another secret does not verify", () => {
  assert.equal(verifyTxTicket(signTxTicket(ticket(), "a-different-secret-entirely-32ch"), SECRET, NOW), null);
});

test("an expired ticket does not verify", () => {
  const token = signTxTicket(ticket({ expiresAt: NOW - 1 }), SECRET);
  assert.equal(verifyTxTicket(token, SECRET, NOW), null);
});

// Expiry is INSIDE the signed payload, so a client cannot extend its own ticket.
test("the expiry cannot be edited without breaking the signature", () => {
  const token = signTxTicket(ticket({ expiresAt: NOW - 1 }), SECRET);
  const sig = token.slice(token.lastIndexOf(".") + 1);
  const extended = Buffer.from(JSON.stringify(ticket({ expiresAt: NOW + 600_000 }))).toString("base64url");
  assert.equal(verifyTxTicket(`${extended}.${sig}`, SECRET, NOW), null);
});

test("garbage is rejected rather than thrown on", () => {
  for (const bad of ["", ".", "no-dot", "a.b", "$$$.$$$", Buffer.from("{").toString("base64url") + ".x"]) {
    assert.equal(verifyTxTicket(bad, SECRET, NOW), null);
  }
});

// A ticket signed by an OLDER build could carry a shape this one does not expect,
// and the relay would then hand `undefined` to Privy as a wallet id. Verified
// signature, wrong shape, still refused.
test("a validly signed ticket of the wrong shape is refused", () => {
  for (const broken of [
    { ...ticket(), walletId: undefined },
    { ...ticket(), userId: 42 },
    { ...ticket(), context: null },
    { ...ticket(), transaction: null },
    { ...ticket(), expiresAt: "soon" },
  ]) {
    const payload = Buffer.from(JSON.stringify(broken)).toString("base64url");
    const token = signTxTicket(broken as unknown as TxTicket, SECRET);
    assert.equal(verifyTxTicket(token, SECRET, NOW), null, `accepted ${payload.slice(0, 12)}…`);
  }
});

// The three bindings the relay checks. verifyTxTicket returns them rather than
// enforcing them — the route knows its own session — so what is asserted here is
// that they SURVIVE the round trip and can actually be compared.
test("the bindings come back for the relay to check", () => {
  const got = verifyTxTicket(signTxTicket(ticket(), SECRET), SECRET, NOW);
  assert.ok(got);
  assert.equal(got.userId, "user-1");
  assert.equal(got.walletId, "wal-1");
  assert.equal(got.context, "debt:abc");
});

// Domain separation: an unlock cookie shares the secret, and its payload must not
// verify here. Shape-checking is what actually stops it, which is why that check
// exists after the HMAC rather than instead of it.
test("a wallet-unlock token is not a ticket", async () => {
  const { signWalletUnlock } = await import("./session-core.ts");
  assert.equal(verifyTxTicket(signWalletUnlock("user-1", NOW + 60_000, SECRET), SECRET, NOW), null);
});
