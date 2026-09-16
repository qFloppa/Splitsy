import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { userMustSign } from "./user-signed.ts";

// userMustSign is the choke point all sixteen money-moving routes gate on, either
// directly or through userSignedLeg. Neither case below touches the database — both
// answers are settled by the two switches before any row is read — which is why
// this can be a plain unit test of the thing that decides who signs.
const provider = process.env.WALLET_PROVIDER;
const ui = process.env.WALLET_UI;
afterEach(() => {
  if (provider === undefined) delete process.env.WALLET_PROVIDER;
  else process.env.WALLET_PROVIDER = provider;
  if (ui === undefined) delete process.env.WALLET_UI;
  else process.env.WALLET_UI = ui;
});

// The misconfiguration this guard exists for: WALLET_UI naming Privy while the
// wallets are still Circle's. Without it userSignedLeg answers `null`, eleven
// routes fall through to executeContract and MOVE MONEY on the prepare pass, and
// the browser — waiting for a transaction to sign — reports a failure. Money gone,
// UI saying otherwise.
test("Privy's UI means the user always signs, whatever the row or the stack says", async () => {
  process.env.WALLET_UI = "privy";
  delete process.env.WALLET_PROVIDER;
  assert.equal(await userMustSign("a-circle-wallet-id"), true);
  process.env.WALLET_PROVIDER = "privy";
  assert.equal(await userMustSign("a-wallet-with-no-row"), true);
});

// And the default is untouched: the Circle stack running the app's own screens
// still has the server sign, with no database read to get there.
test("the default stack never asks the user to sign", async () => {
  delete process.env.WALLET_UI;
  delete process.env.WALLET_PROVIDER;
  assert.equal(await userMustSign("a-circle-wallet-id"), false);
});
