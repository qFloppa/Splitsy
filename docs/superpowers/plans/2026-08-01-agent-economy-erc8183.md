# Agent Economy — ERC-8004 Identity + ERC-8183 Jobs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Splitsy's invisible autopay into a visible agent economy — every user owns a funded Circle DCW agent with an ERC-8004 identity, every settlement is an ERC-8183 job posted/escrowed/delivered/evaluated on chain, and the Splitsy Settler buys each bill review from the Splitsy Auditor over x402.

**Architecture:** Zero new Solidity. Three already-deployed contracts do the work: `AgenticCommerce` (ERC-8183) holds the fee escrow, `BillSplitRegistry` and `AutopayMandate` settle the bill as they already do, and `IdentityRegistry` (ERC-8004) mints identities. Three distinct wallets sit on every job — the user's agent (client), the Settler EOA (provider), the Auditor DCW (evaluator) — so nobody grades their own work. The decision core `decideAutopay` stays pure and unchanged; a new pure `buildGrant` chooses whether its caps come from the chain (Mandate mode) or the Postgres mirror (Funded mode).

**Tech Stack:** Next.js 16 (App Router, `runtime = "nodejs"`), TypeScript, viem 2.52, `@circle-fin/developer-controlled-wallets` 9.2, `@circle-fin/x402-batching` 2.1, Supabase (PostgREST), `node --test --experimental-strip-types` for unit tests.

**Source spec:** `docs/superpowers/specs/2026-08-01-agent-economy-erc8183-design.md`. Read it only if a task brief is ambiguous — the briefs are self-contained.

## Global Constraints

- **Arc Testnet constants** (copy verbatim, never re-derive):
  - Network CAIP-2 `eip155:5042002`
  - USDC `0x3600000000000000000000000000000000000000`
  - AgenticCommerce (ERC-8183) `0x0747EEf0706327138c69792bF28Cd525089e4583`
  - ERC-8004 IdentityRegistry `0x8004A818BFB912233c491871b3d84c89A494BD9e`
  - RPC `https://rpc.testnet.arc.network`
  - Explorer `https://testnet.arcscan.app`
- **No new Solidity, no contract redeploy.** If a task seems to need one, stop and report BLOCKED.
- **`decideAutopay` in `lib/autopay.ts` keeps its exact current signature and body.** Only new code is added to that file.
- **`reviewBill` in `lib/autopay-review.ts` is not rewritten.** The new route is a thin wrapper around it.
- **Modules under `lib/` that have a `.test.ts` sibling must use relative imports with an explicit `.ts` extension** (e.g. `./x402/constants.ts`), never the `@/` alias — `node --test --experimental-strip-types` cannot resolve the alias and the test will fail to load. Files under `app/` use `@/` as they do today.
- **Money is never a float in transit.** USDC base units are `bigint` (6dp). Convert to `number` only to compare against a user's own caps, as `lib/autopay.ts` already does.
- **Every skip must be logged with a reason slug.** New slugs introduced by this plan: `agent_unfunded`, `job_failed`. Existing slugs keep their exact spelling.
- **Fail closed.** Any error in the review path, the job path, or the funding check is a skip, never a payment.
- **Unset `NEXT_PUBLIC_AGENTIC_COMMERCE_ADDRESS` or `SETTLER_PRIVATE_KEY` reads as "autopay off"**, exactly like an unset mandate address. Never "run the settlement without the job".
- **Comment style:** this repo writes prose comments explaining *why*, not *what*. Match the density and voice of the file you are editing. Mark deliberate shortcuts with a `ponytail:` comment naming the ceiling and the upgrade path.
- **Commit per task**, message in the repo's style: `feat(agents): …`, `fix(agents): …`, `docs(agents): …`.

## Deviations from the spec, already decided — implement these, do not re-litigate

1. **ERC-8004 NFT ownership.** The spec says the user's agent identity is minted by the registrar and "transferred to the user" via `ensureAgent`'s `minterAddress` branch "without change". That branch transfers to the *keyed* wallet, and keying on the user's main wallet would collide with their existing `splitsy-payer` identity. Resolution: key the identity on the **agent's own DCW address**, mint from the agent's own wallet, then send one **best-effort** `transferFrom` moving the NFT to the user's main wallet. `ensureAgent` is unchanged; the transfer lives in `lib/user-agent.ts` (Task 5).
2. **`uploadMetadataToIPFS` gains an optional `agentType` parameter** (default `"splitsy-payer"`), because the spec's new `agent_type` values (`splitsy-settler`, `splitsy-auditor`, `splitsy-user-agent`) cannot be expressed otherwise. Existing callers pass nothing and are unaffected.
3. **Funded mode needs a second USDC approval.** `BillSplitRegistry._payDebt` calls `usdc.safeTransferFrom(msg.sender, …)` (verified at `contracts/BillSplitRegistry.sol:792`), so the agent must approve the **registry** as well as the job contract. The lazy-approval helper therefore takes a spender argument and is called for both. The spec's §4 only named the job contract; this is the gap being filled.
4. **Funded mode's daily-spend figure comes from `autopay_log`.** In Mandate mode it comes from the on-chain token bucket, as today. There is no bucket in Funded mode, so `sumAutopaySpentTodayUsdc(userId)` is added to `lib/agents-repo.ts`. This does not reintroduce "two answers": each mode has exactly one source.

## Unverified at plan time — implement as written, verify by hand

Spec §12 Q1–Q9 have not been executed. Q2 (can an evaluator that is not the client call `complete`?) and Q4 (does a raw EOA pay Arc gas in USDC with no native balance?) could each force a change. Implement the design as specified; the manual checks stay manual and are documented in Task 10. Do **not** invent mocks to "prove" a network behaviour.

## File Structure

**New**

| File | Responsibility |
|---|---|
| `lib/erc8183.ts` | AgenticCommerce ABI, calldata encoders, `JobCreated` decoding, `getJob` read, status enum, deliverable hash |
| `lib/erc8183.test.ts` | Unit tests for the above |
| `lib/settler.ts` | The Settler EOA — viem wallet client for contract writes, `GatewayClient` for x402 |
| `lib/user-agent.ts` | Per-user agent DCW: get-or-create, ERC-8004 identity, balance, lazy USDC approvals |
| `app/api/agents/review/route.ts` | The Auditor's paid `$0.002` bill-review endpoint |
| `app/api/agents/wallet/route.ts` | GET the signed-in user's agent (address, identity, balance, jobs) |
| `scripts/settler-setup.ts` | One-time Settler bootstrap: key, ERC-8004 identity, Gateway deposit |
| `schema-agent-economy.sql` | The additive columns |
| `docs/agent-economy.md` | Operator documentation |

**Changed**

| File | Change |
|---|---|
| `lib/autopay.ts` | Add pure `buildGrant`. `decideAutopay` untouched. |
| `lib/autopay.test.ts` | Add `buildGrant` cases |
| `lib/agents-repo.ts` | `money_mode` read/write; `job_id`/`job_status`/`fee_usdc` write; `sumAutopaySpentTodayUsdc` |
| `lib/users-repo.ts` | Read/write `agent_wallet_address`, `agent_wallet_id` |
| `lib/erc8004.ts` | `uploadMetadataToIPFS` gains optional `agentType` |
| `lib/x402/seller.ts` | `withGateway` gains optional `payTo` resolver |
| `lib/x402/pricing.ts` | Add `/api/agents/review: "$0.002"` |
| `app/api/agents/autopay/route.ts` | Job lifecycle, Funded mode, Settler signs, review bought over HTTP |
| `app/api/agents/grants/route.ts` | Read/write `moneyMode`; expose the agent address |
| `app/SettlementAgentsPanel.tsx` | Your-agent card, money-mode picker, Fund, job list, Unlink button |
| `package.json` | `settler:setup` script; `test:agents` gains `lib/erc8183.test.ts` |
| `docs/autopay-agent.md` | New agent address, new funding requirement, re-arm notice |

---

### Task 1: ERC-8183 job primitives (`lib/erc8183.ts`)

**Files:**
- Create: `lib/erc8183.ts`
- Create: `lib/erc8183.test.ts`
- Modify: `package.json` (the `test:agents` script)

**Interfaces:**
- Consumes: nothing from earlier tasks. `viem` and `./x402/constants.ts` only.
- Produces, relied on by Tasks 5, 7, 8, 9, 10:
  - `AGENTIC_COMMERCE_ADDRESS: \`0x${string}\``
  - `isJobsConfigured(): boolean`
  - `JOB_ABI` (const-asserted viem ABI)
  - `JOB_STATUS: readonly ["open","funded","submitted","completed","rejected","expired"]`
  - `type JobStatusName = (typeof JOB_STATUS)[number] | "unknown"`
  - `jobStatusName(status: number): JobStatusName`
  - `encodeCreateJob(provider, evaluator, expiredAt: bigint, description: string): \`0x${string}\``
  - `encodeSetBudget(jobId: bigint, amount: bigint): \`0x${string}\``
  - `encodeFund(jobId: bigint): \`0x${string}\``
  - `encodeSubmit(jobId: bigint, deliverable: \`0x${string}\`): \`0x${string}\``
  - `encodeComplete(jobId: bigint, reason: \`0x${string}\`): \`0x${string}\``
  - `deliverableFor(settlementTxHash: string): \`0x${string}\``
  - `COMPLETE_REASON: \`0x${string}\``
  - `jobIdFromLogs(logs: readonly { address: string; topics: readonly string[]; data: string }[]): bigint | null`
  - `getJobOnchain(jobId: bigint): Promise<{ id, client, provider, evaluator, description, budget, expiredAt, status, statusName, hook } | null>`

**Context:** The AgenticCommerce reference implementation is already deployed on Arc Testnet; the ABI below is copied from Arc's own ERC-8183 quickstart and is authoritative. `expiredAt` is an absolute Unix-seconds timestamp, not a duration. `optParams` is `"0x"` on every call — the non-hooked default path.

- [ ] **Step 1: Write the failing test**

Create `lib/erc8183.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeFunctionData, keccak256, toHex } from "viem";
import {
  COMPLETE_REASON,
  JOB_ABI,
  JOB_STATUS,
  deliverableFor,
  encodeComplete,
  encodeCreateJob,
  encodeFund,
  encodeSetBudget,
  encodeSubmit,
  jobIdFromLogs,
  jobStatusName,
} from "./erc8183.ts";

const PROVIDER = "0x1111111111111111111111111111111111111111" as const;
const EVALUATOR = "0x2222222222222222222222222222222222222222" as const;
const ZERO = "0x0000000000000000000000000000000000000000";

const decode = (data: `0x${string}`) => decodeFunctionData({ abi: JOB_ABI, data });

test("encodeCreateJob round-trips every argument and pins hook to address(0)", () => {
  const data = encodeCreateJob(PROVIDER, EVALUATOR, 1_800_000_000n, "Splitsy: settle bill 7 share for 0xabc");
  const { functionName, args } = decode(data);
  assert.equal(functionName, "createJob");
  assert.deepEqual(args, [PROVIDER, EVALUATOR, 1_800_000_000n, "Splitsy: settle bill 7 share for 0xabc", ZERO]);
});

test("encodeSetBudget carries the amount in USDC base units and empty optParams", () => {
  const { functionName, args } = decode(encodeSetBudget(42n, 10_000n));
  assert.equal(functionName, "setBudget");
  assert.deepEqual(args, [42n, 10_000n, "0x"]);
});

test("encodeFund takes the job id alone", () => {
  const { functionName, args } = decode(encodeFund(42n));
  assert.equal(functionName, "fund");
  assert.deepEqual(args, [42n, "0x"]);
});

test("encodeSubmit carries the deliverable hash", () => {
  const hash = deliverableFor("0x" + "ab".repeat(32));
  const { functionName, args } = decode(encodeSubmit(42n, hash));
  assert.equal(functionName, "submit");
  assert.deepEqual(args, [42n, hash, "0x"]);
});

test("encodeComplete carries the reason hash", () => {
  const { functionName, args } = decode(encodeComplete(42n, COMPLETE_REASON));
  assert.equal(functionName, "complete");
  assert.deepEqual(args, [42n, COMPLETE_REASON, "0x"]);
});

// The binding the Auditor's evaluation rests on: what the Settler submits is
// exactly the hash of the settlement transaction, so anyone can recompute it.
test("the deliverable IS keccak256 of the settlement tx hash", () => {
  const txHash = "0x" + "cd".repeat(32);
  assert.equal(deliverableFor(txHash), keccak256(txHash as `0x${string}`));
});

test("deliverableFor rejects anything that is not a 32-byte hex hash", () => {
  assert.throws(() => deliverableFor("not-a-hash"));
  assert.throws(() => deliverableFor("0xdeadbeef"));
});

test("jobStatusName maps the contract's enum and refuses to guess past it", () => {
  assert.deepEqual([...JOB_STATUS], ["open", "funded", "submitted", "completed", "rejected", "expired"]);
  assert.equal(jobStatusName(0), "open");
  assert.equal(jobStatusName(3), "completed");
  assert.equal(jobStatusName(5), "expired");
  assert.equal(jobStatusName(9), "unknown");
  assert.equal(jobStatusName(-1), "unknown");
});

test("jobIdFromLogs reads the id from a JobCreated log and ignores foreign logs", () => {
  const jobCreatedTopic = keccak256(toHex("JobCreated(uint256,address,address,address,uint256,address)"));
  const pad = (hex: string) => `0x${hex.replace(/^0x/, "").padStart(64, "0")}`;
  const logs = [
    // Another contract's log in the same bundled transaction — must be skipped.
    { address: "0x9999999999999999999999999999999999999999", topics: [jobCreatedTopic, pad("7b")], data: "0x" },
    {
      address: "0x0747EEf0706327138c69792bF28Cd525089e4583",
      topics: [jobCreatedTopic, pad("1c8"), pad(PROVIDER.slice(2)), pad(EVALUATOR.slice(2))],
      data: "0x",
    },
  ];
  assert.equal(jobIdFromLogs(logs), 456n);
});

test("jobIdFromLogs returns null when the receipt has no JobCreated", () => {
  assert.equal(jobIdFromLogs([{ address: "0x0747EEf0706327138c69792bF28Cd525089e4583", topics: ["0x00"], data: "0x" }]), null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --experimental-strip-types lib/erc8183.test.ts`
