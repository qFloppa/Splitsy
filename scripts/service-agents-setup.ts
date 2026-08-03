// One-time (idempotent) ERC-8004 registration for the Splitsy service agents
// that act in their own name on chain: the Auditor and the Validator.
//
// Both were doing their jobs anonymously. The Auditor is the named evaluator on
// every ERC-8183 job and sells reviews over x402; the Validator signs every
// giveFeedback on the ReputationRegistry. The Settler and Scout were registered
// by their own setup scripts and these two never were, which left the one agent
// that decides whether escrow releases as the only unattributable party on a job.
//
// SAFE TO RE-RUN. Unlike settler-setup.ts / scout-setup.ts, which skip on an env
// var and would mint a SECOND identity for an already-registered wallet if that
// var were ever lost, this keys on reputation_agents and is additionally guarded
// on chain by balanceOf (see ensureAgent). Both wallets must hold USDC for gas —
// Arc bills gas in USDC — so fund them from https://faucet.circle.com/ first.
//
// The token ids it prints are DISPLAY ONLY, matching how SCOUT_ERC8004_TOKEN_ID
// and SETTLER_ERC8004_TOKEN_ID are used: nothing in the settlement path reads
// them, because identity is resolved from reputation_agents at runtime.
//
// Run: npm run agents:setup
import { formatUnits } from "viem";
import { getUsdcBalanceOnchain } from "../lib/arc-read.ts";
import { getOrCreateArcWallet } from "../lib/circle-dcw.ts";
import { ensureServiceAgentIdentity, SERVICE_AGENTS } from "../lib/erc8004.ts";
import { getAgentByWallet } from "../lib/reputation-repo.ts";

// Registering costs one transaction. Well under this, but a wallet reading zero
// cannot pay gas at all and the mint fails in a way that looks like a bug.
const MIN_GAS_USDC = 100_000n; // 0.1 USDC

let failed = false;

for (const { refId, agentType } of SERVICE_AGENTS) {
  console.log(`\n--- splitsy:${refId} (${agentType})`);
  try {
    const wallet = await getOrCreateArcWallet("splitsy", refId);
    if (!wallet) {
      console.log("  Circle is not configured — skipping.");
      failed = true;
      continue;
    }
    console.log(`  address: ${wallet.address}`);

    const existing = await getAgentByWallet(wallet.address).catch(() => null);
    if (existing?.agent_id) {
      console.log(`  already registered: #${existing.agent_id} — nothing to do.`);
      continue;
    }

    // Checked before the mint rather than after it fails: an unfunded wallet is
    // the likeliest reason this script does not work, and "insufficient funds"
    // from deep inside Circle does not say which wallet to send USDC to.
    const balance = await getUsdcBalanceOnchain(wallet.address as `0x${string}`);
    console.log(`  USDC: ${formatUnits(balance, 6)}`);
    if (balance < MIN_GAS_USDC) {
      console.log(`  NOT FUNDED — send Arc Testnet USDC to the address above (faucet:`);
      console.log(`  https://faucet.circle.com/), then re-run this script.`);
      failed = true;
      continue;
    }

    console.log("  registering...");
    const { agentId } = await ensureServiceAgentIdentity(refId, agentType);
    console.log(`  registered: #${agentId}`);
    console.log(`  https://testnet.arcscan.app/token/0x8004A818BFB912233c491871b3d84c89A494BD9e/instance/${agentId}`);
  } catch (err) {
    // One agent's failure must not skip the other: they are independent, and a
    // half-run script that silently stopped is worse than one that says which
    // half worked.
    console.error(`  FAILED: ${err instanceof Error ? err.message : err}`);
    failed = true;
  }
}

console.log(
  failed
    ? "\nOne or more service agents are not registered. Fix the above and re-run — this script is idempotent."
    : "\nEvery service agent has an on-chain identity.",
);
process.exit(failed ? 1 : 0);
