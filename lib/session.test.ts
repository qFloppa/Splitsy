import assert from "node:assert/strict";
import test from "node:test";
import { signSession, verifySession, SESSION_COOKIE_NAME } from "./session.ts";

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
