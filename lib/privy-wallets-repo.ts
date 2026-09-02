import { createSupabaseServerClient } from "./supabase.ts";

export type PrivyWalletRow = {
  namespace: string;
  key: string;
  privy_user_id: string;
  wallet_id: string;
  address: string;
};

function requireClient() {
  const client = createSupabaseServerClient();
  if (!client) throw new Error("Supabase is not configured");
  return client;
}

export async function getPrivyWallet(namespace: string, key: string): Promise<PrivyWalletRow | null> {
  const client = requireClient();
  const { data, error } = await client
    .from("privy_wallets")
    .select("namespace, key, privy_user_id, wallet_id, address")
    .eq("namespace", namespace)
    .eq("key", key)
    .maybeSingle();
  if (error) throw new Error(`Failed to read privy_wallets: ${error.message}`);
  return (data as PrivyWalletRow) ?? null;
}

// Upsert, not insert: two concurrent taggings of the same handle both reach here and
// the primary key makes the second a no-op collision instead of a duplicate wallet in
// use. Which wallet the losing CALLER then returns is decided one layer up — the
// upsert reports nothing, so lib/privy-wallet.ts re-reads the row afterwards and
// returns whatever it says.
export async function insertPrivyWallet(row: PrivyWalletRow): Promise<void> {
  const client = requireClient();
  const { error } = await client
    .from("privy_wallets")
    .upsert(row, { onConflict: "namespace,key", ignoreDuplicates: true });
  if (error) throw new Error(`Failed to save privy_wallets: ${error.message}`);
}
