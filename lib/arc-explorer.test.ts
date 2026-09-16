import assert from "node:assert/strict";
import { test } from "node:test";
import { looksLikeTxHash, waitForCircleTxUrl } from "./arc-explorer.ts";

test("a hash needs no polling — the link is already knowable", async () => {
  const hash = `0x${"a".repeat(64)}`;
  let fetched = false;
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetched = true;
    throw new Error("must not be called");
  }) as typeof fetch;
  try {
    assert.equal(await waitForCircleTxUrl(hash), `https://testnet.arcscan.app/tx/${hash}`);
    assert.equal(fetched, false, "a hash must short-circuit before any network call");
  } finally {
    globalThis.fetch = original;
  }
});

test("only 0x + 64 hex is a hash; a Circle transaction id is not", () => {
  assert.equal(looksLikeTxHash(`0x${"a".repeat(64)}`), true);
  assert.equal(looksLikeTxHash("6f8a1d3e-1b2c-4d5e-8f90-1234567890ab"), false);
  assert.equal(looksLikeTxHash(null), false);
});
