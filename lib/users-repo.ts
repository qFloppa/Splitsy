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

export async function getUserById(id: string): Promise<AppUser | null> {
  const client = requireClient();
  const { data, error } = await client.from("users").select().eq("id", id).maybeSingle();
  if (error) {
    throw new Error(`Failed to read user: ${error.message}`);
  }
  return (data as AppUser) ?? null;
}
