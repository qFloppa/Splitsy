export const runtime = "nodejs";

export async function POST(request: Request) {
  const { amount, fromCurrency } = (await request.json()) as {
    amount?: number;
    fromCurrency?: string;
  };

  const source = String(fromCurrency ?? "USD").trim().toUpperCase();
  const numericAmount = Number(amount);

  if (!Number.isFinite(numericAmount) || numericAmount < 0) {
    return Response.json({ error: "Amount must be a non-negative number." }, { status: 400 });
  }

  if (source === "USD") {
    return Response.json({
      amountUsd: Number(numericAmount.toFixed(2)),
      rate: 1,
      source: "USD",
      asOf: new Date().toISOString(),
    });
  }

  const response = await fetch(`https://open.er-api.com/v6/latest/${encodeURIComponent(source)}`, {
    cache: "no-store",
  });
  const payload = await response.json();
  const rate = Number(payload?.rates?.USD);

  if (!response.ok || payload?.result !== "success" || !Number.isFinite(rate)) {
    return Response.json({ error: `Could not convert ${source} to USD.` }, { status: 502 });
  }

  return Response.json({
    amountUsd: Number((numericAmount * rate).toFixed(2)),
    rate,
    source,
    asOf: payload.time_last_update_utc ?? new Date().toISOString(),
  });
}
