// One-off replay/backfill of DebtPaid events the webhook missed (e.g. captured
// before the contracts.eventLog handler was live). Pulls the events Circle
// stored under the monitor, decodes each, and runs the same scoring path the
// webhook uses. Safe to re-run: recordExternalPaidFeedback is idempotent per
// (payer, bill), so already-scored payments are skipped.
//
//   node --env-file=.env.local --experimental-strip-types scripts/circle-scp-replay.ts
import { parseDebtPaidLog, recordExternalPaidFeedback, DEBT_PAID_EVENT_SIGNATURE } from "../lib/erc8004.ts";

const apiKey = process.env.CIRCLE_API_KEY;
if (!apiKey || apiKey.includes("your_circle_api_key")) {
  throw new Error("Set a real CIRCLE_API_KEY in .env.local first.");
}
const registry = process.env.NEXT_PUBLIC_BILL_SPLIT_REGISTRY_ADDRESS;
if (!registry || /^0x0+$/.test(registry)) {
  throw new Error("Set NEXT_PUBLIC_BILL_SPLIT_REGISTRY_ADDRESS in .env.local first.");
}

const BLOCKCHAIN = "ARC-TESTNET";
type EventLog = { txHash?: string; topics?: string[]; data?: string };

const params = new URLSearchParams({
  contractAddress: registry,
  blockchain: BLOCKCHAIN,
  eventSignature: DEBT_PAID_EVENT_SIGNATURE,
});
const res = await fetch(`https://api.circle.com/v1/w3s/contracts/events?${params}`, {
  headers: { accept: "application/json", authorization: `Bearer ${apiKey}` },
});
const json = (await res.json().catch(() => ({}))) as { data?: { eventLogs?: EventLog[] } };
if (!res.ok) {
  console.error("Event history fetch failed:", JSON.stringify(json, null, 2));
  throw new Error(`HTTP ${res.status}`);
}

const logs = json.data?.eventLogs ?? [];
console.log(`Replaying ${logs.length} DebtPaid event(s) through the scoring path …\n`);

for (const log of logs) {
  const decoded = parseDebtPaidLog(log.topics ?? [], log.data ?? "0x");
  const txHash = log.txHash ?? null;
  if (!decoded || !decoded.paidInFull || !txHash) {
    console.log(`skip ${txHash ?? "(no tx)"} — decoded=${!!decoded} paidInFull=${decoded?.paidInFull}`);
    continue;
  }
  try {
    await recordExternalPaidFeedback({
      payerAddress: decoded.payer,
      billId: decoded.billId,
      paymentTxHash: txHash,
    });
    console.log(`ok   bill ${decoded.billId} payer ${decoded.payer} — scored (or already had feedback)`);
  } catch (err) {
    console.error(`FAIL bill ${decoded.billId} payer ${decoded.payer}:`, err instanceof Error ? err.message : err);
  }
}

console.log("\nDone. Check reputation_feedback for the payer, and the Circle console for a new");
console.log("splitsy:reputation-registrar wallet (fund it with faucet USDC if scoring failed on gas).");
