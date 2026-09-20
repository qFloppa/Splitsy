import { network } from "hardhat";
import { ARC } from "../lib/arc-chain.ts";

// THE SAME ADDRESS HandleEscrow USES, read from the same variable. One key to
// guard rather than two, and the refund relay signs with its private half
// (REFUND_SLOT_ATTESTER_PRIVATE_KEY, lib/refund-slot.ts).
//
// Demanded rather than defaulted, for the reason scripts/deploy-handle-escrow.ts
// spells out: the attester is immutable once deployed. A wrong or empty value
// here is not a misconfiguration you can correct later — it is a registry whose
// slot refunds can never be authorized, and the only exit is a redeploy.
const attester = process.env.ESCROW_ATTESTER_ADDRESS;

if (!attester || !/^0x[a-fA-F0-9]{40}$/.test(attester)) {
  throw new Error("Set ESCROW_ATTESTER_ADDRESS to the address whose key will sign slot refunds.");
}

// The chain comes from `--network`, not from a literal in here: a script that
// pins its own network deploys to testnet however you invoke it. USDC and the
// explorer come from the profile (lib/arc-chain.ts), so neither is retyped.
const { viem, networkName } = await network.create({ chainType: "l1" });

const [deployer] = await viem.getWalletClients();

console.log(`Deploying BillSplitRegistry to ${networkName}`);
console.log("Deployer:", deployer.account.address);
console.log("USDC ERC-20 interface:", ARC.usdcAddress);
console.log("Attester:", attester);

const registry = await viem.deployContract("BillSplitRegistry", [
  ARC.usdcAddress,
  attester as `0x${string}`,
]);

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
console.log("");
console.log("  REFUND_SLOT_ATTESTER_PRIVATE_KEY must be the private half of the");
console.log(`  attester above (${attester}) — the same key as`);
console.log("  ESCROW_ATTESTER_PRIVATE_KEY. Without it, a slot's refund cannot be");
console.log("  signed and money stays in the registry.");
