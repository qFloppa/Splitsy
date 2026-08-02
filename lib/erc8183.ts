// ERC-8183 jobs on Arc's deployed AgenticCommerce reference implementation.
//
// Every autopay settlement is posted here as a job: the user's agent is the
// client, the Splitsy Settler is the provider, the Splitsy Auditor is the
// evaluator. Three distinct wallets, so nobody grades their own work.
//
// The escrow only ever holds the FEE, never the bill money. That is what makes
// creating the job before doing the work affordable: a failure after funding
// strands 0.01 USDC for an hour, and nothing else.
//
// Isomorphic and side-effect free at import, like lib/registry-calldata.ts:
// the encoders are pure so a Circle DCW, a raw EOA, or a test can all use them.
import { createPublicClient, decodeEventLog, encodeFunctionData, http, keccak256, toHex } from "viem";
import { arcTestnet } from "viem/chains";
import { ARC_TESTNET_RPC } from "./x402/constants.ts";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

// Unset means "no job market configured", which reads as autopay OFF — never as
// "settle without the job". Same rule as MANDATE_ADDRESS in lib/arc-read.ts.
export const AGENTIC_COMMERCE_ADDRESS = (process.env.NEXT_PUBLIC_AGENTIC_COMMERCE_ADDRESS ??
  ZERO_ADDRESS) as `0x${string}`;

export function isJobsConfigured() {
  return AGENTIC_COMMERCE_ADDRESS !== ZERO_ADDRESS;
}

