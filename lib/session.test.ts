import assert from "node:assert/strict";
import test from "node:test";
import { signSession, verifySession, SESSION_COOKIE_NAME, signWalletUnlock, verifyWalletUnlock } from "./session-core.ts";

const SECRET = "test-secret-that-is-at-least-32-chars-long!!";

test("verifySession returns the userId for a token it signed", () => {
  const token = signSession("user-123", SECRET);
  assert.equal(verifySession(token, SECRET), "user-123");
});

test("verifySession rejects a tampered payload", () => {
  const token = signSession("user-123", SECRET);
  const tampered = token.replace("user-123", "user-999");
  assert.equal(verifySession(tampered, SECRET), null);
});

test("verifySession rejects a token signed with a different secret", () => {
  const token = signSession("user-123", SECRET);
  assert.equal(verifySession(token, "a-completely-different-secret-value-32x"), null);
});

test("verifySession rejects malformed tokens", () => {
  assert.equal(verifySession("garbage", SECRET), null);
  assert.equal(verifySession("", SECRET), null);
  assert.equal(verifySession("a.b.c", SECRET), null);
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
