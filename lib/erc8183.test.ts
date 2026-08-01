import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeFunctionData, encodeAbiParameters, keccak256, toHex } from "viem";

// erc8183.ts reads the contract address ONCE at import time (unset = autopay
// off), and jobIdFromLogs filters receipt logs by it — so the address has to be
// in the environment before that module evaluates, hence the dynamic import.
// It lives here rather than as a `FOO=bar node …` prefix on the npm script
// because `npm run` shells out to cmd.exe on Windows, where that is not a
// command; a test that only passes under one shell is a test that will rot.
const AGENTIC_COMMERCE = "0x0747EEf0706327138c69792bF28Cd525089e4583";
process.env.NEXT_PUBLIC_AGENTIC_COMMERCE_ADDRESS = AGENTIC_COMMERCE;

const {
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
} = await import("./erc8183.ts");

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
  // The three non-indexed params, as the chain would actually put them in the
  // log body. decodeEventLog is strict by default (same as parseBillCreatedLog
  // in lib/arc-read.ts), so a "0x" body would be rejected before the id is read.
  const jobCreatedData = encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }, { type: "address" }],
    [EVALUATOR, 1_800_000_000n, ZERO],
  );
  const logs = [
    // Another contract's log in the same bundled transaction — must be skipped.
    { address: "0x9999999999999999999999999999999999999999", topics: [jobCreatedTopic, pad("7b")], data: "0x" },
    {
      address: "0x0747EEf0706327138c69792bF28Cd525089e4583",
      topics: [jobCreatedTopic, pad("1c8"), pad(PROVIDER.slice(2)), pad(EVALUATOR.slice(2))],
      data: jobCreatedData,
    },
  ];
  assert.equal(jobIdFromLogs(logs), 456n);
});

test("jobIdFromLogs returns null when the receipt has no JobCreated", () => {
  assert.equal(jobIdFromLogs([{ address: "0x0747EEf0706327138c69792bF28Cd525089e4583", topics: ["0x00"], data: "0x" }]), null);
});
