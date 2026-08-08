import { type Address, type Chain } from "viem";
import { arcTestnet, avalancheFuji, baseSepolia, sepolia } from "viem/chains";

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

export const arcContracts: ChainConfig = {
  domain: 26,
  testnet: {
    RPC: "https://rpc.testnet.arc.network",
    GatewayWallet: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9",
    GatewayMinter: "0x0022222ABE238Cc2C7Bb1f21003F0a260052475B",
    USDCAddress: "0x3600000000000000000000000000000000000000",
    ViemChain: arcTestnet,
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
  Polygon: avalancheContracts, // Using Avalanche as fallback since Polygon not in testnet
  Avalanche: avalancheContracts,
  Base: baseContracts,
  Ethereum: ethereumContracts,
};
