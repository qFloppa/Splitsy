import { createSupabaseServerClient } from "./supabase.ts";
import type { IdentityProvider } from "./types.ts";

export type PendingWallet = {
  provider: IdentityProvider;
  handle: string;
  wallet_address: string;
  circle_wallet_id: string;
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

export async function insertPendingWallet(row: PendingWallet): Promise<void> {
  const client = requireClient();
  const { error } = await client.from("pending_wallets").upsert(
    {
      provider: row.provider,
      handle: normalizePendingHandle(row.handle),
      wallet_address: row.wallet_address,
      circle_wallet_id: row.circle_wallet_id,
    },
    { onConflict: "provider,handle", ignoreDuplicates: true },
  );
  if (error) throw new Error(`Failed to insert pending wallet: ${error.message}`);
}

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
