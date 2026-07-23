"use client";

import {
  createPublicClient,
  createWalletClient,
  custom,
  encodePacked,
  hexToBigInt,
  http,
  maxUint256,
  pad,
  parseErc6492Signature,
  type Chain,
  type EIP1193Provider,
} from "viem";
import {
  arbitrumSepolia,
  avalancheFuji,
  baseSepolia,
  optimismSepolia,
  polygonAmoy,
  sepolia,
} from "viem/chains";
import {
  createBundlerClient,
  toSimple7702SmartAccount,
} from "viem/account-abstraction";
import type { BridgeSourceChain } from "@/lib/appkit-bridge";

// Circle Paymaster v0.8 — same address on every supported testnet.
export const PAYMASTER_ADDRESS_V08 =
  "0x3BA9A96eE3eFf3A69E2B18886AcF52027EFF8966" as const;

// CCTP v2 TokenMessengerV2 — same address on all supported testnets.
export const TOKEN_MESSENGER_V2 =
  "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA" as const;

// Arc Testnet CCTP domain ID.
export const ARC_TESTNET_DOMAIN = 26 as const;

// Native balance (wei) below which we offer to pay bridge gas in USDC.
// ~0.001 ETH — conservative floor covering a couple of source-chain txs.
export const LOW_NATIVE_THRESHOLD = 1_000_000_000_000_000n; // 1e15

const CHAIN_CONFIG: Record<
  BridgeSourceChain,
  { chain: Chain; usdcAddress: `0x${string}` }
> = {
  Base_Sepolia: { chain: baseSepolia, usdcAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" },
  Ethereum_Sepolia: { chain: sepolia, usdcAddress: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" },
  Arbitrum_Sepolia: { chain: arbitrumSepolia, usdcAddress: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d" },
  Optimism_Sepolia: { chain: optimismSepolia, usdcAddress: "0x5fd84259d66Cd46123540766Be93DFE6D43130D7" },
  Avalanche_Fuji: { chain: avalancheFuji, usdcAddress: "0x5425890298aed601595a70AB815c96711a31Bc65" },
  Polygon_Amoy_Testnet: { chain: polygonAmoy, usdcAddress: "0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582" },
};

// Minimal EIP-2612 ABI for the permit path.
const eip2612Abi = [
  { type: "function", name: "nonces", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "string" }] },
  { type: "function", name: "version", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "string" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "", type: "bool" }] },
] as const;

const tokenMessengerV2Abi = [
  {
    type: "function",
    name: "depositForBurn",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amount", type: "uint256" },
      { name: "destinationDomain", type: "uint32" },
      { name: "mintRecipient", type: "bytes32" },
      { name: "burnToken", type: "address" },
      { name: "destinationCaller", type: "bytes32" },
      { name: "maxFee", type: "uint256" },
      { name: "minFinalityThreshold", type: "uint32" },
    ],
    outputs: [],
  },
] as const;

// Pimlico bundler URL is per-chain, so we build it from a chain-agnostic API key
// rather than a fixed URL (a single URL would hardcode one chainId and break the
// other source chains). No key → public testnet endpoint, fine for dev.
function bundlerUrl(chainId: number): string {
  const key = process.env.NEXT_PUBLIC_PIMLICO_API_KEY;
  if (key) return `https://api.pimlico.io/v2/${chainId}/rpc?apikey=${key}`;
  return `https://public.pimlico.io/v2/${chainId}/rpc`;
}

// Coarse EIP-7702 capability probe. There's no standard pre-flight for 7702, so
// we use EIP-5792 wallet_getCapabilities as a "modern enough" heuristic: wallets
// that implement it (e.g. MetaMask) are the ones that also do 7702, and a wallet
// too old to answer it definitely can't. If this passes but signAuthorization
// still fails downstream, the burn step surfaces a clean error — no crash.
export async function canUsePaymaster(
  provider: EIP1193Provider,
  address: `0x${string}`,
): Promise<boolean> {
  try {
    const caps = await provider.request({
      method: "wallet_getCapabilities",
      params: [address],
    } as Parameters<typeof provider.request>[0]);
    return caps !== null && caps !== undefined;
  } catch {
    return false;
  }
}

/** Native gas balance for an address on a given source chain. */
export async function getNativeBalance(
  address: `0x${string}`,
  sourceChain: BridgeSourceChain,
): Promise<bigint> {
  const { chain } = CHAIN_CONFIG[sourceChain];
  const client = createPublicClient({ chain, transport: http() });
  return client.getBalance({ address });
}

export type PaymasterBridgeStep =
  | { method: "sign7702"; state: "pending" | "success" | "error" }
  | { method: "signPermit"; state: "pending" | "success" | "error" }
  | { method: "burn"; state: "pending" | "success" | "error"; txHash?: string };

