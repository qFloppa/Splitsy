import { createSupabaseServerClient } from "./supabase.ts";
import { slotForHandle } from "./handle-slot.ts";
import type { IdentityProvider } from "./types.ts";

export type PendingWallet = {
  provider: IdentityProvider;
  handle: string;
  wallet_address: string;
  /// @dev Null for a DERIVED slot: there is no wallet behind it to sign with, so
  ///      a refund goes through the registry's attester-signed refundSlot instead.
  ///      Non-null only on a legacy pre-minted row from before the change.
  circle_wallet_id: string | null;
};

// Same normalization the debt matcher uses (lib/bills-repo.ts), so a handle
// keys identically whether it is tagged, resolved, or adopted at login.
export function normalizePendingHandle(handle: string): string {
  return handle.trim().replace(/^@/, "").toLowerCase();
}

function requireClient() {
  const client = createSupabaseServerClient();
  if (!client) throw new Error("Supabase is not configured");
  return client;
}

export async function getPendingWallet(
  provider: IdentityProvider,
  handle: string,
): Promise<PendingWallet | null> {
  const client = requireClient();
  const { data, error } = await client
    .from("pending_wallets")
    .select("provider, handle, wallet_address, circle_wallet_id")
    .eq("provider", provider)
    .eq("handle", normalizePendingHandle(handle))
    .maybeSingle();
  if (error) throw new Error(`Failed to read pending wallet: ${error.message}`);
  return (data as PendingWallet) ?? null;
}

/**
 * The SLOT belonging to a signed-in user, if one was minted before they arrived.
 *
 * A bill created while this person was a stranger names their slot as the debtor,
 * NOT the wallet they later signed in with. So every path that answers "what do I
 * owe?" has to look here as well as at `users.wallet_address`, or the debt is
 * invisible — which is exactly the bug measured on bill 64 (2026-09-15).
 *
 * A NEW BILL NEVER FILES UNDER A SLOT THIS RETURNS. Slots are derived now
 * (lib/handle-slot.ts), so the address here is a pure function of the handle and
 * no key exists for it anywhere. The `pending_wallets` read below is the UPGRADE
 * PATH, kept for people tagged before the change: their debt really is filed
 * against a pre-minted address, and this is how that debt stays visible.
 *
 * `circle_wallet_id` comes back null for a derived slot — there is no wallet to
 * sign with, which is why refunding one goes through the attester-signed
 * {BillSplitRegistry.refundSlot} rather than any wallet call.
 *
 * Null for a wallet-only session. A raw address is not a handle, so it has no
 * namespace a slot could ever be derived in.
 */
export async function getSlotWalletForUser(user: {
  provider: string | null;
  handle: string;
}): Promise<PendingWallet | null> {
  if (!user.provider || user.provider === "wallet") return null;

  // The legacy row wins when it exists: that is the address their older bills
  // actually name, and returning the derived slot instead would hide those debts.
  const preMinted = await getPendingWallet(user.provider as IdentityProvider, user.handle);
  if (preMinted) return preMinted;

  return {
    provider: user.provider as IdentityProvider,
    handle: normalizePendingHandle(user.handle),
    wallet_address: slotForHandle(user.provider as IdentityProvider, user.handle),
    circle_wallet_id: null,
  };
}

// No insert. Nothing writes to this table any more: the one caller was
// wallet-resolve.ts's pre-mint, and a slot is derived rather than stored. The
// table is now read-and-delete only — every row is a pre-change tombstone that
// leaves on its owner's first login, so it empties itself and never refills.
export async function deletePendingWallet(
  provider: IdentityProvider,
  handle: string,
): Promise<void> {
  const client = requireClient();
  const { error } = await client
    .from("pending_wallets")
    .delete()
    .eq("provider", provider)
    .eq("handle", normalizePendingHandle(handle));
  if (error) throw new Error(`Failed to delete pending wallet: ${error.message}`);
}
