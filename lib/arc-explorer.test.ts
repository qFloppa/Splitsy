import assert from "node:assert/strict";
import { test } from "node:test";
import { ARC_EXPLORER, looksLikeTxHash, waitForCircleTxUrl } from "./arc-explorer.ts";
import { ARC } from "./arc-chain.ts";

test("a hash needs no polling — the link is already knowable", async () => {
  const hash = `0x${"a".repeat(64)}`;
  let fetched = false;
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetched = true;
    throw new Error("must not be called");
  }) as typeof fetch;
  try {
    assert.equal(await waitForCircleTxUrl(hash), `${ARC.explorerUrl}/tx/${hash}`);
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

// The footer, the dashboard and every receipt link read this. Pinned to a
// literal it silently pointed a mainnet receipt at a testnet explorer, where the
// transaction does not exist — which reads to a user as "my payment vanished".
test("the explorer host is whichever network this deployment is on", () => {
  assert.equal(ARC_EXPLORER, ARC.explorerUrl);
});
