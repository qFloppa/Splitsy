import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizePendingHandle } from "./pending-wallets-repo.ts";

test("normalizePendingHandle strips a leading @ and lowercases", () => {
  assert.equal(normalizePendingHandle("@Alice"), "alice");
  assert.equal(normalizePendingHandle("BOB"), "bob");
  assert.equal(normalizePendingHandle("a@b.com"), "a@b.com");
});

test("normalizePendingHandle trims whitespace so padded input keys identically", () => {
  assert.equal(normalizePendingHandle(" @Alice "), "alice");
  assert.equal(normalizePendingHandle("alice "), "alice");
});
