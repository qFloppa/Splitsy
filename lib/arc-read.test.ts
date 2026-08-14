import { test } from "node:test";
import assert from "node:assert/strict";
import { usdcShortfall } from "./arc-read.ts";

const USDC = (dollars: string) => BigInt(Math.round(Number(dollars) * 1e6));

test("a funded wallet is not a shortfall", () => {
  assert.equal(usdcShortfall(USDC("10.00"), USDC("4.20")), null);
  // Exactly enough still pays — the guard must not eat a to-the-cent payment.
  assert.equal(usdcShortfall(USDC("4.20"), USDC("4.20")), null);
});

test("an empty wallet names both figures instead of 'Contract execution failed'", () => {
  const message = usdcShortfall(0n, USDC("4.20"));
  assert.match(message ?? "", /needs 4\.20/);
  assert.match(message ?? "", /holds 0\.00/);
});

test("a partly funded wallet names what it actually holds", () => {
  assert.match(usdcShortfall(USDC("1.05"), USDC("4.20")) ?? "", /needs 4\.20 but your wallet holds 1\.05/);
});
