import { network } from "hardhat";
import { ARC } from "../lib/arc-chain.ts";

// Deploys the on-chain autopay mandate in FRONT of the existing registry. It is
// deliberately a standalone contract rather than a registry change: bills 1-N
// survive, the Circle SCP monitors stay pointed at the same address, reputation
// keeps its key, and there is no v1/v2 env dance to get wrong.
const registryAddress = process.env.NEXT_PUBLIC_BILL_SPLIT_REGISTRY_ADDRESS;

if (!registryAddress) {
  throw new Error("Missing NEXT_PUBLIC_BILL_SPLIT_REGISTRY_ADDRESS in .env.local");
}

if (!/^0x[a-fA-F0-9]{40}$/.test(registryAddress)) {
  throw new Error("NEXT_PUBLIC_BILL_SPLIT_REGISTRY_ADDRESS must be a 0x-prefixed EVM address.");
}

// The chain comes from `--network`; USDC and the explorer come from the profile
// (lib/arc-chain.ts). See scripts/deploy-bill-split-registry.ts.
const { viem, networkName } = await network.create({ chainType: "l1" });

const [deployer] = await viem.getWalletClients();

console.log(`Deploying AutopayMandate to ${networkName}`);
console.log("Deployer:", deployer.account.address);
console.log("Registry (immutable):", registryAddress);
console.log("USDC ERC-20 interface:", ARC.usdcAddress);

const mandate = await viem.deployContract("AutopayMandate", [
  registryAddress as `0x${string}`,
  ARC.usdcAddress,
]);

console.log("AutopayMandate deployed:", mandate.address);
console.log(`Explorer: ${ARC.explorerUrl}/address/${mandate.address}`);

// The mandate names ONE agent per debtor, and that name is written on chain by
// the user. Pointing the app at a new mandate address without re-enabling
// autopay leaves every existing user with a mandate on the old contract, which
// the app no longer reads — so print both moves together.
console.log("");
console.log("Next steps:");
console.log(`  NEXT_PUBLIC_AUTOPAY_MANDATE_ADDRESS=${mandate.address}`);
console.log("  (optional) NEXT_PUBLIC_AUTOPAY_AGENT_ADDRESS=0x…  # otherwise resolved from the Circle DCW at runtime");
console.log("  Then: re-save the autopay rules once per user, which writes the on-chain mandate.");
console.log("  No registry redeploy and no SCP monitor re-run — the mandate sits in front of both.");
