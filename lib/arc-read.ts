// Server-side (Node runtime) reads of BillSplitRegistry. Mirrors the publicClient
// pattern in app/api/onchain-bills/preimage/route.ts. Kept separate from the
// "use client" lib/bill-split-contracts.ts so server routes never pull client code.
import { createPublicClient, decodeEventLog, http, parseAbiItem } from "viem";
import { arcTestnet } from "viem/chains";

export const REGISTRY_ADDRESS = (process.env.NEXT_PUBLIC_BILL_SPLIT_REGISTRY_ADDRESS ??
  "0x0000000000000000000000000000000000000000") as `0x${string}`;

// The v1 registry, kept readable so bill history survives the v2 redeploy. Bill
// ids restart at 1 in v2, so a bare id is only meaningful next to the registry
// it came from — that is also why reputation rows are keyed by both.
export const REGISTRY_ADDRESS_V1 = (process.env.BILL_SPLIT_REGISTRY_ADDRESS_V1 ??
  "0x0000000000000000000000000000000000000000") as `0x${string}`;

export function isV1RegistryConfigured() {
  return REGISTRY_ADDRESS_V1 !== "0x0000000000000000000000000000000000000000";
}

// AutopayMandate: the on-chain spending permission that sits in FRONT of the
// registry. Unset means autopay simply has no on-chain grant to read, which
// reads as "off" everywhere — never as "unlimited".
export const MANDATE_ADDRESS = (process.env.NEXT_PUBLIC_AUTOPAY_MANDATE_ADDRESS ??
  "0x0000000000000000000000000000000000000000") as `0x${string}`;

