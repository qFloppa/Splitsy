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
