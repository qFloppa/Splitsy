// Server-side (Node runtime) reads of BillSplitRegistry. Mirrors the publicClient
// pattern in app/api/onchain-bills/preimage/route.ts. Kept separate from the
// "use client" lib/bill-split-contracts.ts so server routes never pull client code.
import { createPublicClient, decodeEventLog, http, parseAbiItem } from "viem";
import { arcTestnet } from "viem/chains";

export const REGISTRY_ADDRESS = (process.env.NEXT_PUBLIC_BILL_SPLIT_REGISTRY_ADDRESS ??
  "0x0000000000000000000000000000000000000000") as `0x${string}`;

const READ_ABI = [
  {
    type: "function",
    name: "getBill",
    stateMutability: "view",
    inputs: [{ name: "billId", type: "uint256" }],
    outputs: [
      { name: "splitter", type: "address" },
      { name: "metadataHash", type: "bytes32" },
      { name: "totalOwed", type: "uint256" },
      { name: "totalPaid", type: "uint256" },
      { name: "claimed", type: "uint256" },
      { name: "participantList", type: "address[]" },
    ],
  },
  {
    type: "function",
    name: "getParticipant",
    stateMutability: "view",
    inputs: [
      { name: "billId", type: "uint256" },
      { name: "participantAddress", type: "address" },
    ],
    outputs: [
      { name: "owed", type: "uint256" },
      { name: "paid", type: "uint256" },
      { name: "exists", type: "bool" },
    ],
  },
  {
    type: "function",
    name: "claimable",
    stateMutability: "view",
    inputs: [{ name: "billId", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "billIdsForSplitter",
    stateMutability: "view",
    inputs: [{ name: "splitter", type: "address" }],
    outputs: [{ name: "", type: "uint256[]" }],
  },
  {
    type: "function",
    name: "billIdsForParticipant",
    stateMutability: "view",
    inputs: [{ name: "participantAddress", type: "address" }],
    outputs: [{ name: "", type: "uint256[]" }],
  },
] as const;

const publicClient = createPublicClient({
  chain: arcTestnet,
  // batch: coalesce the many concurrent eth_calls the dashboard fires (getBill +
  // per-participant getParticipant, fanned out via Promise.all) into batched
  // JSON-RPC POSTs — far fewer round trips. batchSize 3 because drpc's free plan
  // hard-rejects batches of >3 with HTTP 500 ("Batch of more than 3 requests are
  // not allowed on free plan"); a multi-wallet dashboard load (21 bills) packed
  // one oversized batch and 500'd every time. 3 is the cap it accepts.
  transport: http(process.env.NEXT_PUBLIC_ARC_TESTNET_RPC_URL ?? "https://rpc.testnet.arc.network", {
    batch: { batchSize: 3 },
  }),
});

export async function getBillOnchain(billId: bigint) {
  const r = await publicClient.readContract({
    address: REGISTRY_ADDRESS,
    abi: READ_ABI,
    functionName: "getBill",
    args: [billId],
  });
  return {
    splitter: r[0],
    metadataHash: r[1],
    totalOwed: r[2],
    totalPaid: r[3],
    claimed: r[4],
    participantList: r[5],
  };
}

export async function getParticipantOnchain(billId: bigint, addr: `0x${string}`) {
  const r = await publicClient.readContract({
    address: REGISTRY_ADDRESS,
    abi: READ_ABI,
    functionName: "getParticipant",
    args: [billId, addr],
  });
  return { owed: r[0], paid: r[1], exists: r[2] };
}

// --- batched reads for the dashboard's fan-out ------------------------------
// The dashboard reads dozens of bills at once. Firing one readContract per bill
// via Promise.all blew past the RPC's limits (drpc's free plan rejects JSON-RPC
// batches of >3 with HTTP 500, and the per-call burst trips its RPS cap → 429).
// Multicall3 collapses N contract reads into ONE eth_call, so the whole
// dashboard becomes a handful of requests. allowFailure so a single unreadable
// bill yields null (skipped by the caller) instead of sinking the whole batch.

export type BillOnchain = {
  billId: bigint;
  splitter: `0x${string}`;
  metadataHash: `0x${string}`;
  totalOwed: bigint;
  totalPaid: bigint;
  claimed: bigint;
  participantList: readonly `0x${string}`[];
};

export async function getBillsOnchain(billIds: bigint[]): Promise<(BillOnchain | null)[]> {
  if (billIds.length === 0) return [];
  const res = await publicClient.multicall({
    allowFailure: true,
    contracts: billIds.map((billId) => ({
      address: REGISTRY_ADDRESS,
      abi: READ_ABI,
      functionName: "getBill",
      args: [billId],
    })),
  });
  return res.map((r, i) => {
    if (r.status !== "success") return null;
    const v = r.result as readonly [`0x${string}`, `0x${string}`, bigint, bigint, bigint, readonly `0x${string}`[]];
    return {
      billId: billIds[i],
      splitter: v[0],
      metadataHash: v[1],
      totalOwed: v[2],
      totalPaid: v[3],
      claimed: v[4],
      participantList: v[5],
    };
  });
}

export type ParticipantOnchain = { owed: bigint; paid: bigint; exists: boolean };

export async function getParticipantsOnchain(
  pairs: { billId: bigint; addr: `0x${string}` }[],
): Promise<(ParticipantOnchain | null)[]> {
  if (pairs.length === 0) return [];
  const res = await publicClient.multicall({
    allowFailure: true,
    contracts: pairs.map(({ billId, addr }) => ({
      address: REGISTRY_ADDRESS,
      abi: READ_ABI,
      functionName: "getParticipant",
      args: [billId, addr],
    })),
  });
  return res.map((r) => {
    if (r.status !== "success") return null;
    const v = r.result as readonly [bigint, bigint, boolean];
    return { owed: v[0], paid: v[1], exists: v[2] };
  });
}

export async function getClaimableOnchain(billId: bigint) {
  return publicClient.readContract({
    address: REGISTRY_ADDRESS,
    abi: READ_ABI,
    functionName: "claimable",
    args: [billId],
  });
}

export async function getBillIdsForSplitterOnchain(addr: `0x${string}`): Promise<readonly bigint[]> {
  return publicClient.readContract({
    address: REGISTRY_ADDRESS,
    abi: READ_ABI,
    functionName: "billIdsForSplitter",
    args: [addr],
  });
}

// Reverse of the splitter lookup: bills where `addr` OWES (is a participant),
// not the ones it created. The dashboard aggregator joins both directions.
export async function getBillIdsForParticipantOnchain(addr: `0x${string}`): Promise<readonly bigint[]> {
  return publicClient.readContract({
    address: REGISTRY_ADDRESS,
    abi: READ_ABI,
    functionName: "billIdsForParticipant",
    args: [addr],
  });
}

const ARC_USDC_ADDRESS = (process.env.ARC_TESTNET_USDC_ADDRESS ??
  "0x3600000000000000000000000000000000000000") as `0x${string}`;

const TRANSFER_EVENT = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

// How much USDC `wallet` sent/received in a mined tx, from the receipt's
// Transfer logs. Circle's listTransactions reports contract executions
// (approve/payDebt/claim) with no `amounts`, so the wallet history would show
// $0 for them — this recovers the real figure from chain. Base units (6 dp).
export async function readUsdcMovedInTx(
  txHash: `0x${string}`,
  wallet: `0x${string}`,
): Promise<{ sent: bigint; received: bigint }> {
  const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
  const me = wallet.toLowerCase();
  let sent = 0n;
  let received = 0n;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== ARC_USDC_ADDRESS.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: [TRANSFER_EVENT], data: log.data, topics: log.topics });
      if (ev.args.from.toLowerCase() === me) sent += ev.args.value;
      if (ev.args.to.toLowerCase() === me) received += ev.args.value;
    } catch {
      // Non-Transfer USDC log (e.g. Approval) — not a movement.
    }
  }
  return { sent, received };
}