export function isMandateConfigured() {
  return MANDATE_ADDRESS !== "0x0000000000000000000000000000000000000000";
}

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
      { name: "dueDate", type: "uint64" },
      { name: "escrowUntilFull", type: "bool" },
      { name: "participantList", type: "address[]" },
    ],
  },
  {
    type: "function",
    name: "collectible",
    stateMutability: "view",
    inputs: [
      { name: "billId", type: "uint256" },
      { name: "debtor", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "collectMandate",
    stateMutability: "view",
    inputs: [
      { name: "billId", type: "uint256" },
      { name: "debtor", type: "address" },
    ],
    outputs: [{ name: "", type: "bool" }],
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

// BillSplitRegistry.BillCreated, as an SCP event monitor delivers it. The
// autopay agent is triggered from this: a bill only becomes autopayable the
// moment it exists on chain. Returns null when the topics/data are not a
// BillCreated, so the webhook can ignore every other event it receives.
const BILL_CREATED_ABI = [
  {
    type: "event",
    name: "BillCreated",
    anonymous: false,
    inputs: [
      { indexed: true, name: "billId", type: "uint256" },
      { indexed: true, name: "splitter", type: "address" },
      { indexed: true, name: "metadataHash", type: "bytes32" },
      { indexed: false, name: "totalOwed", type: "uint256" },
      { indexed: false, name: "dueDate", type: "uint64" },
      { indexed: false, name: "escrowUntilFull", type: "bool" },
    ],
  },
] as const;

export function parseBillCreatedLog(topics: string[], data: string): { billId: string; splitter: string } | null {
  try {
    const decoded = decodeEventLog({
      abi: BILL_CREATED_ABI,
      topics: topics as [signature: `0x${string}`, ...args: `0x${string}`[]],
      data: (data ?? "0x") as `0x${string}`,
    });
    if (decoded.eventName !== "BillCreated") return null;
    return { billId: decoded.args.billId.toString(), splitter: decoded.args.splitter.toLowerCase() };
  } catch {
    return null;
  }
}

const MANDATE_READ_ABI = [
  {
    type: "function",
    name: "mandates",
    stateMutability: "view",
    inputs: [{ name: "debtor", type: "address" }],
    outputs: [
      { name: "agent", type: "address" },
      { name: "maxPerBill", type: "uint96" },
      { name: "maxPerDay", type: "uint128" },
      { name: "spent", type: "uint128" },
      { name: "lastSpendAt", type: "uint64" },
    ],
  },
  {
    type: "function",
    name: "allowedCreators",
    stateMutability: "view",
    inputs: [{ name: "debtor", type: "address" }],
    outputs: [{ name: "", type: "address[]" }],
  },
  {
    type: "function",
    name: "dailyHeadroom",
    stateMutability: "view",
    inputs: [{ name: "debtor", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "spendable",
    stateMutability: "view",
    inputs: [
      { name: "billId", type: "uint256" },
      { name: "debtor", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export type AutopayMandateOnchain = {
  agent: `0x${string}`;
  maxPerBill: bigint; // USDC base units
  maxPerDay: bigint;
  headroom: bigint; // room left in the token bucket right now
  allowedCreators: `0x${string}`[]; // EMPTY = any creator
};

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// The debtor's live on-chain mandate, or null when there isn't one. This is the
// ONLY source of truth for the caps and the creator allowlist — the Postgres
// columns are a display mirror. `headroom` is read rather than derived so the
// contract's own token-bucket refill is what the agent pre-flights against.
//
// One multicall: three reads that are always wanted together, and a mandate
// stitched from three separate round trips could straddle a settings change.
export async function getAutopayMandateOnchain(debtor: `0x${string}`): Promise<AutopayMandateOnchain | null> {
  if (!isMandateConfigured()) return null;

  const [mandate, creators, headroom] = await publicClient.multicall({
    allowFailure: false,
    contracts: [
      { address: MANDATE_ADDRESS, abi: MANDATE_READ_ABI, functionName: "mandates", args: [debtor] },
      { address: MANDATE_ADDRESS, abi: MANDATE_READ_ABI, functionName: "allowedCreators", args: [debtor] },
      { address: MANDATE_ADDRESS, abi: MANDATE_READ_ABI, functionName: "dailyHeadroom", args: [debtor] },
    ],
  });

  // agent == 0 is the contract's own "autopay is off". There is no separate
  // enabled flag to disagree with it.
  if (mandate[0] === ZERO_ADDRESS) return null;

  return {
    agent: mandate[0],
    maxPerBill: mandate[1],
    maxPerDay: mandate[2],
    headroom,
    allowedCreators: [...creators],
  };
}

// What payFor would move right now, 0 if any rule blocks it — including the
// debtor's USDC approval and balance. Lets the agent decline before paying gas
// to discover a revert, the same job collectible() does for the creditor pull.
export async function getMandateSpendableOnchain(billId: bigint, debtor: `0x${string}`): Promise<bigint> {
  if (!isMandateConfigured()) return 0n;
  return publicClient.readContract({
    address: MANDATE_ADDRESS,
    abi: MANDATE_READ_ABI,
    functionName: "spendable",
    args: [billId, debtor],
  });
}

// USDC balance of an address on Arc. Callers check it before sending, because a
// transfer that runs out of money reverts and a revert carries no reason string —
// "insufficient funds" has to be established up front or not at all.
export async function getUsdcBalanceOnchain(addr: `0x${string}`): Promise<bigint> {
  return publicClient.readContract({
    address: (process.env.ARC_TESTNET_USDC_ADDRESS ?? "0x3600000000000000000000000000000000000000") as `0x${string}`,
    abi: [parseAbiItem("function balanceOf(address owner) view returns (uint256)")],
    functionName: "balanceOf",
    args: [addr],
  });
}

// How much of `owner`'s USDC `spender` may still pull. The mandate's caps bound
// each pull; this bounds the total exposure across all of them, and it is the
// one bound the user can withdraw without touching this app.
export async function getUsdcAllowanceOnchain(owner: `0x${string}`, spender: `0x${string}`): Promise<bigint> {
  return publicClient.readContract({
    address: (process.env.ARC_TESTNET_USDC_ADDRESS ?? "0x3600000000000000000000000000000000000000") as `0x${string}`,
    abi: [parseAbiItem("function allowance(address owner, address spender) view returns (uint256)")],
    functionName: "allowance",
    args: [owner, spender],
  });
}

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
    dueDate: r[5],
    escrowUntilFull: r[6],
    participantList: r[7],
  };
}

// What collectDebt would actually move for this debtor right now: 0 without a
// mandate, before the due date, or when their remaining/allowance/balance leave
// nothing. Lets the dunning agent ask "would this succeed?" without simulating
// a revert.
export async function getCollectibleOnchain(billId: bigint, debtor: `0x${string}`): Promise<bigint> {
  return publicClient.readContract({
    address: REGISTRY_ADDRESS,
    abi: READ_ABI,
    functionName: "collectible",
    args: [billId, debtor],
  });
}

export async function getCollectMandateOnchain(billId: bigint, debtor: `0x${string}`): Promise<boolean> {
  return publicClient.readContract({
    address: REGISTRY_ADDRESS,
    abi: READ_ABI,
    functionName: "collectMandate",
    args: [billId, debtor],
  });
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
  dueDate: bigint; // Unix seconds; 0n = no deadline
  escrowUntilFull: boolean;
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
    const v = r.result as readonly [
      `0x${string}`,
      `0x${string}`,
      bigint,
      bigint,
      bigint,
      bigint,
      boolean,
      readonly `0x${string}`[],
    ];
    return {
      billId: billIds[i],
      splitter: v[0],
      metadataHash: v[1],
      totalOwed: v[2],
      totalPaid: v[3],
      claimed: v[4],
      dueDate: v[5],
      escrowUntilFull: v[6],
      participantList: v[7],
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
