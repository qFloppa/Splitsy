import { network } from "hardhat";
import { ARC } from "../lib/arc-chain.ts";

// The chain comes from `--network`, not from a literal in here: a script that
// pins its own network deploys to testnet however you invoke it. USDC and the
// explorer come from the profile (lib/arc-chain.ts), so neither is retyped.
const { viem, networkName } = await network.create({ chainType: "l1" });

const [deployer] = await viem.getWalletClients();

console.log(`Deploying BillSplitRegistry to ${networkName}`);
console.log("Deployer:", deployer.account.address);
console.log("USDC ERC-20 interface:", ARC.usdcAddress);

const registry = await viem.deployContract("BillSplitRegistry", [ARC.usdcAddress]);

console.log("BillSplitRegistry deployed:", registry.address);
console.log(`Explorer: ${ARC.explorerUrl}/address/${registry.address}`);

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
