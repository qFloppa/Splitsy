import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeAbiParameters, encodeEventTopics } from "viem";
import {
  AGENT_PROFILE,
  feedbackDedupeKey,
  feedbackHashFor,
  imageUriForCid,
  isSelfMint,
  parseDebtPaidLog,
  SERVICE_AGENTS,
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
  "splitsy-validator",
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

test("each role describes its own job — no shared boilerplate across the roles", () => {
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

// The reputation identity and the autopay agent are two different NFTs doing two
// different things, and they shipped describing themselves the same way: both
// opened "Settles its owner's ... Splitsy bills" and both claimed
// debt_settlement. A payer who got the reputation NFT for paying a bill read it
// as the autopay agent's, which is the confusion this pins shut.
//
// The distinction is not cosmetic. The reputation identity is a passive holder
// of scores — its owner pays from their own wallet, and under the consent policy
// that self-payment is the ONLY thing that authorizes a score. An identity that
// advertises itself as settling bills on someone's behalf describes the opposite
// arrangement, permanently, because minted metadata is immutable.
test("the reputation identity does not describe itself as settling bills", () => {
  const reputation = AGENT_PROFILE["splitsy-payer"];
  const autopay = AGENT_PROFILE["splitsy-user-agent"];

  assert.match(reputation.title, /Reputation/, "the reputation identity must say so in its name");
  assert.doesNotMatch(reputation.title, /Payer|Autopay/, "reads as the agent that pays, which is the autopay one");

  // "Settles its owner's …" was the shared opening. Neither the claim nor the
  // capability that encodes it belongs on an identity that never moves money.
  assert.doesNotMatch(reputation.description, /\bSettles its owner/i);
  assert.ok(
    !reputation.capabilities.includes("debt_settlement"),
    "debt_settlement is the autopay agent's job, not the reputation identity's",
  );
  assert.ok(reputation.capabilities.includes("payment_reputation"));

  // And the autopay agent keeps the settling role, so this stays a real split
  // rather than a rename that quietly left both of them saying nothing.
  assert.match(autopay.description, /\bSettles its owner/i);
  assert.ok(autopay.capabilities.includes("debt_settlement"));
});

// The one-identity-per-wallet guard. An agent wallet must hold exactly one
// ERC-8004 identity; four piled up on one because a failed finalize left a real
// NFT with no recorded id, and the stale-claim takeover minted again. The
// on-chain balanceOf check that now backstops that only applies to a SELF mint —
// the registrar legitimately holds many at once while minting for browser payers
// — so this predicate decides whether the guard runs at all.
test("a wallet minting for itself is guarded; a registrar minting for others is not", () => {
  const payer = "0x734E41581EFF7C76D16C6404530638D6999E04F6";
  const registrar = "0xba867373502c82d248292287862111e835a3e801";

  // No minter named: the wallet signs its own register() — guard applies.
  assert.equal(isSelfMint(payer, undefined), true);
  // Minter IS the wallet, differing only in case. Case-sensitive comparison
  // here would skip the guard for every checksummed address and let the
  // duplicate mints straight back in.
  assert.equal(isSelfMint(payer, payer.toLowerCase()), true);
  assert.equal(isSelfMint(payer.toLowerCase(), payer), true);
  // The registrar minting on a browser payer's behalf: it already holds other
  // payers' tokens, so a balance check would refuse every mint after the first.
  assert.equal(isSelfMint(payer, registrar), false);
});

// The image URI baked into an immutable NFT. A bare ipfs:// image rendered
// nowhere: Arcscan rewrites it to dweb.link, and no public gateway can retrieve
// a Pinata pin of this size (dweb.link and ipfs.io both time out after 30s),
// while Pinata's own gateway serves it in under two seconds. So when a dedicated
// gateway is configured the URI must be an https one pointing at it — and must
// still carry the CID, or the artwork stops being content-addressed.
test("an image CID becomes an https URI on the dedicated gateway, falling back to ipfs://", () => {
  const cid = "QmQ9JoJNMctbHwkW2QGjroUnZX5syioCNQUgLPK3RmkNh6";
  const before = process.env.PINATA_GATEWAY;
  try {
    delete process.env.PINATA_GATEWAY;
    assert.equal(imageUriForCid(cid), `ipfs://${cid}`);

    process.env.PINATA_GATEWAY = "amaranth-awful-trout-784.mypinata.cloud";
    assert.equal(imageUriForCid(cid), `https://amaranth-awful-trout-784.mypinata.cloud/ipfs/${cid}`);

    // A gateway pasted from a browser carries a scheme and/or a trailing slash.
    // Left in, they mint "https://https://host//ipfs/Qm…" into an immutable
    // token — a dead image link nobody can fix without re-pointing the URI.
    for (const messy of [
      "https://amaranth-awful-trout-784.mypinata.cloud",
      "amaranth-awful-trout-784.mypinata.cloud/",
      "https://amaranth-awful-trout-784.mypinata.cloud/",
    ]) {
      process.env.PINATA_GATEWAY = messy;
      assert.equal(imageUriForCid(cid), `https://amaranth-awful-trout-784.mypinata.cloud/ipfs/${cid}`, messy);
    }
  } finally {
    if (before === undefined) delete process.env.PINATA_GATEWAY;
    else process.env.PINATA_GATEWAY = before;
  }
});

// Which service wallets get an identity of their own. The registrar's absence is
// the assertion that matters: it holds OTHER agents' NFTs in transit (register()
// mints to msg.sender, and browser payers cannot sign), so giving it one of its
// own makes "why does this wallet hold four identities?" unanswerable — which is
// the exact question a duplicate-mint bug forces you to ask.
test("the service agents registered are the auditor and validator, never the registrar", () => {
  const refIds = SERVICE_AGENTS.map((a) => a.refId);
  assert.deepEqual([...refIds].sort(), ["auditor", "reputation-validator"]);
  assert.ok(!refIds.includes("reputation-registrar" as never), "the registrar must not be given an identity");

  // Each one must name a profile that actually exists, or the mint writes
  // metadata for an agent type nobody described — permanently, since minted
  // metadata is immutable.
  for (const { refId, agentType } of SERVICE_AGENTS) {
    assert.ok(AGENT_PROFILE[agentType], `${refId} points at a missing profile`);
  }
  // Two wallets sharing an agent type would describe one of them wrongly forever.
  assert.equal(new Set(SERVICE_AGENTS.map((a) => a.agentType)).size, SERVICE_AGENTS.length);
});
