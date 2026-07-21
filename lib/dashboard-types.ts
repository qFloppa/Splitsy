export type IdentityBucket = "x" | "discord" | "email" | "wallet" | "unknown";
export const IDENTITY_BUCKETS: IdentityBucket[] = ["x", "discord", "email", "wallet", "unknown"];

export type Kpis = {
  createdCount: number;
  createdTotalUsdc: string;
  claimableUsdc: string;
  owedToMeOutstandingUsdc: string;
  iOweOutstandingUsdc: string;
};

export type TimePoint = { weekStart: string; createdUsdc: string; settledUsdc: string };

export type IdentitySlice = { bucket: IdentityBucket; billCount: number; volumeUsdc: string };

export type StatusFunnel = {
  scope: "one_time" | "recurring";
  created: number; partiallyPaid: number; fullyPaid: number;
};

export type Counterparty = { label: string; bucket: IdentityBucket; volumeUsdc: string; billCount: number };

export type AgingBuckets = { d0_7Usdc: string; d8_30Usdc: string; d30plusUsdc: string };

export type ReputationTrend = { avgScore: number; count: number; lateCount: number; points: { at: string; score: number }[] };

export type RecurringHealth = {
  tabAddress: string; settlementCount: number; maxSettlements: number;
  claimableUsdc: string; shortfallCount: number;
};

export type DashboardData = {
  generatedAtSeconds: number;
  isDemo: boolean;
  kpis: Kpis;
  activity: TimePoint[];
  byIdentity: IdentitySlice[];
  status: StatusFunnel[];
  topCounterparties: Counterparty[];
  aging: AgingBuckets;
  reputation: ReputationTrend;
  recurring: RecurringHealth[];
};
