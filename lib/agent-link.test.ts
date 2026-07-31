import test from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";
import { buildLinkMessage, verifyLinkSignature, LINK_MAX_AGE_MS } from "./agent-link.ts";

const account = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);
const other = privateKeyToAccount(
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
);

const NOW = 1_770_000_000_000; // fixed clock; the module must never call Date.now itself
const stamp = new Date(NOW).toISOString();

test("buildLinkMessage pins the address, handle and timestamp", () => {
  const message = buildLinkMessage(account.address, "ada", stamp);
  assert.ok(message.includes(account.address.toLowerCase()));
  assert.ok(message.includes("@ada"));
  assert.ok(message.includes(stamp));
});

test("a signature from the claimed address is accepted", async () => {
  const message = buildLinkMessage(account.address, "ada", stamp);
  const signature = await account.signMessage({ message });

  const result = await verifyLinkSignature({
    address: account.address,
    handle: "ada",
    message,
    signature,
    nowMs: NOW,
  });
  assert.deepEqual(result, { ok: true });
});

test("a signature from a different wallet is rejected", async () => {
  const message = buildLinkMessage(account.address, "ada", stamp);
  const signature = await other.signMessage({ message });

  const result = await verifyLinkSignature({
    address: account.address,
    handle: "ada",
    message,
    signature,
    nowMs: NOW,
  });
  assert.equal(result.ok, false);
});

test("a stale timestamp is rejected even with a valid signature", async () => {
  const message = buildLinkMessage(account.address, "ada", stamp);
  const signature = await account.signMessage({ message });

  const result = await verifyLinkSignature({
    address: account.address,
    handle: "ada",
    message,
    signature,
    nowMs: NOW + LINK_MAX_AGE_MS + 1,
  });
  assert.equal(result.ok, false);
});

test("a message whose body does not match the claim is rejected", async () => {
  // Signed correctly, but for a DIFFERENT handle than the session claims.
  const message = buildLinkMessage(account.address, "mallory", stamp);
  const signature = await account.signMessage({ message });

  const result = await verifyLinkSignature({
    address: account.address,
    handle: "ada",
    message,
    signature,
    nowMs: NOW,
  });
  assert.equal(result.ok, false);
});