Expected: FAIL — `Cannot find module './erc8183.ts'`.

- [ ] **Step 3: Write the implementation**

Create `lib/erc8183.ts`:

```ts
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
```

Note for the test to pass: `jobIdFromLogs` filters on `AGENTIC_COMMERCE_ADDRESS`, so the test needs that env var set. Add it to the test command in Step 4 rather than weakening the filter.

- [ ] **Step 4: Run the test to verify it passes**

Run: `NEXT_PUBLIC_AGENTIC_COMMERCE_ADDRESS=0x0747EEf0706327138c69792bF28Cd525089e4583 node --test --experimental-strip-types lib/erc8183.test.ts`
Expected: PASS, 10/10.

If the `jobIdFromLogs` tests fail on the topic hash, note that `decodeEventLog` matches on `topics[0]`; the test computes it from the canonical signature string, which is what viem does internally. Do not change the test's expected job id (`456n` = `0x1c8`).

- [ ] **Step 5: Wire the test into the suite**

In `package.json`, append `lib/erc8183.test.ts` to the `test:agents` script and prefix it with the env var so the suite runs green without a `.env.local`:

```json
"test:agents": "NEXT_PUBLIC_AGENTIC_COMMERCE_ADDRESS=0x0747EEf0706327138c69792bF28Cd525089e4583 node --test --experimental-strip-types lib/autopay.test.ts lib/dunning.test.ts lib/agent-link.test.ts lib/autopay-review.test.ts lib/agent-queue.test.ts lib/erc8183.test.ts",
```

Run: `npm run test:agents`
Expected: PASS, every existing test still green.

- [ ] **Step 6: Commit**

```bash
git add lib/erc8183.ts lib/erc8183.test.ts package.json
git commit -m "feat(agents): ERC-8183 job calldata, status enum and JobCreated decoding"
```

---

### Task 2: Data model — the additive columns and their repo access

**Files:**
- Create: `schema-agent-economy.sql`
- Modify: `lib/agents-repo.ts`
- Modify: `lib/users-repo.ts`
- Modify: `lib/types.ts` (the `AppUser` type)

**Interfaces:**
- Consumes: nothing.
- Produces, relied on by Tasks 3, 5, 7, 8, 9:
  - `export type MoneyMode = "mandate" | "funded"` — **declared in `lib/autopay.ts`** (which has no dependencies, so the pure test still loads) and re-exported from `lib/agents-repo.ts`, which already imports types from `./autopay.ts`. Task 3 adds `buildGrant` beside it.
  - `AutopayGrantRow` gains `moneyMode: MoneyMode`
  - `upsertAutopayGrant` accepts and writes `moneyMode`
  - `AutopayLogRow` gains `jobId?: string | null; jobStatus?: string | null; feeUsdc?: number`
  - `AutopayLogEntry` gains `jobId: string | null; jobStatus: string | null; feeUsdc: number`
  - `finalizeAutopayDecision` patch gains `jobId?: string | null; jobStatus?: string | null; feeUsdc?: number`
  - `sumAutopaySpentTodayUsdc(userId: string): Promise<number>`
  - `setUserAgentWallet(userId: string, address: string, walletId: string): Promise<void>` in `lib/users-repo.ts`
  - `AppUser` gains `agent_wallet_address: string | null; agent_wallet_id: string | null`

**Context:** No new table. `autopay_log`'s existing unique key `(registry_address, bill_id, debtor_address)` stays the idempotency lock and is not widened. Every column is `add column if not exists`, matching the repo's additive-script convention (see `schema-agents.sql`). The user runs the SQL by hand in the Supabase editor — this task does not execute it.

- [ ] **Step 1: Write the schema script**

Create `schema-agent-economy.sql`:

```sql
-- schema-agent-economy.sql — run in the Supabase SQL editor (additive; standalone).
--
-- The agent economy adds no table. Everything it needs hangs off rows that
-- already exist, because the identity that matters was already there:
--   * autopay_log     — one row per decision, and now also per JOB. Its unique
--                       key (registry_address, bill_id, debtor_address) is
--                       still the idempotency lock, unchanged and unwidened:
--                       the claim is taken BEFORE createJob, so a redelivered
--                       webhook cannot even open a second job.
--   * autopay_grants  — gains the money mode, which decides where BILL money
--                       comes from. Not where the FEE comes from: the fee
--                       always comes from the user's agent, in both modes.
--   * users           — caches the agent wallet so it is not re-derived from
--                       Circle on every request.

-- The ERC-8183 job this decision opened. Display mirror only: getJob(jobId) on
-- chain is the source of truth and the UI refetches it. A skip has no job and
-- both columns stay null — paying gas to record a non-payment buys nothing.
alter table autopay_log add column if not exists job_id      text;
alter table autopay_log add column if not exists job_status  text;

-- What the settlement cost the user's agent in job fees, separate from
-- amount_usdc, which is the bill share. Two different pockets, two columns.
alter table autopay_log add column if not exists fee_usdc    numeric(20,6) not null default 0;

-- Where BILL money comes from.
--   'mandate' — the user's own wallet, pulled under AutopayMandate. The caps
--               that bind are the on-chain ones. This is the default, and it
--               is the default deliberately: it is the mode where the chain,
--               not this server, is the thing that says no.
--   'funded'  — the agent's own balance, via BillSplitRegistry.payDebtFor. The
--               mandate is not in the path, so the caps that bind are the ones
--               in THIS table, enforced off chain by lib/autopay.ts. The only
--               ceiling the chain still enforces is the agent's balance.
-- The weakening is real and the UI must say so in one sentence.
alter table autopay_grants add column if not exists money_mode text not null default 'mandate'
  check (money_mode in ('mandate','funded'));

-- The user's agent wallet — one per ACCOUNT, refId 'agent:<user_id>', covering
-- both the Splitsy DCW and any linked browser wallet. Cached here so a page
-- load does not re-list wallets against Circle. Circle remains authoritative;
-- these two columns are a cache that lib/user-agent.ts refills on a miss.
alter table users add column if not exists agent_wallet_address text;
alter table users add column if not exists agent_wallet_id      text;
```

- [ ] **Step 2: Apply the schema and confirm**

Ask the human partner to run `schema-agent-economy.sql` in the Supabase SQL editor. This task cannot proceed to a passing verification without it.

Verify with the Supabase MCP tool if available, otherwise ask for confirmation:
Run: `list_tables` on the project, schemas `["public"]`, verbose `true`.
Expected: `autopay_log` has `job_id`, `job_status`, `fee_usdc`; `autopay_grants` has `money_mode`; `users` has `agent_wallet_address`, `agent_wallet_id`.

If the human partner cannot apply it right now, record that in the report and continue — the repo code below is written to tolerate a missing column only in the read direction (see the `requireBillReview` precedent), and the writes will fail loudly, which is correct.

- [ ] **Step 3: Extend `lib/agents-repo.ts`**

First, in `lib/autopay.ts`, add the mode union beside the existing exported types. It lives there because `lib/autopay.ts` has no runtime dependencies, so `lib/autopay.test.ts` keeps loading — and because Task 3's `buildGrant`, which consumes it, lives there too:

```ts
// Where BILL money comes from. Not where the FEE comes from — the job fee is
// always the user's agent's, in both modes.
export type MoneyMode = "mandate" | "funded";
```

Then in `lib/agents-repo.ts`, extend its existing type import and re-export the union so consumers of the repo layer do not have to reach past it:

```ts
import type { AutopayDecision, AutopayGrant, MoneyMode } from "./autopay.ts";
export type { MoneyMode };
```

Extend `AutopayGrantRow`:

```ts
export type AutopayGrantRow = AutopayGrant & {
  userId: string;
  debtorAddress: string | null;
  requireBillReview: boolean;
  // Outside AutopayGrant for the same reason as the two above: decideAutopay
  // never sees the mode. buildGrant reads it to choose which caps to hand over.
  moneyMode: MoneyMode;
};
```

In `getAutopayGrant`, add `money_mode` to the `.select(...)` list, add `money_mode: string | null;` to the row cast, and add to the returned object:

```ts
    // An unrecognised or absent value reads as 'mandate' — the mode where the
    // CHAIN enforces the caps. A missing column must never silently move a user
    // into the mode where only this server says no.
    moneyMode: row.money_mode === "funded" ? "funded" : "mandate",
```

In `upsertAutopayGrant`, add `money_mode: grant.moneyMode,` to the upsert payload.

Extend `AutopayLogRow` and `claimAutopayDecision`:

```ts
export type AutopayLogRow = {
  userId: string;
  registryAddress: string;
  billId: string;
  debtorAddress: string;
  decision: "pay" | "skip";
  reason: string;
  amountUsdc: number;
  txHash: string | null;
  // The job this decision opened, once it exists. Null at claim time: the claim
  // is taken BEFORE createJob, which is what stops a redelivered webhook from
  // opening a second job for the same share.
  jobId?: string | null;
  jobStatus?: string | null;
  feeUsdc?: number;
};
```

In `claimAutopayDecision`'s insert, add:

```ts
    job_id: row.jobId ?? null,
    job_status: row.jobStatus ?? null,
    fee_usdc: row.feeUsdc ?? 0,
```

In `reclaimUndecided`'s update, add the same three keys.

Extend `finalizeAutopayDecision`'s patch parameter and its update body:

```ts
export async function finalizeAutopayDecision(
  registryAddress: string,
  billId: string,
  debtorAddress: string,
  patch: {
    decision?: "pay" | "skip";
    reason?: string;
    amountUsdc?: number;
    txHash?: string | null;
    jobId?: string | null;
    jobStatus?: string | null;
    feeUsdc?: number;
  },
): Promise<void> {
```

and inside the `.update({...})`:

```ts
      ...(patch.jobId !== undefined ? { job_id: patch.jobId } : {}),
      ...(patch.jobStatus !== undefined ? { job_status: patch.jobStatus } : {}),
      ...(patch.feeUsdc !== undefined ? { fee_usdc: patch.feeUsdc } : {}),
```

Extend `AutopayLogEntry` and `listAutopayLog`'s mapper:

```ts
export type AutopayLogEntry = AutopayLogRow & {
  createdAt: string;
  jobId: string | null;
  jobStatus: string | null;
  feeUsdc: number;
};
```

Add `job_id, job_status, fee_usdc` to the `.select(...)` and to the mapped object:

```ts
      jobId: (row.job_id as string | null) ?? null,
      jobStatus: (row.job_status as string | null) ?? null,
      feeUsdc: Number(row.fee_usdc ?? 0),
```

Add the Funded-mode daily-spend reader at the end of the autopay section, with its justification:

```ts
// The rolling daily spend for FUNDED mode only.
//
// Mandate mode reads this from AutopayMandate's token bucket (lib/arc-read.ts),
// because there the contract is the thing that will revert. Funded mode has no
// bucket — the mandate is not in the path — so the log is the only record of
// what this agent has already spent for this user. Each mode has exactly one
// source; this is not the two-answers problem the bucket comment warns about.
//
// A read failure returns Infinity, matching sumSpentTodayUsd in
// lib/x402/payments-repo.ts: an unreadable ledger must look like "cap
// exhausted", never like "nothing spent yet".
export async function sumAutopaySpentTodayUsdc(userId: string): Promise<number> {
  const client = requireClient();
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await client
    .from("autopay_log")
    .select("amount_usdc")
    .eq("user_id", userId)
    .eq("decision", "pay")
    .gte("created_at", since);
  if (error || !data) {
    console.error("[autopay] sumAutopaySpentTodayUsdc failed, treating the cap as spent:", error?.message);
    return Number.POSITIVE_INFINITY;
  }
  return data.reduce((sum, r) => sum + Number((r as { amount_usdc: string | number }).amount_usdc), 0);
}
```

- [ ] **Step 4: Extend `lib/users-repo.ts` and `lib/types.ts`**

In `lib/types.ts`, add to `AppUser`:

```ts
  agent_wallet_address: string | null;
  agent_wallet_id: string | null;
```

In `lib/users-repo.ts`, mirror `setUserWallet` exactly (read it first and match its shape and error text):

