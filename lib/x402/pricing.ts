// The price list for Splitsy's paid endpoints — the single place to change what
// an agent pays. Both sides read from here: the seller quotes it in the 402
// challenge, and Scout uses it for budget math before deciding to call. Keeping
// them in one table stops the two from silently drifting apart, which would let
// Scout's spend gate reason about a price it no longer charges.
export const PRICES = {
  "/api/ocr": "$0.005",
  "/api/fx": "$0.001",
  // The Auditor's bill review, bought by the Settler out of its job-fee income
  // before every settlement. Priced well under the $0.01 job fee so the Settler
  // is still ahead on a job it completes.
  "/api/agents/review": "$0.002",
} as const;

export type PaidEndpoint = keyof typeof PRICES;

/** "$0.005" -> 0.005, for budget arithmetic. */
export function priceUsd(endpoint: PaidEndpoint): number {
  return parseFloat(PRICES[endpoint].replace("$", ""));
}
