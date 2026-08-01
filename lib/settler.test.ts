// isSettlerConfigured is the only gate between "autopay off" and a key reaching
// privateKeyToAccount — getSettler() now throws on exactly this predicate — so a
// regex that accepted a truncated paste would turn a config typo into a raw viem
// error deep inside a settlement. These pin both directions.
//
// Deliberately only isSettlerConfigured(): it re-reads process.env on every call,
// whereas getSettler() caches forever and would return a stale account for a
// toggled env var. No network, no mocks.
import test from "node:test";
import assert from "node:assert/strict";
import { isSettlerConfigured } from "./settler.ts";

const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // well-known test key
const original = process.env.SETTLER_PRIVATE_KEY;

function withKey(value: string | undefined) {
  if (value === undefined) delete process.env.SETTLER_PRIVATE_KEY;
  else process.env.SETTLER_PRIVATE_KEY = value;
  return isSettlerConfigured();
}

test.after(() => withKey(original));

test("a well-formed 64-hex key reads as configured", () => {
  assert.equal(withKey(KEY), true);
  assert.equal(withKey(KEY.toUpperCase().replace("0X", "0x")), true); // checksum casing
});

test("anything short of a full 64-hex key reads as unconfigured", () => {
  assert.equal(withKey(undefined), false, "unset is autopay off, not a crash");
  assert.equal(withKey(""), false);
  assert.equal(withKey("changeme"), false, "placeholder left in .env.local");
  assert.equal(withKey("0xdeadbeef"), false, "truncated paste");
  assert.equal(withKey(KEY.slice(0, -1)), false, "63 hex chars — one short");
  assert.equal(withKey(KEY + "ab"), false, "65+ hex chars — one over");
  assert.equal(withKey(KEY.slice(2)), false, "missing the 0x prefix");
  assert.equal(withKey(KEY.replace("5", "z")), false, "non-hex character");
  assert.equal(withKey(` ${KEY} `), false, "stray whitespace from a copy-paste");
});
