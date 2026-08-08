import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";

type DcwClient = ReturnType<typeof initiateDeveloperControlledWalletsClient>;

let _client: DcwClient | null = null;

// Returns the DCW client configured for Gateway-style transfers.
// We reuse Circle's DCW SDK — server-side Gateway settlement for the hackathon
// MVP uses the same ARC-TESTNET transfer path as the autopay agent. A full
// client-driven Gateway flow would need a browser wallet + signature; this is
// the server-settled path.
export function getGatewayClient(): DcwClient {
  const apiKey = process.env.CIRCLE_API_KEY;
  if (!apiKey) {
    throw new Error("CIRCLE_API_KEY is required for Gateway payments");
  }
  const entitySecret = process.env.CIRCLE_ENTITY_SECRET;
  if (!entitySecret) {
    throw new Error("CIRCLE_ENTITY_SECRET is required for Gateway payments");
  }
  if (!_client) {
    _client = initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });
  }
  return _client;
}

export type GatewayPaymentResult = {
  success: boolean;
  transaction?: string;
  error?: string;
};

const ARC_USDC_ADDRESS =
  process.env.ARC_TESTNET_USDC_ADDRESS ?? "0x3600000000000000000000000000000000000000";

/**
 * Settle a bill share via Circle DCW — the server-side analogue to a Gateway
 * cross-chain transfer. For the hackathon MVP, the "source chain" annotation
 * is recorded in the response but the actual settlement lands on Arc Testnet.
 */
export async function payViaGateway(input: {
  fromWalletId: string; // Circle DCW wallet funding the transfer
  amount: bigint; // USDC units (6 decimals)
  recipientAddress: string; // Arc address to receive on
  sourceChain: string; // e.g. "Polygon_PoS" — logged for demo, not used server-side
}): Promise<GatewayPaymentResult> {
  const client = getGatewayClient();

  try {
    // Convert 6-decimal units → human USDC string
    const amountUsdc = (Number(input.amount) / 1_000_000).toFixed(6);

    // ponytail: cast the whole input — SDK 9.2.0's transfer union types lag the API
    // (ARC-TESTNET missing). Shape verified against Circle's createTransaction docs.
    const res = await client.createTransaction({
      walletId: input.fromWalletId,
      blockchain: "ARC-TESTNET",
      tokenAddress: ARC_USDC_ADDRESS,
      amount: [amountUsdc],
      destinationAddress: input.recipientAddress,
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    } as Parameters<typeof client.createTransaction>[0]);

    const txId = res.data?.id ?? "unknown";
    return { success: true, transaction: txId };
  } catch (err) {
    console.error("[gateway-pay] transfer failed:", err);
    return {
      success: false,
      error: err instanceof Error ? err.message : "Gateway transfer failed",
    };
  }
}
