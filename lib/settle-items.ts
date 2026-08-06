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

// Sort: refund-only rows last, then dated before undated, earliest date first,
// then larger amounts first. Tuple compare keeps it readable and stable.
type SortKey = [refundLast: 0 | 1, undated: 0 | 1, due: bigint, negAmount: bigint];

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

export function buildSettleItems(input: {
  socialDebts: SocialDebt[];
  walletDebts: OwnedDebt[];
  splitterBills: OwnedDebt[];
  nowSeconds: bigint;
}): SettleItem[] {
  const { socialDebts, walletDebts, splitterBills, nowSeconds } = input;

  // Social debts carry no due date on the wire, so they sort as undated.
  const socialItems: DebtItem[] = socialDebts.map((debt) => ({
    kind: "debt-social",
    id: `social:${debt.id}`,
    sortKey: [0, 1, 0n, -BigInt(Math.round(debt.amountUsd * UNITS))],
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
      sortKey: [
        action === "refund" ? 1 : 0,
        debt.dueDate === 0n ? 1 : 0,
        debt.dueDate,
        -(action === "refund" ? refundable : debt.remaining),
      ],
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

  const rightSide: SettleItem[] = [...claimItems, ...failedItems];
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
