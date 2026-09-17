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

// A BLANK variable must read the same as a missing one. Vercel refuses to save
// an empty value, so an operator who wants reputation off is nudged toward
// typing *something* — and under `??` the empty string sailed past the default,
// leaving IDENTITY_REGISTRY as "" while isReputationConfigured() answered true.
// The feature then called a contract at the empty address instead of staying off.
test("a blank registry variable reads as unset, not as a configured empty address", async () => {
  process.env.ERC8004_IDENTITY_REGISTRY = "";
  process.env.ERC8004_REPUTATION_REGISTRY = "";
  try {
    // Fresh URL so node re-evaluates the module: these are module-scope reads.
    // Held in a variable because a literal would send tsc looking for a file
    // named with the query string on it.
    const fresh = "./erc8004.ts?blank-env";
    const reloaded = await import(fresh);
    assert.equal(reloaded.IDENTITY_REGISTRY, ZERO);
    assert.equal(reloaded.REPUTATION_REGISTRY, ZERO);
    assert.equal(reloaded.isReputationConfigured(), false);
  } finally {
    delete process.env.ERC8004_IDENTITY_REGISTRY;
    delete process.env.ERC8004_REPUTATION_REGISTRY;
  }
});
