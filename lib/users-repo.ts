import { createSupabaseServerClient } from "@/lib/supabase";
import type { AppUser } from "@/lib/types";

export type XProfileInput = {
  xUserId: string;
  handle: string;
  name: string | null;
  avatarUrl: string | null;
  email: string | null;
};

function requireClient() {
  const client = createSupabaseServerClient();
  if (!client) {
    throw new Error("Supabase is not configured");
  }
  return client;
}

export async function upsertUserFromX(profile: XProfileInput): Promise<AppUser> {
  const client = requireClient();
  const { data, error } = await client
    .from("users")
    .upsert(
      {
        x_user_id: profile.xUserId,
        x_handle: profile.handle,
        x_name: profile.name,
        x_avatar_url: profile.avatarUrl,
        email: profile.email,
      },
      { onConflict: "x_user_id" },
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

// The stored X avatar for a handle, if that handle belongs to a Splitsy user.
// Case-insensitive; escapes LIKE metacharacters (_ and % are legal-ish in the
// ilike pattern but not in real handles) so we never match the wrong row.
export async function getUserAvatarByHandle(handle: string): Promise<string | null> {
  const client = createSupabaseServerClient();
  if (!client) return null;
  const pattern = handle.replace(/^@/, "").replace(/[\\%_]/g, "\\$&");
  const { data, error } = await client
    .from("users")
    .select("x_avatar_url")
    .ilike("x_handle", pattern)
    .not("x_avatar_url", "is", null)
    .limit(1)
    .maybeSingle();
  if (error) return null;
  return (data as { x_avatar_url: string | null } | null)?.x_avatar_url ?? null;
}

export async function getUserById(id: string): Promise<AppUser | null> {
  const client = requireClient();
  const { data, error } = await client.from("users").select().eq("id", id).maybeSingle();
  if (error) {
    throw new Error(`Failed to read user: ${error.message}`);
  }
  return (data as AppUser) ?? null;
}
