// Pure aggregation core for the analytics dashboard: raw chain/DB reads in,
// DashboardData out. No I/O, no clock (nowSeconds is passed in), no Date.now().
// All USDC math happens here in 6-dp base-unit bigints; decimal strings leave
// through unitsToUsdc at the boundary. Tested by dashboard-aggregate.test.ts.
import {
  IDENTITY_BUCKETS,
  type AgingBuckets,
  type Counterparty,
  type DashboardData,
  type IdentityBucket,
  type IdentitySlice,
  type StatusFunnel,
  type TimePoint,
} from "./dashboard-types.ts";

const USDC = 1_000_000n;
const DAY = 86_400;
const WEEK = 7 * DAY;

export function unitsToUsdc(v: bigint): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const whole = a / USDC;
  const frac = a % USDC;
  const fracStr = frac === 0n ? "" : "." + frac.toString().padStart(6, "0").replace(/0+$/, "");
  return (neg ? "-" : "") + whole.toString() + fracStr;
}

export function bucketForProvider(p: string | null | undefined): IdentityBucket {
  return (IDENTITY_BUCKETS as string[]).includes(p ?? "") ? (p as IdentityBucket) : "unknown";
}

export type CreatedBill = {
  // `claimed` is a uint256 base-unit AMOUNT already withdrawn by the creator,
  // NOT a boolean. claimable = totalPaid - claimed.
  billId: bigint;
  totalOwed: bigint;
  totalPaid: bigint;
  claimed: bigint;
  participants: { addr: string; owed: bigint; paid: bigint }[];
  labels: string[];
  providers: (string | null)[];
  createdAtSeconds: number; // 0 = unknown (no preimage row)
};

export type OwedBill = { billId: bigint; myOwed: bigint; myPaid: bigint; createdAtSeconds: number };

export type DashboardInput = {
  nowSeconds: number;
  myWallet: string;
  created: CreatedBill[];
  owed: OwedBill[];
  recipientTabs: { address: string; claimable: bigint; settlementCount: bigint; maxSettlements: bigint }[];
  shortfallCountByTab: Record<string, number>;
  reputation: { avgScore: number; count: number; lateCount: number; points: { at: string; score: number }[] };
};

const max0 = (v: bigint) => (v < 0n ? 0n : v);

