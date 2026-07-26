export type FxQuote = { amountUsd: number; rate: number; source: string; asOf: string };

// The FX lookup, extracted from /api/fx for the same reason as parseReceipt:
// Scout buys it over HTTP (x402), and falls back to calling it directly when the
// paid path is unavailable.
export async function quoteUsd(amount: number, fromCurrency?: string): Promise<FxQuote> {
  const source = String(fromCurrency ?? "USD").trim().toUpperCase();
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error("Amount must be a non-negative number.");
  }

  if (source === "USD") {
    return {
      amountUsd: Number(amount.toFixed(2)),
      rate: 1,
      source: "USD",
      asOf: new Date().toISOString(),
    };
  }

  const response = await fetch(`https://open.er-api.com/v6/latest/${encodeURIComponent(source)}`, {
    cache: "no-store",
  });
  const payload = await response.json();
  const rate = Number(payload?.rates?.USD);

  if (!response.ok || payload?.result !== "success" || !Number.isFinite(rate)) {
    throw new Error(`Could not convert ${source} to USD.`);
  }

  return {
    amountUsd: Number((amount * rate).toFixed(2)),
    rate,
    source,
    asOf: payload.time_last_update_utc ?? new Date().toISOString(),
  };
}
