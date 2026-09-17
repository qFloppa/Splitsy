import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { IDENTITY_REGISTRY, REPUTATION_REGISTRY, isReputationConfigured } from "./erc8004.ts";

const ZERO = "0x0000000000000000000000000000000000000000";

const TESTNET_IDENTITY = "0x8004A818BFB912233c491871b3d84c89A494BD9e";
const TESTNET_REPUTATION = "0x8004B663056A597Dffe9eCcC1965A193B7388713";
const MAINNET_IDENTITY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";
const MAINNET_REPUTATION = "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63";

// Reputation MINTS NFTs and writes feedback from the registrar and validator
// wallets, so on mainnet it spends real gas from real wallets on the first bill
// anybody pays. Unset therefore means OFF and stays off until an address is
// entered — never "call the testnet registry", which on mainnet is an address
// with no code, failing in a way that reads as a bug rather than as missing
// configuration.
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

// A SUBPROCESS, and not a fresh dynamic import, for the network tests below.
// erc8004.ts imports ./arc-chain.ts by a plain specifier, and that module is
// already cached from this file's top-level import with the switch unset — so
// re-importing erc8004.ts under a `?query` would keep reading "testnet" no
// matter what the environment says. A `?query` re-evaluates the module under
// test; it cannot re-evaluate that module's DEPENDENCY. Only a new process
// re-reads the switch.
function registriesUnder(env: Record<string, string>) {
  const script = `
    const m = await import("./lib/erc8004.ts");
    process.stdout.write(JSON.stringify({
      identity: m.IDENTITY_REGISTRY,
      reputation: m.REPUTATION_REGISTRY,
      configured: m.isReputationConfigured(),
    }));
  `;
  const out = execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return JSON.parse(out) as { identity: string; reputation: string; configured: boolean };
}

// Arc mainnet HAS both registries as of 2026-09-17, at DIFFERENT addresses from
// testnet's — verified on chain against rpc.mainnet.arc.io (chain id 0x13b2).
// So the pair a deployment reads has to follow the network, and the direction
// that matters is this one: a mainnet deployment with only the testnet slots
// filled in must report itself off rather than reaching for them.
test("a mainnet deployment never borrows the testnet registry slot", () => {
  const borrowed = registriesUnder({
    NEXT_PUBLIC_ARC_NETWORK: "mainnet",
    ERC8004_IDENTITY_REGISTRY: TESTNET_IDENTITY,
    ERC8004_REPUTATION_REGISTRY: TESTNET_REPUTATION,
  });

  assert.equal(borrowed.identity, ZERO, "mainnet read the testnet identity registry");
  assert.equal(borrowed.configured, false, "mainnet reported reputation on with only testnet slots set");
});

test("a mainnet deployment reads its own registry slot when it is set", () => {
  const configured = registriesUnder({
    NEXT_PUBLIC_ARC_NETWORK: "mainnet",
    // Both pairs present at once — the arrangement that makes the network switch
    // a one-variable flip. The switch decides, not which variables exist.
    ERC8004_IDENTITY_REGISTRY: TESTNET_IDENTITY,
    ERC8004_REPUTATION_REGISTRY: TESTNET_REPUTATION,
    ERC8004_IDENTITY_REGISTRY_MAINNET: MAINNET_IDENTITY,
    ERC8004_REPUTATION_REGISTRY_MAINNET: MAINNET_REPUTATION,
  });

  assert.equal(configured.identity, MAINNET_IDENTITY);
  assert.equal(configured.reputation, MAINNET_REPUTATION);
  assert.equal(configured.configured, true);
});

test("a testnet deployment ignores the mainnet slot even when it is set", () => {
  const onTestnet = registriesUnder({
    ERC8004_IDENTITY_REGISTRY: TESTNET_IDENTITY,
    ERC8004_REPUTATION_REGISTRY: TESTNET_REPUTATION,
    ERC8004_IDENTITY_REGISTRY_MAINNET: MAINNET_IDENTITY,
    ERC8004_REPUTATION_REGISTRY_MAINNET: MAINNET_REPUTATION,
  });

  assert.equal(onTestnet.identity, TESTNET_IDENTITY);
  assert.equal(onTestnet.reputation, TESTNET_REPUTATION);
});
