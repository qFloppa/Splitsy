import test from "node:test";
import assert from "node:assert/strict";
import { describeAccount } from "./provider-display.ts";

// The wallet-collision refusals send the user to the account that already holds
// the wallet, so this phrase has to name it — provider alone is not enough.
test("an account is named by handle and platform", () => {
  assert.equal(describeAccount({ provider: "x", handle: "@alice" }), "@alice on X");
  assert.equal(describeAccount({ provider: "discord", handle: "alice" }), "alice on Discord");
  assert.equal(describeAccount({ provider: "email", handle: "a@b.com" }), "a@b.com on Email");
});

test("a wallet account names its address, not a platform it isn't on", () => {
  const label = describeAccount({ provider: "wallet", handle: "0xabcdef0123456789abcdef0123456789abcdef01" });
  assert.equal(label, "the wallet account 0xabcd…ef01");
  assert.ok(!label.includes(" on "));
});
