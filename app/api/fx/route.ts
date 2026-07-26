import { quoteUsd } from "@/lib/fx-core";
import { withGateway } from "@/lib/x402/seller";

export const runtime = "nodejs";

// x402-paywalled: $0.001 USDC per quote. Scout pays this when a receipt is in a
// foreign currency; the browser reaches it via /api/scout/fx, which pays on its
// behalf, so no human ever sees the 402.
const handler = async (request: Request): Promise<Response> => {
  const { amount, fromCurrency } = (await request.json()) as {
    amount?: number;
    fromCurrency?: string;
  };

  try {
    return Response.json(await quoteUsd(Number(amount), fromCurrency));
  } catch (error) {
    const message = error instanceof Error ? error.message : "FX conversion failed.";
    // A bad amount is the caller's fault; a failed upstream lookup is ours.
    const status = message.startsWith("Amount must be") ? 400 : 502;
    return Response.json({ error: message }, { status });
  }
};

export const POST = withGateway(handler, "$0.001", "/api/fx");
