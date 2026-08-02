import test from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";
import {
  buildLinkMessage,
  buildSigninMessage,
  isStaleWalletSession,
  verifyLinkSignature,
  verifySigninSignature,
  LINK_MAX_AGE_MS,
} from "./agent-link.ts";

const account = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);
const other = privateKeyToAccount(
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
);

const NOW = 1_770_000_000_000; // fixed clock; the module must never call Date.now itself
const stamp = new Date(NOW).toISOString();

test("buildLinkMessage pins the address, handle, provider and timestamp", () => {
  const message = buildLinkMessage(account.address, "ada", "x", stamp);
  assert.ok(message.includes(account.address.toLowerCase()));
  assert.ok(message.includes("@ada"));
  assert.ok(message.includes(" on x "));
  assert.ok(message.includes(stamp));

  // Casing is normalised on every field, because handles are looked up
  // case-insensitively everywhere in the schema while users.handle keeps the
  // provider's display casing. Drop the lowercasing and a user whose client
  // sends "Ada" could never link at all.
  assert.equal(
    buildLinkMessage(account.address, "Ada", "X", stamp),
    buildLinkMessage(account.address, "ada", "x", stamp),
  );
});

test("a signature from the claimed address is accepted", async () => {
  const message = buildLinkMessage(account.address, "ada", "x", stamp);
  const signature = await account.signMessage({ message });

  const result = await verifyLinkSignature({
    address: account.address,
    handle: "ada",
    provider: "x",
    message,
    signature,
    nowMs: NOW,
  });
  assert.deepEqual(result, { ok: true });
});

test("a signature from a different wallet is rejected", async () => {
  const message = buildLinkMessage(account.address, "ada", "x", stamp);
  const signature = await other.signMessage({ message });

  const result = await verifyLinkSignature({
    address: account.address,
    handle: "ada",
    provider: "x",
    message,
    signature,
    nowMs: NOW,
  });
  assert.equal(result.ok, false);
});

test("a stale timestamp is rejected even with a valid signature", async () => {
  const message = buildLinkMessage(account.address, "ada", "x", stamp);
  const signature = await account.signMessage({ message });

  const result = await verifyLinkSignature({
    address: account.address,
    handle: "ada",
    provider: "x",
    message,
    signature,
    nowMs: NOW + LINK_MAX_AGE_MS + 1,
  });
  assert.equal(result.ok, false);
});

// The other direction of the window. Without this, narrowing the check to
// `nowMs - signedAt > MAX` would leave a signature dated far in the future
// valid forever, and the whole suite would still pass.
test("a future timestamp is rejected too, not just a stale one", async () => {
  const message = buildLinkMessage(account.address, "ada", "x", stamp);
  const signature = await account.signMessage({ message });

  const result = await verifyLinkSignature({
    address: account.address,
    handle: "ada",
    provider: "x",
    message,
    signature,
    nowMs: NOW - LINK_MAX_AGE_MS - 1,
  });
  assert.deepEqual(result, { ok: false, error: "That link request expired. Try again." });
});

// A correctly-signed message whose timestamp line is not a date at all. The body
// matches what the session claims, so only the parse guard can reject it.
test("an unreadable timestamp is rejected, not treated as time zero", async () => {
  const message = buildLinkMessage(account.address, "ada", "x", "not-a-date");
  const signature = await account.signMessage({ message });

  const result = await verifyLinkSignature({
    address: account.address,
    handle: "ada",
    provider: "x",
    message,
    signature,
    nowMs: NOW,
  });
  assert.deepEqual(result, {
    ok: false,
    error: "That link request has no readable timestamp.",
  });
});

test("a message whose body does not match the claim is rejected", async () => {
  // Signed correctly, but for a DIFFERENT handle than the session claims.
  const message = buildLinkMessage(account.address, "mallory", "x", stamp);
  const signature = await account.signMessage({ message });

  const result = await verifyLinkSignature({
    address: account.address,
    handle: "ada",
    provider: "x",
    message,
    signature,
    nowMs: NOW,
  });
  assert.equal(result.ok, false);
});

// The regression that matters: a handle is unique only WITHIN a provider, so
// @ada on x and @ada on discord are different people. Mallory, holding the
// discord handle "ada", phishes X-@ada into signing a message naming the
// victim's own handle and own address — then replays it from her own session.
// If the provider were not in the signed bytes, this would link the victim's
// wallet to Mallory's account.
test("a signature for one provider cannot be replayed on another", async () => {
  const message = buildLinkMessage(account.address, "ada", "x", stamp);
  const signature = await account.signMessage({ message });

  const result = await verifyLinkSignature({
    address: account.address,
    handle: "ada",
    provider: "discord",
    message,
    signature,
    nowMs: NOW,
  });
  assert.deepEqual(result, {
    ok: false,
    error: "That signature was not for this account and wallet.",
  });
});

