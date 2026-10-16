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
  STEP_BY_TOPIC,
  stepsFromLogs,
} = await import("./erc8183.ts");

const PROVIDER = "0x1111111111111111111111111111111111111111" as const;
const EVALUATOR = "0x2222222222222222222222222222222222222222" as const;
const CLIENT = "0x3333333333333333333333333333333333333333" as const;
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
  // Indexed order is (jobId, client, provider) — topics[2] is the CLIENT.
  const topicsFor = (jobIdHex: string) => [jobCreatedTopic, pad(jobIdHex), pad(CLIENT.slice(2)), pad(PROVIDER.slice(2))];
  const logs = [
    // Another AgenticCommerce deployment's log, in the same ERC-4337 bundle.
    // Deliberately WELL-FORMED and first in the array: a malformed one would be
    // thrown out by decodeEventLog and swallowed by the catch, so it would pass
    // whether or not the address filter existed — pinning nothing. This one
    // decodes cleanly to 291n, so deleting the filter makes this test fail.
    { address: "0x9999999999999999999999999999999999999999", topics: topicsFor("123"), data: jobCreatedData },
    { address: AGENTIC_COMMERCE, topics: topicsFor("1c8"), data: jobCreatedData },
  ];
  assert.equal(jobIdFromLogs(logs), 456n);
});

// The leading bytes of each step's topic0, copied from what Arc Testnet really
// emitted for job 164720 (tx 0xf2be6aa3… and its four siblings). Hard-coded
// rather than recomputed from the same strings the source uses, which would only
// prove keccak256 is deterministic: these came off the deployed contract, so a
// signature edited to something plausible-but-wrong fails here.
const ONCHAIN_TOPICS = {
  createJob: "0xb0f0239b",
  setBudget: "0x869e2577",
  fund: "0xe3fbcc1e",
  submit: "0x80c17db7",
  complete: "0x0fd54bd3",
  "escrow released": "0x21d71db5",
} as const;

test("every ceremony step keys off the topic0 the deployed contract emits", () => {
  const byStep = new Map([...STEP_BY_TOPIC].map(([topic, step]) => [step, topic]));
  for (const [step, prefix] of Object.entries(ONCHAIN_TOPICS)) {
    const topic = byStep.get(step);
    assert.ok(topic, `no topic registered for the ${step} step`);
    assert.ok(topic.startsWith(prefix), `${step} hashes to ${topic}, but Arc emits ${prefix}…`);
  }
  assert.equal(STEP_BY_TOPIC.size, 6, "six events make up the trail");
});

test("stepsFromLogs orders the ceremony by block, keeps only this job, drops the rest", () => {
  const pad = (hex: string) => `0x${hex.replace(/^0x/, "").padStart(64, "0")}`;
  const byStep = new Map([...STEP_BY_TOPIC].map(([topic, step]) => [step, topic]));
  const MINE = pad("28370"); // 164720
  const log = (step: string, blockNumber: bigint, txHash: string, jobTopic = MINE, logIndex = 0) => ({
    topics: [byStep.get(step) as string, jobTopic],
    blockNumber,
    transactionHash: txHash,
    logIndex,
  });

  const steps = stepsFromLogs(164720n, [
    // Out of order on purpose: getLogs is ordered, but the window is wide enough
    // to hold another job's ceremony interleaved with this one's.
    log("fund", 776n, "0xf2be"),
    log("createJob", 752n, "0x2f09"),
    // A neighbouring job in the same window — right event, wrong id.
    log("complete", 760n, "0xdead", pad("28371")),
    log("setBudget", 766n, "0x3d8e"),
    log("complete", 814n, "0xb636", MINE, 3),
    log("escrow released", 814n, "0xb636", MINE, 4),
    log("submit", 809n, "0xc0f5"),
    // An event this contract emits that is not part of the trail.
    { topics: [pad("beef"), MINE], blockNumber: 800n, transactionHash: "0xbeef", logIndex: 0 },
    // Still in the mempool as far as this node is concerned: no block, no hash.
    { topics: [byStep.get("fund") as string, MINE], blockNumber: null, transactionHash: null, logIndex: 0 },
  ]);

  assert.deepEqual(
    steps.map((s) => [s.step, s.blockNumber, s.txHash]),
    [
      ["createJob", 752, "0x2f09"],
      ["setBudget", 766, "0x3d8e"],
      ["fund", 776, "0xf2be"],
      ["submit", 809, "0xc0f5"],
      // Same block AND same transaction — ordered by log index, not by luck.
      ["complete", 814, "0xb636"],
      ["escrow released", 814, "0xb636"],
    ],
  );
});

test("jobIdFromLogs returns null when the receipt has no JobCreated", () => {
  assert.equal(jobIdFromLogs([{ address: "0x0747EEf0706327138c69792bF28Cd525089e4583", topics: ["0x00"], data: "0x" }]), null);
});

// THE PREDICATE THE AGENTS PANEL NOW HANGS ON. An unset address means "no job
// market", which reads as autopay OFF — and since autopay will not settle
// without opening a job, it is the whole feature, not a degraded version of it.
// That is the live state on Arc mainnet, where Arc deploys no ERC-8183 contract.
//
// Pinned because the two read paths must answer from the PREDICATE and never
// from the chain: a getLogs or a getJob aimed at the zero address does not fail
// usefully, it fails as an RPC error on a path whose honest answer is "there is
// nothing here". The fresh import is the only way to reach that state — the
// module reads the address once, at evaluation.
test("an unset job contract is 'no job market', and the read paths say so without touching the chain", async () => {
  const saved = process.env.NEXT_PUBLIC_AGENTIC_COMMERCE_ADDRESS;
  delete process.env.NEXT_PUBLIC_AGENTIC_COMMERCE_ADDRESS;
  try {
    const fresh = "./erc8183.ts?jobs-unconfigured";
    const off = await import(fresh);
    assert.equal(off.isJobsConfigured(), false);
    // Both short-circuit, so neither needs an RPC to be reachable to pass.
    assert.deepEqual(await off.getJobTrail(1n, `0x${"11".repeat(32)}`), []);
    assert.equal(await off.getJobOnchain(1n), null);
  } finally {
    if (saved === undefined) delete process.env.NEXT_PUBLIC_AGENTIC_COMMERCE_ADDRESS;
    else process.env.NEXT_PUBLIC_AGENTIC_COMMERCE_ADDRESS = saved;
  }
});

// And configured is configured, so the test above is pinning a switch rather
// than a module that always answers false.
test("a configured job contract is a job market", async () => {
  const { isJobsConfigured } = await import("./erc8183.ts");
  assert.equal(isJobsConfigured(), true);
});
