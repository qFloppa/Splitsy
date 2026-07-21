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
  topCounterparties: [
    { label: "@satoshi", bucket: "x", volumeUsdc: "88.5", billCount: 4 },
    { label: "alice@example.com", bucket: "email", volumeUsdc: "74.25", billCount: 3 },
    { label: "vitalik#4242", bucket: "discord", volumeUsdc: "61", billCount: 3 },
    { label: "@naomi", bucket: "x", volumeUsdc: "48", billCount: 2 },
    { label: "0x9f3a…c21b", bucket: "wallet", volumeUsdc: "41.25", billCount: 2 },
    { label: "0x1c88…7de0", bucket: "unknown", volumeUsdc: "30", billCount: 1 },
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
};
