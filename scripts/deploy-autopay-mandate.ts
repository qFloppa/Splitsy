import { network } from "hardhat";

// Deploys the on-chain autopay mandate in FRONT of the existing registry. It is
// deliberately a standalone contract rather than a registry change: bills 1-N
// survive, the Circle SCP monitors stay pointed at the same address, reputation
// keeps its key, and there is no v1/v2 env dance to get wrong.
const registryAddress = process.env.NEXT_PUBLIC_BILL_SPLIT_REGISTRY_ADDRESS;
const usdcAddress = process.env.ARC_TESTNET_USDC_ADDRESS;

if (!registryAddress) {
  throw new Error("Missing NEXT_PUBLIC_BILL_SPLIT_REGISTRY_ADDRESS in .env.local");
}

if (!usdcAddress) {
  throw new Error("Missing ARC_TESTNET_USDC_ADDRESS in .env.local");
}

for (const [name, value] of [
  ["NEXT_PUBLIC_BILL_SPLIT_REGISTRY_ADDRESS", registryAddress],
  ["ARC_TESTNET_USDC_ADDRESS", usdcAddress],
] as const) {
  if (!/^0x[a-fA-F0-9]{40}$/.test(value)) {
    throw new Error(`${name} must be a 0x-prefixed EVM address.`);
  }
}

const { viem } = await network.create({
  network: "arcTestnet",
  chainType: "l1",
});

const [deployer] = await viem.getWalletClients();

console.log("Deploying AutopayMandate to Arc Testnet");
console.log("Deployer:", deployer.account.address);
console.log("Registry (immutable):", registryAddress);
console.log("USDC ERC-20 interface:", usdcAddress);

const mandate = await viem.deployContract("AutopayMandate", [
  registryAddress as `0x${string}`,
  usdcAddress as `0x${string}`,
]);

console.log("AutopayMandate deployed:", mandate.address);
console.log(`Arcscan: https://testnet.arcscan.app/address/${mandate.address}`);

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
