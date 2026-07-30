import assert from "node:assert/strict";
import { test } from "node:test";
import { decideAutopay, type AutopayGrant, type AutopayInput } from "./autopay.ts";
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
