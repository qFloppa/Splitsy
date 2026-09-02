import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { looksLikeTxHash, walletProviderName } from "./wallet-provider.ts";

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
