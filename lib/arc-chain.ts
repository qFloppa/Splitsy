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
  /**
   * Circle's own name for this network, in two SDKs that each spell it
   * differently and neither of which spells it the way viem does.
   *
   * They live here rather than at the call sites because they are properties of
   * WHICH ARC THIS IS, exactly like chainId — and because both are the kind of
   * value whose wrong answer is silent. `dcwBlockchain` is a wire string sent to
   * Circle's custody API; naming testnet there while every other rail is on
   * mainnet does not error, it moves the user's money on the wrong chain.
   */
  dcwBlockchain: "ARC" | "ARC-TESTNET";
  /** The key into @circle-fin/x402-batching's own chain registry. */
  x402Chain: "arc" | "arcTestnet";
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
    dcwBlockchain: "ARC",
    x402Chain: "arc",
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
    dcwBlockchain: "ARC-TESTNET",
    x402Chain: "arcTestnet",
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

// Which network, decided once, before anything derived from it is read.
const selected = resolveArcProfile(process.env.NEXT_PUBLIC_ARC_NETWORK);

/**
 * Pick the value configured for the network this deployment is on.
 *
 * The convention every call site follows, and the reason it is shaped this way:
 * the EXISTING unsuffixed variable is the TESTNET slot, and a new `_MAINNET`
 * twin is the mainnet slot. So a testnet deployment needs no variable renamed to
 * keep working, and a mainnet one is configured by adding rather than editing —
 * which means both networks can be fully set up at once and the deployment
 * switched between them by `NEXT_PUBLIC_ARC_NETWORK` alone.
 *
 * Mainnet NEVER falls back to the testnet slot. An address missing on mainnet
 * resolves to the zero address, which every consumer already reads as "not
 * configured" and refuses on. The alternative — quietly using the testnet
 * address on chain 5042 — is the exact failure this whole module exists to stop.
 *
 * Both arguments must be written as literal `process.env.NEXT_PUBLIC_X` reads at
 * the call site. Next inlines those textually at build time; a dynamic read is
 * undefined in the browser.
 */
export function forArcNetwork<T>(mainnet: T, testnet: T): T {
  return selected.network === "mainnet" ? mainnet : testnet;
}

// Written as literals on purpose, for the reason in forArcNetwork above.
// ARC_RPC_URL is server-only and wins where it exists, so a keyed endpoint need
// not be published into the client bundle; in the browser it is simply
// undefined and the public one applies.
//
// A keyed endpoint is per-NETWORK, not per-deployment: pointing a mainnet build
// at a testnet RPC does not fail, it reads testnet state and labels it chain
// 5042. viem does not check. Hence a separate mainnet slot rather than one
// shared variable.
export const ARC = resolveArcProfile(
  selected.network,
  forArcNetwork(
    process.env.ARC_RPC_URL_MAINNET || process.env.NEXT_PUBLIC_ARC_RPC_URL_MAINNET,
    process.env.ARC_RPC_URL || process.env.NEXT_PUBLIC_ARC_RPC_URL,
  ),
);
