import { BatchFacilitatorClient } from "@circle-fin/x402-batching/server";
import {
  ARC_TESTNET_NETWORK,
  ARC_TESTNET_USDC,
  ARC_TESTNET_GATEWAY_WALLET,
  usdToAtomic,
} from "./constants";
import { recordPayment } from "./payments-repo";

// Circle Gateway is the facilitator: it verifies the EIP-3009 authorization and
// batches settlement, so a $0.005 call costs the buyer no gas.
const facilitator = new BatchFacilitatorClient();

function requirementsFor(price: string, sellerAddress: string) {
  return {
    scheme: "exact" as const,
    network: ARC_TESTNET_NETWORK,
    asset: ARC_TESTNET_USDC,
    amount: usdToAtomic(price),
    payTo: sellerAddress,
    maxTimeoutSeconds: 345600,
    // Signals Gateway batching to the buyer: the EIP-712 domain it must sign
    // against is the GatewayWallet contract, not the USDC token.
    extra: {
      name: "GatewayWalletBatched",
      version: "1",
      verifyingContract: ARC_TESTNET_GATEWAY_WALLET,
    },
  };
}

// Wraps a route handler in the x402 handshake: no `payment-signature` header
// gets a 402 challenge describing what to pay; a valid one is verified and
// settled through Circle Gateway before the handler runs.
export function withGateway(
  handler: (req: Request) => Promise<Response>,
  price: string,
  endpoint: string,
) {
  return async (req: Request): Promise<Response> => {
    // Read at call time, not module load: an unset SELLER_ADDRESS must fail this
    // request, not crash the route's whole module at import.
    const sellerAddress = process.env.SELLER_ADDRESS;
    if (!sellerAddress) {
      return Response.json({ error: "Missing SELLER_ADDRESS on the server." }, { status: 500 });
    }
    const requirements = requirementsFor(price, sellerAddress);

    const signature = req.headers.get("payment-signature");
    if (!signature) {
      const challenge = {
        x402Version: 2,
        resource: {
          url: endpoint,
          description: `Paid resource (${price} USDC)`,
          mimeType: "application/json",
        },
        accepts: [requirements],
      };
      return new Response(JSON.stringify({ error: "Payment required." }), {
        status: 402,
        headers: {
          "Content-Type": "application/json",
          "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(challenge)).toString("base64"),
        },
      });
    }

    let settlement: { transaction: string; payer: string };
    try {
      const payload = JSON.parse(Buffer.from(signature, "base64").toString("utf-8"));
      const verify = await facilitator.verify(payload, requirements);
      if (!verify.isValid) {
        return Response.json(
          { error: "Payment verification failed", reason: verify.invalidReason },
          { status: 402 },
        );
      }
      const settle = await facilitator.settle(payload, requirements);
      if (!settle.success) {
        return Response.json(
          { error: "Payment settlement failed", reason: settle.errorReason },
          { status: 402 },
        );
      }
      settlement = {
        transaction: settle.transaction,
        payer: settle.payer ?? verify.payer ?? "unknown",
      };
    } catch (error) {
      return Response.json(
        {
          error: "Payment processing error",
          message: error instanceof Error ? error.message : String(error),
        },
        { status: 500 },
      );
    }

    const response = await handler(req);

    // Ledger the earning only for a 2xx: money already moved either way, but
    // recording a 502 as revenue would overstate earnings on the dashboard.
    if (response.ok) {
      await recordPayment({
        direction: "earned",
        endpoint,
        counterparty: settlement.payer,
        amountUsdc: (Number(requirements.amount) / 1e6).toString(),
        gatewayTx: settlement.transaction,
      });
    }

    response.headers.set(
      "PAYMENT-RESPONSE",
      Buffer.from(
        JSON.stringify({
          success: true,
          transaction: settlement.transaction,
          network: requirements.network,
          payer: settlement.payer,
        }),
      ).toString("base64"),
    );
    return response;
  };
}
