import { parseDebtPaidLog } from "../lib/erc8004.ts";

// Diagnostic: pull the real DebtPaid events Circle captured under the monitor
// and run each through the exact decoder the webhook uses. Tells us definitively
// whether the payload decodes and whether it reads as paid-in-full, without
// having to re-pay and read server logs.
//   node --env-file=.env.local --experimental-strip-types scripts/circle-scp-debug.ts

const apiKey = process.env.CIRCLE_API_KEY;
const registry = process.env.NEXT_PUBLIC_BILL_SPLIT_REGISTRY_ADDRESS;
if (!apiKey || !registry) throw new Error("CIRCLE_API_KEY and NEXT_PUBLIC_BILL_SPLIT_REGISTRY_ADDRESS required.");

const params = new URLSearchParams({
  contractAddress: registry,
  blockchain: "ARC-TESTNET",
  eventSignature: "DebtPaid(uint256,address,uint256,uint256,uint256)",
});
const res = await fetch(`https://api.circle.com/v1/w3s/contracts/events?${params}`, {
  headers: { Authorization: `Bearer ${apiKey}` },
});
const json = (await res.json()) as {
  code?: number;
  message?: string;
  data?: { eventLogs?: Array<{ txHash: string; eventSignature: string; topics: string[]; data: string }> };
};

if (res.status >= 300) {
  console.error(`Event history fetch failed (HTTP ${res.status}):`, JSON.stringify(json, null, 2));
  process.exit(1);
}

const logs = json.data?.eventLogs ?? [];
console.log(`Captured ${logs.length} DebtPaid event(s) under the monitor.\n`);

for (const log of logs) {
  console.log(`txHash: ${log.txHash}`);
  console.log(`  eventSignature: ${log.eventSignature}`);
  console.log(`  topics[0]: ${log.topics?.[0]}`);
  console.log(`  #topics: ${log.topics?.length}  data.len: ${log.data?.length}`);
  const decoded = parseDebtPaidLog(log.topics ?? [], log.data ?? "0x");
  console.log(`  decode: ${decoded ? JSON.stringify(decoded) : "NULL (did not decode as DebtPaid)"}\n`);
}