```ts
// The account's agent wallet, cached so it is not re-derived from Circle on
// every request. One per ACCOUNT, never per wallet: a user who signs in
// socially AND links a browser wallet has one agent covering both.
export async function setUserAgentWallet(id: string, address: string, walletId: string): Promise<void> {
  const client = createSupabaseServerClient();
  if (!client) return;
  const { error } = await client
    .from("users")
    .update({ agent_wallet_address: address.toLowerCase(), agent_wallet_id: walletId })
    .eq("id", id);
  if (error) throw new Error(`Failed to save agent wallet: ${error.message}`);
}
```

`getUserById` calls `.select()` with no arguments, so it already returns every column — nothing to change there. Both `getSessionUser` and the autopay route go through it, which is why `getOrCreateUserAgent` in Task 5 can take an `AppUser` directly.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. If `upsertAutopayGrant` callers now fail because `moneyMode` is required, that is intended — Task 8 fixes `app/api/agents/grants/route.ts`. For **this** task, make the callers compile by passing `moneyMode: existing?.moneyMode ?? "mandate"` at each call site; Task 8 replaces that with the real value from the request body.

Run: `npm run test:agents`
Expected: PASS, unchanged.

- [ ] **Step 6: Commit**

```bash
git add schema-agent-economy.sql lib/agents-repo.ts lib/users-repo.ts lib/types.ts app/api/agents/grants/route.ts
git commit -m "feat(agents): additive columns for job id, fee, money mode and the agent wallet"
```

---

### Task 3: `buildGrant` — the one new branch, and it is pure

**Files:**
- Modify: `lib/autopay.ts` (append only; `decideAutopay` untouched)
- Modify: `lib/autopay.test.ts` (append cases)

**Interfaces:**
- Consumes: `MoneyMode`, already declared in `lib/autopay.ts` by Task 2. Nothing else — this file must stay dependency-free so `lib/autopay.test.ts` keeps loading under `--experimental-strip-types`.
- Produces, relied on by Task 7:
  - `export type MandateFacts = { agent: string; maxPerBill: bigint; maxPerDay: bigint; allowedCreators: string[] } | null`
  - `export type MirrorRules = { enabled: boolean; maxPerBillUsdc: number; maxPerDayUsdc: number; trustedCreators: string[]; minCreatorScore: number; requireVerifiedHash: boolean } | null`
  - `export function buildGrant(mode: MoneyMode, mandate: MandateFacts, rules: MirrorRules): AutopayGrant | null`

