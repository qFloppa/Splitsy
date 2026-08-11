import type { WalletClient } from "viem";
import { createPublicClient, http, maxUint64, parseUnits, pad, type Hex, zeroAddress } from "viem";
import {
  GATEWAY_CONFIG,
  CHAIN_CONFIGS,
  arcContracts,
  type ChainConfig,
} from "./gateway-contracts.ts";

const EIP712_DOMAIN = {
  name: "GatewayWallet",
  version: "1",
} as const;

const EIP712_TYPES = {
  TransferSpec: [
    { name: "version", type: "uint32" },
    { name: "sourceDomain", type: "uint32" },
    { name: "destinationDomain", type: "uint32" },
    { name: "sourceContract", type: "bytes32" },
    { name: "destinationContract", type: "bytes32" },
    { name: "sourceToken", type: "bytes32" },
    { name: "destinationToken", type: "bytes32" },
    { name: "sourceDepositor", type: "bytes32" },
    { name: "destinationRecipient", type: "bytes32" },
    { name: "sourceSigner", type: "bytes32" },
    { name: "destinationCaller", type: "bytes32" },
    { name: "value", type: "uint256" },
    { name: "salt", type: "bytes32" },
    { name: "hookData", type: "bytes" },
  ],
  BurnIntent: [
    { name: "maxBlockHeight", type: "uint256" },
    { name: "maxFee", type: "uint256" },
    { name: "spec", type: "TransferSpec" },
  ],
} as const;

// Circle's documented floor is `gas fee + (amount * 0.00005)`; this flat cap is
// what their own quickstart signs. It is a ceiling, not a charge — only the real
// fee is taken, and whatever is left stays credited for the next transfer.
// Deposits must cover it on top of the transfer value, since the Gateway System
// decrements the balance when it issues the attestation.
export const GATEWAY_MAX_FEE = 2_010000n;

// Every number in a burn intent is a bigint, and JSON.stringify throws
// "Do not know how to serialize a BigInt" on the first one it meets — which
// killed the transfer *after* the deposit had already spent USDC on the source
// chain. Circle's own quickstart ships this exact replacer.
const bigintToString = (_key: string, value: unknown) =>
  typeof value === "bigint" ? value.toString() : value;

