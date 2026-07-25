// Pure treasury aggregation: registry reads in, one net position per
// counterparty out. No I/O, no clock. Money math is base-unit bigint; only
// unitsToUsdc crosses the wire boundary (bigint would throw in Response.json).
//
// IMPORTANT — what "net" means here. BillSplitRegistry.payDebt credits
// msg.sender on ONE billId and claim pays only the splitter, so debts can
// neither be routed through a third party nor cancelled against each other
// on-chain. The netting below is therefore a VIEW: it tells you your true
// exposure per counterparty. The executable saving is transaction batching
// (one approve for the summed amount instead of one per bill) — which is what
// grossTxCount/payLegCount report. Do not restate it as fewer USDC moved.
import { bucketForProvider, unitsToUsdc } from "./dashboard-aggregate.ts";
import type { TreasuryPlan, TreasuryPosition } from "./dashboard-types.ts";

export type TreasuryCreatedBill = {
  billId: string;
  totalPaid: bigint;
  claimed: bigint;
  participants: { addr: string; owed: bigint; paid: bigint }[];
};

export type TreasuryOwedBill = {
  billId: string;
  splitter: string;
  myOwed: bigint;
  myPaid: bigint;
};

export type CounterpartyIdentity = { label: string; provider: string | null };

export type TreasuryInput = {
  myWallets: string[]; // every wallet the viewer controls; case-insensitive
  created: TreasuryCreatedBill[];
  owed: TreasuryOwedBill[];
  identities: Record<string, CounterpartyIdentity>; // keyed by lowercase address
};

const max0 = (v: bigint) => (v < 0n ? 0n : v);
const absBig = (v: bigint) => (v < 0n ? -v : v);

export function buildTreasury(input: TreasuryInput): TreasuryPlan {
  const mine = new Set(input.myWallets.map((w) => w.toLowerCase()));

  type Acc = { theyOweMe: bigint; iOweThem: bigint; payBillIds: string[] };
  const acc = new Map<string, Acc>();
  const slot = (addr: string): Acc => {
    const existing = acc.get(addr);
    if (existing) return existing;
    const fresh: Acc = { theyOweMe: 0n, iOweThem: 0n, payBillIds: [] };
    acc.set(addr, fresh);
    return fresh;
  };

  // Bills I created: every participant with an unpaid remainder owes me. Skip my
  // own wallets — a bill where I'm both splitter and participant is legal, and
  // "I owe myself" is not a position.
  for (const bill of input.created) {
    for (const p of bill.participants) {
      const addr = p.addr.toLowerCase();
      if (mine.has(addr)) continue;
      const outstanding = max0(p.owed - p.paid);
      if (outstanding === 0n) continue;
      slot(addr).theyOweMe += outstanding;
    }
  }

  // Bills where I'm a participant: I owe the splitter. Same self-skip.
  for (const bill of input.owed) {
    const addr = bill.splitter.toLowerCase();
    if (mine.has(addr)) continue;
    const outstanding = max0(bill.myOwed - bill.myPaid);
    if (outstanding === 0n) continue;
    const s = slot(addr);
    s.iOweThem += outstanding;
    s.payBillIds.push(bill.billId);
  }

  const positions: TreasuryPosition[] = [...acc.entries()].map(([counterparty, v]) => {
    const identity = input.identities[counterparty];
    return {
      counterparty,
      label: identity?.label ?? counterparty,
      bucket: bucketForProvider(identity?.provider),
      theyOweMeUsdc: unitsToUsdc(v.theyOweMe),
      iOweThemUsdc: unitsToUsdc(v.iOweThem),
      netUsdc: unitsToUsdc(v.theyOweMe - v.iOweThem),
      payBillIds: v.payBillIds,
    };
  });

  // Sort by |net| descending, comparing the accumulator's bigints rather than
  // the formatted strings — "1000" < "9" lexicographically. Address breaks ties
  // so the order is stable across reloads.
  positions.sort((a, b) => {
    const an = absBig(netUnits(acc.get(a.counterparty)!));
    const bn = absBig(netUnits(acc.get(b.counterparty)!));
    if (an === bn) return a.counterparty < b.counterparty ? -1 : 1;
    return bn > an ? 1 : -1;
  });

  const claimBills = input.created.filter((b) => b.totalPaid - b.claimed > 0n);
  const claimable = claimBills.reduce((s, b) => s + (b.totalPaid - b.claimed), 0n);

  const totalTheyOweMe = [...acc.values()].reduce((s, v) => s + v.theyOweMe, 0n);
  const totalIOweThem = [...acc.values()].reduce((s, v) => s + v.iOweThem, 0n);
  const payLegCount = [...acc.values()].reduce((s, v) => s + v.payBillIds.length, 0);

  return {
    positions,
    claimBillIds: claimBills.map((b) => b.billId),
    totalTheyOweMeUsdc: unitsToUsdc(totalTheyOweMe),
    totalIOweThemUsdc: unitsToUsdc(totalIOweThem),
    netUsdc: unitsToUsdc(totalTheyOweMe - totalIOweThem),
    claimableUsdc: unitsToUsdc(claimable),
    payLegCount,
    claimLegCount: claimBills.length,
    // Bill-by-bill today: approve + payDebt per debt, one claim per funded bill.
    grossTxCount: 2 * payLegCount + claimBills.length,
  };
}

function netUnits(v: { theyOweMe: bigint; iOweThem: bigint }): bigint {
  return v.theyOweMe - v.iOweThem;
}