// Copied from Arc's ERC-8183 quickstart. `optParams` is "0x" everywhere: the
// non-hooked default path, which is the only one this design uses.
export const JOB_ABI = [
  {
    type: "function",
    name: "createJob",
    stateMutability: "nonpayable",
    inputs: [
      { name: "provider", type: "address" },
      { name: "evaluator", type: "address" },
      { name: "expiredAt", type: "uint256" },
      { name: "description", type: "string" },
      { name: "hook", type: "address" },
    ],
    outputs: [{ name: "jobId", type: "uint256" }],
  },
  {
    type: "function",
    name: "setBudget",
    stateMutability: "nonpayable",
    inputs: [
      { name: "jobId", type: "uint256" },
      { name: "amount", type: "uint256" },
      { name: "optParams", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "fund",
    stateMutability: "nonpayable",
    inputs: [
      { name: "jobId", type: "uint256" },
      { name: "optParams", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "submit",
    stateMutability: "nonpayable",
    inputs: [
      { name: "jobId", type: "uint256" },
      { name: "deliverable", type: "bytes32" },
      { name: "optParams", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "complete",
    stateMutability: "nonpayable",
    inputs: [
      { name: "jobId", type: "uint256" },
      { name: "reason", type: "bytes32" },
      { name: "optParams", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "getJob",
    stateMutability: "view",
    inputs: [{ name: "jobId", type: "uint256" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "id", type: "uint256" },
          { name: "client", type: "address" },
          { name: "provider", type: "address" },
          { name: "evaluator", type: "address" },
          { name: "description", type: "string" },
          { name: "budget", type: "uint256" },
          { name: "expiredAt", type: "uint256" },
          { name: "status", type: "uint8" },
          { name: "hook", type: "address" },
        ],
      },
    ],
  },
  {
    type: "event",
    name: "JobCreated",
    anonymous: false,
    inputs: [
      { indexed: true, name: "jobId", type: "uint256" },
      { indexed: true, name: "client", type: "address" },
      { indexed: true, name: "provider", type: "address" },
      { indexed: false, name: "evaluator", type: "address" },
      { indexed: false, name: "expiredAt", type: "uint256" },
      { indexed: false, name: "hook", type: "address" },
    ],
  },
] as const;

// The contract's own enum, lowercased for the log column and the UI chip.
export const JOB_STATUS = ["open", "funded", "submitted", "completed", "rejected", "expired"] as const;

export type JobStatusName = (typeof JOB_STATUS)[number] | "unknown";

// An out-of-range status is "unknown", never a guess: a contract upgrade that
// added a state must not be silently rendered as one we do recognise.
export function jobStatusName(status: number): JobStatusName {
  return JOB_STATUS[status] ?? "unknown";
}

export function encodeCreateJob(
  provider: `0x${string}`,
  evaluator: `0x${string}`,
  expiredAt: bigint,
  description: string,
): `0x${string}` {
  return encodeFunctionData({
    abi: JOB_ABI,
    functionName: "createJob",
    // hook = address(0): the default non-hooked path. Never parameterised,
    // because a hook is a third party in the settlement and we have none.
    args: [provider, evaluator, expiredAt, description, ZERO_ADDRESS],
  });
}

export function encodeSetBudget(jobId: bigint, amount: bigint): `0x${string}` {
  return encodeFunctionData({ abi: JOB_ABI, functionName: "setBudget", args: [jobId, amount, "0x"] });
}

export function encodeFund(jobId: bigint): `0x${string}` {
  return encodeFunctionData({ abi: JOB_ABI, functionName: "fund", args: [jobId, "0x"] });
}

export function encodeSubmit(jobId: bigint, deliverable: `0x${string}`): `0x${string}` {
  return encodeFunctionData({ abi: JOB_ABI, functionName: "submit", args: [jobId, deliverable, "0x"] });
}

export function encodeComplete(jobId: bigint, reason: `0x${string}`): `0x${string}` {
  return encodeFunctionData({ abi: JOB_ABI, functionName: "complete", args: [jobId, reason, "0x"] });
}

// The Auditor's verdict, recorded on chain as a fixed reason. It only ever
// completes after reading getParticipant and seeing paid >= owed, so one
// constant is honest: there is exactly one thing this evaluator ever asserts.
export const COMPLETE_REASON = keccak256(toHex("splitsy-settlement-verified"));

// The deliverable IS the settlement transaction, hashed. Anyone holding the tx
// hash can recompute this and check the job's deliverable against it — which is
// the whole reason the escrow release means something.
export function deliverableFor(settlementTxHash: string): `0x${string}` {
  if (!/^0x[0-9a-fA-F]{64}$/.test(settlementTxHash)) {
    throw new Error(`deliverableFor: not a 32-byte tx hash: ${settlementTxHash}`);
  }
  return keccak256(settlementTxHash as `0x${string}`);
}

// The job id from a createJob receipt. Read from the logs rather than the
// return value because a Circle SCA user-op returns no calldata result — and
// filtered by the contract's own address, because ERC-4337 bundles can carry
// another wallet's logs in the same transaction (same trap lib/erc8004.ts hit).
export function jobIdFromLogs(
  logs: readonly { address: string; topics: readonly string[]; data: string }[],
): bigint | null {
  for (const log of logs) {
    if (log.address.toLowerCase() !== AGENTIC_COMMERCE_ADDRESS.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({
        abi: JOB_ABI,
        data: log.data as `0x${string}`,
        topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
      });
      if (decoded.eventName === "JobCreated") return decoded.args.jobId;
    } catch {
      // ponytail: a decode failure is indistinguishable from "this receipt has
      // no JobCreated" — both end up as null, so real ABI drift would look like
      // an ordinary miss. Fine while nothing can act on the difference; if that
      // changes, collect the decode errors and let the caller report which it was.
      continue;
    }
  }
  return null;
}

// ── the ceremony, rebuilt from the chain ──
//
// Nothing writes these five transaction hashes down as they happen: autopay_log
// keeps the job id and the settlement hash, and that is all. So the trail is
// REBUILT from the contract's own logs rather than stored — which costs one
// getLogs, and buys a full history for every job ever settled, including the
// ones that predate this code.
//
// Keyed by topic0 rather than decoded through an ABI: the step's name, block and
// transaction is all the trail shows, and every one of those is readable off the
// raw log. A signature that drifts drops its row instead of throwing.
const STEP_SIGNATURES = [
  ["createJob", "JobCreated(uint256,address,address,address,uint256,address)"],
  ["setBudget", "BudgetSet(uint256,uint256)"],
  ["fund", "JobFunded(uint256,address,uint256)"],
  ["submit", "JobSubmitted(uint256,address,bytes32)"],
  ["complete", "JobCompleted(uint256,address,bytes32)"],
  ["escrow released", "PaymentReleased(uint256,address,uint256)"],
] as const;

export const STEP_BY_TOPIC = new Map<string, string>(
  STEP_SIGNATURES.map(([step, signature]) => [keccak256(toHex(signature)), step]),
);

export type JobStep = { step: string; blockNumber: number; txHash: string };

type RawLog = {
  address?: string;
  topics: readonly string[];
  blockNumber: bigint | null;
  transactionHash: string | null;
  logIndex: number | null;
};

// Pure, so the assembly is testable without a network.
//
// ponytail: the job id is matched in ANY topic slot rather than a known
// position, because these six events do not agree on where they index it. The
// ceiling: an indexed address or amount whose 32 bytes equal the job id would
// pull in a foreign row. Nothing on this chain has one — a job id small enough
// to be a plausible address would need 26 leading zero bytes. Pin the slot per
// event if the contract ever indexes a uint that ranges that low.
export function stepsFromLogs(jobId: bigint, logs: readonly RawLog[]): JobStep[] {
  const idTopic = `0x${jobId.toString(16).padStart(64, "0")}`;
  return logs
    .filter((log) => log.topics.some((t) => t?.toLowerCase() === idTopic))
    .flatMap((log) => {
      const step = STEP_BY_TOPIC.get((log.topics[0] ?? "").toLowerCase());
      if (!step || log.blockNumber === null || !log.transactionHash) return [];
      return [
        {
          step,
          blockNumber: Number(log.blockNumber),
          txHash: log.transactionHash,
          order: Number(log.logIndex ?? 0),
        },
      ];
    })
    .sort((a, b) => a.blockNumber - b.blockNumber || a.order - b.order)
    .map(({ step, blockNumber, txHash }) => ({ step, blockNumber, txHash }));
}

const publicClient = createPublicClient({ chain: arcTestnet, transport: http(ARC_TESTNET_RPC) });

// How far either side of the settlement to look. The whole ceremony spans about
// 60 blocks; 2000 is ~17 minutes at Arc's block time, which covers a run that
// stalled on a slow Circle poll without asking the RPC for an unbounded scan.
const TRAIL_WINDOW = 2_000n;

// The five calls and the escrow release, in the order the chain saw them.
// Anchored on the settlement transaction because that is the one hash the log
// row already holds — and it lands mid-ceremony, between fund and submit.
export async function getJobTrail(jobId: bigint, anchorTxHash: `0x${string}`): Promise<JobStep[]> {
  if (!isJobsConfigured()) return [];
  const [receipt, head] = await Promise.all([
    publicClient.getTransactionReceipt({ hash: anchorTxHash }),
    publicClient.getBlockNumber(),
  ]);
  const anchor = receipt.blockNumber;
  const logs = await publicClient.getLogs({
    address: AGENTIC_COMMERCE_ADDRESS,
    fromBlock: anchor > TRAIL_WINDOW ? anchor - TRAIL_WINDOW : 0n,
    // Clamped to the head: an RPC that rejects a toBlock in the future would
    // fail the whole trail on a job settled seconds ago.
    toBlock: anchor + TRAIL_WINDOW > head ? head : anchor + TRAIL_WINDOW,
  });
  return stepsFromLogs(jobId, logs);
}

export type JobOnchain = {
  id: bigint;
  client: string;
  provider: string;
  evaluator: string;
  description: string;
  budget: bigint;
  expiredAt: bigint;
  status: number;
  statusName: JobStatusName;
  hook: string;
};

// The chain is authoritative for a job's status; autopay_log.job_status is a
// display mirror the UI refetches over this.
export async function getJobOnchain(jobId: bigint): Promise<JobOnchain | null> {
  if (!isJobsConfigured()) return null;
  const job = await publicClient.readContract({
    address: AGENTIC_COMMERCE_ADDRESS,
    abi: JOB_ABI,
    functionName: "getJob",
    args: [jobId],
  });
  return { ...job, statusName: jobStatusName(Number(job.status)) };
}
