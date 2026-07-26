import { getScout } from "./wallet.ts";
import type { ScanDeps } from "./scan.ts";
import { parseReceipt } from "../ocr-core.ts";
import { sumSpentTodayUsd, recordPayment } from "../x402/payments-repo.ts";

export const DAILY_CAP_USD = Number(process.env.SCOUT_DAILY_CAP_USDC ?? "0.05");

// Binds Scout's decision loop to the real world: its Gateway wallet pays
// Splitsy's own paywalled endpoints over HTTP, and the ledger records the spend.
//
// `baseUrl` must be an absolute origin — Scout is a server-side HTTP client, so
// it makes a real 402 round-trip against this app rather than calling in-process.
// That round-trip is the point: it is the same path an external agent would take.
export function buildScoutDeps(baseUrl: string): ScanDeps & { address: `0x${string}` } {
  const { gateway, address } = getScout();

  return {
    address,
    dailyCapUsd: DAILY_CAP_USD,
    spentTodayUsd: sumSpentTodayUsd,
    parseDirect: (imageBase64, mimeType, hq) => parseReceipt(imageBase64, mimeType, { hq }),
    record: (direction, endpoint, amountUsd, tx, confidence) =>
      recordPayment({
        direction,
        endpoint,
        counterparty: address,
        amountUsdc: amountUsd.toString(),
        gatewayTx: tx,
        confidence,
      }),
    pay: async (path, body) => {
      const result = await gateway.pay(`${baseUrl}${path}`, { method: "POST", body });
      return {
        result: result.data,
        // Atomic USDC (6dp) -> dollars. formattedAmount is the SDK's own string
        // form of the same figure; deriving it keeps this a number for the math.
        amountUsd: Number(result.amount) / 1e6,
        tx: result.transaction || null,
      };
    },
  };
}

// The origin Scout should call itself on. NEXT_PUBLIC_BASE_URL wins so a deployed
// instance pays its public URL; otherwise fall back to the incoming request's own.
export function scoutBaseUrl(request: Request): string {
  return process.env.NEXT_PUBLIC_BASE_URL ?? new URL(request.url).origin;
}
