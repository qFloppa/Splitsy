import { randomUUID } from "node:crypto";

// One-shot setup for the Circle Smart Contract Platform event monitor that lets
// BROWSER / non-custodial payments earn ERC-8004 reputation. Those payments
// settle on-chain directly and never touch our pay route, so we can't record
// feedback from a request handler — instead Circle watches BillSplitRegistry
// for DebtPaid and POSTs each one to our webhook (app/api/webhooks/circle),
// which scores the paid-in-full ones (see lib/erc8004 recordExternalPaidFeedback).
//
// Run once, after the webhook URL is registered in the Circle console:
//   node --env-file=.env.local --experimental-strip-types scripts/circle-scp-monitor-setup.ts
//
// Idempotent: Circle dedups by (contract, blockchain) and (monitor signature),
// so a second run just reports the existing import/monitor instead of erroring.
// Uses only the API key — importing a contract and creating a monitor are
// registration actions, not signing ones, so no entity-secret ciphertext.

const apiKey = process.env.CIRCLE_API_KEY;
if (!apiKey || apiKey.includes("your_circle_api_key")) {
  throw new Error("Set a real CIRCLE_API_KEY in .env.local first.");
}

const registry = process.env.NEXT_PUBLIC_BILL_SPLIT_REGISTRY_ADDRESS;
if (!registry || /^0x0+$/.test(registry)) {
  throw new Error("Set NEXT_PUBLIC_BILL_SPLIT_REGISTRY_ADDRESS in .env.local first.");
}

const BLOCKCHAIN = "ARC-TESTNET";
const DEBT_PAID_SIGNATURE = "DebtPaid(uint256,address,uint256,uint256,uint256)";
const BASE = "https://api.circle.com/v1/w3s";

// Only the fields this script reads; Circle returns more.
type CircleResponse = {
  code?: number;
  message?: string;
  data?: {
    contract?: { id?: string };
    eventMonitor?: { id?: string; isEnabled?: boolean };
  };
};

async function circle(path: string, body: unknown): Promise<{ status: number; json: CircleResponse }> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as CircleResponse;
  return { status: res.status, json };
}

// Import the registry so the Contracts platform knows its ABI. Both name and
// description must be alphanumeric (spaces/punctuation are rejected), so the
// description is omitted rather than fought. A repeat import returns the same id.
console.log(`Importing ${registry} on ${BLOCKCHAIN} …`);
const imported = await circle("/contracts/import", {
  idempotencyKey: randomUUID(),
  name: "SplitsyBillSplitRegistry",
  address: registry,
  blockchain: BLOCKCHAIN,
});
if (imported.status >= 300 && imported.json?.code !== undefined) {
  console.error("Import response:", JSON.stringify(imported.json, null, 2));
  throw new Error(`Contract import failed (HTTP ${imported.status}).`);
}
const contractId = imported.json?.data?.contract?.id ?? "(already imported)";
console.log(`  contract id: ${contractId}`);

// Create the DebtPaid monitor. 201 = created, 200 = already existed.
console.log(`Creating event monitor for ${DEBT_PAID_SIGNATURE} …`);
const monitor = await circle("/contracts/monitors", {
  idempotencyKey: randomUUID(),
  blockchain: BLOCKCHAIN,
  contractAddress: registry,
  eventSignature: DEBT_PAID_SIGNATURE,
});
if (monitor.status >= 300) {
  console.error("Monitor response:", JSON.stringify(monitor.json, null, 2));
  throw new Error(`Event monitor creation failed (HTTP ${monitor.status}).`);
}
const mon = monitor.json?.data?.eventMonitor;
console.log(`  monitor id: ${mon?.id ?? "(existing)"} — enabled: ${mon?.isEnabled ?? "?"}`);

console.log(
  "\nDone. Make sure your webhook endpoint (app/api/webhooks/circle) is registered\n" +
    "in the Circle console and set to receive Smart Contract Platform (contracts.eventLog)\n" +
    "notifications. Browser payments that settle a debt in full will now be scored.",
);
