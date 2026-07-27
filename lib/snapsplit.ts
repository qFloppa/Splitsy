import type { IdentityProvider } from "@/lib/types";

export type BillLineItem = {
  description: string;
  quantity: number;
  amount: number;
};

export type ParsedBill = {
  merchant: string;
  currency: string;
  subtotal: number;
  tax: number;
  tip: number;
  total: number;
  lineItems: BillLineItem[];
  confidence: number;
  notes: string[];
};

export type SplitParticipant = {
  id: string;
  label: string;
  walletAddress: string;
  amountUsd: number;
  status: "draft" | "unpaid" | "bridging" | "confirmed";
  // What kind of target this row's debtor field holds: a wallet address, or an
  // identity handle (X / Discord / Email). Per-row so one bill can mix debtors
  // across platforms. Undefined defaults to "x"; wallet and email are also
  // auto-detected from the value itself.
  provider?: IdentityProvider | "wallet";
};

export const emptyParsedBill: ParsedBill = {
  merchant: "",
  currency: "USD",
  subtotal: 0,
  tax: 0,
  tip: 0,
  total: 0,
  lineItems: [],
  confidence: 0,
  notes: [],
};

export function normalizeParsedBill(input: Partial<ParsedBill>): ParsedBill {
  return {
    merchant: normalizeText(input.merchant, "Unknown merchant"),
    currency: normalizeText(input.currency, "USD").toUpperCase(),
    subtotal: normalizeMoney(input.subtotal),
    tax: normalizeMoney(input.tax),
    tip: normalizeMoney(input.tip),
    total: normalizeMoney(input.total),
    lineItems: Array.isArray(input.lineItems)
      ? input.lineItems.map((item) => ({
          description: normalizeText(item.description, "Item"),
          quantity: Number.isFinite(Number(item.quantity)) ? Number(item.quantity) : 1,
          amount: normalizeMoney(item.amount),
        }))
      : [],
    confidence: clamp(Number(input.confidence ?? 0), 0, 1),
    notes: Array.isArray(input.notes) ? input.notes.map((note) => String(note)) : [],
  };
}

// What the breakdown doesn't explain, in the bill's own currency: a discount (or
// a coupon, or a round-down) makes subtotal + tax + tip overshoot the total.
// Negative means the reverse — an unlisted charge — which is not a discount.
export function billDiscount(bill: ParsedBill) {
  return Number((bill.subtotal + bill.tax + bill.tip - bill.total).toFixed(2));
}

// Re-derive the total after a subtotal/tax/tip edit, holding the discount
// constant so an edited bill stays as discounted as the scan said it was.
// A bill whose scan gave no breakdown keeps its total untouched: there the
// total is the only figure there was, and deriving it from zeros would erase it.
export function retotalBill(previous: ParsedBill, edited: ParsedBill): ParsedBill {
  if (previous.subtotal + previous.tax + previous.tip <= 0) {
    return edited;
  }

  const discount = Math.max(0, billDiscount(previous));
  const total = edited.subtotal + edited.tax + edited.tip - discount;
  return { ...edited, total: Math.max(0, Number(total.toFixed(2))) };
}

export function equalSplit(totalUsd: number, participants: SplitParticipant[]) {
  if (participants.length === 0) {
    return [];
  }

  const cents = Math.round(totalUsd * 100);
  const base = Math.floor(cents / participants.length);
  let remainder = cents % participants.length;

  return participants.map((participant) => {
    const extra = remainder > 0 ? 1 : 0;
    remainder -= extra;

    return {
      ...participant,
      amountUsd: (base + extra) / 100,
    };
  });
}

function normalizeText(value: unknown, fallback: string) {
  const text = String(value ?? "").trim();
  return text.length > 0 ? text : fallback;
}

function normalizeMoney(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? Number(numeric.toFixed(2)) : 0;
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.min(max, Math.max(min, value));
}
