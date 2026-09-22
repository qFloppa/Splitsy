import { ARC } from "../arc-chain.ts";

export const ARC_NETWORK = ARC.caip2;
export const ARC_USDC = ARC.usdcAddress;
export const ARC_GATEWAY_WALLET = ARC.gatewayWallet;

// The RPC every server-side client and script here talks to.
//
// The public endpoint rate-limits: -32011 'request limit reached' surfaces as a
// failed contract READ, so it looks like a broken call rather than a quota. The
// override lives on the profile now (ARC_RPC_URL wins over
// NEXT_PUBLIC_ARC_RPC_URL, lib/arc-chain.ts), so this const no longer has its own
// opinion — it was the one place that ignored those variables, which is why the
// agent economy alone kept hitting the public node.
export const ARC_RPC = ARC.rpcUrl;
export const ARC_IDENTITY_REGISTRY = "0x8004A818BFB912233c491871b3d84c89A494BD9e" as const;

// The facilitator's own base, without the /v1 the SDK appends itself.
//
// BatchFacilitatorClient defaults to gateway-api.circle.com — MAINNET — and a
// mainnet facilitator does not know eip155:5042002, so it rejects every testnet
// payment with `unsupported_network` at verify(). That default was harmless in
// @circle-fin/x402-batching 2.x and is not in 3.x, which is the kind of silent
// move this file exists to absorb: the facilitator is per-network, like every
// address above it, so it reads off the profile rather than off the SDK.
export const GATEWAY_API_ORIGIN = new URL(ARC.gatewayApiUrl).origin;

// Circle's own record of one batched x402 payment: status, both addresses, the
// amount, and the txHash of the batch that settled it on chain. Append the id
// that settle() returned — the same string x402_payments.gateway_tx stores.
//
// Note the /x402/ segment. The plain /v1/transfers/<id> route is a DIFFERENT
// namespace (Gateway's own transfer attestations) and 404s on these ids, which
// reads as "this payment never happened" rather than "wrong endpoint".
export const GATEWAY_TRANSFER_URL = `${ARC.gatewayApiUrl}/x402/transfers/` as const;

/** "$0.005" -> "5000" (atomic 6-dp USDC string). */
export function usdToAtomic(price: string): string {
  const dollars = parseFloat(price.replace("$", ""));
  if (!Number.isFinite(dollars) || dollars < 0) throw new Error(`Invalid price: ${price}`);
  return Math.round(dollars * 1_000_000).toString();
}
