// One-time setup for the Splitsy Settler, the provider on every ERC-8183 job:
//   1. generate its EOA (its ERC-8183 signer AND its x402 signer)
//   2. register an ERC-8004 identity so its jobs are attributable on chain
//   3. deposit USDC into Circle Gateway so it can buy reviews without gas
//
// Idempotent: re-running with SETTLER_PRIVATE_KEY and SETTLER_ERC8004_TOKEN_ID
// set skips straight to topping up the Gateway balance.
//
// AFTER RUNNING THIS: every existing user must RE-ARM their mandate. The
// Settler's address replaces the old splitsy:autopay-agent DCW as the address
// named in AutopayMandate, and a mandate naming the old agent is simply
// skipped — the route returns before writing any log row for it.
//
// Run: npm run settler:setup
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

const privateKey = (process.env.SETTLER_PRIVATE_KEY as `0x${string}`) ?? generatePrivateKey();
const account = privateKeyToAccount(privateKey);

if (!process.env.SETTLER_PRIVATE_KEY) {
  console.log("Generated a new Settler key. Add these to .env.local:\n");
  console.log(`SETTLER_PRIVATE_KEY=${privateKey}`);
  console.log(`NEXT_PUBLIC_AUTOPAY_AGENT_ADDRESS=${account.address}\n`);
}
console.log("Settler address:", account.address);

const publicClient = createPublicClient({ chain: arcTestnet, transport: http(ARC_TESTNET_RPC) });

// On Arc, USDC is the gas token. UNVERIFIED whether a raw EOA holding only
// ERC-20 USDC and no native balance can pay gas (spec §12 Q4) — this print is
// how you find out before the first settlement does.
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

// Stop only when BOTH balances are empty. If Q4's answer turns out to be "yes,
// ERC-20 USDC alone pays gas", a zero native balance is not a blocker, and
// exiting on it would contradict the non-zero USDC figure printed one line up.
// SETTLER_FORCE=1 pushes past this either way — for a stale RPC read, or to let
// the register tx below BE the Q4 experiment.
const force = process.env.SETTLER_FORCE === "1";
if (gas === 0n && usdc === 0n && !force) {
  console.log("\nNot funded yet: native (gas) and USDC (ERC-20) are both zero.");
  console.log("Send Arc Testnet USDC to the address above");
  console.log("(faucet: https://faucet.circle.com/), then re-run this script.");
  console.log("(SETTLER_FORCE=1 proceeds anyway.)");
  process.exit(0);
}
if (gas === 0n && usdc > 0n) {
  console.log("\nNote: native (gas) balance is zero — only the ERC-20 USDC balance is funded.");
  console.log("If the register tx below fails on gas, that answers spec §12 Q4: Arc needs a native balance.");
} else if (gas === 0n) {
  console.log("\nNote: proceeding with SETTLER_FORCE on an entirely unfunded address. Expect the register tx to fail.");
}

const wallet = createWalletClient({ account, chain: arcTestnet, transport: http(ARC_TESTNET_RPC) });

// --- ERC-8004 identity -------------------------------------------------------
// The env var is a hint, not the authority. Gating the mint on it alone means a
// .env.local that loses SETTLER_ERC8004_TOKEN_ID mints a SECOND identity for a
// wallet that already owns one — the same duplicate-identity bug that hit the
// user agents, one script over. So ask the chain: one wallet, one identity.
const heldIdentities = await publicClient.readContract({
  address: ARC_IDENTITY_REGISTRY,
  abi: [
    {
      type: "function",
      name: "balanceOf",
      stateMutability: "view",
      inputs: [{ name: "owner", type: "address" }],
      outputs: [{ type: "uint256" }],
    },
  ] as const,
  functionName: "balanceOf",
  args: [account.address],
});

if (process.env.SETTLER_ERC8004_TOKEN_ID) {
  console.log("\nERC-8004 already registered: #" + process.env.SETTLER_ERC8004_TOKEN_ID);
} else if (heldIdentities > 0n) {
  console.log(`\nThis address already holds ${heldIdentities} ERC-8004 identity NFT(s) — not minting another.`);
  console.log("Find its token id on Arcscan and set SETTLER_ERC8004_TOKEN_ID in .env.local:");
  console.log(`https://testnet.arcscan.app/address/${account.address}`);
} else {
  const metadataUri =
    process.env.SETTLER_METADATA_URI ??
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
    console.log(`\nAdd to .env.local:\nSETTLER_ERC8004_TOKEN_ID=${tokenId}\n`);
  } else {
    console.log("Could not read tokenId from the receipt — check the tx on Arcscan.");
  }
}

// --- Circle Gateway deposit --------------------------------------------------
const gateway = new GatewayClient({ chain: "arcTestnet", privateKey, rpcUrl: ARC_TESTNET_RPC });
const before = await gateway.getBalances();
console.log("Gateway available:", before.gateway.formattedAvailable, "USDC");

const depositAmount = process.env.SETTLER_DEPOSIT_AMOUNT ?? "0.5";
let available = Number(before.gateway.formattedAvailable);

if (available < Number(depositAmount)) {
  console.log(`Depositing ${depositAmount} USDC into Gateway...`);
  const deposit = await gateway.deposit(depositAmount);
  console.log("deposit tx:", deposit.depositTxHash);

  // Gateway credits the deposit only after Circle attests it, which lands a few
  // seconds behind the transaction. Reading once here raced that and printed a
  // stale 0.5 -> 0, directly above a line claiming the Settler was ready.
  for (let attempt = 0; attempt < 10 && available < Number(depositAmount); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    available = Number((await gateway.getBalances()).gateway.formattedAvailable);
  }
  console.log("Gateway available:", available, "USDC");
}

// Only claim readiness that was actually observed. The Settler cannot buy a
// review without a Gateway balance, and a review it cannot buy is a settlement
// it will not make — so "ready" with an empty balance is the one lie this
// script must not tell.
if (available >= Number(depositAmount)) {
  console.log("\nThe Settler is ready.");
} else {
  console.log(`\nThe Settler is registered, but Gateway still reads ${available} USDC.`);
  console.log("Circle's attestation can lag; re-run this script in a minute to confirm the credit.");
}
console.log("REMINDER: every existing user must RE-ARM their mandate to name this address.");
