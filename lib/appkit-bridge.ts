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
import { CCTPV2BridgingProvider } from "@circle-fin/provider-cctp-v2";
import type { AppKitActions } from "@circle-fin/app-kit";
import type { Connector } from "wagmi";
import { parseUnits, type EIP1193Provider } from "viem";
import {
  bridgeWithPaymaster,
  canUsePaymaster,
  getNativeBalance,
  LOW_NATIVE_THRESHOLD,
  type PaymasterBridgeStep,
} from "@/lib/paymaster-bridge";

export { canUsePaymaster, getNativeBalance, LOW_NATIVE_THRESHOLD };

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

// Live, per-transaction progress emitted by the CCTP v2 provider while a bridge
// runs. The flow is: approve (source) -> burn (source) -> fetchAttestation
// (Circle) -> mint (Arc). `reAttest` only appears if an attestation expires.
export type BridgeStepEvent = {
  method: "approve" | "burn" | "fetchAttestation" | "mint" | "reAttest";
  state: "pending" | "success" | "error" | "noop";
  explorerUrl?: string;
  txHash?: string;
  errorMessage?: string;
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
  onStep,
}: {
  session: BrowserWalletSession;
  sourceChain: BridgeSourceChain;
  recipientAddress: string;
  amount: string;
  onStep?: (event: BridgeStepEvent) => void;
}): Promise<BridgeSummary> {
  const chain = resolveChainIdentifier(sourceChain);

  if (chain.type !== "evm") {
    throw new Error(`${sourceChain} is not an EVM chain.`);
  }

  await session.adapter.ensureChain(chain);

  const unsubscribe = onStep ? subscribeBridgeSteps(onStep) : undefined;

  try {
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
  } finally {
    unsubscribe?.();
  }
}

// Source-chain CCTP domain definitions for the granular attestation/mint path.
const SOURCE_CHAIN_DEFS: Record<BridgeSourceChain, unknown> = {
  Arbitrum_Sepolia: ArbitrumSepolia,
  Avalanche_Fuji: AvalancheFuji,
  Base_Sepolia: BaseSepolia,
  Ethereum_Sepolia: EthereumSepolia,
  Optimism_Sepolia: OptimismSepolia,
  Polygon_Amoy_Testnet: PolygonAmoy,
};

// 7702 auth + USDC permit both surface to the existing UI as the "approve"
// phase; the burn drives the advance to the bridge step.
function mapPaymasterStep(step: PaymasterBridgeStep): BridgeStepEvent {
  if (step.method === "burn") {
    return { method: "burn", state: step.state, txHash: step.txHash };
  }
  return { method: "approve", state: step.state === "error" ? "error" : "pending" };
}

// Paymaster variant of bridgeUsdcToArc: hand-rolls the source-chain approve +
// burn as an ERC-4337 UserOperation (gas paid in USDC) so a wallet with no
// native gas token can still bridge, then hands the burn txHash to AppKit's
// CCTP attestation + mint for the Arc side (Arc gas is USDC natively).
export async function bridgeUsdcToArcWithPaymaster({
  session,
  provider,
  sourceChain,
  recipientAddress,
  amount,
  onStep,
}: {
  session: BrowserWalletSession;
  provider: EIP1193Provider;
  sourceChain: BridgeSourceChain;
  recipientAddress: string;
  amount: string;
  onStep?: (event: BridgeStepEvent) => void;
}): Promise<BridgeSummary> {
  // Put the wallet on the source chain before the burn signs its 7702 auth +
  // permit there (mirrors bridgeUsdcToArc's ensureChain before kit.bridge).
  const srcChain = resolveChainIdentifier(sourceChain);
  if (srcChain.type !== "evm") throw new Error(`${sourceChain} is not an EVM chain.`);
  await session.adapter.ensureChain(srcChain);

  const { txHash } = await bridgeWithPaymaster({
    provider,
    address: session.connectedAddress as `0x${string}`,
    sourceChain,
    amount: parseUnits(amount, 6),
    recipientAddress,
    onStep: (step) => onStep?.(mapPaymasterStep(step)),
  });

  const cctp = new CCTPV2BridgingProvider();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- cross-package WalletContext structural types
  const source = { adapter: session.adapter, address: session.connectedAddress, chain: SOURCE_CHAIN_DEFS[sourceChain] } as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- cross-package DestinationWalletContext
  const destination = { adapter: session.adapter, address: session.connectedAddress, chain: ArcTestnet, recipientAddress } as any;

  onStep?.({ method: "fetchAttestation", state: "pending" });
  const attestation = await cctp.fetchAttestation(source, txHash);
  onStep?.({ method: "fetchAttestation", state: "success" });

  onStep?.({ method: "mint", state: "pending" });
  await session.adapter.ensureChain(resolveChainIdentifier("Arc_Testnet"));
  const prepared = await cctp.mint(source, destination, attestation);
  const mintTxHash = await prepared.execute();
  onStep?.({ method: "mint", state: "success", txHash: mintTxHash });

  return { state: "success", explorerUrls: [], steps: ["burn: success", "mint: success"] };
}

// Bridge over the AppKit event bus so the UI can render live per-transaction
// progress. A single wildcard subscriber is used and torn down when the bridge
// settles, so concurrent bridges never cross wires.
function subscribeBridgeSteps(onStep: (event: BridgeStepEvent) => void): () => void {
  const handler = (payload: AppKitActions[keyof AppKitActions]) => {
    const action = payload as unknown as {
      method?: string;
      values?: { state?: string; explorerUrl?: string; txHash?: string; errorMessage?: string };
    };

    if (!action.method || !action.values) {
      return;
    }

    onStep({
      method: action.method as BridgeStepEvent["method"],
      state: (action.values.state ?? "pending") as BridgeStepEvent["state"],
      explorerUrl: action.values.explorerUrl,
      txHash: action.values.txHash,
      errorMessage: action.values.errorMessage,
    });
  };

  kit.on("*", handler);
  return () => kit.off("*", handler);
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
