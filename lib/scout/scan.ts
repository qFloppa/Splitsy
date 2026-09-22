import { assessImage, shouldPayAgain, pickBetterParse } from "./decide.ts";
import { canSpend, remainingBudget } from "../x402/spend.ts";
import { priceUsd } from "../x402/pricing.ts";
import type { ParsedBill } from "../snapsplit.ts";

// Every outside effect is injected so the decision loop — which spends real
// money — is testable without a chain, a facilitator, or a model call.
export type ScanDeps = {
  pay: (
    path: string,
    body: unknown,
  ) => Promise<{ result: Record<string, unknown>; amountUsd: number; tx: string | null }>;
  parseDirect: (imageBase64: string, mimeType: string, hq?: boolean) => Promise<ParsedBill>;
  spentTodayUsd: () => Promise<number>;
  record: (
    direction: "spent",
    endpoint: string,
    amountUsd: number,
    tx: string | null,
    confidence?: number,
  ) => Promise<void>;
  /**
   * The payment behind the most recent pay() attempt, live at the moment it
   * throws. A handler that fails still runs after verify() and settle(), so a
   * failed parse has been charged for — this is what prices it, since the
   * thrown error does not.
   *
   * Null when the attempt never reached the facilitator, which is also when
   * nothing was charged.
   */
  settledByFailedPay: () => { amountUsd: number; tx: string | null } | null;
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

  // One paid parse, from the buy to the ledger write. Every opinion Scout holds
  // — first, second, the model fallback — comes through here for a reason: the
  // payment-check header is read whether or not the handler succeeds, so a
  // failed parse has still been paid for and must land in `payments` and the
  // ledger on the failure path too. Bought outside this helper, a dead opinion
  // is a silent charge.
  const buyOpinion = async (body: Record<string, unknown>) => {
    try {
      const { result, amountUsd, tx } = await deps.pay("/api/ocr", {
        imageBase64: input.imageBase64,
        mimeType: input.mimeType,
        ...body,
      });
      // Charged, and the response carries no bill — that is a failed parse, not
      // a cheap success, and `result.bill` would throw on it anyway.
      if (!result.bill) throw new Error("The receipt scanner returned no bill data.");
      const opinion = result.bill as ParsedBill;
      spent += amountUsd;
      payments.push({ endpoint: "/api/ocr", amountUsd, tx, confidence: opinion.confidence });
      await deps.record("spent", "/api/ocr", amountUsd, tx, opinion.confidence);
      return opinion;
    } catch (error) {
      // The throw carries no amount, so the purchase is priced from what the
      // facilitator settled. It is already spent whether or not the parse
      // worked, so it counts against the cap and lands in the ledger here —
      // otherwise a paid-for error costs real money and shows up nowhere.
      const settled = deps.settledByFailedPay();
      if (settled) {
        spent += settled.amountUsd;
        payments.push({ endpoint: "/api/ocr", amountUsd: settled.amountUsd, tx: settled.tx });
        await deps.record("spent", "/api/ocr", settled.amountUsd, settled.tx);
      }
      throw error;
    }
  };

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

  let bill: ParsedBill | null = null;
  let primaryError: unknown = null;
  try {
    bill = await buyOpinion({});
  } catch (error) {
    // Could be the facilitator, Scout's balance, or the model itself. Which one
    // it was does not change what to do — buy an opinion from the other
    // family below — it only matters if everything down the line fails too.
    primaryError = error;
  }

  // Signal 4 — the model Scout defaults to is busy. A 503 is a property of the
  // MODEL, not of the endpoint: the whole gemini-3.x family answers 503 together
  // while gemini-flash-lite-latest, on the same key, is fine. Worth a second
  // purchase because a failed parse has already been paid for (see buyOpinion):
  // stopping here means the human paid for an error.
  if (!bill && canSpend(spent, OCR_PRICE, deps.dailyCapUsd)) {
    try {
      bill = await buyOpinion({
        model: process.env.SCOUT_FALLBACK_MODEL ?? "gemini-flash-lite-latest",
      });
    } catch {
      // The fallback model is down too, or the paid path is. Fall through.
    }
  }

  if (!bill) {
    // Out of paid opinions. Serve the human with the free internal parse — they
    // uploaded a receipt and must still get their split, whatever the agent
    // economy is doing.
    try {
      bill = await deps.parseDirect(input.imageBase64, input.mimeType);
    } catch (error) {
      // Everything is down. The unpaid parse's own message names why — busy
      // upstream, missing key, malformed reply — which is why it is preferred
      // over `primaryError`: a bare SDK "Payment failed: ..." would hide a
      // plain 503 behind wording that reads like a broken deployment.
      return {
        bill: null,
        declined:
          error instanceof Error
            ? error.message
            : primaryError instanceof Error
              ? primaryError.message
              : "Receipt scan failed.",
        payments,
        totalSpentUsd: totalSpent(),
        budgetRemainingUsd: budget(),
        degraded: true,
      };
    }
    return {
      bill,
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
      bill = pickBetterParse(
        bill,
        await buyOpinion({
          hq: true,
          model: process.env.SCOUT_SECOND_OPINION_MODEL ?? "gemini-3.6-flash",
        }),
      );
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
