import { after } from "next/server";
import { getScout, getScoutGateway } from "./wallet.ts";
import type { ScanDeps } from "./scan.ts";
import { parseReceipt } from "../ocr-core.ts";
import { sumSpentTodayUsd, recordPayment } from "../x402/payments-repo.ts";

export const DAILY_CAP_USD = Number(process.env.SCOUT_DAILY_CAP_USDC ?? "1");

// What the most recent pay() attempt settled for, module-level because it has to
// survive the throw.
//
// It must be filled by the SDK's response hook rather than read from `pay()`'s
// return value: pay() throws BEFORE returning, so anything assigned after the
// await never runs. The hook fires on the failure path too, and carries the
// PAYMENT-RESPONSE header — the facilitator's own record of the charge — where
// pay()'s thrown error carries only the upstream's message and no amount at all.
let lastSettled: { amountUsd: number; tx: string | null } | null = null;

// Binds Scout's decision loop to the real world: its Gateway wallet pays
// Splitsy's own paywalled endpoints over HTTP, and the ledger records the spend.
//
// `baseUrl` must be an absolute origin — Scout is a server-side HTTP client, so
// it makes a real 402 round-trip against this app rather than calling in-process.
// That round-trip is the point: it is the same path an external agent would take.
export function buildScoutDeps(baseUrl: string): ScanDeps & { address: `0x${string}` } {
  const gateway = getScoutGateway();
  const { address } = getScout();

  // Registered once per client. `settleResponse` is present only if the
  // facilitator settled, which is what makes this a record of a charge rather
  // than a guess — it is read straight from the PAYMENT-RESPONSE header. A hook
  // must not throw: it runs inside pay()'s own body.
  gateway.onPaymentResponse(async (context) => {
    const transaction = context.settleResponse?.transaction;
    if (!transaction) return;
    lastSettled = {
      amountUsd: Number(context.requirements.amount) / 1e6,
      tx: transaction,
    };
  });

  return {
    address,
    dailyCapUsd: DAILY_CAP_USD,
    spentTodayUsd: sumSpentTodayUsd,
    parseDirect: (imageBase64, mimeType, hq) => parseReceipt(imageBase64, mimeType, { hq }),
    // Ledger writes happen after the response is sent. The payment has already
    // settled by this point, so making the user wait ~0.5s per write for a
    // bookkeeping round-trip buys them nothing.
    record: async (direction, endpoint, amountUsd, tx, confidence) => {
      after(() =>
        recordPayment({
          direction,
          endpoint,
          counterparty: address,
          amountUsdc: amountUsd.toString(),
          gatewayTx: tx,
          confidence,
        }),
      );
    },
    pay: async (path, body) => {
      // Cleared per attempt. Left stale, a successful pay whose *handler* then
      // failed would re-bill the previous attempt's amount against the cap.
      lastSettled = null;
      const result = await gateway.pay(`${baseUrl}${path}`, { method: "POST", body });
      return {
        // The SDK types the paid endpoint's JSON body as unknown; every caller
        // in scan.ts narrows the field it reads.
        result: result.data as Record<string, unknown>,
        // Atomic USDC (6dp) -> dollars. formattedAmount is the SDK's own string
        // form of the same figure; deriving it keeps this a number for the math.
        amountUsd: Number(result.amount) / 1e6,
        tx: result.transaction || null,
      };
    },
    // The payment behind the attempt that just threw, from the hook above.
    // `amountUsd` is exact — it is the amount the seller asked for, which is
    // what the facilitator settled — so it needs no rounding to match the `usd`
    // price the ledger stores for this endpoint.
    settledByFailedPay: () => lastSettled,
  };
}

// The origin Scout should call itself on. NEXT_PUBLIC_BASE_URL wins so a deployed
// instance pays its public URL; otherwise fall back to the incoming request's own.
export function scoutBaseUrl(request: Request): string {
  return process.env.NEXT_PUBLIC_BASE_URL ?? new URL(request.url).origin;
}
