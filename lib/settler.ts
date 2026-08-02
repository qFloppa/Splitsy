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
import { createPublicClient, createWalletClient, http, type TransactionReceipt } from "viem";
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
//
// The `settlement` tag is the discriminator, because nothing else here is one:
// a config throw carries no cause, and viem forwards the native cause on a
// failed send, so "has a cause" cannot tell an unconfirmed tx from one that
// never left. Callers switch on the tag through isIndeterminate() below and
// treat its absence as never-sent. Undefined on both never-broadcast paths is
// the safe default — it is the only answer that never invents a settlement.
// ponytail: viem re-fetches the nonce per send, so two overlapping settlements can claim the same one — wrap the account in viem's createNonceManager if deliveries ever run concurrently
export async function settlerWrite(to: `0x${string}`, data: `0x${string}`, timeout = 60_000): Promise<`0x${string}`> {
  const { account } = getSettler();
  const wallet = createWalletClient({ account, chain: arcTestnet, transport: http(ARC_TESTNET_RPC) });
  const hash = await wallet.sendTransaction({ to, data });
  let receipt: TransactionReceipt | undefined;
  try {
    // Bounded far below viem's 180s default, and tighter still for callers on a
    // platform deadline. Timing out sooner means MORE indeterminate throws,
    // which is fine: the caller accounts for one correctly, and it cannot
    // account for a request the platform killed mid-wait.
    receipt = await publicClient.waitForTransactionReceipt({ hash, timeout });
  } catch (err) {
    throw Object.assign(new Error(`settler tx indeterminate — broadcast but unconfirmed: ${hash}`, { cause: err }), {
      txHash: hash,
      settlement: "indeterminate" as const,
    });
  }
  if (receipt.status !== "success") {
    throw Object.assign(new Error(`settler tx reverted: ${hash}`), { txHash: hash, settlement: "reverted" as const });
  }
  return hash;
}

// The tag above, read as a type guard rather than as a bare string literal at
// each call site.
//
// NOT a licence to resend — nothing in this codebase retries a settlement, and
// the autopay_log claim row is what makes that structurally true. What callers
// actually need it for is ACCOUNTING: 'indeterminate' means the payFor was
// broadcast and may still mine, so the money must be counted as spent, while
// 'reverted' and an unsent tx mean it definitely was not. Those are opposite
// rows in the log, and a mistyped literal would quietly pick the wrong one and
// hand a user back a daily cap they had already spent.
export const isIndeterminate = (e: unknown): e is { txHash: `0x${string}` } =>
  (e as { settlement?: string })?.settlement === "indeterminate";

// The receipt for a transaction this process did not necessarily send — in
// practice the user's agent's createJob, whose logs carry the job id.
//
// WAITS rather than asking once. Circle reports a transaction COMPLETE from its
// own indexer's view, and this public RPC can still be a block behind it:
// getTransactionReceipt would throw TransactionReceiptNotFound for a
// transaction that is perfectly real, losing a settlement to a race the chain
// had already won. Bounded well under viem's 180s default, because the caller
// is a webhook with five more transactions still to send.
//
// A THROW HERE IS "STILL UNCONFIRMED", NEVER "DIDN'T HAPPEN" — the same reading
// settlerWrite's indeterminate tag demands, and for the same reason: resending
// on it double-settles.
export async function settlerReceipt(txHash: `0x${string}`, timeout = 30_000) {
  return publicClient.waitForTransactionReceipt({ hash: txHash, timeout });
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
