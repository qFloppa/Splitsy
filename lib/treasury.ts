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
import { bucketForProvider, counterpartyLabel, unitsToUsdc } from "./dashboard-aggregate.ts";
import type { TreasuryPlan, TreasuryPosition } from "./dashboard-types.ts";

export type TreasuryCreatedBill = {
  billId: string;
  totalOwed: bigint;
  totalPaid: bigint;
  claimed: bigint;
  dueDate: bigint; // Unix seconds; 0n = no deadline
  escrowUntilFull: boolean;
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
  // Wall-clock seconds, injected so this stays a pure function. Used to decide
  // whether an escrowed bill has passed its deadline, which is what turns a
  // short one into a failed one its payers can refund.
  nowSeconds: bigint;
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
      // Same naming rule as topCounterparties — see counterpartyLabel.
      label: counterpartyLabel(identity?.label, identity?.provider, counterparty),
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

  // claimableNow, not a raw remainder: an escrowed bill's funds are real but
  // not yet takeable, so quoting them as claimable would offer a claim that
  // reverts — and, in a settle batch, take every other leg down with it.
  const claimBills = input.created.filter((b) => claimableNow(b) > 0n);
  const claimable = claimBills.reduce((s, b) => s + claimableNow(b), 0n);

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
    // Bill-by-bill: approve + payDebt per debt, one claim per funded bill.
    grossTxCount: 2 * payLegCount + claimBills.length,
    // With registry v2's settle(): one approve, then one settle carrying every
    // claim and pay leg. Two, regardless of how many legs — and the same two
    // whether a Circle SCA or a browser EOA signs.
    batchedTxCount: 2,
  };
}

// Does this created bill have funds the splitter can take out RIGHT NOW?
//
// Mirrors BillSplitRegistry's `_isEscrowed` exactly: an escrowUntilFull bill
// withholds its funds until every participant has paid — and only that. There is
// deliberately no due-date release; past the deadline a short bill has failed
// and its payers withdraw via `refund`, so the splitter's claim never opens.
// Both settle paths must agree with the contract here — settle() is atomic, so
// putting one escrowed bill in the claim list reverts every other leg with it.
//
// Time is not an input: claimability is pure bill state now. See refundableNow
// for the payer-side mirror, which is the half that does need a clock.
export function claimableNow(bill: {
  totalOwed: bigint;
  totalPaid: bigint;
  claimed: bigint;
  escrowUntilFull: boolean;
}): bigint {
  const unclaimed = bill.totalPaid - bill.claimed;
  if (unclaimed <= 0n) return 0n;

  if (bill.escrowUntilFull && bill.totalPaid < bill.totalOwed) return 0n;

  return unclaimed;
}

// How much can THIS payer pull back out of a failed all-or-nothing bill?
//
// Mirrors BillSplitRegistry.refund's preconditions: the bill is escrowUntilFull,
// its deadline has passed, and it is still short of totalOwed. Refunds are
// all-or-nothing, so the answer is the payer's whole `myPaid` or zero. Lives
// next to claimableNow on purpose — they are the two halves of the same escrow
// rule, and split across files they would drift.
//
// `nowSeconds` is a parameter, not a clock read, so this stays testable. Callers
// pass wall-clock time; the contract compares against the block timestamp, so
// the two can disagree by a few seconds right at the deadline. That window costs
// a retry, never money.
export function refundableNow(
  bill: {
    totalOwed: bigint;
    totalPaid: bigint;
    dueDate: bigint;
    escrowUntilFull: boolean;
  },
  myPaid: bigint,
  nowSeconds: bigint,
): bigint {
  if (!bill.escrowUntilFull) return 0n;
  if (bill.totalPaid >= bill.totalOwed) return 0n;
  if (myPaid <= 0n) return 0n;

  const isDue = bill.dueDate !== 0n && nowSeconds >= bill.dueDate;
  if (!isDue) return 0n;

  return myPaid;
}

function netUnits(v: { theyOweMe: bigint; iOweThem: bigint }): bigint {
  return v.theyOweMe - v.iOweThem;
}

// Does this owed bill belong in a settle batch? Both settle paths ask — the
// Circle SCA route and the browser-EOA loop — and they must agree, because a
// mismatch means charging someone for a bill they unticked.
//
// `selected` is a whitelist of lowercase counterparty addresses, or null for
// "everything". `me` is the settling wallet: a bill I created and also owe is
// not a counterparty position (buildTreasury drops it above), so the treasury
// view never quotes it and settling must not silently pay it either.
export function shouldPayLeg(
  leg: { splitter: string; remaining: bigint },
  me: string,
  selected: Set<string> | null,
): boolean {
  if (leg.remaining <= 0n) return false;
  const splitter = leg.splitter.toLowerCase();
  if (splitter === me.toLowerCase()) return false;
  return !selected || selected.has(splitter);
}
