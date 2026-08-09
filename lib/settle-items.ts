import type { BillSplitDebt } from "./bill-split-contracts.ts";
import { refundableNow } from "./treasury.ts";

// A registry debt tagged with the wallet it belongs to. HomeClient's
// OwnedBillSplitDebt aliases this — declared here so the module stays importable
// by node:test without pulling a "use client" component into scope.
export type OwnedDebt = BillSplitDebt & { account: `0x${string}`; via: "wallet" | "social" };

// An off-chain debt tagged to a handle, as /api/bills returns it under `iOwe`.
export type SocialDebt = {
  id: string;
  amountUsd: number;
  merchant: string;
  creator: { provider?: string; handle: string; avatar_url: string | null } | null;
};

export type SettleItem =
  | { kind: "debt-social"; id: string; sortKey: SortKey; debt: SocialDebt; editable: false }
  | {
      kind: "debt-wallet";
      id: string;
      sortKey: SortKey;
      debt: OwnedDebt;
      editable: boolean;
      action: "pay" | "refund";
      refundable: bigint;
    }
  | { kind: "divider"; id: "divider"; claimCount: number; totalUsd: number }
  | { kind: "claim"; id: string; debt: OwnedDebt; editable: boolean }
  | { kind: "claim-failed"; id: string; debt: OwnedDebt }
  | { kind: "end"; id: "end" };

type DebtItem = Extract<SettleItem, { kind: "debt-social" | "debt-wallet" }>;
type ClaimItem = Extract<SettleItem, { kind: "claim" }>;
type FailedItem = Extract<SettleItem, { kind: "claim-failed" }>;

// Two sections can exist for one bill: a dual-identity user may owe the same
// bill from their browser wallet and from their Circle DCW. Keying on billId
// alone collapses them into one, which is why every per-debt map in HomeClient
// is keyed by this too.
export function settleItemId(billId: bigint, account: string): string {
  return `${billId.toString()}:${account.toLowerCase()}`;
}

// Sort: newest bill on top, older ones below — the deck reads top-down as a
// timeline, so the bill you just made is the first thing under your thumb.
// Registry ids only count up, so a higher billId IS a newer bill.
//
// Refund-only rows still sort last: money coming back is not work the deck is
// asking for. Off-chain social debts share no clock with the chain, so they keep
// the newest-first order /api/bills returns them in (stable sort) and follow the
// on-chain run. Tuple compare keeps it readable.
type SortKey = [refundLast: 0 | 1, offChain: 0 | 1, negBillId: bigint];

function compare(a: SortKey, b: SortKey): number {
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
}

const UNITS = 1_000_000; // USDC has 6 decimals
const toUsd = (units: bigint) => Number(units) / UNITS;

// Did a flow that just succeeded finish this section off? A bridge only moves
// USDC onto Arc and pays no one, and a partial payment leaves the rest owed —
// treating either as "done" dims the card and scrolls away from live work.
export function clearsSection(
  item: SettleItem | undefined,
  flow: { kind: string; amountLabel: string },
): boolean {
  if (!item || flow.kind === "bridge") return false;
  const paid = Number(flow.amountLabel);
  const outstanding =
    item.kind === "debt-social"
      ? item.debt.amountUsd
      : item.kind === "debt-wallet"
        ? toUsd(item.action === "refund" ? item.refundable : item.debt.remaining)
        : item.kind === "claim"
          ? toUsd(item.debt.claimable)
          : // divider, end and failed-claim rows carry no flow and never clear.
            Infinity;
  return Number.isFinite(paid) && paid >= outstanding;
}

// A section the user settled this session, plus the slot it occupied. The
// registry refresh drops a paid debt from the read, so without a snapshot the
// card the user just paid unmounts under their thumb — which reads as a glitch
// rather than a confirmation.
export type HeldSection = { index: number; item: SettleItem };

// Put the held cards back where they were. A held id that is still live is
// dropped: the fresh row is the truthful one, and two sections with one id would
// break the deck's key and its scroll targeting alike.
export function withHeldSections(fresh: SettleItem[], held: HeldSection[]): SettleItem[] {
  const live = new Set(fresh.map((item) => item.id));
  const ghosts = held.filter((entry) => !live.has(entry.item.id));
  if (ghosts.length === 0) return fresh;
  const out = [...fresh];
  // Ascending, so each splice lands before the next one shifts the list under it.
  for (const { index, item } of [...ghosts].sort((a, b) => a.index - b.index)) {
    out.splice(Math.min(index, out.length), 0, item);
  }
  return out;
}

export function buildSettleItems(input: {
  socialDebts: SocialDebt[];
  walletDebts: OwnedDebt[];
  splitterBills: OwnedDebt[];
  nowSeconds: bigint;
}): SettleItem[] {
  const { socialDebts, walletDebts, splitterBills, nowSeconds } = input;

  // Social debts have no bill id to rank by — they arrive newest-first from
  // /api/bills (created_at desc) and Array.sort is stable, so tying every one of
  // them on the same key preserves that order.
  const socialItems: DebtItem[] = socialDebts.map((debt) => ({
    kind: "debt-social",
    id: `social:${debt.id}`,
    sortKey: [0, 1, 0n],
    debt,
    editable: false,
  }));

  const walletItems: DebtItem[] = walletDebts.map((debt) => {
    const refundable = refundableNow(debt, debt.paid, nowSeconds);
    // Nothing left to pay: the row is only still here because a failed
    // all-or-nothing bill owes this payer their money back.
    const action = debt.remaining === 0n && refundable > 0n ? "refund" : "pay";
    return {
      kind: "debt-wallet",
      id: settleItemId(debt.billId, debt.account),
      sortKey: [action === "refund" ? 1 : 0, 0, -debt.billId],
      debt,
      // The server-signed routes read the debt from chain and ignore any client
      // amount, so only a browser-wallet row can be partially paid.
      editable: debt.via === "wallet",
      action,
      refundable,
    };
  });

  const debtItems = [...socialItems, ...walletItems].sort((a, b) => compare(a.sortKey, b.sortKey));

  const claimItems: ClaimItem[] = splitterBills
    .filter((debt) => debt.claimable > 0n)
    .map((debt) => ({
      kind: "claim",
      id: settleItemId(debt.billId, debt.account),
      debt,
      editable: debt.via === "wallet",
    }));

  // All-or-nothing bills that missed the deadline. `claimable` is 0n on these
  // forever, so without a section the creator watches them vanish with no word.
  const failedItems: FailedItem[] = splitterBills
    .filter(
      (debt) =>
        debt.escrowUntilFull && debt.totalPaid < debt.totalOwed && debt.dueDate !== 0n && nowSeconds >= debt.dueDate,
    )
    .map((debt) => ({ kind: "claim-failed", id: settleItemId(debt.billId, debt.account), debt }));

  // The claim run reads newest-first too — same rule as the debt run above.
  const rightSide: SettleItem[] = [...claimItems, ...failedItems].sort((a, b) =>
    compare([0, 0, -a.debt.billId], [0, 0, -b.debt.billId]),
  );
  const divider: SettleItem[] =
    debtItems.length > 0 && rightSide.length > 0
      ? [
          {
            kind: "divider",
            id: "divider",
            claimCount: rightSide.length,
            totalUsd: claimItems.reduce((sum, item) => sum + toUsd(item.debt.claimable), 0),
          },
        ]
      : [];

  return [...debtItems, ...divider, ...rightSide, { kind: "end", id: "end" }];
}
