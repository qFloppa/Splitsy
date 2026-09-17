import test from "node:test";
import assert from "node:assert/strict";
import { IDENTITY_REGISTRY, REPUTATION_REGISTRY, isReputationConfigured } from "./erc8004.ts";

const ZERO = "0x0000000000000000000000000000000000000000";

// Circle has not deployed ERC-8004 to Arc mainnet and intends to. So unset must
// mean OFF and stay off until an address is entered — never "call the testnet
// registry", which on mainnet is an address with no code. A call to it fails in
// a way that reads as a bug rather than as missing configuration.
//
// Same rule, and the same shape, as isJobsConfigured() in lib/erc8183.ts:24.
test("an unset registry is the zero address, not a testnet address", () => {
  assert.equal(IDENTITY_REGISTRY, ZERO);
  assert.equal(REPUTATION_REGISTRY, ZERO);
});

test("reputation reports itself unconfigured when the registries are unset", () => {
  assert.equal(isReputationConfigured(), false);
});
