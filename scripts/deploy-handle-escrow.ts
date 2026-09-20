import { network } from "hardhat";
import { ARC } from "../lib/arc-chain.ts";

const attester = process.env.ESCROW_ATTESTER_ADDRESS;

// Demanded rather than defaulted. The attester is immutable once deployed, so a
// wrong or empty value here is not a misconfiguration you can correct later —
// it is a contract that can never release anything, and the only exit is every
// depositor reclaiming.
if (!attester || !/^0x[a-fA-F0-9]{40}$/.test(attester)) {
  throw new Error("Set ESCROW_ATTESTER_ADDRESS to the address whose key will sign releases.");
}

// The chain comes from `--network`; USDC and the explorer come from the profile
// (lib/arc-chain.ts). See scripts/deploy-bill-split-registry.ts.
const { viem, networkName } = await network.create({ chainType: "l1" });
const [deployer] = await viem.getWalletClients();

console.log(`Deploying HandleEscrow to ${networkName}`);
console.log("Deployer:", deployer.account.address);
console.log("USDC:", ARC.usdcAddress);
console.log("Attester:", attester);

const escrow = await viem.deployContract("HandleEscrow", [
  ARC.usdcAddress,
  attester as `0x${string}`,
]);

console.log("HandleEscrow deployed:", escrow.address);
console.log(`Explorer: ${ARC.explorerUrl}/address/${escrow.address}`);
console.log("");
console.log("Next steps:");
console.log(`  NEXT_PUBLIC_HANDLE_ESCROW_ADDRESS=${escrow.address}`);
console.log("  Deposit ids restart at 1 per deployment, so escrow_deposits rows");
console.log("  are keyed by (escrow_address, deposit_id) — an old address stays");
console.log("  readable rather than being overwritten.");