// EIP-2612 permit typed-data. deadline is MAX_UINT256 because the paymaster
// cannot read block.timestamp under 4337 opcode restrictions.
async function eip2612Permit({
  client,
  token,
  chain,
  ownerAddress,
  spenderAddress,
  value,
}: {
  client: ReturnType<typeof createPublicClient>;
  token: `0x${string}`;
  chain: Chain;
  ownerAddress: `0x${string}`;
  spenderAddress: `0x${string}`;
  value: bigint;
}) {
  const [name, version, nonce] = await Promise.all([
    client.readContract({ address: token, abi: eip2612Abi, functionName: "name" }) as Promise<string>,
    client.readContract({ address: token, abi: eip2612Abi, functionName: "version" }) as Promise<string>,
    client.readContract({ address: token, abi: eip2612Abi, functionName: "nonces", args: [ownerAddress] }) as Promise<bigint>,
  ]);
  return {
    types: {
      Permit: [
        { name: "owner", type: "address" },
        { name: "spender", type: "address" },
        { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "Permit" as const,
    domain: {
      name,
      version,
      chainId: chain.id,
      verifyingContract: token,
    },
    message: {
      owner: ownerAddress,
      spender: spenderAddress,
      value,
      nonce,
      deadline: maxUint256,
    },
  };
}

/**
 * Source-chain approve + burn as one ERC-4337 UserOperation via Circle
 * Paymaster v0.8, paying gas in USDC. Returns the burn txHash so the caller
 * hands off to AppKit's fetchAttestation + mint for the Arc destination side.
 */
export async function bridgeWithPaymaster({
  provider,
  address,
  sourceChain,
  amount,
  recipientAddress,
  onStep,
}: {
  provider: EIP1193Provider;
  address: `0x${string}`;
  sourceChain: BridgeSourceChain;
  amount: bigint; // USDC units (6 decimals)
  recipientAddress: string;
  onStep?: (step: PaymasterBridgeStep) => void;
}): Promise<{ txHash: string }> {
  const { chain, usdcAddress } = CHAIN_CONFIG[sourceChain];

  const client = createPublicClient({ chain, transport: http() });
  // The connected browser wallet is the smart-account owner/signer.
  const owner = createWalletClient({ account: address, chain, transport: custom(provider) });
  // toSimple7702SmartAccount types owner as PrivateKeyAccount, but at runtime it
  // only calls owner.address / signMessage / signTypedData / signAuthorization —
  // all provided by this JSON-RPC WalletClient (the connected browser wallet).
  const account = await toSimple7702SmartAccount({
    client,
    owner: owner as unknown as Parameters<typeof toSimple7702SmartAccount>[0]["owner"],
  });

  // Paymaster object: signs the USDC permit and packs paymasterData per the
  // Circle v0.8 layout [uint8 mode, address token, uint256 amount, bytes sig].
  const paymaster = {
    async getPaymasterData() {
      onStep?.({ method: "signPermit", state: "pending" });
      try {
        const permitAmount = 10_000_000n; // 10 USDC ceiling for gas
        const permitData = await eip2612Permit({
          client,
          token: usdcAddress,
          chain,
          ownerAddress: address,
          spenderAddress: PAYMASTER_ADDRESS_V08,
          value: permitAmount,
        });
        const wrapped = await owner.signTypedData({ account: address, ...permitData });
        const { signature } = parseErc6492Signature(wrapped);

        const paymasterData = encodePacked(
          ["uint8", "address", "uint256", "bytes"],
          [0, usdcAddress, permitAmount, signature],
        );
        onStep?.({ method: "signPermit", state: "success" });
        return {
          paymaster: PAYMASTER_ADDRESS_V08,
          paymasterData,
          paymasterVerificationGasLimit: 200_000n,
          paymasterPostOpGasLimit: 15_000n,
          isFinal: true,
        };
      } catch (e) {
        onStep?.({ method: "signPermit", state: "error" });
        throw e;
      }
    },
  };

  const bundler = createBundlerClient({
    account,
    client,
    paymaster,
    userOperation: {
      estimateFeesPerGas: async ({ bundlerClient }) => {
        const { standard: fees } = (await bundlerClient.request({
          // @ts-expect-error Pimlico-specific RPC method
          method: "pimlico_getUserOperationGasPrice",
        })) as { standard: { maxFeePerGas: `0x${string}`; maxPriorityFeePerGas: `0x${string}` } };
        return {
          maxFeePerGas: hexToBigInt(fees.maxFeePerGas),
          maxPriorityFeePerGas: hexToBigInt(fees.maxPriorityFeePerGas),
        };
      },
    },
    transport: http(bundlerUrl(chain.id)),
  });

  // EIP-7702 authorization — upgrades the EOA to the Simple7702 implementation.
  onStep?.({ method: "sign7702", state: "pending" });
  let authorization;
  try {
    authorization = await owner.signAuthorization({
      account: address,
      chainId: chain.id,
      nonce: await client.getTransactionCount({ address }),
      contractAddress: account.authorization.address,
    });
  } catch (e) {
    onStep?.({ method: "sign7702", state: "error" });
    throw e;
  }
  onStep?.({ method: "sign7702", state: "success" });

  onStep?.({ method: "burn", state: "pending" });
  // CCTP mintRecipient is the 20-byte address right-aligned in bytes32.
  const mintRecipient = pad(recipientAddress as `0x${string}`, { size: 32 });
  let txHash: string;
  try {
    const userOpHash = await bundler.sendUserOperation({
      account,
      authorization,
      calls: [
        { to: usdcAddress, abi: eip2612Abi, functionName: "approve", args: [TOKEN_MESSENGER_V2, amount] },
        {
          to: TOKEN_MESSENGER_V2,
          abi: tokenMessengerV2Abi,
          functionName: "depositForBurn",
          args: [
            amount,
            ARC_TESTNET_DOMAIN,
            mintRecipient,
            usdcAddress,
            "0x0000000000000000000000000000000000000000000000000000000000000000",
            1_000n, // maxFee: 0.001 USDC
            1000, // minFinalityThreshold: Fast Transfer
          ],
        },
      ],
    });
    const receipt = await bundler.waitForUserOperationReceipt({ hash: userOpHash });
    txHash = receipt.receipt.transactionHash;
  } catch (e) {
    onStep?.({ method: "burn", state: "error" });
    throw e;
  }

  onStep?.({ method: "burn", state: "success", txHash });
  return { txHash };
}
