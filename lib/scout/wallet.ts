import { GatewayClient } from "@circle-fin/x402-batching/client";
import { privateKeyToAccount } from "viem/accounts";

// Scout's x402 signer. A plain EOA, deliberately not a Circle DCW: it only ever
// signs EIP-3009 authorizations against its own Gateway balance, so it needs no
// custody features, and keeping it separate caps the blast radius to its deposit.
let cached: { gateway: GatewayClient; address: `0x${string}` } | null = null;

export function getScout() {
  if (cached) return cached;
  const privateKey = process.env.SCOUT_PRIVATE_KEY as `0x${string}` | undefined;
  if (!privateKey) throw new Error("Missing SCOUT_PRIVATE_KEY — run npm run scout:setup");
  cached = {
    gateway: new GatewayClient({ chain: "arcTestnet", privateKey }),
    address: privateKeyToAccount(privateKey).address,
  };
  return cached;
}

const REDEPOSIT_THRESHOLD = 500_000n; // 0.5 USDC atomic
const DEPOSIT_AMOUNT = process.env.SCOUT_DEPOSIT_AMOUNT ?? "1";

// Top the Gateway balance up when it runs low. Called best-effort before a scan;
// a failure here is not fatal — the pay attempt itself will surface the problem.
export async function ensureGatewayBalance(minAtomic: bigint = REDEPOSIT_THRESHOLD): Promise<void> {
  const { gateway } = getScout();
  const balances = await gateway.getBalances();
  if (balances.gateway.available < minAtomic) {
    await gateway.deposit(DEPOSIT_AMOUNT);
  }
}
