import assert from "node:assert/strict";
import test from "node:test";
import { decideOtp, generateOtpCode, isValidEmail, normalizeEmail, OTP_MAX_ATTEMPTS } from "./email-otp.ts";

const NOW = 1_000_000;
const FUTURE = { expiresAt: NOW + 60_000, attempts: 0 };

test("decideOtp accepts a matching, unexpired code under the attempt cap", () => {
  assert.equal(decideOtp(FUTURE, true, NOW), "accept");
});

test("decideOtp rejects a wrong code", () => {
  assert.equal(decideOtp(FUTURE, false, NOW), "reject");
});

test("decideOtp rejects when there is no pending challenge", () => {
  assert.equal(decideOtp(null, true, NOW), "reject");
});

test("decideOtp reports expiry even when the code would match", () => {
  assert.equal(decideOtp({ expiresAt: NOW - 1, attempts: 0 }, true, NOW), "expired");
});

test("decideOtp locks out once attempts hit the cap, even on a correct code", () => {
  assert.equal(decideOtp({ expiresAt: NOW + 60_000, attempts: OTP_MAX_ATTEMPTS }, true, NOW), "locked");
});

test("generateOtpCode is always 6 digits", () => {
  for (let i = 0; i < 200; i++) {
    assert.match(generateOtpCode(), /^\d{6}$/);
  }
});

test("normalizeEmail lowercases and trims", () => {
  assert.equal(normalizeEmail("  Alice@Example.COM "), "alice@example.com");
});

test("isValidEmail accepts plausible addresses and rejects junk", () => {
  assert.equal(isValidEmail("a@b.co"), true);
  assert.equal(isValidEmail("no-at-sign"), false);
  assert.equal(isValidEmail("a@b"), false);
  assert.equal(isValidEmail("a b@c.com"), false);
});
