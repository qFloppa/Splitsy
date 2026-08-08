import type { WalletClient } from "viem";
import { maxUint64, parseUnits, pad, type Hex, zeroAddress } from "viem";
import {
  GATEWAY_CONFIG,
  CHAIN_CONFIGS,
  arcContracts,
  type ChainConfig,
} from "./gateway-contracts";

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

const MAX_FEE = 2_010000n;

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
      maxBlockHeight: maxUint64.toString(),
      maxFee: MAX_FEE.toString(),
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
        value: transferAmount.toString(),
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
      body: JSON.stringify([{ burnIntent, signature: burnSignature }]),
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
