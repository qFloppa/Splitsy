// The index of HandleEscrow deposits — the table is schema-escrow-deposits.sql.
//
// AN INDEX, NEVER AN AUTHORITY. The contract decides whether money may move;
// these rows only decide what is worth TRYING. A stale 'open' row costs one
// reverted release (NoSuchDeposit) and nothing else, which is why no function
// here is consulted before a transfer is allowed — only before one is attempted.
//
// It exists because Arc's public RPC refuses an eth_getLogs range wider than
// ~25k blocks, so "scan the chain for this handle's deposits" is not something a
// login request can do.
import { normalizeHandle } from "./iou.ts";
import { createSupabaseServerClient } from "./supabase.ts";

function requireClient() {
  const client = createSupabaseServerClient();
  if (!client) throw new Error("Supabase is not configured");
  return client;
}

// The handle half of a row, normalized in ONE place. lib/handle-escrow.ts hashes
// `${provider.toLowerCase()}:${normalizeHandle(handle)}` — so the row key and the
// hash the money actually sits under have to be derived the same way, or a row
// points at a deposit no signature ever names. Reader and writer both go through
// here, which is what makes "@Dani" on a bill findable as "dani" at login.
function handleKey(provider: string, handle: string) {
  return { provider: provider.toLowerCase(), handle: normalizeHandle(handle) };
}

/**
 * Record a deposit that is already on-chain.
 *
 * First write wins (on conflict do nothing), same as pending_wallets: a retried
 * request must not resurrect a row that has since been marked released. The
 * status column takes its 'open' default rather than being set here, so there is
 * one definition of what a fresh row looks like.
 */
export async function insertEscrowDeposit(row: {
  escrow_address: string;
  deposit_id: string;
  provider: string;
  handle: string;
  depositor_address: string;
  amount_usdc: string;
  tx_hash: string | null;
}): Promise<void> {
  const client = requireClient();
  const { error } = await client.from("escrow_deposits").upsert(
    {
      escrow_address: row.escrow_address.toLowerCase(),
      deposit_id: row.deposit_id,
      ...handleKey(row.provider, row.handle),
      depositor_address: row.depositor_address.toLowerCase(),
      amount_usdc: row.amount_usdc,
      tx_hash: row.tx_hash,
    },
    { onConflict: "escrow_address,deposit_id", ignoreDuplicates: true },
  );
  if (error) throw new Error(`Failed to insert escrow deposit: ${error.message}`);
}

/**
 * What is waiting for this handle, as far as we know.
 *
 * 'open' is a hint, not a permission — these are the deposits worth attempting a
 * release on. escrow_address comes back with each row because deposit ids
 * restart at 1 in every deployment, so an id alone does not name a deposit.
 */
export async function getOpenDeposits(
  provider: string,
  handle: string,
): Promise<{ escrow_address: string; deposit_id: string; amount_usdc: string }[]> {
  const client = requireClient();
  const { data, error } = await client
    .from("escrow_deposits")
    .select("escrow_address, deposit_id, amount_usdc")
    .match({ ...handleKey(provider, handle), status: "open" });
  if (error) throw new Error(`Failed to read escrow deposits: ${error.message}`);
  // PostgREST hands back numeric as a number or a string depending on the value.
  // The caller turns this into uint256 units, where a float would round, so it is
  // stringified here rather than trusted to already be one.
  return (data ?? []).map((r) => ({
    escrow_address: r.escrow_address,
    deposit_id: r.deposit_id,
    amount_usdc: String(r.amount_usdc),
  }));
}

/**
 * Mark a deposit released. Bookkeeping after the fact — the chain has already
 * moved, and matching no row is not an error: the money went either way, and all
 * a missing row costs is one wasted release attempt later.
 */
export async function markDepositReleased(
  escrowAddress: string,
  depositId: string,
  txHash: string | null,
): Promise<void> {
  const client = requireClient();
  const { error } = await client
    .from("escrow_deposits")
    .update({
      status: "released",
      release_tx_hash: txHash,
      // Server clock rather than now(): PostgREST sends this value as a literal,
      // so there is no way to ask Postgres for its own time from an update here.
      released_at: new Date().toISOString(),
    })
    .match({ escrow_address: escrowAddress.toLowerCase(), deposit_id: depositId });
  if (error) throw new Error(`Failed to mark escrow deposit released: ${error.message}`);
}
