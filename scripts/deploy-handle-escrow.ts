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

// THE TWO BOUNDS, AND WHY THEY ARE DEFAULTED RATHER THAN DEMANDED. Both are
// immutable, so neither can be corrected after the fact — but unlike the
// attester, a wrong value here degrades rather than bricks: too tight and honest
// releases bounce (deposits stay reclaimable), too loose and the leaked-key
// exposure is larger than it needed to be. A default that is right for Splitsy's
// volume beats an env var nobody sets.
//
// 30 DAYS is a BACKSTOP, not the policy. The operational policy lives in the
// nightly sweep (/api/escrow/reclaim-stale), which reclaims at a week and can be
// retuned without a redeploy. This number exists so the bound still holds if the
// sweep is switched off, forgotten, or Splitsy stops running at all — in which
// case every deposit becomes reclaim-only within a month instead of sitting
// there forever under a key nobody is watching.
const HOLD_WINDOW_SECONDS = BigInt(Number(process.env.ESCROW_HOLD_WINDOW_SECONDS ?? 30 * 24 * 60 * 60));

// 10,000 USDC/day, as a rolling bucket rather than a calendar day. Well above
// honest volume and well below "every deposit at once", which is the only thing
// a ceiling has to achieve: a leaked key gets one day's worth, in public, while
// depositors reclaim. Raise it if real daily inflow ever approaches it — an
// honest release that hits the ceiling fails until the bucket refills, and the
// deposit stays safe and reclaimable while it does.
const MAX_RELEASE_PER_DAY = BigInt(process.env.ESCROW_MAX_RELEASE_PER_DAY_UNITS ?? 10_000_000_000n);

if (HOLD_WINDOW_SECONDS <= 0n || MAX_RELEASE_PER_DAY <= 0n) {
  throw new Error("Hold window and daily release ceiling must both be positive.");
}

// The chain comes from `--network`; USDC and the explorer come from the profile
// (lib/arc-chain.ts). See scripts/deploy-bill-split-registry.ts.
const { viem, networkName } = await network.create({ chainType: "l1" });
const [deployer] = await viem.getWalletClients();

console.log(`Deploying HandleEscrow to ${networkName}`);
console.log("Deployer:", deployer.account.address);
console.log("USDC:", ARC.usdcAddress);
console.log("Attester:", attester);
console.log("Hold window:", `${HOLD_WINDOW_SECONDS}s (${Number(HOLD_WINDOW_SECONDS) / 86400} days)`);
console.log("Max release/day:", `${Number(MAX_RELEASE_PER_DAY) / 1e6} USDC`);

const escrow = await viem.deployContract("HandleEscrow", [
  ARC.usdcAddress,
  attester as `0x${string}`,
  HOLD_WINDOW_SECONDS,
  MAX_RELEASE_PER_DAY,
]);

console.log("HandleEscrow deployed:", escrow.address);
console.log(`Explorer: ${ARC.explorerUrl}/address/${escrow.address}`);
console.log("");
console.log("Next steps:");
console.log(`  NEXT_PUBLIC_HANDLE_ESCROW_ADDRESS=${escrow.address}`);
console.log("  Deposit ids restart at 1 per deployment, so escrow_deposits rows");
console.log("  are keyed by (escrow_address, deposit_id) — an old address stays");
console.log("  readable rather than being overwritten.");
