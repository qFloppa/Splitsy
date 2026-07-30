import { network } from "hardhat";

const usdcAddress = process.env.ARC_TESTNET_USDC_ADDRESS;

if (!usdcAddress) {
  throw new Error("Missing ARC_TESTNET_USDC_ADDRESS in .env.local");
}

if (!/^0x[a-fA-F0-9]{40}$/.test(usdcAddress)) {
  throw new Error("ARC_TESTNET_USDC_ADDRESS must be a 0x-prefixed EVM address.");
}

const { viem } = await network.create({
  network: "arcTestnet",
  chainType: "l1",
});

const [deployer] = await viem.getWalletClients();

console.log("Deploying BillSplitRegistry to Arc Testnet");
console.log("Deployer:", deployer.account.address);
console.log("USDC ERC-20 interface:", usdcAddress);

const registry = await viem.deployContract("BillSplitRegistry", [usdcAddress as `0x${string}`]);

console.log("BillSplitRegistry deployed:", registry.address);
console.log(`Arcscan: https://testnet.arcscan.app/address/${registry.address}`);

// Bill ids restart at 1 in every deployment, so the OLD address has to stay
// readable or history becomes ambiguous. Print both moves together — swapping
// one without the other is the whole hazard.
const previous = process.env.NEXT_PUBLIC_BILL_SPLIT_REGISTRY_ADDRESS;
console.log("");
console.log("Next steps:");
console.log(`  NEXT_PUBLIC_BILL_SPLIT_REGISTRY_ADDRESS=${registry.address}`);
if (previous && previous !== registry.address) {
  console.log(`  BILL_SPLIT_REGISTRY_ADDRESS_V1=${previous}   # keep the old bills readable`);
}
console.log("  Then: run the registry re-key migration in schema-reputation.sql,");
console.log("  and re-run scripts/circle-scp-monitor-setup.ts against the new address.");
