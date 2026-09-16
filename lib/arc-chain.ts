// The one place that knows which Arc network this deployment is on.
//
// Before this module, 24 call sites across 20 files each decided for themselves,
// and every one of them read an `ARC_TESTNET_*` variable with a TESTNET value as
// its fallback. That is the wrong direction: a mainnet deployment missing one
// variable did not fail, it read testnet state and rendered it as real money.
//
// So the rule here is two-level, and the levels are what make it safe:
//   - the SWITCH has a default (absent means testnet, never mainnet);
//   - nothing DERIVED from the switch has a default at all.
// A deployment can still be wrong about which network it is, which is loud and
// harmless. It can no longer be wrong about one address inside a network, which
// was quiet and expensive.
import { defineChain, type Chain } from "viem";
import { arcTestnet } from "viem/chains";

// viem exports `arc`, but it is an empty stub — no RPC urls, no block explorer,
// no multicall3 — in 2.52.2 and in every later version including latest, so
// `createPublicClient({ chain: arc })` throws. Arc's docs say both chains are
// "bundled with viem"; the export exists but is not usable. Hence this.
//
// Values verified on chain 2026-09-16 against https://rpc.mainnet.arc.io.
// nativeCurrency mirrors viem's own arcTestnet: gas is USDC at 18 decimals of
// precision, while the ERC-20 interface at usdcAddress reports 6. Mixing the two
// breaks balance maths — read the ERC-20 for balances, never the native unit.
export const arcMainnet = defineChain({
  id: 5042,
  name: "Arc",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.arc.io"] } },
  blockExplorers: {
    default: { name: "Arc Explorer", url: "https://explorer.arc.io" },
  },
  contracts: {
    multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" },
  },
});

export type ArcNetwork = "mainnet" | "testnet";

export type ArcProfile = {
  network: ArcNetwork;
  chain: Chain;
  chainId: number;
  rpcUrl: string;
  explorerUrl: string;
  usdcAddress: `0x${string}`;
  gatewayWallet: `0x${string}`;
  gatewayMinter: `0x${string}`;
  gatewayApiUrl: string;
  /** eip155:<chainId>, the form Privy and x402 both want. */
  caip2: string;
};

export const ARC_PROFILES: Record<ArcNetwork, ArcProfile> = {
  mainnet: {
    network: "mainnet",
    chain: arcMainnet,
    chainId: 5042,
    rpcUrl: "https://rpc.mainnet.arc.io",
    explorerUrl: "https://explorer.arc.io",
    usdcAddress: "0x3600000000000000000000000000000000000000",
    // Note these differ from testnet's. USDC does not, which is exactly what
    // makes assuming "Arc addresses are the same on both" so easy and so wrong.
    gatewayWallet: "0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE",
    gatewayMinter: "0x2222222d7164433c4C09B0b0D809a9b52C04C205",
    gatewayApiUrl: "https://gateway-api.circle.com/v1",
    caip2: "eip155:5042",
  },
  testnet: {
    network: "testnet",
    chain: arcTestnet,
    chainId: 5042002,
    rpcUrl: "https://rpc.testnet.arc.network",
    explorerUrl: "https://testnet.arcscan.app",
    usdcAddress: "0x3600000000000000000000000000000000000000",
    gatewayWallet: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9",
    gatewayMinter: "0x0022222ABE238Cc2C7Bb1f21003F0a260052475B",
    gatewayApiUrl: "https://gateway-api-testnet.circle.com/v1",
    caip2: "eip155:5042002",
  },
};

/**
 * Pick a profile, with an optional RPC override.
 *
 * Exported separately from `ARC` so it is testable without touching the process
 * environment — the same shape as `siteContracts(env)` in lib/site-contracts.ts.
 *
 * The match is EXACT and fails toward testnet. A capitalised value, a typo or an
 * unset variable in a new environment all land on the chain where being wrong
 * costs nothing, which is the same rule `walletProviderName()` uses.
 */
export function resolveArcProfile(network: string | undefined, rpcOverride?: string): ArcProfile {
  const base = ARC_PROFILES[network === "mainnet" ? "mainnet" : "testnet"];
  // Spread rather than return `base` directly: callers must not be able to
  // mutate the shared table out from under twenty other modules.
  return { ...base, rpcUrl: rpcOverride || base.rpcUrl };
}

// Both reads are written as literals on purpose. Next replaces
// `process.env.NEXT_PUBLIC_*` textually at BUILD time, so a dynamic read —
// `env[key]`, a destructure — is never inlined and is undefined in the browser.
// ARC_RPC_URL is server-only and wins where it exists, so a keyed endpoint need
// not be published into the client bundle; in the browser it is simply
// undefined and the public one applies.
export const ARC = resolveArcProfile(
  process.env.NEXT_PUBLIC_ARC_NETWORK,
  process.env.ARC_RPC_URL || process.env.NEXT_PUBLIC_ARC_RPC_URL,
);