**Context:** `decideAutopay` must not learn about modes — its purity and signature are load-bearing (three files' comments say so). Only its *input* changes. `buildGrant` decides where that input comes from and is the single new branch in the whole design.

- [ ] **Step 1: Write the failing tests**

Append to `lib/autopay.test.ts` (read the file first and match its `test(...)` / `assert` style):

```ts
// --- buildGrant --------------------------------------------------------------

const MANDATE = {
  agent: "0xAgent",
  maxPerBill: 25_000_000n, // 25 USDC
  maxPerDay: 60_000_000n, // 60 USDC
  allowedCreators: ["0xCreatorOnChain"],
};

const MIRROR = {
  enabled: true,
  maxPerBillUsdc: 5,
  maxPerDayUsdc: 9,
  trustedCreators: ["0xcreatorinpostgres"],
  minCreatorScore: 70,
  requireVerifiedHash: true,
};

test("buildGrant('mandate') takes the caps from the chain and ignores the mirror's", () => {
  const grant = buildGrant("mandate", MANDATE, MIRROR);
  assert.ok(grant);
  assert.equal(grant.enabled, true);
  assert.equal(grant.maxPerBillUsdc, 25);
  assert.equal(grant.maxPerDayUsdc, 60);
  assert.deepEqual(grant.trustedCreators, ["0xCreatorOnChain"]);
  // The two rules the chain cannot evaluate still come from Postgres.
  assert.equal(grant.minCreatorScore, 70);
  assert.equal(grant.requireVerifiedHash, true);
});

test("buildGrant('mandate') is null when there is no mandate on chain", () => {
  assert.equal(buildGrant("mandate", null, MIRROR), null);
});

test("buildGrant('mandate') works with no Postgres row at all, failing closed on the hash", () => {
  const grant = buildGrant("mandate", MANDATE, null);
  assert.ok(grant);
  assert.equal(grant.minCreatorScore, 0);
  assert.equal(grant.requireVerifiedHash, true);
});

test("buildGrant('funded') takes the caps from the mirror and ignores the chain's", () => {
  const grant = buildGrant("funded", MANDATE, MIRROR);
  assert.ok(grant);
  assert.equal(grant.maxPerBillUsdc, 5);
  assert.equal(grant.maxPerDayUsdc, 9);
  assert.deepEqual(grant.trustedCreators, ["0xcreatorinpostgres"]);
});

test("buildGrant('funded') needs no mandate on chain", () => {
  const grant = buildGrant("funded", null, MIRROR);
  assert.ok(grant);
  assert.equal(grant.maxPerBillUsdc, 5);
});

test("buildGrant('funded') is null when autopay is switched off in the mirror", () => {
  assert.equal(buildGrant("funded", MANDATE, { ...MIRROR, enabled: false }), null);
  assert.equal(buildGrant("funded", MANDATE, null), null);
});

test("funded caps still bind: decideAutopay refuses a share above the mirror's per-bill cap", () => {
  const grant = buildGrant("funded", null, MIRROR);
  const decision = decideAutopay({
    grant,
    remaining: 6_000_000n, // 6 USDC against a 5 USDC mirror cap
    creator: "0xcreatorinpostgres",
    creatorScore: 90,
    spentTodayUsdc: 0,
    onchainMetadataHash: "0x00",
    preimage: null,
  });
  assert.equal(decision.pay, false);
  assert.equal(decision.reason, "over_bill_cap");
});
```

Add `buildGrant` to the file's existing import from `./autopay.ts`.

- [ ] **Step 2: Run to verify it fails**

Run: `node --test --experimental-strip-types lib/autopay.test.ts`
Expected: FAIL — `buildGrant is not exported` / `is not a function`.

- [ ] **Step 3: Implement `buildGrant`**

Append to `lib/autopay.ts`, below `decideAutopay`. `MoneyMode` is already declared here by Task 2 — do not redeclare it:

```ts
// AutopayMandate.mandates(debtor), as lib/arc-read.ts returns it. Null = the
// user has written no mandate on this wallet.
export type MandateFacts = {
  agent: string;
  maxPerBill: bigint; // USDC base units
  maxPerDay: bigint; // USDC base units
  allowedCreators: string[];
} | null;

// The autopay_grants row. Null = the user has never touched autopay.
export type MirrorRules = {
  enabled: boolean;
  maxPerBillUsdc: number;
  maxPerDayUsdc: number;
  trustedCreators: string[];
  minCreatorScore: number;
  requireVerifiedHash: boolean;
} | null;

// The ONE new branch in the agent-economy design, and it is a pure function so
// it can be tested without a network.
//
// decideAutopay does not learn about modes — its signature and its purity are
// load-bearing. Only its INPUT changes, and this is what chooses the input:
//
//   'mandate' — the caps come from AutopayMandate, the contract that will
//               revert on its own numbers regardless of what this server
//               believes. No mandate means no permission: null.
//   'funded'  — the mandate is not in the path at all, so the caps come from
//               the Postgres mirror and are enforced HERE. That is a genuine
//               weakening and the UI has to say so: in this mode the only
//               ceiling the chain enforces is the agent's own balance.
//
// The two rules a contract can never evaluate — the ERC-8004 score floor and
// the verified-hash check — come from Postgres in BOTH modes, because Postgres
// is their only home. Both default to the closed direction when the row is
// missing: score floor off, hash check ON.
export function buildGrant(mode: MoneyMode, mandate: MandateFacts, rules: MirrorRules): AutopayGrant | null {
  const minCreatorScore = rules?.minCreatorScore ?? 0;
  const requireVerifiedHash = rules?.requireVerifiedHash ?? true;

  if (mode === "funded") {
    if (!rules || !rules.enabled) return null;
    return {
      enabled: true,
      maxPerBillUsdc: rules.maxPerBillUsdc,
      maxPerDayUsdc: rules.maxPerDayUsdc,
      trustedCreators: rules.trustedCreators,
      minCreatorScore,
      requireVerifiedHash,
    };
  }

  if (!mandate) return null;
  return {
    enabled: true,
    maxPerBillUsdc: toUsdc(mandate.maxPerBill),
    maxPerDayUsdc: toUsdc(mandate.maxPerDay),
    trustedCreators: mandate.allowedCreators,
    minCreatorScore,
    requireVerifiedHash,
  };
}
```

`toUsdc` already exists in this file — reuse it, do not redefine.

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test:agents`
Expected: PASS, every existing `decideAutopay` test still green plus 7 new ones.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add lib/autopay.ts lib/autopay.test.ts
git commit -m "feat(agents): buildGrant chooses chain caps or mirror caps, still pure"
```

---

### Task 4: The Settler EOA (`lib/settler.ts` + `scripts/settler-setup.ts`)

**Files:**
- Create: `lib/settler.ts`
- Create: `scripts/settler-setup.ts`
- Modify: `package.json` (add `settler:setup`)

**Interfaces:**
- Consumes: `lib/x402/constants.ts` (`ARC_TESTNET_RPC`, `ARC_IDENTITY_REGISTRY`, `ARC_TESTNET_USDC`).
- Produces, relied on by Tasks 7 and 8:
  - `isSettlerConfigured(): boolean`
  - `getSettler(): { address: \`0x${string}\`; gateway: GatewayClient }`
  - `settlerWrite(to: \`0x${string}\`, data: \`0x${string}\`): Promise<\`0x${string}\`>` — sends, waits for the receipt, throws on revert, returns the tx hash
  - `settlerReceipt(txHash: \`0x${string}\`): Promise<{ logs: readonly { address: string; topics: readonly string[]; data: string }[] }>`
  - `ensureSettlerGatewayBalance(): Promise<void>`

**Context:** The Settler must be a raw EOA, not a DCW, because x402 needs a raw key to sign EIP-3009/EIP-712 authorizations. One key signs both its ERC-8183 contract writes (viem) and its x402 payments (`GatewayClient`). This mirrors `lib/scout/wallet.ts` exactly — read that file first and match its shape, including the cached singleton and the re-deposit helper.

Migration cost to state in the commit message and in Task 10's docs: the Settler's address **replaces** today's `splitsy:autopay-agent` DCW as the address named in mandates, so **every existing user must re-arm their mandate**.

- [ ] **Step 1: Write `lib/settler.ts`**

```ts
// The Splitsy Settler: provider on every ERC-8183 job, signer of the settlement
// in Mandate mode, and the buyer of every bill review over x402.
//
// A raw EOA, deliberately not a Circle DCW, for one reason: x402 needs a raw
// key to sign the EIP-3009/EIP-712 authorization, and a DCW will not hand one
// over. One key therefore signs both halves of this agent's life — its contract
// writes through viem, its nanopayments through Gateway. Same precedent, same
// blast-radius argument as lib/scout/wallet.ts.
//
// It earns: the job fee lands here when the Auditor completes a job, and the
// review it buys is paid out of that income.
import { GatewayClient } from "@circle-fin/x402-batching/client";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";
import { ARC_TESTNET_RPC } from "./x402/constants.ts";

let cached: { account: ReturnType<typeof privateKeyToAccount>; gateway: GatewayClient; address: `0x${string}` } | null =
  null;

// Read at call time, never at module load: an unset key must fail the one
// request that needs it, not crash every route that imports this file.
export function isSettlerConfigured() {
  return /^0x[0-9a-fA-F]{64}$/.test(process.env.SETTLER_PRIVATE_KEY ?? "");
}

export function getSettler() {
  if (cached) return cached;
  const privateKey = process.env.SETTLER_PRIVATE_KEY as `0x${string}` | undefined;
  if (!privateKey) throw new Error("Missing SETTLER_PRIVATE_KEY — run npm run settler:setup");
  const account = privateKeyToAccount(privateKey);
  cached = { account, gateway: new GatewayClient({ chain: "arcTestnet", privateKey }), address: account.address };
  return cached;
}

const publicClient = createPublicClient({ chain: arcTestnet, transport: http(ARC_TESTNET_RPC) });

// One contract write, waited to a receipt. Throws on revert rather than
// returning a hash the caller would go on to treat as a settlement — an
// unchecked receipt is how a "paid" row gets written for money that never moved.
export async function settlerWrite(to: `0x${string}`, data: `0x${string}`): Promise<`0x${string}`> {
  const { account } = getSettler();
  const wallet = createWalletClient({ account, chain: arcTestnet, transport: http(ARC_TESTNET_RPC) });
  const hash = await wallet.sendTransaction({ to, data });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`settler tx reverted: ${hash}`);
  return hash;
}

export async function settlerReceipt(txHash: `0x${string}`) {
  return publicClient.getTransactionReceipt({ hash: txHash });
}

const REDEPOSIT_THRESHOLD = 100_000n; // 0.1 USDC atomic — 50 reviews at $0.002
const DEPOSIT_AMOUNT = process.env.SETTLER_DEPOSIT_AMOUNT ?? "0.5";

// Top the Gateway balance up when it runs low. Best-effort, exactly like
// Scout's: a failure here is not fatal, because the pay attempt itself will
// surface the problem — and a Settler that cannot buy a review settles nothing.
export async function ensureSettlerGatewayBalance(minAtomic: bigint = REDEPOSIT_THRESHOLD): Promise<void> {
  const { gateway } = getSettler();
  const balances = await gateway.getBalances();
  if (balances.gateway.available < minAtomic) {
    await gateway.deposit(DEPOSIT_AMOUNT);
  }
}
```

- [ ] **Step 2: Write `scripts/settler-setup.ts`**

Model it on `scripts/scout-setup.ts` — read that file first and mirror its structure, its console output, and its idempotency (re-running with the key and token id set skips to the deposit).

```ts
// One-time setup for the Splitsy Settler, the provider on every ERC-8183 job:
//   1. generate its EOA (its ERC-8183 signer AND its x402 signer)
//   2. register an ERC-8004 identity so its jobs are attributable on chain
//   3. deposit USDC into Circle Gateway so it can buy reviews without gas
//
// Idempotent: re-running with SETTLER_PRIVATE_KEY and SETTLER_ERC8004_TOKEN_ID
// set skips straight to topping up the Gateway balance.
//
// AFTER RUNNING THIS: every existing user must RE-ARM their mandate. The
// Settler's address replaces the old splitsy:autopay-agent DCW as the address
// named in AutopayMandate, and a mandate naming the old agent is simply
// skipped — the route returns before writing any log row for it.
//
// Run: npm run settler:setup
import { createWalletClient, createPublicClient, http, formatUnits, erc20Abi } from "viem";
import { arcTestnet } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { GatewayClient } from "@circle-fin/x402-batching/client";
import { ARC_TESTNET_RPC, ARC_IDENTITY_REGISTRY, ARC_TESTNET_USDC } from "../lib/x402/constants.ts";

const REGISTER_ABI = [
  {
    type: "function",
    name: "register",
    stateMutability: "nonpayable",
    inputs: [{ name: "metadataURI", type: "string" }],
    outputs: [{ name: "tokenId", type: "uint256" }],
  },
] as const;

const privateKey = (process.env.SETTLER_PRIVATE_KEY as `0x${string}`) ?? generatePrivateKey();
const account = privateKeyToAccount(privateKey);

if (!process.env.SETTLER_PRIVATE_KEY) {
  console.log("Generated a new Settler key. Add these to .env.local:\n");
  console.log(`SETTLER_PRIVATE_KEY=${privateKey}`);
  console.log(`NEXT_PUBLIC_AUTOPAY_AGENT_ADDRESS=${account.address}\n`);
}
console.log("Settler address:", account.address);

const publicClient = createPublicClient({ chain: arcTestnet, transport: http(ARC_TESTNET_RPC) });

// On Arc, USDC is the gas token. UNVERIFIED whether a raw EOA holding only
// ERC-20 USDC and no native balance can pay gas (spec §12 Q4) — this print is
// how you find out before the first settlement does.
const [gas, usdc] = await Promise.all([
  publicClient.getBalance({ address: account.address }),
  publicClient.readContract({
    address: ARC_TESTNET_USDC,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [account.address],
  }),
]);
console.log("Native (gas):", formatUnits(gas, 18));
console.log("USDC (ERC-20):", formatUnits(usdc, 6));

if (gas === 0n) {
  console.log("\nNot funded yet. Send Arc Testnet USDC to the address above");
  console.log("(faucet: https://faucet.circle.com/), then re-run this script.");
  process.exit(0);
}

const wallet = createWalletClient({ account, chain: arcTestnet, transport: http(ARC_TESTNET_RPC) });

// --- ERC-8004 identity -------------------------------------------------------
if (process.env.SETTLER_ERC8004_TOKEN_ID) {
  console.log("\nERC-8004 already registered: #" + process.env.SETTLER_ERC8004_TOKEN_ID);
} else {
  const metadataUri =
    process.env.SETTLER_METADATA_URI ??
    "ipfs://bafkreibdi6623n3xpf7ymk62ckb4bo75o3qemwkpfvp5i25j66itxvsoei";
  console.log("\nRegistering ERC-8004 identity...");
  const hash = await wallet.writeContract({
    address: ARC_IDENTITY_REGISTRY,
    abi: REGISTER_ABI,
    functionName: "register",
    args: [metadataUri],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const mint = receipt.logs.find(
    (log) => log.address.toLowerCase() === ARC_IDENTITY_REGISTRY.toLowerCase() && log.topics.length === 4,
  );
  const tokenId = mint ? BigInt(mint.topics[3]!).toString() : null;

  console.log("register tx:", receipt.transactionHash);
  if (tokenId) {
    console.log(`\nAdd to .env.local:\nSETTLER_ERC8004_TOKEN_ID=${tokenId}\n`);
  } else {
    console.log("Could not read tokenId from the receipt — check the tx on Arcscan.");
  }
}

// --- Circle Gateway deposit --------------------------------------------------
const gateway = new GatewayClient({ chain: "arcTestnet", privateKey });
const before = await gateway.getBalances();
console.log("Gateway available:", before.gateway.formattedAvailable, "USDC");

const depositAmount = process.env.SETTLER_DEPOSIT_AMOUNT ?? "0.5";
if (Number(before.gateway.formattedAvailable) < Number(depositAmount)) {
  console.log(`Depositing ${depositAmount} USDC into Gateway...`);
  const deposit = await gateway.deposit(depositAmount);
  console.log("deposit tx:", deposit.depositTxHash);
  const after = await gateway.getBalances();
  console.log("Gateway available:", after.gateway.formattedAvailable, "USDC");
}

console.log("\nThe Settler is ready.");
console.log("REMINDER: every existing user must RE-ARM their mandate to name this address.");
```

- [ ] **Step 3: Add the npm script**

In `package.json`, beside `scout:setup`:

```json
    "settler:setup": "node --experimental-strip-types --env-file=.env.local scripts/settler-setup.ts",
```

- [ ] **Step 4: Verify it compiles and the module loads**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `node --experimental-strip-types -e "import('./lib/settler.ts').then(m => console.log('isSettlerConfigured:', m.isSettlerConfigured()))"`
Expected: prints `isSettlerConfigured: false` with no key set — the module must load cleanly without one. If it throws, the key is being read at module load and must be moved inside `getSettler`.

Do **not** run `npm run settler:setup` — it spends real testnet money and needs a funded wallet. That is the human partner's step, documented in Task 10.

- [ ] **Step 5: Commit**

```bash
git add lib/settler.ts scripts/settler-setup.ts package.json
git commit -m "feat(agents): the Settler EOA — one key for ERC-8183 writes and x402 payments"
```

---

### Task 5: The per-user agent (`lib/user-agent.ts`)

**Files:**
- Create: `lib/user-agent.ts`
- Modify: `lib/erc8004.ts` (`uploadMetadataToIPFS` gains an optional `agentType`)

**Interfaces:**
- Consumes: `getOrCreateArcWallet`, `executeContractOnArc` (`lib/circle-dcw.ts`); `ensureAgent`, `uploadMetadataToIPFS`, `IDENTITY_REGISTRY`, `getAgentByWallet` (`lib/erc8004.ts`); `getUsdcBalanceOnchain`, `getUsdcAllowanceOnchain` (`lib/arc-read.ts`); `encodeApprove` (`lib/registry-calldata.ts`); `AGENTIC_COMMERCE_ADDRESS` (Task 1); `setUserAgentWallet` (Task 2).
- Produces, relied on by Tasks 7 and 8:
  - `type UserAgent = { address: \`0x${string}\`; walletId: string }`
  - `getOrCreateUserAgent(user: { id: string; agent_wallet_address: string | null; agent_wallet_id: string | null }): Promise<UserAgent | null>`
  - `getAgentBalanceUsdc(address: \`0x${string}\`): Promise<bigint>`
  - `ensureAgentAllowance(agent: UserAgent, spender: \`0x${string}\`, need: bigint): Promise<void>`
  - `ensureUserAgentIdentity(agent: UserAgent, ownerWallet: string | null): Promise<string | null>`

**Context — read this carefully, it contains the two deviations from the spec:**

1. The agent's `refId` is `agent:<userId>` — keyed to the **account**, so a user who signs in socially *and* links a browser wallet gets **one** agent, one balance, one identity. `getOrCreateArcWallet(provider, providerUserId)` builds `refId` as `` `${provider}:${providerUserId}` ``, so call it as `getOrCreateArcWallet("agent", userId)`.
2. The ERC-8004 identity is keyed on the **agent's own address** and minted from the agent's own wallet, then sent on to the user's main wallet with a **best-effort** `transferFrom`. Keying it on the user's main wallet would collide with their existing `splitsy-payer` identity and mint nothing.

The USDC approval is sent **lazily, immediately before it is needed, and only when the current allowance is short**. Not on top-up (an inbound transfer the agent cannot hook), and not at wallet creation (`approve` costs gas and an empty wallet cannot pay it). Checking the allowance rather than a database flag makes it self-healing.

- [ ] **Step 1: Give `uploadMetadataToIPFS` an agent type**

In `lib/erc8004.ts`, change the signature and every literal `"splitsy-payer"` inside it to the parameter. The default keeps every existing caller byte-identical:

```ts
export async function uploadMetadataToIPFS(
  walletAddress: string,
  registeredAt?: Date,
  // The ERC-8004 metadata's agent_type. Defaults to the payer identity every
  // existing caller mints; the agent economy passes 'splitsy-user-agent'.
  agentType: "splitsy-payer" | "splitsy-user-agent" | "splitsy-settler" | "splitsy-auditor" = "splitsy-payer",
): Promise<string> {
```

Replace the three `agent_type: "splitsy-payer",` occurrences (the no-Pinata fallback, the real metadata object, and the catch-block fallback) with `agent_type: agentType,`. Leave the `name` and `description` strings alone — they are cosmetic and changing them would churn every existing agent's metadata for nothing.

- [ ] **Step 2: Write `lib/user-agent.ts`**

```ts
// The user's own agent: a Circle DCW they fund, with an ERC-8004 identity that
// ends up in their own wallet.
//
// ONE PER ACCOUNT, not per wallet. The refId is 'agent:<userId>', so a person
// who signs in socially AND links a browser wallet has one agent, one balance
// and one identity covering both. They fund it once. This needs no new lookup:
// the autopay route already resolves either kind of address down to a userId.
//
// The agent needs USDC for two things in BOTH money modes — its own gas (Arc
// charges gas in USDC) and the job fee it escrows — which is why funding is now
// required even in Mandate mode, where nothing used to be. In Funded mode it
// also pays the bill share, and then its BALANCE is the cap: an agent holding
// 5 USDC can never spend 6. That is a simpler and more honest ceiling than a
// mandate, and it needs no contract.
import { createPublicClient, encodeFunctionData, http } from "viem";
import { arcTestnet } from "viem/chains";
import { getUsdcAllowanceOnchain, getUsdcBalanceOnchain } from "./arc-read.ts";
import { executeContractOnArc, getOrCreateArcWallet } from "./circle-dcw.ts";
import { ensureAgent, IDENTITY_REGISTRY } from "./erc8004.ts";
import { encodeApprove } from "./registry-calldata.ts";
import { setUserAgentWallet } from "./users-repo.ts";
import { ARC_TESTNET_RPC } from "./x402/constants.ts";

export type UserAgent = { address: `0x${string}`; walletId: string };

const publicClient = createPublicClient({ chain: arcTestnet, transport: http(ARC_TESTNET_RPC) });

// Just the two ERC-721 calls this file needs. Not imported from erc8004.ts's
// ERC8004_ABI because that one is not exported; two fragments are cheaper than
// widening another module's public surface for them.
const NFT_ABI = [
  {
    type: "function",
    name: "transferFrom",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "tokenId", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "ownerOf",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

const ARC_USDC_ADDRESS = (process.env.ARC_TESTNET_USDC_ADDRESS ??
  "0x3600000000000000000000000000000000000000") as `0x${string}`;

// Get-or-create, with the users row as a cache in front of Circle. Circle stays
// authoritative — listWallets by refId is idempotent — but a page load should
// not pay a round trip to learn an address that has not changed.
export async function getOrCreateUserAgent(user: {
  id: string;
  agent_wallet_address: string | null;
  agent_wallet_id: string | null;
}): Promise<UserAgent | null> {
  if (user.agent_wallet_address && user.agent_wallet_id) {
    return { address: user.agent_wallet_address as `0x${string}`, walletId: user.agent_wallet_id };
  }

  // 'agent' is a provider namespace of its own, so it can never collide with a
  // signin wallet ("<provider>:<id>"), a pre-mint wallet ("prem:…") or the
  // Splitsy service wallets ("splitsy:…").
  const wallet = await getOrCreateArcWallet("agent", user.id);
  if (!wallet) return null;

  // Cache it, but never let a cache write fail the caller: the wallet exists on
  // Circle either way, and the next call re-derives it.
  await setUserAgentWallet(user.id, wallet.address, wallet.walletId).catch((err) => {
    console.error(`user-agent: could not cache the agent wallet for ${user.id}:`, err);
  });

  return { address: wallet.address as `0x${string}`, walletId: wallet.walletId };
}

export async function getAgentBalanceUsdc(address: `0x${string}`): Promise<bigint> {
  return getUsdcBalanceOnchain(address);
}

// A week of fees and shares at the amount being spent right now, so the next
// hundred settlements do not each pay for their own approval.
const APPROVAL_MULTIPLE = 100n;

// Lazy, self-healing USDC approval.
//
// Sent immediately before the call that needs it, and only when the current
// allowance is short. NOT on top-up: a top-up is an inbound transfer the agent
// cannot hook. NOT at wallet creation: approve costs gas, and a wallet with no
// balance cannot pay it. Checking the ALLOWANCE rather than a database flag is
// what makes it self-healing — if the approval is ever spent down, or the row
// is lost, the next settlement re-sends it.
//
// Two spenders need this, for two different reasons:
//   * AgenticCommerce — fund() pulls the job fee into escrow.
//   * BillSplitRegistry — payDebtFor does safeTransferFrom(msg.sender, …) in
//     Funded mode. The spec's §4 named only the first; this is the second.
export async function ensureAgentAllowance(
  agent: UserAgent,
  spender: `0x${string}`,
  need: bigint,
): Promise<void> {
  const allowance = await getUsdcAllowanceOnchain(agent.address, spender);
  if (allowance >= need) return;
  await executeContractOnArc(agent.walletId, ARC_USDC_ADDRESS, encodeApprove(spender, need * APPROVAL_MULTIPLE));
}

// The agent's ERC-8004 identity, minted once and then owned by the USER.
//
// Keyed on the AGENT's address, not the user's: the user's main wallet already
// carries their own 'splitsy-payer' identity from paying bills, and reusing it
// would mean the agent has no identity of its own at all.
//
// The transfer to the user's wallet is best-effort and deliberately so — a
// failed transfer leaves the NFT with the agent, which is a cosmetic loss, and
// must never block a settlement. Same posture as ensureAgent's own transfer.
export async function ensureUserAgentIdentity(
  agent: UserAgent,
  ownerWallet: string | null,
): Promise<string | null> {
  try {
    const agentId = await ensureAgent(agent.address, agent.walletId);
    if (!ownerWallet || ownerWallet.toLowerCase() === agent.address.toLowerCase()) return agentId;

    // Already handed over on an earlier run? ensureAgent is idempotent but the
    // transfer is not, so ask the registry who owns it before sending again.
    const owner = await currentOwner(BigInt(agentId));
    if (owner && owner.toLowerCase() === ownerWallet.toLowerCase()) return agentId;

    await executeContractOnArc(
      agent.walletId,
      IDENTITY_REGISTRY,
      encodeFunctionData({
        abi: NFT_ABI,
        functionName: "transferFrom",
        args: [agent.address, ownerWallet as `0x${string}`, BigInt(agentId)],
      }),
    );
    return agentId;
  } catch (err) {
    console.error("user-agent: identity registration failed (settlement continues):", err);
    return null;
  }
}

async function currentOwner(tokenId: bigint): Promise<string | null> {
  return publicClient
    .readContract({ address: IDENTITY_REGISTRY, abi: NFT_ABI, functionName: "ownerOf", args: [tokenId] })
    .catch(() => null);
}
```

- [ ] **Step 3: Typecheck and smoke-load**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `node --experimental-strip-types -e "import('./lib/user-agent.ts').then(() => console.log('loads clean'))"`
Expected: `loads clean`. The module must import with no Circle credentials configured.

- [ ] **Step 4: Commit**

```bash
git add lib/user-agent.ts lib/erc8004.ts
git commit -m "feat(agents): one funded agent per account, with its own ERC-8004 identity"
```

---

### Task 6: The Auditor sells bill review over x402

**Files:**
- Modify: `lib/x402/seller.ts`
- Modify: `lib/x402/pricing.ts`
- Create: `app/api/agents/review/route.ts`

**Interfaces:**
- Consumes: `reviewBill`, `ReviewInput`, `ReviewVerdict` (`lib/autopay-review.ts`); `withGateway` (`lib/x402/seller.ts`); `getOrCreateArcWallet` (`lib/circle-dcw.ts`).
- Produces, relied on by Task 7:
  - `POST /api/agents/review` — body `{ preimage, shareUsdc, participantCount, creatorScore }`, response `{ approve: boolean, reason: string }`, price `$0.002`, paid to the Auditor.
  - `withGateway(handler, price, endpoint, payTo?)` where `payTo?: () => Promise<string | null>`.

**Context:** `withGateway` today always pays `SELLER_ADDRESS`. The Auditor must receive its own earnings at its own address. `/api/ocr` and `/api/fx` pass nothing and keep paying the treasury exactly as now. The Auditor's address is resolved lazily from `getOrCreateArcWallet("splitsy", "auditor")` — the same pattern the validator and registrar already use.

The route is **public to anyone who pays**, like `/api/ocr` and `/api/fx`, and that is intended: it is a service the Auditor sells. It leaks nothing, because every field it judges arrives in the request body from the caller.

- [ ] **Step 1: Add the price**

In `lib/x402/pricing.ts`:

```ts
export const PRICES = {
  "/api/ocr": "$0.005",
  "/api/fx": "$0.001",
  // The Auditor's bill review, bought by the Settler out of its job-fee income
  // before every settlement. Priced well under the $0.01 job fee so the Settler
  // is still ahead on a job it completes.
  "/api/agents/review": "$0.002",
} as const;
```

- [ ] **Step 2: Give `withGateway` a payee**

In `lib/x402/seller.ts`, change the signature and the address resolution. Everything else in the function is untouched:

```ts
export function withGateway(
  handler: (req: Request) => Promise<Response>,
  price: string,
  endpoint: string,
  // Who gets paid. Defaults to the treasury (SELLER_ADDRESS), which is what
  // /api/ocr and /api/fx want. A resolver rather than a string because the
  // Auditor's address is a lazily-created Circle wallet, not an env var.
  payTo?: () => Promise<string | null>,
) {
  return async (req: Request): Promise<Response> => {
    // Read at call time, not module load: an unset seller must fail this
    // request, not crash the route's whole module at import.
    const sellerAddress = payTo ? await payTo().catch(() => null) : process.env.SELLER_ADDRESS;
    if (!sellerAddress) {
      return Response.json({ error: "Missing SELLER_ADDRESS on the server." }, { status: 500 });
    }
    // …unchanged from here down…
```

Leave the error string as-is: a resolver returning null is the same operator problem — nobody to pay.

- [ ] **Step 3: Write the route**

Create `app/api/agents/review/route.ts`:

```ts
// The Splitsy Auditor's paid bill review, and the evaluator's day job.
//
// lib/autopay-review.ts used to be a free internal function call. Making it a
// paid endpoint is what turns "an agent with a model prompt" into two agents
// that trade: the Settler buys this verdict for $0.002 out of the fee income it
// has accumulated, and the Auditor earns it. Both sides land in x402_payments —
// 'earned' by the seller wrapper here, 'spent' by the Settler.
//
// PUBLIC to anyone who pays, like /api/ocr and /api/fx, and that is the point:
// it is a service the Auditor sells. It leaks nothing — every field it judges
// arrives in the request body, so a stranger who pays $0.002 gets a verdict on
// their own data and learns nothing about Splitsy's.
//
// reviewBill() itself is not rewritten. This is a thin wrapper: the same input,
// the same verdict shape, and the same fail-closed behaviour.
import { reviewBill } from "@/lib/autopay-review";
import { getOrCreateArcWallet } from "@/lib/circle-dcw";
import { PRICES } from "@/lib/x402/pricing";
import { withGateway } from "@/lib/x402/seller";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ENDPOINT = "/api/agents/review";

// Resolved once per process, the same lazy pattern the validator and registrar
// already use. Distinct from the Settler and from every user's agent, so the
// three roles on a job are three different addresses and nobody grades their
// own work.
let auditorAddress: Promise<string | null> | null = null;

function getAuditorAddress(): Promise<string | null> {
  auditorAddress ??= getOrCreateArcWallet("splitsy", "auditor")
    .then((wallet) => wallet?.address ?? null)
    .catch((err) => {
      console.error("[review] could not resolve the Auditor wallet:", err);
      auditorAddress = null; // let the next request retry
      return null;
    });
  return auditorAddress;
}

async function handler(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => null)) as {
    preimage?: unknown;
    shareUsdc?: unknown;
    participantCount?: unknown;
    creatorScore?: unknown;
  } | null;

  // Validated at the trust boundary: this endpoint is public and the numbers
  // below go straight into a prompt that decides whether money moves.
  const preimage = body?.preimage;
  const shareUsdc = Number(body?.shareUsdc);
  const participantCount = Number(body?.participantCount);
  if (!preimage || typeof preimage !== "object") {
    return Response.json({ error: "Expected { preimage, shareUsdc, participantCount, creatorScore }." }, { status: 400 });
  }
  if (!Number.isFinite(shareUsdc) || shareUsdc < 0) {
    return Response.json({ error: "shareUsdc must be a non-negative number." }, { status: 400 });
  }
  if (!Number.isInteger(participantCount) || participantCount < 1) {
    return Response.json({ error: "participantCount must be a whole number of at least 1." }, { status: 400 });
  }
  const rawScore = body?.creatorScore;
  const creatorScore = rawScore === null || rawScore === undefined ? null : Number(rawScore);
  if (creatorScore !== null && !Number.isFinite(creatorScore)) {
    return Response.json({ error: "creatorScore must be a number or null." }, { status: 400 });
  }

  // reviewBill never throws — every path returns a verdict, and an
  // unreachable model is a refusal. That contract is what lets the buyer treat
  // a 200 as an answer and anything else as "no review happened".
  const verdict = await reviewBill({
    preimage: preimage as Parameters<typeof reviewBill>[0]["preimage"],
    shareUsdc,
    participantCount,
    creatorScore,
  });
  return Response.json(verdict);
}

export const POST = withGateway(handler, PRICES[ENDPOINT], ENDPOINT, getAuditorAddress);
```

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit`
Expected: no errors. In particular `PRICES[ENDPOINT]` must typecheck — if it does not, `ENDPOINT` needs `as const`.

Run: `npm run lint`
Expected: clean.

Run: `npm run build`
Expected: the build succeeds and lists `/api/agents/review` among the routes.

Manual 402 check (only if a dev server is already running; do not start one just for this):
Run: `curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:3000/api/agents/review -H 'content-type: application/json' -d '{}'`
Expected: `402`. Record the result in the report; if no server is running, say so rather than skipping silently.

- [ ] **Step 5: Commit**

```bash
git add lib/x402/pricing.ts lib/x402/seller.ts app/api/agents/review/route.ts
git commit -m "feat(agents): the Auditor sells bill review over x402 at its own address"
```

---

### Task 7: The settlement becomes an ERC-8183 job

**Files:**
- Modify: `app/api/agents/autopay/route.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–6.
- Produces: nothing new for later tasks; Task 9 renders the log rows this writes.

**Context — the whole shape of the change:**

Today `settleOne` decides, claims, and calls `AutopayMandate.payFor` from a Circle DCW. It becomes: decide, buy the review over HTTP, claim, then run a six-transaction job ceremony around the settlement.

```
0. decide            lib/autopay.ts rules, then the PAID Auditor review
                     any 'skip' → STOP. No job. 0 transactions.
1. createJob         user's agent
2. setBudget         Settler                     ← provider sets the price
3. fund              user's agent                → the fee into escrow
4. settle            payFor (Settler) | payDebtFor (user's agent)
5. submit            Settler                     → keccak256(settlement tx)
6. complete          Auditor, ONLY after reading getParticipant on chain
                     and confirming paid >= owed
```

**Step 6 is not a rubber stamp and is the single most important line in this design.** If the debt is not really settled, the Auditor does not complete, the job expires, and the Settler is not paid.

**Idempotency does not change.** `claimAutopayDecision` still writes its row on the unique `(registry, bill, debtor)` key *before* anything moves, and the claim is taken at step 0, before `createJob`, so a redelivered webhook cannot even open a job.

**Two money modes:**

| Mode | Bill money | Settlement call | Signer |
|---|---|---|---|
| `mandate` | the user's own wallet | `AutopayMandate.payFor(billId, debtor)` | Settler |
| `funded` | the agent's own balance | `BillSplitRegistry.payDebtFor(billId, debtor, amount)` | user's agent |

`payDebtFor` emits `DebtPaid` with the **debtor** as payer, so reputation keeps flowing to the user and the existing scoring path is untouched. Do not add a second scoring call.

**New skip reasons, both of which need adding to `REASONS` in the UI (Task 9):**
- `agent_unfunded` — the agent's balance cannot cover the fee plus gas. This is the most likely real-world failure and it gets its own slug so the user is told what to fix rather than seeing `tx_failed`.
- `job_failed` — a job transaction reverted after the claim was taken.

- [ ] **Step 1: Update the module header**

The file's top comment explains the two-layer model. Extend it — do not replace it — with the job ceremony, the two modes, and this cost note verbatim:

```ts
// ponytail: 6 tx per settled share, 24 for a 4-person bill. Accepted while Arc
// gas is sub-cent USDC. If it hurts: investigate Circle SCA batch execution to
// fold createJob+fund and setBudget+submit into single user-ops.
```

- [ ] **Step 2: Replace the agent resolution in `POST`**

The route currently resolves one DCW for the whole bill:

```ts
  const agent = await getOrCreateArcWallet("splitsy", "autopay-agent");
```

The Settler now plays that role, and each participant has their own agent. Replace it with:

```ts
  // The Settler is the address a mandate must name, and it is the same for
  // every participant on the bill. The per-user AGENT is resolved inside
  // settleOne, because it is per account.
  //
  // No Settler and no job market means autopay is OFF — the same reading an
  // unset mandate address already has. Never "settle without the job".
  const settler = isSettlerConfigured() && isJobsConfigured() ? getSettler().address : null;
```

Pass `settler` into `settleOne` in place of `agent`, and pass the participant's `userId` (already resolved) so `settleOne` can build the agent.

- [ ] **Step 3: Rewrite `settleOne`**

Keep every existing early return and its exact reason slug. The full replacement:

```ts
const FEE_USDC = Number(process.env.SETTLEMENT_FEE_USDC ?? "0.01");
const FEE_UNITS = BigInt(Math.round(FEE_USDC * 1_000_000));

// The agent must be able to cover the fee AND its own gas for six
// transactions. Arc charges gas in USDC and a settlement is the most gas this
// agent ever spends in one go, so the headroom is deliberate rather than tight:
// an agent that runs dry mid-ceremony strands an escrowed fee.
const GAS_HEADROOM_UNITS = 200_000n; // 0.20 USDC

const JOB_TTL_SECONDS = 3600n;

async function settleOne(input: {
  settler: `0x${string}` | null;
  billId: bigint;
  debtor: `0x${string}`;
  userId: string;
  splitter: `0x${string}`;
  metadataHash: `0x${string}`;
  preimage: Awaited<ReturnType<typeof getOnchainBillPreimage>>;
  participantCount: number;
  creatorScore: number | null;
  baseUrl: string;
}): Promise<Outcome | null> {
  const { billId, debtor, userId, settler } = input;
  const billKey = billId.toString();

  const [rules, mandate, participant, spendable] = await Promise.all([
    getAutopayGrant(userId),
    getAutopayMandateOnchain(debtor).catch(() => null),
    getParticipantOnchain(billId, debtor).catch(() => null),
    getMandateSpendableOnchain(billId, debtor).catch(() => null),
  ]);

  const mode = rules?.moneyMode ?? "mandate";

  // A mandate naming somebody else's agent is not this agent's business.
  // Returns BEFORE claiming, so no row is written at all — logging 'disabled'
  // would tell a user who deliberately runs their own Circle Agent Wallet that
  // their autopay is off, which is the opposite of true.
  //
  // Only in Mandate mode: in Funded mode the mandate is not in the path at all,
  // so what it names is none of this route's business either way.
  if (mode === "mandate" && mandate && settler && mandate.agent.toLowerCase() !== settler.toLowerCase()) {
    return null;
  }

  const mine = mode === "mandate" ? Boolean(mandate && settler && mandate.agent.toLowerCase() === settler.toLowerCase()) : true;

  // The caps come from the chain in Mandate mode and from the mirror in Funded
  // mode. One pure function, one branch, testable without a network.
  const grant = buildGrant(
    mode,
    mine && mandate
      ? {
          agent: mandate.agent,
          maxPerBill: mandate.maxPerBill,
          maxPerDay: mandate.maxPerDay,
          allowedCreators: mandate.allowedCreators,
        }
      : null,
    rules
      ? {
          enabled: rules.enabled,
          maxPerBillUsdc: rules.maxPerBillUsdc,
          maxPerDayUsdc: rules.maxPerDayUsdc,
          trustedCreators: rules.trustedCreators,
          minCreatorScore: rules.minCreatorScore,
          requireVerifiedHash: rules.requireVerifiedHash,
        }
      : null,
  );

  // Mandate mode reads the day's spend from the contract's own token bucket, so
  // the figure the agent reasons about is the figure that will bind it. Funded
  // mode has no bucket — the log is the only record.
  const spentTodayUsdc =
    mode === "funded"
      ? await sumAutopaySpentTodayUsdc(userId)
      : mandate
        ? usdc(mandate.maxPerDay - mandate.headroom)
        : 0;

  const decision = decideAutopay({
    grant,
    remaining: participant?.exists ? participant.owed - participant.paid : 0n,
    creator: input.splitter,
    creatorScore: input.creatorScore,
    spentTodayUsdc,
    onchainMetadataHash: input.metadataHash,
    preimage: input.preimage,
  });

  const logSkip = async (reason: string): Promise<Outcome> => {
    await claimAutopayDecision({
      userId,
      registryAddress: REGISTRY_ADDRESS,
      billId: billKey,
      debtorAddress: debtor,
      decision: "skip",
      reason,
      amountUsdc: 0,
      txHash: null,
    });
    return { debtor, decision: "skip", reason, amountUsdc: 0 };
  };

  // Mandate mode only: the rules passed but the money cannot move, because the
  // debtor's approval to the mandate has run down or their balance has. In
  // Funded mode the mandate is not in the path and this bound does not exist.
  if (decision.pay && mode === "mandate" && spendable === 0n) {
    return logSkip("allowance_short");
  }

  // The contents check, last among the free rules: it is the only step that
  // costs money and latency, so nothing already rejected reaches it. Fails
  // closed — a timeout, a 402, or an unparseable verdict skips rather than pays.
  if (decision.pay && rules?.requireBillReview !== false) {
    // Nothing to review is not permission to skip reviewing. requireVerifiedHash
    // and requireBillReview are independent.
    if (!input.preimage) return logSkip(REVIEW_UNAVAILABLE);

    const verdict = await buyReview(input.baseUrl, {
      preimage: input.preimage,
      shareUsdc: usdc(decision.amount),
      participantCount: input.participantCount,
      creatorScore: input.creatorScore,
    });
    if (!verdict.approve) {
      // The model's own sentence goes straight into the log when it reached a
      // verdict; REVIEW_UNAVAILABLE when it could not. Both are refusals.
      return logSkip(verdict.reason);
    }
  }

  const amountUsdc = usdc(decision.amount);

  // Claim first. The unique key on (registry, bill, debtor) is the idempotency
  // lock, taken BEFORE createJob so a redelivered webhook cannot even open a
  // second job — the existing lock covers the new ceremony without widening.
  const claimed = await claimAutopayDecision({
    userId,
    registryAddress: REGISTRY_ADDRESS,
    billId: billKey,
    debtorAddress: debtor,
    decision: decision.pay ? "pay" : "skip",
    reason: decision.reason,
    amountUsdc: decision.pay ? amountUsdc : 0,
    txHash: null,
  });
  if (!claimed) return null; // already decided by an earlier delivery

  if (!decision.pay) return { debtor, decision: "skip", reason: decision.reason, amountUsdc: 0 };

  if (!settler) {
    await releaseSpend(billKey, debtor, "agent_wallet_unavailable");
    return { debtor, decision: "skip", reason: "agent_wallet_unavailable", amountUsdc: 0 };
  }

  const user = await getUserById(userId);
  const agent = user ? await getOrCreateUserAgent(user) : null;
  if (!agent) {
    await releaseSpend(billKey, debtor, "agent_wallet_unavailable");
    return { debtor, decision: "skip", reason: "agent_wallet_unavailable", amountUsdc: 0 };
  }

  // The most likely real-world failure, and it gets its own slug so the user is
  // told what to fix. In Funded mode the agent also pays the share, so its
  // balance IS the cap: an agent holding 5 USDC can never spend 6.
  const need = FEE_UNITS + GAS_HEADROOM_UNITS + (mode === "funded" ? decision.amount : 0n);
  const balance = await getAgentBalanceUsdc(agent.address).catch(() => 0n);
  if (balance < need) {
    await releaseSpend(billKey, debtor, "agent_unfunded");
    return { debtor, decision: "skip", reason: "agent_unfunded", amountUsdc: 0 };
  }

  try {
    const { jobId, settlementTx } = await runJob({
      agent,
      settler,
      billId,
      debtor,
      mode,
      amount: decision.amount,
    });
    await finalizeAutopayDecision(REGISTRY_ADDRESS, billKey, debtor, {
      txHash: settlementTx,
      jobId: jobId.toString(),
      jobStatus: "completed",
      feeUsdc: FEE_USDC,
    });

    // Reputation is deliberately NOT recorded here, in either mode. payFor and
    // payDebtFor both emit DebtPaid with the DEBTOR as payer, so the existing
    // SCP event monitor already scores this payment on the same (wallet,
    // registry, bill) key. A second path would only race the first.
    after(() => console.log(`autopay: paid bill ${billKey} for ${debtor} — job ${jobId}, tx ${settlementTx}`));

    return { debtor, decision: "pay", reason: decision.reason, amountUsdc, txHash: settlementTx };
  } catch (err) {
    const reason =
      err instanceof InsufficientFundsError ? "agent_unfunded" : err instanceof JobError ? "job_failed" : "tx_failed";
    await releaseSpend(billKey, debtor, reason);
    console.error(`autopay: bill ${billKey} for ${debtor} failed:`, err instanceof Error ? err.message : err);
    return { debtor, decision: "skip", reason, amountUsdc: 0 };
  }
}
```

- [ ] **Step 4: Add the job ceremony and the review purchase**

Below `settleOne`, add:

```ts
// Thrown when a job transaction fails, so the catch above can log 'job_failed'
// rather than the vaguer 'tx_failed'. The distinction matters to whoever reads
// the log: one means the escrow ceremony broke, the other means the bill money
// did not move.
class JobError extends Error {
  constructor(step: string, cause: unknown) {
    super(`job ${step}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "JobError";
  }
}

