import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildGrant,
  decideAutopay,
  defaultMoneyMode,
  settlementRowFor,
  type AutopayGrant,
  type AutopayInput,
} from "./autopay.ts";
import { billMetadataHash, type BillPreimage } from "./bill-metadata.ts";

const CREATOR = "0xAbC0000000000000000000000000000000000001";
const OTHER_CREATOR = "0xdEf0000000000000000000000000000000000002";

const preimage: BillPreimage = {
  merchant: "Tonda",
  currency: "USD",
  total: 40,
  participantLabels: ["alice", "bob"],
  receiptHash: "",
};

const GRANT: AutopayGrant = {
  enabled: true,
  maxPerBillUsdc: 50,
  maxPerDayUsdc: 200,
  trustedCreators: [],
  minCreatorScore: 0,
  requireVerifiedHash: true,
};

function input(overrides: Partial<AutopayInput> = {}): AutopayInput {
  return {
    grant: GRANT,
    remaining: 20_000_000n, // $20
    creator: CREATOR,
    creatorScore: null,
    spentTodayUsdc: 0,
    onchainMetadataHash: billMetadataHash(preimage),
    preimage,
    ...overrides,
  };
}

test("pays when the debt is under every cap and the hash verifies", () => {
  const d = decideAutopay(input());
  assert.equal(d.pay, true);
  assert.equal(d.amount, 20_000_000n);
  assert.equal(d.reason, "ok");
});

test("always pays the full remaining share — partial autopay is not a thing", () => {
  const d = decideAutopay(input({ remaining: 7_250_000n }));
  assert.equal(d.pay, true);
  assert.equal(d.amount, 7_250_000n);
});

test("skips a bill over the per-bill cap", () => {
  const d = decideAutopay(input({ remaining: 400_000_000n }));
  assert.equal(d.pay, false);
  assert.equal(d.reason, "over_bill_cap");
  assert.equal(d.amount, 0n);
});

test("skips when the payment would breach the rolling daily cap", () => {
  const d = decideAutopay(input({ spentTodayUsdc: 190 }));
  assert.equal(d.pay, false);
  assert.equal(d.reason, "over_daily_cap");
});

test("pays when the payment exactly reaches the daily cap", () => {
  const d = decideAutopay(input({ spentTodayUsdc: 180 }));
  assert.equal(d.pay, true);
});

test("skips a creator absent from a non-empty allowlist", () => {
  const d = decideAutopay(input({ grant: { ...GRANT, trustedCreators: [OTHER_CREATOR.toLowerCase()] } }));
  assert.equal(d.pay, false);
  assert.equal(d.reason, "untrusted_creator");
});

test("an empty allowlist means anyone, not nobody", () => {
  const d = decideAutopay(input({ grant: { ...GRANT, trustedCreators: [] } }));
  assert.equal(d.pay, true);
});

test("matches the allowlist case-insensitively", () => {
  const d = decideAutopay(input({ grant: { ...GRANT, trustedCreators: [CREATOR.toUpperCase()] } }));
  assert.equal(d.pay, true);
});

test("skips a creator whose score is below the floor", () => {
  const d = decideAutopay(input({ grant: { ...GRANT, minCreatorScore: 80 }, creatorScore: 60 }));
  assert.equal(d.pay, false);
  assert.equal(d.reason, "low_creator_score");
});

// The one rule that fails open, deliberately: refusing every first-time creator
// forever is worse than paying one, and it matches the existing reputation
// consent policy where "no history" renders neutral rather than bad.
test("pays a creator with no score yet even when a floor is set", () => {
  const d = decideAutopay(input({ grant: { ...GRANT, minCreatorScore: 90 }, creatorScore: null }));
  assert.equal(d.pay, true);
  assert.equal(d.reason, "ok");
});

test("skips when the recomputed hash does not match the chain", () => {
  const d = decideAutopay(input({ onchainMetadataHash: ("0x" + "11".repeat(32)) as `0x${string}` }));
  assert.equal(d.pay, false);
  assert.equal(d.reason, "hash_mismatch");
});

// Fail closed: no preimage means we cannot tell what we are paying for.
test("skips when no preimage was published at all", () => {
  const d = decideAutopay(input({ preimage: null }));
  assert.equal(d.pay, false);
  assert.equal(d.reason, "unverifiable");
});

test("pays an unverifiable bill only when the user turned the check off", () => {
  const d = decideAutopay(input({ preimage: null, grant: { ...GRANT, requireVerifiedHash: false } }));
  assert.equal(d.pay, true);
});

test("skips when the grant is disabled", () => {
  const d = decideAutopay(input({ grant: { ...GRANT, enabled: false } }));
  assert.equal(d.pay, false);
  assert.equal(d.reason, "disabled");
});

test("skips when there is no grant at all", () => {
  const d = decideAutopay(input({ grant: null }));
  assert.equal(d.pay, false);
  assert.equal(d.reason, "disabled");
});

test("skips a debt that is already settled", () => {
  const d = decideAutopay(input({ remaining: 0n }));
  assert.equal(d.pay, false);
  assert.equal(d.reason, "nothing_owed");
});

// A zero cap is "off", not "unlimited" — the opposite reading would let a blank
// settings row drain a wallet.
test("a zero per-bill cap blocks everything", () => {
  const d = decideAutopay(input({ grant: { ...GRANT, maxPerBillUsdc: 0 } }));
  assert.equal(d.pay, false);
  assert.equal(d.reason, "over_bill_cap");
});

test("a zero daily cap blocks everything", () => {
  const d = decideAutopay(input({ grant: { ...GRANT, maxPerDayUsdc: 0 } }));
  assert.equal(d.pay, false);
  assert.equal(d.reason, "over_daily_cap");
});

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

