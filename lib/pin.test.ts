import assert from "node:assert/strict";
import test from "node:test";
import { hashPin, verifyPin } from "./pin.ts";

test("verifyPin accepts the correct pin", () => {
  const stored = hashPin("1234");
  assert.equal(verifyPin("1234", stored), true);
});

test("verifyPin rejects the wrong pin", () => {
  const stored = hashPin("1234");
  assert.equal(verifyPin("9999", stored), false);
});

test("hashPin is salted — same pin hashes differently each time", () => {
  assert.notEqual(hashPin("1234"), hashPin("1234"));
});

test("verifyPin rejects malformed stored values", () => {
  assert.equal(verifyPin("1234", ""), false);
  assert.equal(verifyPin("1234", "garbage"), false);
});
