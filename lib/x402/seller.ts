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

// Fallback terms, used only if the facilitator can't be reached. 604800s (7 days)
// is Gateway's current minValiditySeconds for Arc — NOT the 345600 the SDK's own
// middleware hardcodes. The buyer signs validBefore = now + maxTimeoutSeconds, so
// anything under the facilitator's minimum is rejected as
// "authorization_validity_too_short" and no payment can ever settle.
const FALLBACK_VALIDITY_SECONDS = 604800;

// Gateway checks the validity *remaining* when it verifies, not when the buyer
// signed, so a window of exactly minValiditySeconds is already short by the time
// the request lands. Ask for an hour more than the minimum.
const VALIDITY_MARGIN_SECONDS = 3600;

type GatewayTerms = { verifyingContract: string; validitySeconds: number };

// Gateway's own terms for Arc, fetched once and cached. Preferred over constants
// because the minimum validity window is a facilitator-side policy that can move
// without a release here.
let termsPromise: Promise<GatewayTerms> | null = null;

function gatewayTerms(): Promise<GatewayTerms> {
  termsPromise ??= facilitator
    .getSupported()
    .then((supported) => {
      const kind = supported.kinds.find((k) => k.network === ARC_TESTNET_NETWORK);
      const extra = kind?.extra as
        | { verifyingContract?: string; minValiditySeconds?: number }
        | undefined;
      return {
        verifyingContract: extra?.verifyingContract ?? ARC_TESTNET_GATEWAY_WALLET,
        validitySeconds:
          (extra?.minValiditySeconds ?? FALLBACK_VALIDITY_SECONDS) + VALIDITY_MARGIN_SECONDS,
      };
    })
    .catch((error) => {
      console.error("[x402] getSupported failed, using fallback terms:", error);
      termsPromise = null; // let the next request retry
      return {
        verifyingContract: ARC_TESTNET_GATEWAY_WALLET,
        validitySeconds: FALLBACK_VALIDITY_SECONDS + VALIDITY_MARGIN_SECONDS,
      };
    });
  return termsPromise;
}

function requirementsFor(price: string, sellerAddress: string, terms: GatewayTerms) {
  return {
    scheme: "exact" as const,
    network: ARC_TESTNET_NETWORK,
    asset: ARC_TESTNET_USDC,
    amount: usdToAtomic(price),
    payTo: sellerAddress,
    maxTimeoutSeconds: terms.validitySeconds,
    // Signals Gateway batching to the buyer: the EIP-712 domain it must sign
    // against is the GatewayWallet contract, not the USDC token.
    extra: {
      name: "GatewayWalletBatched",
      version: "1",
      verifyingContract: terms.verifyingContract,
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
    const requirements = requirementsFor(price, sellerAddress, await gatewayTerms());

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