// ── Sign-in ──────────────────────────────────────────────────────────────────
// Signing in MINTS an account and a session; linking only widens the reach of
// one that already exists. So the two messages must be mutually inert: neither
// signature may be replayed as the other.

test("a link signature is not a sign-in, and a sign-in is not a link", async () => {
  const link = buildLinkMessage(account.address, "ada", "x", stamp);
  const signin = buildSigninMessage(account.address, stamp);
  assert.notEqual(link, signin);

  const asSignin = await verifySigninSignature({
    address: account.address,
    message: link,
    signature: await account.signMessage({ message: link }),
    nowMs: NOW,
  });
  assert.deepEqual(asSignin, {
    ok: false,
    error: "That signature was not a Splitsy sign-in for this wallet.",
  });

  const asLink = await verifyLinkSignature({
    address: account.address,
    handle: "ada",
    provider: "x",
    message: signin,
    signature: await account.signMessage({ message: signin }),
    nowMs: NOW,
  });
  assert.deepEqual(asLink, {
    ok: false,
    error: "That signature was not for this account and wallet.",
  });
});

test("a sign-in signature from the claimed address is accepted", async () => {
  const message = buildSigninMessage(account.address, stamp);
  const result = await verifySigninSignature({
    address: account.address,
    message,
    signature: await account.signMessage({ message }),
    nowMs: NOW,
  });
  assert.deepEqual(result, { ok: true });
});

// The address is the account: a signature from any other key must never mint
// one under it.
test("a sign-in signed by a different wallet is rejected", async () => {
  const message = buildSigninMessage(account.address, stamp);
  const result = await verifySigninSignature({
    address: account.address,
    message,
    signature: await other.signMessage({ message }),
    nowMs: NOW,
  });
  assert.deepEqual(result, {
    ok: false,
    error: "That signature does not come from this wallet.",
  });
});

// The timestamp window is the only replay defence sign-in has (no nonce store),
// so it is the thing worth pinning.
test("a stale sign-in signature expires", async () => {
  const message = buildSigninMessage(account.address, stamp);
  const signature = await account.signMessage({ message });

  const result = await verifySigninSignature({
    address: account.address,
    message,
    signature,
    nowMs: NOW + LINK_MAX_AGE_MS + 1,
  });
  assert.deepEqual(result, { ok: false, error: "That sign-in request expired. Try again." });

  // ...and a future one is as suspect as a stale one.
  const ahead = await verifySigninSignature({
    address: account.address,
    message,
    signature,
    nowMs: NOW - LINK_MAX_AGE_MS - 1,
  });
  assert.deepEqual(ahead, { ok: false, error: "That sign-in request expired. Try again." });
});

// Casing: wagmi hands the panel a checksummed address while every lookup in this
// schema is lowercase. Sign the raw casing and the account would never match.
test("buildSigninMessage lowercases the address", () => {
  assert.equal(
    buildSigninMessage(account.address.toUpperCase().replace("0X", "0x"), stamp),
    buildSigninMessage(account.address.toLowerCase(), stamp),
  );
});

// The header drops a wallet session the moment the extension moves off it. The
// false cases are the ones that hurt: a hydrating wagmi (address undefined) or a
// checksummed-vs-lowercase comparison would log everyone out on every load.
test("isStaleWalletSession fires on an account switch and on a disconnect", () => {
  const session = { provider: "wallet", handle: account.address.toLowerCase() };

  assert.equal(isStaleWalletSession(session, { connected: true, address: other.address }), true, "switched accounts");
  assert.equal(isStaleWalletSession(session, { connected: false }), true, "disconnecting is signing out");

  assert.equal(
    isStaleWalletSession(session, { connected: true, address: account.address }),
    false,
    "checksummed casing is the same account",
  );
  // The one that would log every wallet user out on every page load: wagmi's
  // store sits at connected-with-no-address for a tick during reconnect, and an
  // unknown address is not a changed one.
  assert.equal(isStaleWalletSession(session, { connected: true }), false, "address not known yet");
  assert.equal(isStaleWalletSession(null, { connected: false }), false, "signed out already");
  assert.equal(
    isStaleWalletSession({ provider: "x", handle: "qFloppa" }, { connected: false }),
    false,
    "a social account's browser wallet is a linked wallet, not its identity",
  );
});