// The six-transaction ceremony. Every signature belongs to a wallet the server
// controls, so the user gets no prompt at settlement time — they signed once at
// setup, and that is the whole point.
//
// Job-first is the honest lifecycle order, and it is affordable because the
// ESCROW ONLY EVER HOLDS THE FEE. If the settlement fails the job sits Funded,
// expires an hour later, and at worst 0.01 USDC of the agent's balance is
// stranded. The bill money is never at risk in either ordering.
// UNVERIFIED (spec §12 Q3): whether an Expired job returns the escrow.
async function runJob(input: {
  agent: UserAgent;
  settler: `0x${string}`;
  billId: bigint;
  debtor: `0x${string}`;
  mode: MoneyMode;
  amount: bigint;
}): Promise<{ jobId: bigint; settlementTx: `0x${string}` }> {
  const { agent, settler, billId, debtor } = input;
  const auditor = await getOrCreateArcWallet("splitsy", "auditor");
  if (!auditor) throw new JobError("evaluator", "the Auditor wallet is unavailable");

  const expiredAt = BigInt(Math.floor(Date.now() / 1000)) + JOB_TTL_SECONDS;
  const description = `Splitsy: settle bill ${billId} share for ${debtor}`;

  // 1. createJob — the user's agent is the client.
  let jobId: bigint;
  try {
    const created = await executeContractOnArc(
      agent.walletId,
      AGENTIC_COMMERCE_ADDRESS,
      encodeCreateJob(settler, auditor.address as `0x${string}`, expiredAt, description),
    );
    if (!created.txHash) throw new Error("createJob is still pending — no tx hash");
    const receipt = await settlerReceipt(created.txHash as `0x${string}`);
    const id = jobIdFromLogs(receipt.logs);
    if (id === null) throw new Error("createJob receipt has no JobCreated log");
    jobId = id;
  } catch (err) {
    throw new JobError("createJob", err);
  }

  // 2. setBudget — the PROVIDER prices the work, which is why the Settler signs
  //    it and not the client. Tutorial order: createJob → setBudget → fund.
  try {
    await settlerWrite(AGENTIC_COMMERCE_ADDRESS, encodeSetBudget(jobId, FEE_UNITS));
  } catch (err) {
    throw new JobError("setBudget", err);
  }

  // 3. fund — the fee into escrow, preceded by the lazy approval.
  try {
    await ensureAgentAllowance(agent, AGENTIC_COMMERCE_ADDRESS, FEE_UNITS);
    await executeContractOnArc(agent.walletId, AGENTIC_COMMERCE_ADDRESS, encodeFund(jobId));
  } catch (err) {
    throw new JobError("fund", err);
  }

  // 4. settle — the only step that moves BILL money, and the only one that
  //    differs between the two modes.
  let settlementTx: `0x${string}`;
  try {
    if (input.mode === "funded") {
      // The agent pays out of its own balance. payDebtFor credits the DEBTOR
      // and emits DebtPaid naming them as payer, so reputation still flows to
      // the user rather than to their agent.
      await ensureAgentAllowance(agent, REGISTRY_ADDRESS, input.amount);
      const tx = await executeContractOnArc(
        agent.walletId,
        REGISTRY_ADDRESS,
        encodePayDebtFor(billId, debtor, input.amount),
      );
      if (!tx.txHash) throw new Error("payDebtFor is still pending — no tx hash");
      settlementTx = tx.txHash as `0x${string}`;
    } else {
      // One call, carrying no amount: the mandate reads the debtor's full
      // remaining share itself and re-checks every cap on chain. Whatever this
      // route decided, the contract decides again.
      settlementTx = await settlerWrite(MANDATE_ADDRESS, encodePayFor(billId, debtor));
    }
  } catch (err) {
    // NOT a JobError: the bill money failing is a different problem from the
    // ceremony failing, and InsufficientFundsError must reach the caller intact
    // so it can be logged as 'agent_unfunded'.
    throw err;
  }

  // 5. submit — the deliverable IS the settlement transaction, hashed, so
  //    anyone holding the tx hash can recompute it and check the job.
  try {
    await settlerWrite(AGENTIC_COMMERCE_ADDRESS, encodeSubmit(jobId, deliverableFor(settlementTx)));
  } catch (err) {
    throw new JobError("submit", err);
  }

  // 6. complete — NOT a rubber stamp. The Auditor reads the registry on chain
  //    and completes only when the debt is really settled. If it is not, the
  //    job expires and the Settler is not paid. This is what separates a job
  //    market from theatre.
  try {
    const settled = await getParticipantOnchain(billId, debtor);
    if (!settled?.exists || settled.paid < settled.owed) {
      throw new Error(`registry still shows ${settled?.paid ?? 0n} paid of ${settled?.owed ?? 0n} owed`);
    }
    await executeContractOnArc(auditor.walletId, AGENTIC_COMMERCE_ADDRESS, encodeComplete(jobId, COMPLETE_REASON));
  } catch (err) {
    throw new JobError("complete", err);
  }

  return { jobId, settlementTx };
}

