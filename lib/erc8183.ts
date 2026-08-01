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
      continue;
    }
  }
  return null;
}

const publicClient = createPublicClient({ chain: arcTestnet, transport: http(ARC_TESTNET_RPC) });

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
