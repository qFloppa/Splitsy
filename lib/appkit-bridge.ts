"use client";

import { AppKit } from "@circle-fin/app-kit";
import {
  ArbitrumSepolia,
  ArcTestnet,
  AvalancheFuji,
  BaseSepolia,
  EthereumSepolia,
  OptimismSepolia,
  PolygonAmoy,
} from "@circle-fin/app-kit/chains";
import { createViemAdapterFromProvider, resolveChainIdentifier } from "@circle-fin/adapter-viem-v2";
import type { Connector } from "wagmi";
import type { EIP1193Provider } from "viem";

export type BridgeSourceChain =
  | "Arbitrum_Sepolia"
  | "Avalanche_Fuji"
  | "Base_Sepolia"
  | "Ethereum_Sepolia"
  | "Optimism_Sepolia"
  | "Polygon_Amoy_Testnet";
type BrowserAdapter = Awaited<ReturnType<typeof createViemAdapterFromProvider>>;

export const bridgeSourceChains: Array<{ id: BridgeSourceChain; label: string }> = [
  { id: "Base_Sepolia", label: "Base Sepolia" },
  { id: "Ethereum_Sepolia", label: "Ethereum Sepolia" },
  { id: "Arbitrum_Sepolia", label: "Arbitrum Sepolia" },
  { id: "Optimism_Sepolia", label: "Optimism Sepolia" },
  { id: "Avalanche_Fuji", label: "Avalanche Fuji" },
  { id: "Polygon_Amoy_Testnet", label: "Polygon Amoy" },
];

export type BrowserWalletSession = {
  adapter: BrowserAdapter;
  connectedAddress: string;
  walletName: string;
};

export async function createBrowserWalletSessionFromConnector({
  connector,
  connectedAddress,
}: {
  connector: Connector;
  connectedAddress: string;
}): Promise<BrowserWalletSession> {
  const provider = (await connector.getProvider()) as EIP1193Provider | null;

  if (!provider) {
    throw new Error("Connected wallet provider is unavailable.");
  }

  const adapter = await createViemAdapterFromProvider({
    provider,
    capabilities: {
      supportedChains: [
        ArbitrumSepolia,
        AvalancheFuji,
        BaseSepolia,
        EthereumSepolia,
        OptimismSepolia,
        PolygonAmoy,
        ArcTestnet,
      ],
    },
  });

  return {
    adapter,
    connectedAddress,
    walletName: connector.name,
  };
}

export type BridgeSummary = {
  state: string;
  explorerUrls: string[];
  steps: string[];
};

type EIP6963ProviderInfo = {
  uuid: string;
  name: string;
  icon: string;
  rdns: string;
};

type EIP6963ProviderDetail = {
  info: EIP6963ProviderInfo;
  provider: EIP1193Provider;
};

type BridgeResultLike = {
  state?: string;
  steps?: Array<{
    name?: string;
    state?: string;
    txHash?: string;
    explorerUrl?: string;
    values?: {
      explorerUrl?: string;
      txHash?: string;
      name?: string;
      state?: string;
    };
    data?: {
      explorerUrl?: string;
      txHash?: string;
    };
  }>;
};

declare global {
  interface WindowEventMap {
    "eip6963:announceProvider": CustomEvent<EIP6963ProviderDetail>;
  }
}

const kit = new AppKit();

export async function connectBrowserWallet(): Promise<BrowserWalletSession> {
  const providers = await discoverBrowserWallets();
  const selectedWallet =
    providers.find(({ info }) => info.rdns === "io.metamask" || info.name === "MetaMask") ??
    providers[0];

  if (!selectedWallet) {
    throw new Error("No EIP-6963 browser wallet found.");
  }

  await selectedWallet.provider.request({
    method: "eth_requestAccounts",
    params: undefined,
  });

  const accounts = (await selectedWallet.provider.request({
    method: "eth_accounts",
    params: undefined,
  })) as string[];
  const connectedAddress = accounts[0];

  if (!connectedAddress) {
    throw new Error("Wallet did not return an account.");
  }

  const adapter = await createViemAdapterFromProvider({
    provider: selectedWallet.provider,
    capabilities: {
      supportedChains: [
        ArbitrumSepolia,
        AvalancheFuji,
        BaseSepolia,
        EthereumSepolia,
        OptimismSepolia,
        PolygonAmoy,
        ArcTestnet,
      ],
    },
  });

  return {
    adapter,
    connectedAddress,
    walletName: selectedWallet.info.name,
  };
}

export async function bridgeUsdcToArc({
  session,
  sourceChain,
  recipientAddress,
  amount,
}: {
  session: BrowserWalletSession;
  sourceChain: BridgeSourceChain;
  recipientAddress: string;
  amount: string;
}): Promise<BridgeSummary> {
  const chain = resolveChainIdentifier(sourceChain);

  if (chain.type !== "evm") {
    throw new Error(`${sourceChain} is not an EVM chain.`);
  }

  await session.adapter.ensureChain(chain);

  const result = (await kit.bridge({
    from: { adapter: session.adapter, chain: sourceChain },
    to: {
      adapter: session.adapter,
      chain: "Arc_Testnet",
      recipientAddress,
    },
    amount,
    token: "USDC",
  })) as BridgeResultLike;

  return summarizeBridgeResult(result);
}

async function discoverBrowserWallets(): Promise<EIP6963ProviderDetail[]> {
  const providers = new Map<string, EIP6963ProviderDetail>();

  const handleProviderAnnouncement = (event: WindowEventMap["eip6963:announceProvider"]) => {
    providers.set(event.detail.info.uuid, event.detail);
  };

  window.addEventListener("eip6963:announceProvider", handleProviderAnnouncement);
  window.dispatchEvent(new Event("eip6963:requestProvider"));

  await new Promise((resolve) => window.setTimeout(resolve, 250));
  window.removeEventListener("eip6963:announceProvider", handleProviderAnnouncement);

  return [...providers.values()];
}

function summarizeBridgeResult(result: BridgeResultLike): BridgeSummary {
  const steps = result.steps ?? [];
  const explorerUrls = steps
    .map((step) => step.explorerUrl ?? step.values?.explorerUrl ?? step.data?.explorerUrl)
    .filter((value): value is string => Boolean(value));

  return {
    state: result.state ?? "unknown",
    explorerUrls,
    steps: steps.map((step) => `${step.name ?? step.values?.name ?? "step"}: ${step.state ?? step.values?.state ?? "unknown"}`),
  };
}
