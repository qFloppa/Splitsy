// The three screens, and in particular that a wallet-less account on Privy's own
// UI WAITS rather than being handed a password form — the case the panel got
// wrong, since it is the one every new social login passes through.
import { test } from "node:test";
import assert from "node:assert/strict";
import { walletStage } from "./wallet-stage.ts";

const ADDRESS = "0xfe3d000000000000000000000000000000002eac";

test("an address is the working wallet, whatever the stack", () => {
  assert.equal(walletStage({ walletAddress: ADDRESS, custodian: "Privy" }, true), "ready");
  assert.equal(walletStage({ walletAddress: ADDRESS, custodian: "Privy" }, false), "ready");
  assert.equal(walletStage({ walletAddress: ADDRESS, custodian: "Circle" }, false), "ready");
});

test("a new social login waits — the wallet is made in the browser, not by a form", () => {
  assert.equal(walletStage({ walletAddress: null, custodian: "Privy" }, true), "waiting");
});

test("a Circle wallet that is not recorded yet waits too — it is minted at login", () => {
  assert.equal(walletStage({ walletAddress: null, custodian: "Circle" }, false), "waiting");
});

test("Splitsy's own ceremony is the one case where nothing arrives on its own", () => {
  assert.equal(walletStage({ walletAddress: null, custodian: "Privy" }, false), "setup");
});
