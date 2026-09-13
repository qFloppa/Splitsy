import { network } from "hardhat";

const usdcAddress = process.env.ARC_TESTNET_USDC_ADDRESS;
const attester = process.env.ESCROW_ATTESTER_ADDRESS;

if (!usdcAddress) {
  throw new Error("Missing ARC_TESTNET_USDC_ADDRESS in .env.local");
}
if (!/^0x[a-fA-F0-9]{40}$/.test(usdcAddress)) {
  throw new Error("ARC_TESTNET_USDC_ADDRESS must be a 0x-prefixed EVM address.");
}
// Demanded rather than defaulted. The attester is immutable once deployed, so a
// wrong or empty value here is not a misconfiguration you can correct later —
// it is a contract that can never release anything, and the only exit is every
// depositor reclaiming.
if (!attester || !/^0x[a-fA-F0-9]{40}$/.test(attester)) {
  throw new Error("Set ESCROW_ATTESTER_ADDRESS to the address whose key will sign releases.");
}

const { viem } = await network.create({ network: "arcTestnet", chainType: "l1" });
const [deployer] = await viem.getWalletClients();

console.log("Deploying HandleEscrow to Arc Testnet");
console.log("Deployer:", deployer.account.address);
console.log("USDC:", usdcAddress);
console.log("Attester:", attester);

const escrow = await viem.deployContract("HandleEscrow", [
  usdcAddress as `0x${string}`,
  attester as `0x${string}`,
]);

console.log("HandleEscrow deployed:", escrow.address);
console.log(`Arcscan: https://testnet.arcscan.app/address/${escrow.address}`);
console.log("");
console.log("Next steps:");
console.log(`  NEXT_PUBLIC_HANDLE_ESCROW_ADDRESS=${escrow.address}`);
console.log("  Deposit ids restart at 1 per deployment, so escrow_deposits rows");
console.log("  are keyed by (escrow_address, deposit_id) — an old address stays");
console.log("  readable rather than being overwritten.");