const gatewayMinterAbi = [
  {
    type: "function",
    name: "gatewayMint",
    inputs: [
      { name: "attestationPayload", type: "bytes" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

const gatewayWalletAbi = [
  {
    type: "function",
    name: "deposit",
    inputs: [
      { name: "token", type: "address" },
      { name: "value", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

const usdcAbi = [
  {
    type: "function",
    name: "approve",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
    stateMutability: "nonpayable",
  },
] as const;

export type GatewayTransferResult = {
  success: boolean;
  transactionHash?: string;
  error?: string;
  mintData?: {
    address: Hex;
    abi: typeof gatewayMinterAbi;
    functionName: "gatewayMint";
    args: [Hex, Hex];
  };
};

export type GatewayDepositResult = {
  success: boolean;
  transactionHash?: string;
  alreadyFunded?: boolean; // Gateway already credits enough; nothing was sent
  error?: string;
};

function randomHex32(): Hex {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `0x${Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}` as Hex;
}

function evmAddressToBytes32(address: Hex): Hex {
  return pad(address.toLowerCase() as Hex, { size: 32 });
}

/**
 * The Gateway System's view of a depositor's spendable balance on one domain,
 * in 6-decimal units. This is not the same as the USDC sitting in the wallet
 * contract: a deposit only counts once its events finalize onchain.
 */
export async function getGatewayBalance(params: {
  domain: number;
  depositor: Hex;
}): Promise<bigint> {
  const response = await fetch(`${GATEWAY_CONFIG.TESTNET_URL}/balances`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token: "USDC",
      sources: [{ domain: params.domain, depositor: params.depositor }],
    }),
  });

  if (!response.ok) return 0n;

  const json = (await response.json()) as { balances?: { balance?: string }[] };
  return parseUnits(json.balances?.[0]?.balance ?? "0", 6);
}

/**
 * Block until Gateway credits `needed` units, or give up. Deposit finality runs
 * ~8s on Fuji but 13-19 minutes on the Sepolia-family chains, so the caller gets
 * told which one it is rather than watching a spinner with no explanation.
 * ponytail: fixed-interval poll, no backoff — the wait is dominated by chain
 * finality, not by how often we ask.
 */
export async function waitForGatewayBalance(params: {
  domain: number;
  depositor: Hex;
  needed: bigint;
  timeoutMs?: number;
  onWait?: (elapsedMs: number) => void;
}): Promise<boolean> {
  const timeoutMs = params.timeoutMs ?? 20 * 60_000;
  const started = performance.now();

  for (;;) {
    if (await getGatewayBalance(params) >= params.needed) return true;

    const elapsed = performance.now() - started;
    if (elapsed >= timeoutMs) return false;
    params.onWait?.(elapsed);
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
}

/**
 * Deposit USDC into Gateway on a source chain, topping up only the shortfall
 * against what Gateway already credits this depositor. Must be called before
 * initiateGatewayTransfer.
 */
export async function depositToGateway(params: {
  walletClient: WalletClient;
  sourceChain: string;
  amountUsdc: string;
}): Promise<GatewayDepositResult> {
  try {
    const sourceChainConfig = CHAIN_CONFIGS[params.sourceChain];
    if (!sourceChainConfig?.testnet) {
      return {
        success: false,
        error: `Chain ${params.sourceChain} not supported`,
      };
    }

    const sourceChain = sourceChainConfig.testnet;
    const evmAddress = params.walletClient.account?.address;

    if (!evmAddress) {
      return { success: false, error: "No wallet address" };
    }

    // Already-credited balance counts. Without this, every payment re-deposits
    // the full fee buffer and strands it a transfer at a time.
    const needed = parseUnits(params.amountUsdc, 6);
    const credited = await getGatewayBalance({
      domain: sourceChainConfig.domain,
      depositor: evmAddress,
    });
    if (credited >= needed) return { success: true, alreadyFunded: true };

    const amount = needed - credited;
    const publicClient = createPublicClient({
      chain: sourceChain.ViemChain,
      transport: http(sourceChain.RPC),
    });

    // Step 1: Approve GatewayWallet to spend USDC
    const approveHash = await params.walletClient.writeContract({
      address: sourceChain.USDCAddress as Hex,
      abi: usdcAbi,
      functionName: "approve",
      args: [sourceChain.GatewayWallet as Hex, amount],
      account: evmAddress,
      chain: sourceChain.ViemChain,
    });
    // deposit() pulls via transferFrom, so it reverts if the approval has not
    // landed yet. Previously both went out back-to-back unawaited.
    await publicClient.waitForTransactionReceipt({ hash: approveHash });

    // Step 2: Deposit into GatewayWallet
    const depositHash = await params.walletClient.writeContract({
      address: sourceChain.GatewayWallet as Hex,
      abi: gatewayWalletAbi,
      functionName: "deposit",
      args: [sourceChain.USDCAddress as Hex, amount],
      account: evmAddress,
      chain: sourceChain.ViemChain,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: depositHash });

    if (receipt.status !== "success") {
      return { success: false, error: "Gateway deposit reverted on the source chain" };
    }

    return {
      success: true,
      transactionHash: depositHash,
    };
  } catch (err) {
    console.error("[gateway-browser] deposit failed:", err);
    return {
      success: false,
      error: err instanceof Error ? err.message : "Gateway deposit failed",
    };
  }
}

/**
 * Initiate a Gateway transfer from a browser wallet.
 * Returns the mint transaction data for the caller to execute on the destination chain.
 */
export async function initiateGatewayTransfer(params: {
  walletClient: WalletClient;
  sourceChain: string;
  amountUsdc: string;
  recipientAddress: string;
}): Promise<GatewayTransferResult> {
  try {
    const sourceChainConfig = CHAIN_CONFIGS[params.sourceChain];
    if (!sourceChainConfig?.testnet) {
      return {
        success: false,
        error: `Chain ${params.sourceChain} not supported`,
      };
    }

    const sourceChain = sourceChainConfig.testnet;
    const destChain = arcContracts.testnet!;
    const evmAddress = params.walletClient.account?.address;

    if (!evmAddress) {
      return { success: false, error: "No wallet address" };
    }

    const recipient = params.recipientAddress as Hex;
    const transferAmount = parseUnits(params.amountUsdc, 6);

    // Build EIP-712 burn intent
    const burnIntent = {
      maxBlockHeight: maxUint64,
      maxFee: GATEWAY_MAX_FEE,
      spec: {
        version: 1,
        sourceDomain: sourceChainConfig.domain,
        destinationDomain: arcContracts.domain,
        sourceContract: evmAddressToBytes32(sourceChain.GatewayWallet as Hex),
        destinationContract: evmAddressToBytes32(destChain.GatewayMinter as Hex),
        sourceToken: evmAddressToBytes32(sourceChain.USDCAddress as Hex),
        destinationToken: evmAddressToBytes32(destChain.USDCAddress as Hex),
        sourceDepositor: evmAddressToBytes32(evmAddress),
        destinationRecipient: evmAddressToBytes32(recipient),
        sourceSigner: evmAddressToBytes32(evmAddress),
        destinationCaller: evmAddressToBytes32(zeroAddress),
        value: transferAmount,
        salt: randomHex32(),
        hookData: "0x" as Hex,
      },
    };

    // Sign the burn intent
    const burnSignature = await params.walletClient.signTypedData({
      domain: EIP712_DOMAIN,
      primaryType: "BurnIntent",
      types: EIP712_TYPES,
      message: burnIntent,
      account: evmAddress,
    });

    // Submit to Gateway API for attestation
    const response = await fetch(`${GATEWAY_CONFIG.TESTNET_URL}/transfer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([{ burnIntent, signature: burnSignature }], bigintToString),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return {
        success: false,
        error: `Gateway API: ${response.status} ${errorText}`,
      };
    }

    const { attestation, signature: apiSignature } = await response.json();

    // Return mint transaction data for caller to execute
    return {
      success: true,
      mintData: {
        address: destChain.GatewayMinter as Hex,
        abi: gatewayMinterAbi,
        functionName: "gatewayMint",
        args: [attestation as Hex, apiSignature as Hex],
      },
    };
  } catch (err) {
    console.error("[gateway-browser] transfer failed:", err);
    return {
      success: false,
      error: err instanceof Error ? err.message : "Gateway transfer failed",
    };
  }
}
