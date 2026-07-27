import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDashboard, bucketForProvider } from "./dashboard-aggregate.ts";

test("bucketForProvider maps known providers, null/unknown -> 'unknown'", () => {
  assert.equal(bucketForProvider("x"), "x");
  assert.equal(bucketForProvider("wallet"), "wallet");
  assert.equal(bucketForProvider(null), "unknown");
  assert.equal(bucketForProvider("nonsense"), "unknown");
});

test("a bill I both created and owe is counted once in createdCount", () => {
  const both = 7n;
  const data = buildDashboard({
    nowSeconds: 1_700_000_000,
    myWallet: "0xme",
    created: [{ billId: both, totalOwed: 1_000000n, totalPaid: 0n, claimed: 0n,
      participants: [{ addr: "0xother", owed: 1_000000n, paid: 0n }],
      labels: ["@a"], providers: ["x"], createdAtSeconds: 1_699_000_000 }],
    owed: [{ billId: both, myOwed: 500000n, myPaid: 0n, createdAtSeconds: 1_699_000_000 }],
    recipientTabs: [],
    shortfallCountByTab: {},
    reputation: { avgScore: 0, count: 0, lateCount: 0, points: [] },
  });
  assert.equal(data.kpis.createdCount, 1);
});

test("KPI totals sum per-participant owed/paid as decimal USDC strings", () => {
  const data = buildDashboard({
    nowSeconds: 1_700_000_000,
    myWallet: "0xme",
    created: [{ billId: 1n, totalOwed: 3_000000n, totalPaid: 1_000000n, claimed: 0n,
      participants: [
        { addr: "0xa", owed: 2_000000n, paid: 1_000000n },
        { addr: "0xb", owed: 1_000000n, paid: 0n },
      ], labels: ["@a", "@b"], providers: ["x", "discord"], createdAtSeconds: 1_699_000_000 }],
    owed: [], recipientTabs: [], shortfallCountByTab: {},
    reputation: { avgScore: 0, count: 0, lateCount: 0, points: [] },
  });
  assert.equal(data.kpis.createdTotalUsdc, "3");
  assert.equal(data.kpis.owedToMeOutstandingUsdc, "2");  // 3 owed - 1 paid
  assert.equal(data.kpis.claimableUsdc, "1");            // totalPaid, unclaimed
});

test("byIdentity always returns all five buckets, zero-filled", () => {
  const data = buildDashboard({
    nowSeconds: 1_700_000_000, myWallet: "0xme",
    created: [], owed: [], recipientTabs: [], shortfallCountByTab: {},
    reputation: { avgScore: 0, count: 0, lateCount: 0, points: [] },
  });
  assert.equal(data.byIdentity.length, 5);
  assert.deepEqual(data.byIdentity.map((s) => s.bucket), ["x", "discord", "email", "wallet", "unknown"]);
});

test("topCounterparties keys by address, so two 'Payer 1's never merge", () => {
  const data = buildDashboard({
    nowSeconds: 1_700_000_000, myWallet: "0xme",
    created: [
      { billId: 1n, totalOwed: 3_000000n, totalPaid: 0n, claimed: 0n, participants: [
          { addr: "0xaaa", owed: 3_000000n, paid: 0n },
        ], labels: ["Payer 1"], providers: [null], createdAtSeconds: 1_699_000_000 },
      // A different person, same positional label from a different bill's form.
      { billId: 2n, totalOwed: 5_000000n, totalPaid: 0n, claimed: 0n, participants: [
          { addr: "0xbbb", owed: 5_000000n, paid: 0n },
        ], labels: ["Payer 1"], providers: [null], createdAtSeconds: 1_699_000_000 },
    ],
    owed: [], recipientTabs: [], shortfallCountByTab: {},
    reputation: { avgScore: 0, count: 0, lateCount: 0, points: [] },
  });

  assert.equal(data.topCounterparties.length, 2, "two addresses must stay two rows");
  // The positional label is dropped: an address row has no name, only an address.
  assert.deepEqual(data.topCounterparties.map((c) => c.label).sort(), ["0xaaa", "0xbbb"]);
  assert.deepEqual(data.topCounterparties.map((c) => c.volumeUsdc).sort(), ["3", "5"]);
});

test("a social label survives and still names the counterparty", () => {
  const data = buildDashboard({
    nowSeconds: 1_700_000_000, myWallet: "0xme",
    created: [
      { billId: 1n, totalOwed: 2_000000n, totalPaid: 0n, claimed: 0n, participants: [
          { addr: "0xaaa", owed: 2_000000n, paid: 0n },
        ], labels: ["@alice"], providers: ["x"], createdAtSeconds: 1_699_000_000 },
    ],
    owed: [], recipientTabs: [], shortfallCountByTab: {},
    reputation: { avgScore: 0, count: 0, lateCount: 0, points: [] },
  });

  assert.equal(data.topCounterparties[0].label, "@alice");
  assert.equal(data.topCounterparties[0].bucket, "x");
});
