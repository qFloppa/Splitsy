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

// One counterparty, both directions netted. `payBillIds` are the bills *I* must
// pay to discharge my side — per-bill because payDebt is escrow-bound to a
// billId; there is no on-chain way to net them away.
export type TreasuryPosition = {
  counterparty: string;      // lowercase 0x address
  label: string;             // handle if known, else the preimage label, else the address
  bucket: IdentityBucket;
  theyOweMeUsdc: string;
  iOweThemUsdc: string;
  netUsdc: string;           // positive = they owe me, negative = I owe them
  payBillIds: string[];
};

export type TreasuryPlan = {
  positions: TreasuryPosition[]; // sorted by |net| descending
  claimBillIds: string[];        // bills I created with unclaimed funds
  totalTheyOweMeUsdc: string;
  totalIOweThemUsdc: string;
  netUsdc: string;
  claimableUsdc: string;
  // Leg counts drive the transaction comparison. Settling bill-by-bill costs
  // approve + payDebt per debt (2 each) plus one claim each — that is
  // grossTxCount. What replaces it depends on who signs: a Circle SCA wallet
  // does the whole thing in ONE atomic executeBatch; a browser EOA still needs
  // one approve + one tx per leg. The UI computes that per scope from these.
  payLegCount: number;
  claimLegCount: number;
  grossTxCount: number;
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
  treasury: TreasuryPlan;
};