export function buildDashboard(input: DashboardInput): DashboardData {
  const { created, owed, recipientTabs, nowSeconds } = input;

  // KPIs. Dedupe rule: a bill where I am both splitter and participant appears
  // in BOTH id lists; created-derived figures use ONLY `created`, iOwe figures
  // use ONLY `owed` — they never cross-add, so nothing is double-counted.
  const createdTotal = created.reduce((s, b) => s + b.totalOwed, 0n);
  const claimable = created.reduce((s, b) => s + max0(b.totalPaid - b.claimed), 0n);
  const owedToMeOutstanding = created.reduce(
    (s, b) => s + b.participants.reduce((t, p) => t + max0(p.owed - p.paid), 0n),
    0n,
  );
  const iOweOutstanding = owed.reduce((s, b) => s + max0(b.myOwed - b.myPaid), 0n);

  // Identity buckets: always all five, zero-filled, in fixed order. providers[]
  // may be SHORTER than participants[] (pre-migration preimages return []) —
  // index defensively; missing entries land in 'unknown'.
  const identity = new Map<IdentityBucket, { billCount: number; volume: bigint }>(
    IDENTITY_BUCKETS.map((b) => [b, { billCount: 0, volume: 0n }]),
  );
  for (const bill of created) {
    const seen = new Set<IdentityBucket>();
    bill.participants.forEach((p, i) => {
      const bucket = bucketForProvider(bill.providers[i]);
      const slot = identity.get(bucket)!;
      slot.volume += p.owed;
      if (!seen.has(bucket)) {
        slot.billCount += 1;
        seen.add(bucket);
      }
    });
  }
  const byIdentity: IdentitySlice[] = IDENTITY_BUCKETS.map((bucket) => {
    const { billCount, volume } = identity.get(bucket)!;
    return { bucket, billCount, volumeUsdc: unitsToUsdc(volume) };
  });

  // Activity: epoch-aligned 7-day buckets keyed by the bill's creation time.
  // settledUsdc is what has been paid to date on bills created that week (the
  // chain records no per-payment timestamp to bucket by). createdAtSeconds=0
  // (no preimage) is excluded — unknown time can't be plotted honestly.
  const weeks = new Map<number, { created: bigint; settled: bigint }>();
  for (const bill of created) {
    if (bill.createdAtSeconds <= 0) continue;
    const weekStart = bill.createdAtSeconds - (bill.createdAtSeconds % WEEK);
    const slot = weeks.get(weekStart) ?? { created: 0n, settled: 0n };
    slot.created += bill.totalOwed;
    slot.settled += bill.totalPaid;
    weeks.set(weekStart, slot);
  }
  const activity: TimePoint[] = [...weeks.entries()]
    .sort(([a], [b]) => a - b)
    .map(([weekStart, v]) => ({
      weekStart: new Date(weekStart * 1000).toISOString().slice(0, 10),
      createdUsdc: unitsToUsdc(v.created),
      settledUsdc: unitsToUsdc(v.settled),
    }));

  // Status funnel: one_time from registry bills, recurring from tab cycles.
  const oneTime: StatusFunnel = { scope: "one_time", created: created.length, partiallyPaid: 0, fullyPaid: 0 };
  for (const b of created) {
    if (b.totalOwed > 0n && b.totalPaid >= b.totalOwed) oneTime.fullyPaid += 1;
    else if (b.totalPaid > 0n) oneTime.partiallyPaid += 1;
  }
  const recurringFunnel: StatusFunnel = {
    scope: "recurring",
    created: recipientTabs.length,
    partiallyPaid: 0,
    fullyPaid: 0,
  };
  for (const t of recipientTabs) {
    if (t.maxSettlements > 0n && t.settlementCount >= t.maxSettlements) recurringFunnel.fullyPaid += 1;
    else if (t.settlementCount > 0n) recurringFunnel.partiallyPaid += 1;
  }

  // Top counterparties by billed volume; label falls back to the address when
  // a preimage (and so its labels) is missing.
  const parties = new Map<string, { bucket: IdentityBucket; volume: bigint; billCount: number }>();
  for (const bill of created) {
    bill.participants.forEach((p, i) => {
      const label = bill.labels[i] ?? p.addr;
      const slot = parties.get(label) ?? { bucket: bucketForProvider(bill.providers[i]), volume: 0n, billCount: 0 };
      slot.volume += p.owed;
      slot.billCount += 1;
      parties.set(label, slot);
    });
  }
  const topCounterparties: Counterparty[] = [...parties.entries()]
    .sort(([, a], [, b]) => (b.volume > a.volume ? 1 : b.volume < a.volume ? -1 : 0))
    .slice(0, 8)
    .map(([label, v]) => ({ label, bucket: v.bucket, volumeUsdc: unitsToUsdc(v.volume), billCount: v.billCount }));

  // Aging of outstanding creator-side debt. Unknown creation time (0) is
  // treated as oldest — it can only understate freshness, never overstate it.
  let d0_7 = 0n, d8_30 = 0n, d30plus = 0n;
  for (const bill of created) {
    for (const p of bill.participants) {
      const outstanding = max0(p.owed - p.paid);
      if (outstanding === 0n) continue;
      const age = bill.createdAtSeconds > 0 ? nowSeconds - bill.createdAtSeconds : Infinity;
      if (age <= 7 * DAY) d0_7 += outstanding;
      else if (age <= 30 * DAY) d8_30 += outstanding;
      else d30plus += outstanding;
    }
  }
  const aging: AgingBuckets = {
    d0_7Usdc: unitsToUsdc(d0_7),
    d8_30Usdc: unitsToUsdc(d8_30),
    d30plusUsdc: unitsToUsdc(d30plus),
  };

  return {
    generatedAtSeconds: nowSeconds,
    isDemo: false,
    kpis: {
      createdCount: created.length,
      createdTotalUsdc: unitsToUsdc(createdTotal),
      claimableUsdc: unitsToUsdc(claimable),
      owedToMeOutstandingUsdc: unitsToUsdc(owedToMeOutstanding),
      iOweOutstandingUsdc: unitsToUsdc(iOweOutstanding),
    },
    activity,
    byIdentity,
    status: [oneTime, recurringFunnel],
    topCounterparties,
    aging,
    reputation: input.reputation,
    recurring: recipientTabs.map((t) => ({
      tabAddress: t.address,
      settlementCount: Number(t.settlementCount),
      maxSettlements: Number(t.maxSettlements),
      claimableUsdc: unitsToUsdc(t.claimable),
      shortfallCount: input.shortfallCountByTab[t.address] ?? 0,
    })),
  };
}
