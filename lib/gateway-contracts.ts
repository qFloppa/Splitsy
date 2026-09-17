import { type Address, type Chain } from "viem";
import { avalancheFuji, baseSepolia, sepolia } from "viem/chains";
import { ARC_PROFILES } from "./arc-chain.ts";

export type NetworkConfig = {
  RPC: string;
  GatewayWallet: string;
  GatewayMinter: string;
  USDCAddress: string;
  ViemChain: Chain;
};

export type ChainConfig = {
  domain: number;
  mainnet?: NetworkConfig;
  testnet?: NetworkConfig;
};

export const GATEWAY_CONFIG = {
  TESTNET_URL: "https://gateway-api-testnet.circle.com/v1",
  MAINNET_URL: "https://gateway-api.circle.com/v1",
} as const;

// Read from ARC_PROFILES rather than retyped: these four addresses are the ones
// that move money, and GatewayWallet/GatewayMinter differ between the networks
// while USDC does not — which is exactly the shape of mistake that survives a
// review. One source means a wrong address is wrong in one place, and
// lib/arc-chain.test.ts is what checks it.
//
// `domain` stays declared here: every chain in this file carries one, and
// Circle's Gateway domain is not the chain id — Arc is 26 on both networks.
export const arcContracts: ChainConfig = {
  domain: 26,
  mainnet: {
    RPC: ARC_PROFILES.mainnet.rpcUrl,
    GatewayWallet: ARC_PROFILES.mainnet.gatewayWallet,
    GatewayMinter: ARC_PROFILES.mainnet.gatewayMinter,
    USDCAddress: ARC_PROFILES.mainnet.usdcAddress,
    ViemChain: ARC_PROFILES.mainnet.chain,
  },
  testnet: {
    RPC: ARC_PROFILES.testnet.rpcUrl,
    GatewayWallet: ARC_PROFILES.testnet.gatewayWallet,
    GatewayMinter: ARC_PROFILES.testnet.gatewayMinter,
    USDCAddress: ARC_PROFILES.testnet.usdcAddress,
    ViemChain: ARC_PROFILES.testnet.chain,
  },
};

export const avalancheContracts: ChainConfig = {
  domain: 1,
  testnet: {
    RPC: "https://avalanche-fuji-c-chain-rpc.publicnode.com",
    GatewayWallet: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9",
    GatewayMinter: "0x0022222ABE238Cc2C7Bb1f21003F0a260052475B",
    USDCAddress: "0x5425890298aed601595a70AB815c96711a31Bc65",
    ViemChain: avalancheFuji,
  },
};

export const baseContracts: ChainConfig = {
  domain: 6,
  testnet: {
    RPC: "https://base-sepolia-rpc.publicnode.com",
    GatewayWallet: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9",
    GatewayMinter: "0x0022222ABE238Cc2C7Bb1f21003F0a260052475B",
    USDCAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    ViemChain: baseSepolia,
  },
};

export const ethereumContracts: ChainConfig = {
  domain: 0,
  testnet: {
    RPC: "https://ethereum-sepolia-rpc.publicnode.com",
    GatewayWallet: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9",
    GatewayMinter: "0x0022222ABE238Cc2C7Bb1f21003F0a260052475B",
    USDCAddress: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
    ViemChain: sepolia,
  },
};

// Map UI-friendly names to contract configs
export const CHAIN_CONFIGS: Record<string, ChainConfig> = {
  Avalanche: avalancheContracts,
  Base: baseContracts,
  Ethereum: ethereumContracts,
  Arbitrum: baseContracts, // Placeholder - update when Arbitrum testnet config available
};