// The Settler buys the verdict from the Auditor over a real 402 round trip,
// exactly as Scout already buys /api/ocr. Both sides run in this same Next.js
// process and that is fine: Circle Gateway verifies and settles a real payment
// between two distinct addresses, and the loopback is the proven shape in this
// repo rather than a shortcut invented here.
//
// Fails closed on everything — a 402, a timeout, an unparseable verdict, a
// missing key, AND an x402 settlement failure. A Settler that cannot pay for a
// review does not settle anything.
async function buyReview(baseUrl: string, body: ReviewInput): Promise<ReviewVerdict> {
  try {
    await ensureSettlerGatewayBalance().catch(() => undefined);
    const { gateway } = getSettler();
    const result = await gateway.pay(`${baseUrl}/api/agents/review`, { method: "POST", body });
    const data = result.data as { approve?: unknown; reason?: unknown };
    if (typeof data?.approve !== "boolean") return { approve: false, reason: REVIEW_UNAVAILABLE };

    after(() =>
      recordPayment({
        direction: "spent",
        endpoint: "/api/agents/review",
        counterparty: getSettler().address,
        amountUsdc: (Number(result.amount) / 1e6).toString(),
        gatewayTx: result.transaction || null,
      }),
    );

    const reason = typeof data.reason === "string" && data.reason.trim() ? data.reason.trim() : "";
    return data.approve
      ? { approve: true, reason: reason || "Bill contents look consistent with this share." }
      : { approve: false, reason: reason || "The agent could not justify this bill's contents." };
  } catch (err) {
    console.warn("[autopay] the Settler could not buy a review; refusing:", err instanceof Error ? err.message : err);
    return { approve: false, reason: REVIEW_UNAVAILABLE };
  }
}
```

Add to `POST`, beside the existing fact resolution, the base URL the Settler calls itself on — mirror `scoutBaseUrl` in `lib/scout/deps.ts`:

```ts
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL ?? new URL(request.url).origin;
```

and pass it into every `settleOne` call.

- [ ] **Step 5: Fix the imports**

The file's import block needs, added to what is already there:

```ts
import { sumAutopaySpentTodayUsdc } from "@/lib/agents-repo";
import { buildGrant, decideAutopay, type MoneyMode } from "@/lib/autopay";
import {
  AGENTIC_COMMERCE_ADDRESS,
  COMPLETE_REASON,
  deliverableFor,
  encodeComplete,
  encodeCreateJob,
  encodeFund,
  encodeSetBudget,
  encodeSubmit,
  isJobsConfigured,
  jobIdFromLogs,
} from "@/lib/erc8183";
import { encodePayDebtFor, encodePayFor } from "@/lib/registry-calldata";
import {
  ensureSettlerGatewayBalance,
  getSettler,
  isSettlerConfigured,
  settlerReceipt,
  settlerWrite,
} from "@/lib/settler";
import { ensureAgentAllowance, getAgentBalanceUsdc, getOrCreateUserAgent, type UserAgent } from "@/lib/user-agent";
import { getUserById, getUsersByWallets } from "@/lib/users-repo";
import { recordPayment } from "@/lib/x402/payments-repo";
import type { ReviewInput, ReviewVerdict } from "@/lib/autopay-review";
```

`reviewBill` is no longer imported here — the route buys it over HTTP instead. `REVIEW_UNAVAILABLE` stays. The `AutopayGrant` type import is no longer needed if `buildGrant` supplies it; remove it if unused.

- [ ] **Step 6: Verify**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npm run lint`
Expected: clean.