// The mirror is the only home of the hash rule, so it has to be readable in both
// directions. Asserting only the `true` case would pass just as happily against
// an implementation that hardcoded `true` and never looked at the row — and a
// user who switched verification off would keep getting `unverifiable` skips.
test("buildGrant reads requireVerifiedHash from the mirror rather than assuming it", () => {
  const grant = buildGrant("funded", MANDATE, { ...MIRROR, requireVerifiedHash: false });
  assert.ok(grant);
  assert.equal(grant.requireVerifiedHash, false);
});

// Deliberate, not an oversight: in mandate mode the contract is the authority, so
// the mirror's on/off switch is not consulted and revoking means revoking the
// mandate. This pins the semantic that app/api/agents/autopay/route.ts already
// ships — it sets `enabled: true` whenever the mandate is this agent's, and uses
// the row only for the two rules a contract cannot evaluate.
test("buildGrant('mandate') ignores the mirror's enabled flag — the chain is the authority", () => {
  assert.ok(buildGrant("mandate", MANDATE, { ...MIRROR, enabled: false }));
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

// --- settlementRowFor -------------------------------------------------------
// The failure-accounting fork. These exist because getting it wrong is an
// overspend, not a cosmetic log bug: sumAutopaySpentTodayUsdc only sums rows
// with decision='pay', and in Funded mode that sum IS the daily cap.

const MOVED = { settlementTx: "0xfeed", broadcast: true, jobId: "12345" };
const BROADCAST = { settlementTx: null, broadcast: true, jobId: "12345" };
const NOTHING = { settlementTx: null, broadcast: false, jobId: null };

test("a settlement that landed is logged as a spend even though the ceremony broke", () => {
  const row = settlementRowFor(MOVED, "job", 8);
  assert.equal(row.decision, "pay", "a zero-amount skip here refunds the day's cap for money that moved");
  assert.equal(row.amountUsdc, 8);
  assert.equal(row.txHash, "0xfeed", "the hash is the evidence the debt is settled");
  assert.equal(row.jobStatus, "settled_incomplete");
  assert.equal(row.reason, "job_failed");
});

// Replaces a "two 8 USDC settlements total 16" test that called settlementRowFor
// with the same arguments as the test above and summed the results — it could
// not fail unless that one did. The arithmetic was never the risk; MIXING the
// three branches is, because only two of them may be charged.
test("the exact overspend: only the branches that moved money are charged to the day", () => {
  // Bill A settles and complete() reverts; bill B is broadcast but never
  // confirms; bill C breaks before step 4. sumAutopaySpentTodayUsdc counts
  // decision='pay' rows only, so A and B must land in the sum against a 10 USDC
  // cap and C must not — charging C would refuse the user's next real bill.
  const rows = [
    settlementRowFor(MOVED, "job", 8),
    settlementRowFor(BROADCAST, "other", 8),
    settlementRowFor(NOTHING, "job", 8),
  ];
  const countedByTheCap = rows.filter((r) => r.decision === "pay").reduce((sum, r) => sum + r.amountUsdc, 0);
  assert.equal(countedByTheCap, 16, "a broadcast settlement counts and a never-sent one does not");
});

// A settled_incomplete row names a job an operator has to complete or expire by
// hand, so dropping the id turns an actionable row into a problem nobody can
// find. Asserted on every branch because the failure rows are exactly the ones
// that carry it.
test("every failure row carries the job it left behind", () => {
  assert.equal(settlementRowFor(MOVED, "job", 8).jobId, "12345");
  assert.equal(settlementRowFor(BROADCAST, "other", 8).jobId, "12345");
  // Null rather than absent: the ceremony broke before createJob returned an id,
  // so there is genuinely no job to point at.
  assert.equal(settlementRowFor(NOTHING, "job", 8).jobId, null);
});

test("a broadcast-but-unconfirmed settlement counts as spent, and says so", () => {
  const row = settlementRowFor(BROADCAST, "other", 8);
  assert.equal(row.decision, "pay", "it may still mine — the cap must fail closed");
  assert.equal(row.amountUsdc, 8);
  assert.equal(row.txHash, null, "no hash to record, which is what a sweep looks for");
  assert.equal(row.jobStatus, "settlement_unconfirmed");
});

test("a ceremony that broke before the money moved is a real skip", () => {
  const row = settlementRowFor(NOTHING, "job", 8);
  assert.equal(row.decision, "skip");
  assert.equal(row.amountUsdc, 0, "nothing moved, so nothing may be charged against the cap");
  assert.equal(row.txHash, null);
  assert.equal(row.jobStatus, "failed");
});

test("each failure kind keeps its own slug, so the user is told what to fix", () => {
  assert.equal(settlementRowFor(NOTHING, "insufficient_funds", 8).reason, "agent_unfunded");
  assert.equal(settlementRowFor(NOTHING, "wallet_unavailable", 8).reason, "agent_wallet_unavailable");
  assert.equal(settlementRowFor(NOTHING, "job", 8).reason, "job_failed");
  assert.equal(settlementRowFor(NOTHING, "other", 8).reason, "tx_failed");
});

// --- defaultMoneyMode --------------------------------------------------------
// Which mode a deployment falls back to, per wallet stack. Both directions are
// asserted because each one is a different failure: 'mandate' on privy arms
// nothing and silently disables autopay, and 'funded' on circle would drop the
// Circle stack out of the mode its contract enforces.

test("the privy stack defaults to funded, because its EOAs cannot batch", () => {
  assert.equal(defaultMoneyMode("privy"), "funded");
});

test("the circle stack still defaults to mandate, the mode the chain enforces", () => {
  assert.equal(defaultMoneyMode("circle"), "mandate");
});
