import { assessImage, shouldPayAgain, pickBetterParse } from "./decide.ts";
import { canSpend, remainingBudget } from "../x402/spend.ts";
import { priceUsd } from "../x402/pricing.ts";
import type { ParsedBill } from "../snapsplit.ts";

// Every outside effect is injected so the decision loop — which spends real
// money — is testable without a chain, a facilitator, or a model call.
export type ScanDeps = {
  pay: (path: string, body: unknown) => Promise<{ result: any; amountUsd: number; tx: string | null }>;
  parseDirect: (imageBase64: string, mimeType: string, hq?: boolean) => Promise<ParsedBill>;
  spentTodayUsd: () => Promise<number>;
  record: (
    direction: "spent",
    endpoint: string,
    amountUsd: number,
    tx: string | null,
    confidence?: number,
  ) => Promise<void>;
  dailyCapUsd: number;
};

export type ScanPayment = {
  endpoint: string;
  amountUsd: number;
  tx: string | null;
  confidence?: number;
};

export type FxQuote = { amountUsd: number; rate: number; source: string; asOf: string };

export type ScanResult = {
  bill: ParsedBill | null;
  declined?: string;
  fx?: FxQuote;
  payments: ScanPayment[];
  totalSpentUsd: number;
  budgetRemainingUsd: number;
  degraded: boolean;
};

export const OCR_PRICE = priceUsd("/api/ocr");
export const FX_PRICE = priceUsd("/api/fx");

export async function runScout(
  input: {
    imageBase64: string;
    mimeType: string;
    bytes: number;
    width: number;
    height: number;
    // Leave the FX buy to a follow-up call. The browser renders the bill as soon
    // as it lands and fills the USD figure in after, instead of waiting ~3s for
    // a second paid round-trip it cannot see yet.
    skipFx?: boolean;
  },
  deps: ScanDeps,
): Promise<ScanResult> {
  const payments: ScanPayment[] = [];
  let spent = await deps.spentTodayUsd();
  const budget = () => remainingBudget(spent, deps.dailyCapUsd);
  const totalSpent = () => payments.reduce((sum, p) => sum + p.amountUsd, 0);

  // Signal 1 — image quality. An illegible photo is refused before spending
  // anything: paying to OCR noise is the one outcome with no upside.
  const quality = assessImage(input.bytes, input.width, input.height);
  if (!quality.ok) {
    return {
      bill: null,
      declined: quality.reason,
      payments,
      totalSpentUsd: 0,
      budgetRemainingUsd: budget(),
      degraded: false,
    };
  }

  // Signal 2 — budget. Out of room means degrade to the unpaid internal parse:
  // the human uploaded a receipt and must still get their split.
  if (!canSpend(spent, OCR_PRICE, deps.dailyCapUsd)) {
    const bill = await deps.parseDirect(input.imageBase64, input.mimeType).catch(() => null);
    return {
      bill,
      declined: bill ? undefined : "Scout is out of budget and the fallback scan failed.",
      payments,
      totalSpentUsd: 0,
      budgetRemainingUsd: budget(),
      degraded: true,
    };
  }

  let bill: ParsedBill;
  try {
    const first = await deps.pay("/api/ocr", {
      imageBase64: input.imageBase64,
      mimeType: input.mimeType,
    });
    bill = first.result.bill as ParsedBill;
    spent += first.amountUsd;
    payments.push({
      endpoint: "/api/ocr",
      amountUsd: first.amountUsd,
      tx: first.tx,
      confidence: bill.confidence,
    });
    await deps.record("spent", "/api/ocr", first.amountUsd, first.tx, bill.confidence);
  } catch {
    // Paid path unavailable (facilitator down, no Gateway balance) — never block
    // the human on the agent economy.
    const fallback = await deps.parseDirect(input.imageBase64, input.mimeType).catch(() => null);
    return {
      bill: fallback,
      declined: fallback ? undefined : "Receipt scan failed.",
      payments,
      totalSpentUsd: totalSpent(),
      budgetRemainingUsd: budget(),
      degraded: true,
    };
  }

  // Signal 3 — confidence. An unsure parse is worth a second, stricter opinion,
  // but only if the cap can absorb another call.
  if (shouldPayAgain(bill.confidence, canSpend(spent, OCR_PRICE, deps.dailyCapUsd))) {
    try {
      const second = await deps.pay("/api/ocr", {
        imageBase64: input.imageBase64,
        mimeType: input.mimeType,
        hq: true,
      });
      const secondBill = second.result.bill as ParsedBill;
      spent += second.amountUsd;
      payments.push({
        endpoint: "/api/ocr",
        amountUsd: second.amountUsd,
        tx: second.tx,
        confidence: secondBill.confidence,
      });
      await deps.record("spent", "/api/ocr", second.amountUsd, second.tx, secondBill.confidence);
      bill = pickBetterParse(bill, secondBill);
    } catch {
      // Keep the first parse — it is already paid for and usable.
    }
  }

  // A foreign-currency bill needs a USD figure to split on, which is the second
  // seller. Optional: without it the UI just shows the source currency.
  let fx: FxQuote | undefined;
  if (!input.skipFx && bill.currency && bill.currency !== "USD" && canSpend(spent, FX_PRICE, deps.dailyCapUsd)) {
    try {
      const quote = await deps.pay("/api/fx", { amount: bill.total, fromCurrency: bill.currency });
      spent += quote.amountUsd;
      payments.push({ endpoint: "/api/fx", amountUsd: quote.amountUsd, tx: quote.tx });
      await deps.record("spent", "/api/fx", quote.amountUsd, quote.tx);
      fx = quote.result as FxQuote;
    } catch {
      // FX is a nice-to-have; a failed quote must not lose a paid-for parse.
    }
  }

  return {
    bill,
    fx,
    payments,
    totalSpentUsd: totalSpent(),
    budgetRemainingUsd: budget(),
    degraded: false,
  };
}