Run: `npm run test:agents`
Expected: PASS — none of these tests touch the route, but a broken import in `lib/` would surface here.

Run: `npm run build`
Expected: success.

- [ ] **Step 7: Commit**

```bash
git add app/api/agents/autopay/route.ts
git commit -m "feat(agents): every settlement is an ERC-8183 job, escrowed and independently evaluated"
```

---

### Task 8: The agent's API surface

**Files:**
- Create: `app/api/agents/wallet/route.ts`
- Modify: `app/api/agents/grants/route.ts`

**Interfaces:**
- Consumes: Tasks 1–5.
- Produces, consumed by Task 9:
  - `GET /api/agents/wallet` →
    ```ts
    {
      address: string | null;
      tokenId: string | null;          // ERC-8004 identity, from reputation_agents
      balanceUsdc: number;
      moneyMode: "mandate" | "funded";
      jobs: { billId: string; jobId: string | null; jobStatus: string | null; feeUsdc: number; txHash: string | null; createdAt: string }[];
    }
    ```
  - `GET /api/agents/grants` gains `moneyMode: "mandate" | "funded"` in its response
  - `PUT /api/agents/grants` accepts `moneyMode` in its body

**Context:** `resolveAgentAddress()` in the grants route currently returns the `splitsy:autopay-agent` DCW. It must now return the **Settler's** address, because that is the address a mandate has to name. Keep the `NEXT_PUBLIC_AUTOPAY_AGENT_ADDRESS` env override — the settler-setup script prints it — and fall back to `getSettler().address`. Delete the DCW fallback: an environment with no Settler has no hosted agent, and returning a DCW that cannot sign a job would arm a mandate nothing can act on.

- [ ] **Step 1: Write the wallet route**

Create `app/api/agents/wallet/route.ts`:

```ts
// The user's own agent, read for the "Your agent" card.
//
// Session-scoped: this is one person's wallet, balance and job history. The
// agent is created on first read, which is deliberate — someone has to look at
// the card before they can fund it, and the wallet must exist to be funded.
// Creating a DCW costs nothing until it is used.
import { getAutopayGrant, listAutopayLog } from "@/lib/agents-repo";
// The authoritative wallet -> ERC-8004 agent id mapping. It survives a registry
// redeploy, which is why identity is resolved from here and not from an env var.
import { getAgentByWallet } from "@/lib/reputation-repo";
import { getSessionUser } from "@/lib/session";
import { getAgentBalanceUsdc, ensureUserAgentIdentity, getOrCreateUserAgent } from "@/lib/user-agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getSessionUser();
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });

  const agent = await getOrCreateUserAgent(user);
  if (!agent) {
    // Circle is not configured. Say so as an absent agent rather than an error:
    // the panel renders "no agent yet", which is the truth.
    return Response.json({ address: null, tokenId: null, balanceUsdc: 0, moneyMode: "mandate", jobs: [] });
  }

  const [balance, identity, rules, log] = await Promise.all([
    getAgentBalanceUsdc(agent.address).catch(() => 0n),
    getAgentByWallet(agent.address).catch(() => null),
    getAutopayGrant(user.id).catch(() => null),
    listAutopayLog(user.id).catch(() => []),
  ]);

  // Register the identity in the background once the agent has gas to pay for
  // it. Never awaited: a card render must not wait on a mint, and a failure
  // leaves the agent perfectly able to settle — it just has no NFT yet.
  if (!identity?.agent_id && balance > 0n) {
    void ensureUserAgentIdentity(agent, user.wallet_address);
  }

  return Response.json({
    address: agent.address,
    tokenId: identity?.agent_id ?? process.env.NEXT_PUBLIC_USER_AGENT_TOKEN_ID ?? null,
    balanceUsdc: Number(balance) / 1e6,
    moneyMode: rules?.moneyMode ?? "mandate",
    // Only the rows that opened a job. A skip has no job and belongs in the
    // decision log, which the panel already renders separately.
    jobs: log
      .filter((row) => row.jobId)
      .map((row) => ({
        billId: row.billId,
        jobId: row.jobId,
        jobStatus: row.jobStatus,
        feeUsdc: row.feeUsdc,
        txHash: row.txHash,
        createdAt: row.createdAt,
      })),
  });
}
```

`getAgentByWallet` lives in `lib/reputation-repo.ts` (line 50) and is already exported — nothing to change there. It returns a `ReputationAgent`; read the type before using `agent_id` and match its exact field name.

- [ ] **Step 2: Point the grants route at the Settler**

In `app/api/agents/grants/route.ts`, replace `resolveAgentAddress`:

```ts
// The agent the mandate will name. The env var is the deployment's answer (the
// settler-setup script prints it); the Settler's own key is the fallback, so a
// fresh environment works without one more address to copy by hand.
//
// No DCW fallback any more. The agent that signs a mandate pull is now the
// Settler EOA, because it also has to sign x402 payments — and returning a DCW
// here would arm a mandate naming an address that can never act on it.
//
// MIGRATION: this address REPLACES the old splitsy:autopay-agent DCW. Every
// existing user must re-arm their mandate, exactly as after a contract redeploy.
async function resolveAgentAddress(): Promise<`0x${string}` | null> {
  const configured = process.env.NEXT_PUBLIC_AUTOPAY_AGENT_ADDRESS;
  if (configured && /^0x[a-fA-F0-9]{40}$/.test(configured)) return configured as `0x${string}`;
  return isSettlerConfigured() ? getSettler().address : null;
}
```

Import `getSettler, isSettlerConfigured` from `@/lib/settler` and drop `getOrCreateArcWallet` from the import list if nothing else in the file uses it (`syncMandateOnchain` does not — check before removing).

- [ ] **Step 3: Carry `moneyMode` through GET and PUT**

In `GET`, add to the response object:

```ts
    // Where BILL money comes from. Not a chain fact — it lives only here.
    moneyMode: rules?.moneyMode ?? "mandate",
```

In `PUT`, validate it at the trust boundary alongside the caps, and pass it to `upsertAutopayGrant` (replacing the `moneyMode: existing?.moneyMode ?? "mandate"` placeholder Task 2 left):

```ts
  // Anything that is not exactly 'funded' reads as 'mandate' — the mode where
  // the CHAIN enforces the caps. A typo must never move someone into the mode
  // where only this server says no.
  const moneyMode = raw.moneyMode === "funded" ? "funded" : "mandate";
```

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit && npm run lint && npm run build`
Expected: all clean; `/api/agents/wallet` appears in the build's route list.

- [ ] **Step 5: Commit**

```bash
git add app/api/agents/wallet/route.ts app/api/agents/grants/route.ts
git commit -m "feat(agents): read the user's agent, and name the Settler in new mandates"
```

---

### Task 9: The panel — Your agent, the money mode, and Unlink

**Files:**
- Modify: `app/SettlementAgentsPanel.tsx`

**Interfaces:**
- Consumes: `GET /api/agents/wallet` and the extended `/api/agents/grants` from Task 8; `DELETE /api/agents/link`, which already exists and works.
- Produces: nothing.

**Context:** Read the whole file first. It is a three-section panel with its own design tokens (`spec-row`, `spec-chip`, `spec-hint`, `spec-label`, `secondary-button`, `segmented-control`, `tab-button`). Match them exactly — do not introduce new class names or a component library.

Four changes:

1. **A "Your agent" card**, in section 01, above the existing "Pay from" row: address with an Arcscan link, its ERC-8004 identity with a link, its USDC balance, a **Fund** control, its jobs (bill, fee, status chip, transaction hashes), and one line stating that this agent covers **both** the Splitsy wallet and the linked browser wallet, so nobody funds twice looking for a second one.
2. **The money-mode picker** (Mandate / Funded), a `segmented-control` like the existing ones, with this sentence rendered verbatim when Funded is selected: *"In this mode your limits are enforced by Splitsy, not by the chain. Your agent's balance is the only limit the chain enforces."*
3. **An Unlink button** in the existing "Pay from" row next to the linked address, with the warning table collapsed behind it. Enabled whenever a wallet is linked. **Never gated behind the wallet-unlock cookie** — tightening must never be harder than loosening.
4. **Two new reason strings** in `REASONS`, and job columns on `pay` rows in the decision log.

Recommended starting balances shown next to Fund: **2 USDC** for Mandate mode (gas + fees only), **20 USDC** for Funded mode (gas + fees + bill money).

- [ ] **Step 1: Add the new reason strings**

In the `REASONS` map:

```ts
  agent_unfunded: "Your agent's balance is too low — top it up and the next bill will settle",
  job_failed: "The on-chain job could not be completed, so nothing was paid",
