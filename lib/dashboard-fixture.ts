// Static demo/empty-state dashboard. Powers both the `?demo=1` toggle and the
// preview shown before a wallet has any real bills. No clock, no reads — every
// value is hardcoded so the shape and story stay stable. Numbers tell a
// plausible ~few-hundred-USDC split history across all five identity buckets.
import type { DashboardData } from "./dashboard-types.ts";

// Fixed reference instant so `generatedAtSeconds` and the ISO strings below
// never drift: 2026-03-20T12:00:00Z.
const GENERATED_AT = 1_774_008_000;

export const DEMO_DASHBOARD: DashboardData = {
  generatedAtSeconds: GENERATED_AT,
  isDemo: true,
  kpis: {
    createdCount: 14,
    createdTotalUsdc: "486.5",
    claimableUsdc: "72.25",
    owedToMeOutstandingUsdc: "118.4",
    iOweOutstandingUsdc: "43.75",
  },
  // ~10 weeks, epoch-aligned Thursdays (weekStart % WEEK), created > settled.
  activity: [
    { weekStart: "2026-01-15", createdUsdc: "42", settledUsdc: "42" },
    { weekStart: "2026-01-22", createdUsdc: "68.5", settledUsdc: "60" },
    { weekStart: "2026-01-29", createdUsdc: "31", settledUsdc: "31" },
    { weekStart: "2026-02-05", createdUsdc: "54.25", settledUsdc: "40" },
    { weekStart: "2026-02-12", createdUsdc: "77", settledUsdc: "77" },
    { weekStart: "2026-02-19", createdUsdc: "38.5", settledUsdc: "22" },
    { weekStart: "2026-02-26", createdUsdc: "49", settledUsdc: "49" },
    { weekStart: "2026-03-05", createdUsdc: "62", settledUsdc: "45.5" },
    { weekStart: "2026-03-12", createdUsdc: "28", settledUsdc: "28" },
    { weekStart: "2026-03-19", createdUsdc: "36.5", settledUsdc: "18" },
  ],
  byIdentity: [
    { bucket: "x", billCount: 5, volumeUsdc: "162.5" },
    { bucket: "discord", billCount: 3, volumeUsdc: "94" },
    { bucket: "email", billCount: 4, volumeUsdc: "128.75" },
    { bucket: "wallet", billCount: 2, volumeUsdc: "71.25" },
    { bucket: "unknown", billCount: 1, volumeUsdc: "30" },
  ],
  status: [
    { scope: "one_time", created: 14, partiallyPaid: 4, fullyPaid: 8 },
    { scope: "recurring", created: 2, partiallyPaid: 1, fullyPaid: 0 },
  ],
  // Identities as their parts, the same way the live route sends them: a bare
  // handle plus its provider, so the panel tags each row and only the two
  // wallet-only rows fall back to an address.
  topCounterparties: [
    { address: "0x3f1e5d7c9b8a06f4e2d1c0b9a8f7e6d5c4b3a291", label: "@satoshi", handle: "satoshi", avatarUrl: null, bucket: "x", volumeUsdc: "88.5", billCount: 4 },
    { address: "0x8c7b6a5948372615d4c3b2a1908f7e6d5c4b3a20", label: "alice@example.com", handle: "alice@example.com", avatarUrl: null, bucket: "email", volumeUsdc: "74.25", billCount: 3 },
    { address: "0x1d2c3b4a59687706f5e4d3c2b1a09f8e7d6c5b4a", label: "vitalik", handle: "vitalik", avatarUrl: null, bucket: "discord", volumeUsdc: "61", billCount: 3 },
    { address: "0x6e5d4c3b2a19087f6e5d4c3b2a19087f6e5d4c3b", label: "@naomi", handle: "naomi", avatarUrl: null, bucket: "x", volumeUsdc: "48", billCount: 2 },
    { address: "0x9f3a0b1c2d3e4f5061728394a5b6c7d8e9f0c21b", label: "0x9f3a0b1c2d3e4f5061728394a5b6c7d8e9f0c21b", handle: null, avatarUrl: null, bucket: "wallet", volumeUsdc: "41.25", billCount: 2 },
    { address: "0x1c88f0e1d2c3b4a5968778695a4b3c2d1e0f7de0", label: "0x1c88f0e1d2c3b4a5968778695a4b3c2d1e0f7de0", handle: null, avatarUrl: null, bucket: "unknown", volumeUsdc: "30", billCount: 1 },
  ],
  aging: {
    d0_7Usdc: "52.4",
    d8_30Usdc: "44",
    d30plusUsdc: "22",
  },
  reputation: {
    avgScore: 91,
    count: 12,
    lateCount: 2,
    points: [
      { at: "2026-01-16T09:12:00Z", score: 72 },
      { at: "2026-01-24T14:05:00Z", score: 75 },
      { at: "2026-02-02T11:40:00Z", score: 78 },
      { at: "2026-02-11T18:22:00Z", score: 81 },
      { at: "2026-02-20T10:03:00Z", score: 84 },
      { at: "2026-03-01T16:47:00Z", score: 88 },
      { at: "2026-03-10T08:30:00Z", score: 90 },
      { at: "2026-03-18T13:15:00Z", score: 93 },
    ],
  },
  recurring: [
    {
      tabAddress: "0x5b7d0e2a1f4c9836ab5e0d1c2f3a4b5c6d7e8f90",
      settlementCount: 3,
      maxSettlements: 12,
      claimableUsdc: "25.5",
      shortfallCount: 0,
    },
    {
      tabAddress: "0xa1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
      settlementCount: 5,
      maxSettlements: 6,
      claimableUsdc: "48",
      shortfallCount: 1,
    },
  ],
  // Nets to -18.35: two counterparties owe me, one I owe more than they owe me.
  treasury: {
    positions: [
      {
        counterparty: "0x9f3c2b1a7d6e5048392a1b0c4d5e6f7089abcdef",
        label: "@dev",
        handle: "dev",
        avatarUrl: null,
        bucket: "x",
        theyOweMeUsdc: "0",
        iOweThemUsdc: "43.75",
        netUsdc: "-43.75",
        payBillIds: ["41", "44"],
      },
      {
        counterparty: "0x2e4f6a8c0b1d3f5709a8b7c6d5e4f3a2b1c0d9e8",
        // No "@": a Discord username doesn't carry one, which is the whole
        // reason an identity travels as its parts rather than a finished label.
        label: "carla",
        handle: "carla",
        avatarUrl: null,
        bucket: "discord",
        theyOweMeUsdc: "18.4",
        iOweThemUsdc: "0",
        netUsdc: "18.4",
        payBillIds: [],
      },
      {
        counterparty: "0x7a1b2c3d4e5f60718293a4b5c6d7e8f901234567",
        label: "sam@example.com",
        handle: "sam@example.com",
        avatarUrl: null,
        bucket: "email",
        theyOweMeUsdc: "7",
        iOweThemUsdc: "0",
        netUsdc: "7",
        payBillIds: [],
      },
    ],
    claimBillIds: ["38", "40"],
    totalTheyOweMeUsdc: "25.4",
    totalIOweThemUsdc: "43.75",
    netUsdc: "-18.35",
    claimableUsdc: "72.25",
    payLegCount: 2,
    claimLegCount: 2,
    batchedTxCount: 2,
    grossTxCount: 6, // 2 debts x (approve + payDebt) + 2 claims
  },
};
