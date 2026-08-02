import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeAbiParameters, encodeEventTopics } from "viem";
import {
  AGENT_PROFILE,
  feedbackDedupeKey,
  feedbackHashFor,
  parseDebtPaidLog,
  type AgentType,
} from "./erc8004.ts";

const DEBT_PAID_ABI = [
  {
    type: "event",
    name: "DebtPaid",
    anonymous: false,
    inputs: [
      { indexed: true, name: "billId", type: "uint256" },
      { indexed: true, name: "payer", type: "address" },
      { indexed: false, name: "amount", type: "uint256" },
      { indexed: false, name: "paidTotal", type: "uint256" },
      { indexed: false, name: "owedTotal", type: "uint256" },
    ],
  },
] as const;

function buildLog(args: {
  billId: bigint;
  payer: `0x${string}`;
  amount: bigint;
  paidTotal: bigint;
  owedTotal: bigint;
}) {
  const topics = encodeEventTopics({
    abi: DEBT_PAID_ABI,
    eventName: "DebtPaid",
    args: { billId: args.billId, payer: args.payer },
  });
  const data = encodeAbiParameters(
    [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
    [args.amount, args.paidTotal, args.owedTotal],
  );
  return { topics: topics as string[], data };
}

const PAYER = ("0x" + "11".repeat(20)) as `0x${string}`;

test("parseDebtPaidLog decodes a paid-in-full settlement", () => {
  const { topics, data } = buildLog({
    billId: 7n,
    payer: PAYER,
    amount: 1000000n,
    paidTotal: 1000000n,
    owedTotal: 1000000n,
  });
  const log = parseDebtPaidLog(topics, data);
  assert.ok(log);
  assert.equal(log.billId, "7");
  assert.equal(log.payer, PAYER.toLowerCase());
  assert.equal(log.paidInFull, true);
});

test("parseDebtPaidLog marks a partial payment as not paid-in-full", () => {
  const { topics, data } = buildLog({
    billId: 7n,
    payer: PAYER,
    amount: 400000n,
    paidTotal: 400000n,
    owedTotal: 1000000n,
  });
  const log = parseDebtPaidLog(topics, data);
  assert.ok(log);
  assert.equal(log.paidInFull, false);
});

test("parseDebtPaidLog treats an overpayment (paidTotal > owedTotal) as paid-in-full", () => {
  const { topics, data } = buildLog({
    billId: 1n,
    payer: PAYER,
    amount: 1n,
    paidTotal: 1200000n,
    owedTotal: 1000000n,
  });
  const log = parseDebtPaidLog(topics, data);
  assert.ok(log);
  assert.equal(log.paidInFull, true);
});

test("parseDebtPaidLog returns null for a non-DebtPaid log", () => {
  // A well-formed 32-byte topic0 that isn't the DebtPaid signature hash —
  // stands in for an unrelated event the monitor could deliver.
  const topics = [("0x" + "cd".repeat(32)) as `0x${string}`];
  assert.equal(parseDebtPaidLog(topics, "0x"), null);
});

test("parseDebtPaidLog returns null for malformed topics/data", () => {
  assert.equal(parseDebtPaidLog([], "0x"), null);
  assert.equal(parseDebtPaidLog(["0xdeadbeef"], "0xnothex"), null);
});

// --- registry namespacing (the v2 redeploy landmine) -------------------------
// BillSplitRegistry v2 restarts nextBillId at 1, so bill #1 exists under both
// registries. If either the on-chain commitment or the mirror's dedupe key
// ignored the registry address, the v2 payment would look like an already-scored
// v1 payment and scoring would silently stop recording.
const V1 = "0x867051b5F840F045B3c72a091B1b6453c86E120B";
const V2 = "0x1111111111111111111111111111111111111111";
const PAY_TX = "0x" + "ab".repeat(32);

test("the same bill id under two registries yields two distinct feedback hashes", () => {
  assert.notEqual(feedbackHashFor(V1, "bill:1", PAY_TX), feedbackHashFor(V2, "bill:1", PAY_TX));
});

test("the same bill id under two registries yields two distinct dedupe keys", () => {
  assert.notEqual(feedbackDedupeKey(V1, "1"), feedbackDedupeKey(V2, "1"));
});

test("feedback hashes and dedupe keys are case-insensitive in the registry address", () => {
  assert.equal(feedbackHashFor(V1.toUpperCase(), "bill:1", PAY_TX), feedbackHashFor(V1.toLowerCase(), "bill:1", PAY_TX));
  assert.equal(feedbackDedupeKey(V1.toUpperCase(), "1"), feedbackDedupeKey(V1.toLowerCase(), "1"));
});

test("a recurring cycle key stays distinct from a bare bill id on the same contract", () => {
  assert.notEqual(feedbackHashFor(V1, "tab:1:cycle:1", PAY_TX), feedbackHashFor(V1, "bill:1", PAY_TX));
});

// The metadata a token is minted with is IMMUTABLE, so these are not cosmetic
// assertions: a profile that is wrong at mint time is wrong on chain forever
// unless somebody re-points the URI by hand.
const AGENT_TYPES: AgentType[] = [
  "splitsy-payer",
  "splitsy-user-agent",
  "splitsy-settler",
  "splitsy-auditor",
];

test("every agent type has a profile, and every title says Agent", () => {
  for (const type of AGENT_TYPES) {
    const profile = AGENT_PROFILE[type];
    assert.ok(profile, `${type} has no profile`);
    // The title lands in the NFT's name and in the picture. Without the word,
    // "Splitsy Payer 0x1234…" reads like a person rather than software.
    assert.match(profile.title, /\bAgent\b/, `${type}'s title must contain "Agent"`);
    assert.ok(profile.capabilities.length > 0, `${type} claims no capabilities`);
  }
  assert.equal(Object.keys(AGENT_PROFILE).length, AGENT_TYPES.length);
});

test("each role describes its own job — no shared boilerplate across the four", () => {
  const descriptions = AGENT_TYPES.map((t) => AGENT_PROFILE[t].description);
  assert.equal(new Set(descriptions).size, AGENT_TYPES.length, "two agents share a description");
  assert.equal(
    new Set(AGENT_TYPES.map((t) => AGENT_PROFILE[t].title)).size,
    AGENT_TYPES.length,
    "two agents share a title",
  );
  for (const description of descriptions) {
    // The old text called all four "Payment reputation agent for Splitsy
    // bill-splitting app", which was true of one of them. Reputation is the
    // payer's job; an autopay client or an escrow evaluator does something else.
    assert.doesNotMatch(description, /^Payment reputation agent/, "the old boilerplate is back");
    assert.ok(description.length > 60, "a description this short cannot say what the agent does");
  }
});