```

- [ ] **Step 2: Add the agent state and its fetch**

Add the type beside the existing response types:

```ts
// The user's own agent, from /api/agents/wallet. One per ACCOUNT: the same
// agent and the same balance cover the Splitsy wallet and the linked browser
// wallet both, which is the line the card has to make unmissable.
type AgentWallet = {
  address: string | null;
  tokenId: string | null;
  balanceUsdc: number;
  moneyMode: "mandate" | "funded";
  jobs: {
    billId: string;
    jobId: string | null;
    jobStatus: string | null;
    feeUsdc: number;
    txHash: string | null;
    createdAt: string;
  }[];
};
```

Add `const [agentWallet, setAgentWallet] = useState<AgentWallet | null>(null);` and a `useEffect` fetching `/api/agents/wallet`, mirroring the existing `/api/agents/grants` effect exactly — including its `signedOut` handling on a 401.

In the same step, extend the panel's own `Grant` type so Steps 3–4 can read it, and give `DEFAULT_GRANT` (if the panel has one) the closed default:

```ts
type Grant = Caps & {
  minCreatorScore: number;
  requireVerifiedHash: boolean;
  requireBillReview: boolean;
  // Where BILL money comes from. Defaults to 'mandate' — the mode where the
  // CHAIN enforces the caps, never the one where only Splitsy says no.
  moneyMode: "mandate" | "funded";
};
```

Add `moneyMode` to the object `save()` sends in its PUT body, and to `LogEntry` as described in Step 6.

- [ ] **Step 3: Render the card**

Insert above the "Pay from" `spec-row`, inside the same `spec-body`:

```tsx
          {/* The agent that spends. It is the user's: they fund it, it holds
              its own balance, and its ERC-8004 identity NFT is theirs. */}
          <div className="spec-row">
            <div className="min-w-0">
              <span className="inline-flex items-center gap-1.5 text-sm font-semibold">
                <Bot size={14} /> Your agent
              </span>
              <span className="spec-hint">
                {agentWallet?.address ? (
                  <>
                    <a
                      className="mono underline-offset-2 hover:underline"
                      href={`https://testnet.arcscan.app/address/${agentWallet.address}`}
                      rel="noreferrer"
                      target="_blank"
                    >
                      {short(agentWallet.address)}
                    </a>
                    {agentWallet.tokenId ? (
                      <>
                        {" · "}
                        <a
                          className="underline-offset-2 hover:underline"
                          href={`https://testnet.arcscan.app/token/0x8004A818BFB912233c491871b3d84c89A494BD9e?a=${agentWallet.tokenId}`}
                          rel="noreferrer"
                          target="_blank"
                        >
                          identity #{agentWallet.tokenId}
                        </a>
                      </>
                    ) : null}
                  </>
                ) : (
                  "No agent yet — it is created the first time this page loads with Circle configured."
                )}
              </span>
              {/* Said plainly, because the alternative is someone funding twice
                  looking for a second agent that does not exist. */}
              <span className="spec-hint">
                One agent covers both your Splitsy wallet and your linked browser wallet. Fund it once.
              </span>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1">
              <span className="mono text-sm font-semibold">{(agentWallet?.balanceUsdc ?? 0).toFixed(2)} USDC</span>
              <span className="spec-hint">
                Send USDC to the address to top it up. Suggested: {grant.moneyMode === "funded" ? "20" : "2"} USDC.
              </span>
            </div>
          </div>
```

There is no in-app Fund transaction: funding is an inbound transfer from whatever wallet the user chooses, so the card shows the address and the suggested amount rather than a button that would need a wallet connection it may not have. **ponytail:** add a one-click fund from the Splitsy DCW if people ask for it; the address plus a copy affordance is what the balance actually needs today. If the panel already has a copy-to-clipboard helper, reuse it on the address; do not write a new one.

- [ ] **Step 4: Render the money-mode picker**

Directly below the agent card:

```tsx
          <div className="spec-row">
            <div className="min-w-0">
              <span className="inline-flex items-center gap-1.5 text-sm font-semibold">
                <Wallet size={14} /> Bill money from
              </span>
              <span className="spec-hint">
                {grant.moneyMode === "funded"
                  ? "In this mode your limits are enforced by Splitsy, not by the chain. Your agent's balance is the only limit the chain enforces."
                  : "Your own wallet, pulled under the on-chain mandate. The caps below are enforced by the contract."}
              </span>
            </div>
            <div className="segmented-control shrink-0 text-xs" role="group" aria-label="Where bill money comes from">
              <button
                className={`tab-button ${grant.moneyMode === "funded" ? "" : "tab-button-active"}`}
                onClick={() => save({ ...grant, moneyMode: "mandate" })}
                type="button"
              >
                My wallet
              </button>
              <button
                className={`tab-button ${grant.moneyMode === "funded" ? "tab-button-active" : ""}`}
                onClick={() => save({ ...grant, moneyMode: "funded" })}
                type="button"
              >
                My agent&rsquo;s balance
              </button>
            </div>
          </div>
```

The `Grant` type already carries `moneyMode` from Step 2, and `save()` already sends it — nothing further here.

- [ ] **Step 5: Add the Unlink button and its warning**

In the "Pay from" row's button group, beside the existing conditional Link button:

```tsx
              {linkedAddress ? (
                <button className="secondary-button" disabled={saving} onClick={() => setShowUnlink((v) => !v)} type="button">
                  <X size={13} /> Unlink
                </button>
              ) : null}
```

and, below the row, the warning that only appears when it is toggled:

```tsx
          {showUnlink && linkedAddress ? (
            <div className="spec-row flex-col items-start gap-2">
              {/* Unlinking does LESS than people expect, and the gap is money.
                  Revoke first, then unlink — offered as the ordered pair,
                  never as "unlink turns it off". */}
              <span className="text-sm font-semibold">Unlinking {short(linkedAddress)} does four things, not one</span>
              <ul className="spec-hint list-disc space-y-1 pl-4">
                <li>Autopay for that wallet <strong>stops</strong> — it is no longer resolvable to your account.</li>
                <li>
                  The on-chain mandate on it <strong>survives</strong>. Revoking is a separate transaction you send from
                  that wallet.
                </li>
                <li>Its USDC approval to the mandate contract <strong>survives</strong>, and is inert only while the mandate is revoked.</li>
                <li>Your agent, its balance and its identity NFT are <strong>untouched</strong> — they belong to your account.</li>
              </ul>
              <div className="flex flex-wrap items-center gap-2">
                <button className="secondary-button" disabled={saving} onClick={() => armOnChain(grant, true)} type="button">
                  <Ban size={13} /> Revoke the mandate first
                </button>
                <button className="secondary-button" disabled={saving} onClick={unlinkWallet} type="button">
                  <X size={13} /> Unlink anyway
                </button>
              </div>
            </div>
          ) : null}
```

and the handler, beside `linkWallet`:

```tsx
  // Never gated behind the wallet-unlock cookie, matching POST /api/agents/link
  // and the settings form: TIGHTENING must never be harder than loosening.
  async function unlinkWallet() {
    setSaving(true);
    try {
      const res = await fetch("/api/agents/link", { method: "DELETE" });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) return fail(data.error ?? "Could not unlink that wallet.");
      setShowUnlink(false);
      setMessageTone("success");
      setMessage("Wallet unlinked. Any mandate you left on it is still live until you revoke it.");
      await refresh();
    } finally {
      setSaving(false);
    }
  }
```

Add `const [showUnlink, setShowUnlink] = useState(false);`. Use whatever the panel's existing reload function is called instead of `refresh()` — read the file and match it. If `armOnChain(grant, true)` is not the existing revoke path, use whichever function the existing revoke control calls.

- [ ] **Step 6: Show the job on `pay` rows**

In the decision-log rendering, for a row whose `jobId` is set, add the job id and its status chip beside the existing transaction link. A `skip` row is unchanged and still shows the model's own sentence verbatim:

```tsx
                    {entry.jobId ? (
                      <span className="spec-hint">
                        job #{entry.jobId} · {entry.jobStatus ?? "unknown"} · fee {entry.feeUsdc.toFixed(3)} USDC
                      </span>
                    ) : null}
```

Add `jobId: string | null; jobStatus: string | null; feeUsdc: number;` to the `LogEntry` type.

- [ ] **Step 7: Verify**

Run: `npx tsc --noEmit && npm run lint && npm run build`
Expected: all clean.

Visual check, only if a dev server is already running: load the panel and confirm the card, the picker, the Unlink button and its warning all render, and that the Funded warning sentence appears verbatim. Record what you saw. If no server is running, say so — do not claim a visual check you did not perform.

- [ ] **Step 8: Commit**

```bash
git add app/SettlementAgentsPanel.tsx
git commit -m "feat(agents): the agent card, the money-mode picker, and a way back from linking"
```

---

### Task 10: Operator documentation and the manual verification checklist

**Files:**
- Create: `docs/agent-economy.md`
- Modify: `docs/autopay-agent.md`

**Interfaces:** none. This task ships prose.

**Context:** Read `docs/autopay-agent.md` first and match its shape, its headings, and its voice. The new document is its sibling, not its replacement — the "bring your own Circle Agent Wallet" path documented there stays exactly as it is, and a self-hosting user can still name their own agent in the mandate with Splitsy writing no log row for them.

- [ ] **Step 1: Write `docs/agent-economy.md`**

It must cover, each as its own section:

1. **What changed and what it costs.** Three agents (the user's, the Settler, the Auditor), three payment rails (ERC-8183 escrow, x402, direct USDC), six transactions per settled share — 24 for a four-person bill. Reproduce the cost table from spec §6:

   | Event | Extra transactions |
   |---|---|
   | bill created | 0 |
   | paid manually in the app | 0 |
   | autopay off | 0 |
   | autopay on, agent **skips** | 0 |
   | autopay on, agent **pays** | 6 |

2. **The migration, stated first and plainly.** The Settler's address replaces the `splitsy:autopay-agent` DCW as the address named in mandates, so **every existing user must re-arm their mandate**, exactly as after a mandate-contract redeploy.

3. **Setup, in order:** run `schema-agent-economy.sql` in the Supabase SQL editor; run `npm run settler:setup` and copy the printed `SETTLER_PRIVATE_KEY`, `NEXT_PUBLIC_AUTOPAY_AGENT_ADDRESS` and `SETTLER_ERC8004_TOKEN_ID` into `.env.local`; fund the Settler from the Circle faucet; set `NEXT_PUBLIC_AGENTIC_COMMERCE_ADDRESS`.

4. **Environment**, exactly as spec §15:

   ```ini
   SETTLER_PRIVATE_KEY=0x…              # required. the Settler EOA; x402 + ERC-8183 signer
   NEXT_PUBLIC_AGENTIC_COMMERCE_ADDRESS=0x0747EEf0706327138c69792bF28Cd525089e4583
   SETTLEMENT_FEE_USDC=0.01             # optional, default 0.01
   SETTLER_ERC8004_TOKEN_ID=…           # optional, DISPLAY ONLY
   AUDITOR_ERC8004_TOKEN_ID=…           # optional, DISPLAY ONLY
   ```

   Say that the two token-id variables are a UI convenience only, matching how `SCOUT_ERC8004_TOKEN_ID` is used today: identity is resolved from `reputation_agents` via `getAgentByWallet`, which is authoritative and survives a redeploy. Say that unsetting `NEXT_PUBLIC_AGENTIC_COMMERCE_ADDRESS` or `SETTLER_PRIVATE_KEY` reads as **autopay off**, never as "run without the job".

5. **Funding.** Every user must fund their agent before autopay can run, **in both modes** — this is a real product change and it is deliberate. Suggested starting balances: 2 USDC for Mandate mode (gas + fees), 20 USDC for Funded mode (gas + fees + bill money). An agent that cannot cover the fee plus gas skips with `agent_unfunded` and creates no job.

6. **The two money modes**, with the table from spec §5 and the one-sentence warning about Funded mode verbatim.

7. **Unlinking**, with the four-row effect table from spec §4 and the "revoke first, then unlink" ordering.

8. **UNVERIFIED — run these by hand.** Reproduce spec §12 Q1–Q9 as a checklist, each with the command or the sequence to run and what to expect. Say plainly at the top of the section that none has been executed, and that Q2 and Q4 could each force a design change:
   - Q1 `setBudget` from the provider while `Open`
   - Q2 `complete` by an evaluator that is not the client
   - Q3 whether `Expired` refunds the client (*if not*: say so here and shorten `JOB_TTL_SECONDS` to 15 minutes)
   - Q4 a raw EOA paying Arc gas in USDC with no native balance (*if not*: `scripts/settler-setup.ts` must fund it natively)
   - Q5 end-to-end Mandate mode
   - Q6 end-to-end Funded mode
   - Q7 the Auditor refuses — expect no job at all and one `spent` row in `x402_payments`
   - Q8 one agent covering both wallets
   - Q9 unlink with a live mandate

9. **What we deliberately did not do**, from spec §13.

- [ ] **Step 2: Update `docs/autopay-agent.md`**

Add, near the top, without disturbing the self-hosting instructions:
- the new agent address is the **Settler**, not the `splitsy:autopay-agent` DCW, and existing mandates must be re-armed;
- funding the user's own agent is now required in both money modes;
- a pointer to `docs/agent-economy.md` for the job lifecycle.

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit && npm run lint && npm run build && npm run test:agents`
Expected: all clean — the whole branch, one last time.

Read `docs/agent-economy.md` back and check every address, every env var name and every reason slug against the code that uses them. A doc naming a slug the code does not emit is a defect.

- [ ] **Step 4: Commit**

```bash
git add docs/agent-economy.md docs/autopay-agent.md
git commit -m "docs(agents): operating the agent economy, and the checks nobody has run yet"
```
