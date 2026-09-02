import { payViaGateway } from "@/lib/gateway-pay";
import { getOrCreateWallet } from "@/lib/wallet-provider";

export const runtime = "nodejs";

type RequestBody = {
  debtor: string;
  amount: string; // USDC units as string (6-decimal)
  sourceChain: string;
};

export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  // token is not used in the MVP path (Gateway settles without reading the bill)
  await params;

  const body = (await request.json().catch(() => ({}))) as RequestBody;

  if (!body.debtor || !body.amount || !body.sourceChain) {
    return Response.json(
      { error: "Missing debtor, amount, or sourceChain" },
      { status: 400 },
    );
  }

  // Resolve the server wallet that will fund the settlement on Arc Testnet.
  // This wallet must be pre-funded; it is the "Gateway settler" identity.
  const serverWallet = await getOrCreateWallet("splitsy", "gateway-settler");
  if (!serverWallet) {
    return Response.json(
      { error: "Circle is not configured — Gateway payments unavailable" },
      { status: 503 },
    );
  }

  const gatewayResult = await payViaGateway({
    fromWalletId: serverWallet.walletId,
    amount: BigInt(body.amount),
    recipientAddress: body.debtor,
    sourceChain: body.sourceChain,
  });

  if (!gatewayResult.success) {
    return Response.json(
      { error: gatewayResult.error ?? "Gateway payment failed" },
      { status: 500 },
    );
  }

  return Response.json({
    ok: true,
    gatewayTx: gatewayResult.transaction,
    message: "Gateway payment settled on Arc",
  });
}
