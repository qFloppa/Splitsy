import { createSupabaseServerClient } from "./supabase.ts";
import type { AccountProvider, AppUser } from "./types.ts";

export type ProviderProfileInput = {
  provider: AccountProvider;
  providerUserId: string;
  handle: string;
  name: string | null;
  avatarUrl: string | null;
};

function requireClient() {
  const client = createSupabaseServerClient();
  if (!client) {
    throw new Error("Supabase is not configured");
  }
  return client;
}

// Insert or update a user by (provider, provider_user_id). Works for any
// sign-in provider (X, Discord, …).
export async function upsertUserFromProvider(profile: ProviderProfileInput): Promise<AppUser> {
  const client = requireClient();
  const { data, error } = await client
    .from("users")
    .upsert(
      {
        provider: profile.provider,
        provider_user_id: profile.providerUserId,
        handle: profile.handle,
        name: profile.name,
        avatar_url: profile.avatarUrl,
      },
      { onConflict: "provider,provider_user_id" },
    )
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to upsert user: ${error.message}`);
  }
  return data as AppUser;
}

export async function setUserWallet(id: string, walletAddress: string, circleWalletId: string): Promise<void> {
  const client = requireClient();
  const { error } = await client
    .from("users")
    .update({ wallet_address: walletAddress, circle_wallet_id: circleWalletId })
    .eq("id", id);
  if (error) {
    throw new Error(`Failed to set wallet: ${error.message}`);
  }
}

// The account's agent wallet, cached so it is not re-derived from Circle on
// every request. One per ACCOUNT, never per wallet: a user who signs in
// socially AND links a browser wallet has one agent covering both.
//
// NULLS CLEAR IT, and that is a real operation rather than a defensive overload:
// unlinking a browser wallet whose own account donated this agent has to give it
// back (POST/DELETE /api/agents/link). Clearing is all that takes — the next read
// re-derives this account's own agent from its unchanged refId.
export async function setUserAgentWallet(
  id: string,
  address: string | null,
  walletId: string | null,
): Promise<void> {
  const client = requireClient();
  const { error } = await client
    .from("users")
    .update({ agent_wallet_address: address?.toLowerCase() ?? null, agent_wallet_id: walletId })
    .eq("id", id);
  if (error) {
    throw new Error(`Failed to save agent wallet: ${error.message}`);
  }
}

export async function setUserPin(id: string, pinHash: string): Promise<void> {
  const client = requireClient();
  const { error } = await client.from("users").update({ pin_hash: pinHash }).eq("id", id);
  if (error) {
    throw new Error(`Failed to set PIN: ${error.message}`);
  }
}

// Find a user by (provider, handle) — handle normalized like bills-repo. Used by
// address resolution to reuse an existing person's wallet before pre-minting.
export async function getUserByProviderHandle(
  provider: AccountProvider,
  handle: string,
): Promise<AppUser | null> {
  const client = requireClient();
  const { data, error } = await client
    .from("users")
    .select()
    .eq("provider", provider)
    .eq("handle", handle.replace(/^@/, "").toLowerCase())
    .maybeSingle();
  if (error) throw new Error(`Failed to read user by handle: ${error.message}`);
  return (data as AppUser) ?? null;
}

export async function getUserById(id: string): Promise<AppUser | null> {
  const client = requireClient();
  const { data, error } = await client.from("users").select().eq("id", id).maybeSingle();
  if (error) {
    throw new Error(`Failed to read user: ${error.message}`);
  }
  return (data as AppUser) ?? null;
}

// Reverse lookup: wallet address -> the social identity that owns it. The
// registry only records addresses, so the treasury view needs this to show
// "@alice" instead of 0xab…12. One query, Map keyed lowercase. Wallets with no
// row (non-custodial users) are simply absent — callers fall back to the address.
export async function getUsersByWallets(
  addresses: string[],
): Promise<Map<string, { id: string; handle: string; provider: AccountProvider }>> {
  const result = new Map<string, { id: string; handle: string; provider: AccountProvider }>();
  const wanted = [...new Set(addresses.map((a) => a.toLowerCase()))].filter(Boolean);
  if (wanted.length === 0) return result;

  const client = createSupabaseServerClient();
  if (!client) return result;

  // Lowercase .in() is safe: every wallet_address originates from Circle DCW
  // (getOrCreateArcWallet -> setUserWallet, directly or via pending_wallets),
  // which returns lowercase hex — verified against all existing rows.
  const { data, error } = await client
    .from("users")
    .select("id, wallet_address, handle, provider")
    .in("wallet_address", wanted);
  // Display-only enrichment: a failure degrades to addresses, never breaks the view.
  if (error || !data) return result;

  for (const row of data) {
    if (!row.wallet_address) continue;
    result.set(String(row.wallet_address).toLowerCase(), {
      id: String(row.id),
      handle: row.handle,
      provider: row.provider as AccountProvider,
    });
  }
  return result;
}
