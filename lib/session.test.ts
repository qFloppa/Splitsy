import assert from "node:assert/strict";
import test from "node:test";
import {
  signSession,
  verifySession,
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE,
  signWalletProof,
  signWalletUnlock,
  verifyWalletProof,
  verifyWalletUnlock,
} from "./session-core.ts";

const SECRET = "test-secret-that-is-at-least-32-chars-long!!";
const NOW = 1_700_000_000_000;

test("verifySession returns the userId for a token it signed", () => {
  const token = signSession("user-123", NOW, SECRET);
  assert.deepEqual(verifySession(token, SECRET, NOW), { userId: "user-123", issuedAtMs: NOW });
});

test("verifySession rejects a tampered payload", () => {
  const token = signSession("user-123", NOW, SECRET);
  const tampered = token.replace("user-123", "user-999");
  assert.equal(verifySession(tampered, SECRET, NOW), null);
});

test("verifySession rejects a token signed with a different secret", () => {
  const token = signSession("user-123", NOW, SECRET);
  assert.equal(verifySession(token, "a-completely-different-secret-value-32x", NOW), null);
});

test("verifySession rejects malformed tokens", () => {
  assert.equal(verifySession("garbage", SECRET, NOW), null);
  assert.equal(verifySession("", SECRET, NOW), null);
  assert.equal(verifySession("a.b.c", SECRET, NOW), null);
});

// The reason the issue time is in the token at all: before this, a captured
// cookie verified forever and nothing server-side could stop it.
test("a session expires on its own after SESSION_MAX_AGE", () => {
  const token = signSession("user-123", NOW, SECRET);
  const lifetimeMs = SESSION_MAX_AGE * 1000;
  assert.ok(verifySession(token, SECRET, NOW + lifetimeMs - 1), "still valid a moment before");
  assert.equal(verifySession(token, SECRET, NOW + lifetimeMs), null, "dead at the boundary");
  assert.equal(verifySession(token, SECRET, NOW + lifetimeMs * 2), null);
});

test("verifySession rejects a future-dated token", () => {
  // Nobody can hold one of these without having minted it, and accepting it
  // would extend the session's life by however far ahead it was dated.
  const token = signSession("user-123", NOW + 86_400_000, SECRET);
  assert.equal(verifySession(token, SECRET, NOW), null);
});

test("verifySession rejects a tampered issue time", () => {
  const token = signSession("user-123", NOW, SECRET);
  const tampered = token.replace(String(NOW), String(NOW + 1_000));
  assert.equal(verifySession(tampered, SECRET, NOW), null);
});

test("the issue time is reported so revocation can compare against it", () => {
  // getSessionUser rejects a token issued before users.sessions_valid_from, which
  // is only possible because verifySession hands the instant back.
  assert.equal(verifySession(signSession("user-1", NOW - 10_000, SECRET), SECRET, NOW)?.issuedAtMs, NOW - 10_000);
  assert.equal(verifySession(signSession("user-1", NOW, SECRET), SECRET, NOW)?.issuedAtMs, NOW);
});

test("cookie name constant is stable", () => {
  assert.equal(SESSION_COOKIE_NAME, "splitsy_session");
});

test("verifyWalletUnlock accepts an unexpired token", () => {
  const now = 1_000_000;
  const token = signWalletUnlock("user-1", now + 300_000, SECRET);
  assert.equal(verifyWalletUnlock(token, SECRET, now), "user-1");
});

test("verifyWalletUnlock rejects an expired token", () => {
  const token = signWalletUnlock("user-1", 500, SECRET);
  assert.equal(verifyWalletUnlock(token, SECRET, 1000), null);
});

test("verifyWalletUnlock rejects a tampered expiry", () => {
  const now = 1_000_000;
  const token = signWalletUnlock("user-1", now + 1000, SECRET);
  const tampered = token.replace(String(now + 1000), String(now + 9_000_000));
  assert.equal(verifyWalletUnlock(tampered, SECRET, now), null);
});

test("verifyWalletProof accepts its own token and honours the expiry", () => {
  const now = 1_000_000;
  assert.equal(verifyWalletProof(signWalletProof("user-1", now + 300_000, SECRET), SECRET, now), "user-1");
  assert.equal(verifyWalletProof(signWalletProof("user-1", 500, SECRET), SECRET, 1000), null);
});

// THE property, not a nicety. All three tokens are HMACs over a userId, so
// without the domain prefix a wallet-proof cookie lifted into the session cookie
// would BE that account, and lifted into the unlock cookie would bypass the wallet
// PIN for as long as the proof lasts. Both directions are checked because either
// one alone would pass with the prefix applied to the wrong side.
test("a wallet-proof token is not a session token and not an unlock token", () => {
  const now = 1_000_000;
  const proof = signWalletProof("user-1", now + 300_000, SECRET);
  const unlock = signWalletUnlock("user-1", now + 300_000, SECRET);

  assert.equal(verifyWalletUnlock(proof, SECRET, now), null, "proof must not unlock the wallet");
  assert.equal(verifyWalletProof(unlock, SECRET, now), null, "an unlock must not prove a wallet account");
  // The session token is the same THREE-PART SHAPE as both of these now that it
  // carries its issue time, so its domain prefix is the only thing keeping them
  // apart — which makes this the check that would actually catch a regression,
  // not belt and braces. Both other tokens replayed as a session would be that
  // account outright.
  assert.equal(verifySession(proof, SECRET, now), null, "proof must not be a session");
  assert.equal(verifySession(unlock, SECRET, now), null, "an unlock must not be a session");
  // And the reverse: a session token must not unlock a wallet or stand in as a
  // second identity. Its middle field is an ISSUE time where theirs is an EXPIRY,
  // so without the prefixes a fresh session would read as an unlock good for
  // thirty years.
  const session = signSession("user-1", now, SECRET);
  assert.equal(verifyWalletUnlock(session, SECRET, now), null, "a session must not unlock the wallet");
  assert.equal(verifyWalletProof(session, SECRET, now), null, "a session must not prove a wallet account");
});
