// One-time setup for Scout, the nanopayment agent:
//   1. generate its EOA (its x402 signer)
//   2. register an ERC-8004 identity so its payments are attributable on-chain
//   3. deposit USDC into Circle Gateway so it can pay per-call without gas
//
// Idempotent: re-running with SCOUT_PRIVATE_KEY and SCOUT_ERC8004_TOKEN_ID set
// skips straight to topping up the Gateway balance.
//
// Run: npm run scout:setup
import { createWalletClient, createPublicClient, http, formatUnits, erc20Abi } from "viem";
import { arcTestnet } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { GatewayClient } from "@circle-fin/x402-batching/client";
import { ARC_TESTNET_RPC, ARC_IDENTITY_REGISTRY, ARC_TESTNET_USDC } from "../lib/x402/constants.ts";

const REGISTER_ABI = [
  {
    type: "function",
    name: "register",
    stateMutability: "nonpayable",
    inputs: [{ name: "metadataURI", type: "string" }],
    outputs: [{ name: "tokenId", type: "uint256" }],
  },
] as const;

const privateKey = (process.env.SCOUT_PRIVATE_KEY as `0x${string}`) ?? generatePrivateKey();
const account = privateKeyToAccount(privateKey);

if (!process.env.SCOUT_PRIVATE_KEY) {
  console.log("Generated a new Scout key. Add these to .env.local:\n");
  console.log(`SCOUT_PRIVATE_KEY=${privateKey}`);
  console.log(`SCOUT_ADDRESS=${account.address}\n`);
}
console.log("Scout address:", account.address);

const publicClient = createPublicClient({ chain: arcTestnet, transport: http(ARC_TESTNET_RPC) });

// On Arc, USDC is the gas token, so one balance covers both fees and payments.
const [gas, usdc] = await Promise.all([
  publicClient.getBalance({ address: account.address }),
  publicClient.readContract({
    address: ARC_TESTNET_USDC,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [account.address],
  }),
]);
console.log("Native (gas):", formatUnits(gas, 18));
console.log("USDC (ERC-20):", formatUnits(usdc, 6));

if (gas === 0n) {
  console.log("\nNot funded yet. Send Arc Testnet USDC to the address above");
  console.log("(faucet: https://faucet.circle.com/), then re-run this script.");
  process.exit(0);
}

const wallet = createWalletClient({ account, chain: arcTestnet, transport: http(ARC_TESTNET_RPC) });

// --- ERC-8004 identity -------------------------------------------------------
if (process.env.SCOUT_ERC8004_TOKEN_ID) {
  console.log("\nERC-8004 already registered: #" + process.env.SCOUT_ERC8004_TOKEN_ID);
} else {
  const metadataUri =
    process.env.SCOUT_METADATA_URI ??
    "ipfs://bafkreibdi6623n3xpf7ymk62ckb4bo75o3qemwkpfvp5i25j66itxvsoei";
  console.log("\nRegistering ERC-8004 identity...");
  const hash = await wallet.writeContract({
    address: ARC_IDENTITY_REGISTRY,
    abi: REGISTER_ABI,
    functionName: "register",
    args: [metadataUri],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });

  // register() mints the identity NFT to msg.sender; tokenId (= agentId) is the
  // third indexed topic of the ERC-721 Transfer log.
  const mint = receipt.logs.find(
    (log) => log.address.toLowerCase() === ARC_IDENTITY_REGISTRY.toLowerCase() && log.topics.length === 4,
  );
  const tokenId = mint ? BigInt(mint.topics[3]!).toString() : null;

  console.log("register tx:", receipt.transactionHash);
  if (tokenId) {
    console.log(`\nAdd to .env.local:\nSCOUT_ERC8004_TOKEN_ID=${tokenId}\n`);
  } else {
    console.log("Could not read tokenId from the receipt — check the tx on Arcscan.");
  }
}

// --- Circle Gateway deposit --------------------------------------------------
const gateway = new GatewayClient({ chain: "arcTestnet", privateKey });
const before = await gateway.getBalances();
console.log("Gateway available:", before.gateway.formattedAvailable, "USDC");

const depositAmount = process.env.SCOUT_DEPOSIT_AMOUNT ?? "1";
if (Number(before.gateway.formattedAvailable) < Number(depositAmount)) {
  console.log(`Depositing ${depositAmount} USDC into Gateway...`);
  const deposit = await gateway.deposit(depositAmount);
  console.log("deposit tx:", deposit.depositTxHash);
  const after = await gateway.getBalances();
  console.log("Gateway available:", after.gateway.formattedAvailable, "USDC");
}

console.log("\nScout is ready.");
