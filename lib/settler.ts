// The Splitsy Settler: provider on every ERC-8183 job, signer of the settlement
// in Mandate mode, and the buyer of every bill review over x402.
//
// A raw EOA, deliberately not a Circle DCW, for one reason: x402 needs a raw
// key to sign the EIP-3009/EIP-712 authorization, and a DCW will not hand one
// over. One key therefore signs both halves of this agent's life — its contract
// writes through viem, its nanopayments through Gateway. Same precedent, same
// blast-radius argument as lib/scout/wallet.ts.
//
// It earns: the job fee lands here when the Auditor completes a job, and the
// review it buys is paid out of that income.
import { GatewayClient } from "@circle-fin/x402-batching/client";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";
import { ARC_TESTNET_RPC } from "./x402/constants.ts";

// The cache outlives any change to SETTLER_PRIVATE_KEY: once built it is never
// invalidated, so a process that rotates the key mid-life keeps the old account.
// Fine for a server that reads its key once at boot; a test toggling the env var
// must not expect getSettler() to follow it.
let cached: { account: ReturnType<typeof privateKeyToAccount>; gateway: GatewayClient; address: `0x${string}` } | null =
  null;

// Read at call time, never at module load: an unset key must fail the one
// request that needs it, not crash every route that imports this file.
export function isSettlerConfigured() {
  return /^0x[0-9a-fA-F]{64}$/.test(process.env.SETTLER_PRIVATE_KEY ?? "");
}

export function getSettler() {
  if (cached) return cached;
  // Gate on the same predicate the rest of the app asks, not on truthiness: a
  // truncated or garbage key would otherwise sail past here and die as a raw
  // viem error inside privateKeyToAccount — or inside the GatewayClient
  // constructor, which parses the key too — never as the message below.
  if (!isSettlerConfigured()) {
    throw new Error("Missing or malformed SETTLER_PRIVATE_KEY — run npm run settler:setup");
  }
  const privateKey = process.env.SETTLER_PRIVATE_KEY as `0x${string}`;
  const account = privateKeyToAccount(privateKey);
  cached = { account, gateway: new GatewayClient({ chain: "arcTestnet", privateKey }), address: account.address };
  return cached;
}

const publicClient = createPublicClient({ chain: arcTestnet, transport: http(ARC_TESTNET_RPC) });

// One contract write, waited to a receipt. Throws on revert rather than
// returning a hash the caller would go on to treat as a settlement — an
// unchecked receipt is how a "paid" row gets written for money that never moved.
//
// A THROW HERE MEANS INDETERMINATE, NOT "DIDN'T HAPPEN". Once sendTransaction
// returns, the tx is broadcast and may still mine no matter what happens next;
// a wait that times out or an RPC that blips proves nothing about the money.
// So every throw past the send carries the hash: a caller must resolve it with
// settlerReceipt() before retrying, because a blind retry double-settles.
// Only a throw from the send itself means nothing was broadcast.
// ponytail: viem re-fetches the nonce per send, so two overlapping settlements can claim the same one — wrap the account in viem's createNonceManager if deliveries ever run concurrently
export async function settlerWrite(to: `0x${string}`, data: `0x${string}`): Promise<`0x${string}`> {
  const { account } = getSettler();
  const wallet = createWalletClient({ account, chain: arcTestnet, transport: http(ARC_TESTNET_RPC) });
  const hash = await wallet.sendTransaction({ to, data });
  let receipt;
  try {
    receipt = await publicClient.waitForTransactionReceipt({ hash });
  } catch (err) {
    throw new Error(`settler tx indeterminate — broadcast but unconfirmed: ${hash}`, { cause: err });
  }
  if (receipt.status !== "success") throw new Error(`settler tx reverted: ${hash}`);
  return hash;
}

export async function settlerReceipt(txHash: `0x${string}`) {
  return publicClient.getTransactionReceipt({ hash: txHash });
}

const REDEPOSIT_THRESHOLD = 100_000n; // 0.1 USDC atomic — 50 reviews at $0.002
const DEPOSIT_AMOUNT = process.env.SETTLER_DEPOSIT_AMOUNT ?? "0.5";

// Top the Gateway balance up when it runs low. Best-effort, exactly like
// Scout's: a failure here is not fatal, because the pay attempt itself will
// surface the problem — and a Settler that cannot buy a review settles nothing.
//
// The swallow is here rather than left to callers so "not fatal" is a property
// of this function instead of a promise every caller has to remember to keep.
// It is warned, never silent: a failed top-up is the root cause a later "pay
// declined" would otherwise hide.
export async function ensureSettlerGatewayBalance(minAtomic: bigint = REDEPOSIT_THRESHOLD): Promise<void> {
  try {
    const { gateway } = getSettler();
    const balances = await gateway.getBalances();
    if (balances.gateway.available < minAtomic) {
      await gateway.deposit(DEPOSIT_AMOUNT);
    }
  } catch (err) {
    console.warn("settler: Gateway top-up failed —", err instanceof Error ? err.message : err);
  }
}
