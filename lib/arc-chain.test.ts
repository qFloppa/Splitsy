import test from "node:test";
import assert from "node:assert/strict";
import { ARC_PROFILES, resolveArcProfile } from "./arc-chain.ts";

// The whole point of the module. Every one of these used to be a separate
// `process.env.ARC_TESTNET_* ?? "<a testnet value>"` at 24 call sites, so a
// mainnet deployment that missed one variable read testnet and rendered it as
// real money.
test("an unset network is testnet, never mainnet", () => {
  assert.equal(resolveArcProfile(undefined).network, "testnet");
  assert.equal(resolveArcProfile("").network, "testnet");
});

// Exact match, failing toward testnet — the same rule as walletProviderName().
// A capitalised or misspelled value in a new environment must land on the chain
// where being wrong is free.
test("only the exact string mainnet selects mainnet", () => {
  assert.equal(resolveArcProfile("mainnet").network, "mainnet");
  assert.equal(resolveArcProfile("Mainnet").network, "testnet");
  assert.equal(resolveArcProfile("MAINNET").network, "testnet");
  assert.equal(resolveArcProfile("mainet").network, "testnet");
  assert.equal(resolveArcProfile("main").network, "testnet");
});

test("each profile carries the chain id its name implies", () => {
  assert.equal(resolveArcProfile("mainnet").chainId, 5042);
  assert.equal(resolveArcProfile("testnet").chainId, 5042002);
  assert.equal(resolveArcProfile("mainnet").chain.id, 5042);
  assert.equal(resolveArcProfile("testnet").chain.id, 5042002);
});

// The CAIP-2 string is handed to Privy and to x402, which both reject a
// transaction whose chain does not match. Deriving it by hand at a call site is
// how it drifts from the chain it claims to name.
test("the CAIP-2 string always agrees with the chain id", () => {
  for (const profile of Object.values(ARC_PROFILES)) {
    assert.equal(profile.caip2, `eip155:${profile.chainId}`);
  }
});

// The trap this module exists to close. USDC happens to share an address across
// both networks, so a migration that checks only USDC concludes "Arc addresses
// are the same everywhere" and is then wrong about Gateway — which moves money.
test("USDC shares an address across networks but Gateway does not", () => {
  assert.equal(ARC_PROFILES.mainnet.usdcAddress, ARC_PROFILES.testnet.usdcAddress);
  assert.notEqual(ARC_PROFILES.mainnet.gatewayWallet, ARC_PROFILES.testnet.gatewayWallet);
  assert.notEqual(ARC_PROFILES.mainnet.gatewayMinter, ARC_PROFILES.testnet.gatewayMinter);
  assert.notEqual(ARC_PROFILES.mainnet.gatewayApiUrl, ARC_PROFILES.testnet.gatewayApiUrl);
});

test("mainnet carries the addresses verified on chain 2026-09-16", () => {
  const mainnet = ARC_PROFILES.mainnet;
  assert.equal(mainnet.rpcUrl, "https://rpc.mainnet.arc.io");
  assert.equal(mainnet.explorerUrl, "https://explorer.arc.io");
  assert.equal(mainnet.usdcAddress, "0x3600000000000000000000000000000000000000");
  assert.equal(mainnet.gatewayWallet, "0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE");
  assert.equal(mainnet.gatewayMinter, "0x2222222d7164433c4C09B0b0D809a9b52C04C205");
  assert.equal(mainnet.gatewayApiUrl, "https://gateway-api.circle.com/v1");
});

// The public endpoints rate-limit: -32011 'request limit reached' surfaces as a
// failed contract READ, so it reads as a broken call rather than a quota
// (lib/x402/constants.ts:16-21). A keyed URL is per-deployment, so it overrides
// the RPC and nothing else.
test("an RPC override replaces the endpoint and leaves every other value alone", () => {
  const overridden = resolveArcProfile("mainnet", "https://arc-mainnet.g.alchemy.com/v2/key");
  const base = ARC_PROFILES.mainnet;

  assert.equal(overridden.rpcUrl, "https://arc-mainnet.g.alchemy.com/v2/key");
  assert.equal(overridden.chainId, base.chainId);
  assert.equal(overridden.explorerUrl, base.explorerUrl);
  assert.equal(overridden.gatewayWallet, base.gatewayWallet);
});

test("an empty override is ignored rather than blanking the endpoint", () => {
  assert.equal(resolveArcProfile("mainnet", "").rpcUrl, ARC_PROFILES.mainnet.rpcUrl);
  assert.equal(resolveArcProfile("mainnet", undefined).rpcUrl, ARC_PROFILES.mainnet.rpcUrl);
});

// Mutating a returned profile must not poison the next caller — these are
// module-level singletons read by ~20 modules.
test("a returned profile does not alias the shared table", () => {
  const first = resolveArcProfile("mainnet", "https://one.example");
  const second = resolveArcProfile("mainnet");

  assert.equal(second.rpcUrl, ARC_PROFILES.mainnet.rpcUrl);
  assert.notEqual(first.rpcUrl, second.rpcUrl);
});
