import { GatewayClient } from "@circle-fin/x402-batching/client";
import { privateKeyToAccount } from "viem/accounts";
import { ARC } from "../arc-chain.ts";
import { ARC_RPC } from "../x402/constants.ts";

// Scout's x402 signer. A plain EOA, deliberately not a Circle DCW: it only ever
// signs EIP-3009 authorizations against its own Gateway balance, so it needs no
// custody features, and keeping it separate caps the blast radius to its deposit.
let cached: { address: `0x${string}` } | null = null;
let cachedGateway: GatewayClient | null = null;

export function getScout() {
  if (cached) return cached;
  const privateKey = process.env.SCOUT_PRIVATE_KEY as `0x${string}` | undefined;
  if (!privateKey) throw new Error("Missing SCOUT_PRIVATE_KEY — run npm run scout:setup");
  cached = { address: privateKeyToAccount(privateKey).address };
  return cached;
}

/**
 * Scout's Gateway client. Split from getScout() for the same reason, and with
 * the same SDK gap, as getSettlerGateway() in lib/settler.ts: there is no Arc
 * mainnet chain in @circle-fin/x402-batching, so this refuses rather than
 * batching real-money nanopayments on testnet. The address alone still reads on
 * mainnet, which is all /api/scout/stats wants.
 */
export function getScoutGateway(): GatewayClient {
  if (cachedGateway) return cachedGateway;
  getScout();
  if (ARC.network === "mainnet") {
    throw new Error(
      "x402 batching has no Arc mainnet chain in @circle-fin/x402-batching — " +
        "Scout cannot scan on mainnet until the SDK ships one.",
    );
  }
  // rpcUrl or the SDK builds its own client against the public node, which
  // rate-limits: a top-up then fails on an allowance read nothing here made.
  cachedGateway = new GatewayClient({
    chain: "arcTestnet",
    privateKey: process.env.SCOUT_PRIVATE_KEY as `0x${string}`,
    rpcUrl: ARC_RPC,
  });
  return cachedGateway;
}

const REDEPOSIT_THRESHOLD = 500_000n; // 0.5 USDC atomic
const DEPOSIT_AMOUNT = process.env.SCOUT_DEPOSIT_AMOUNT ?? "1";

// Top the Gateway balance up when it runs low. Called best-effort before a scan;
// a failure here is not fatal — the pay attempt itself will surface the problem.
export async function ensureGatewayBalance(minAtomic: bigint = REDEPOSIT_THRESHOLD): Promise<void> {
  const gateway = getScoutGateway();
  const balances = await gateway.getBalances();
  if (balances.gateway.available < minAtomic) {
    await gateway.deposit(DEPOSIT_AMOUNT);
  }
}
