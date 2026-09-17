import { network } from "hardhat";
import { ARC } from "../lib/arc-chain.ts";

// The chain comes from `--network`; USDC and the explorer come from the profile
// (lib/arc-chain.ts). See scripts/deploy-bill-split-registry.ts.
const { viem, networkName } = await network.create({ chainType: "l1" });

const [deployer] = await viem.getWalletClients();

console.log(`Deploying RecurringTabFactory to ${networkName}`);
console.log("Deployer:", deployer.account.address);
console.log("USDC ERC-20 interface:", ARC.usdcAddress);

const factory = await viem.deployContract("RecurringTabFactory", [ARC.usdcAddress]);

console.log("RecurringTabFactory deployed:", factory.address);
console.log(`Explorer: ${ARC.explorerUrl}/address/${factory.address}`);
