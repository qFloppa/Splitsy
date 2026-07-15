import { createSupabaseServerClient } from "@/lib/supabase";
import type { AppUser, IdentityProvider } from "@/lib/types";

export type ProviderProfileInput = {
  provider: IdentityProvider;
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
  provider: IdentityProvider,
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
