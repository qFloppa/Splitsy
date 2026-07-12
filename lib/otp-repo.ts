import { createSupabaseServerClient } from "@/lib/supabase";

// Persistence for Email-OTP challenges (schema-otp.sql). One row per email; a
// resend upserts (overwrites) the prior code. The code itself lives here only as
// a salted scrypt hash.

function requireClient() {
  const client = createSupabaseServerClient();
  if (!client) {
    throw new Error("Supabase is not configured");
  }
  return client;
}

export type StoredOtp = { email: string; code_hash: string; expires_at: string; attempts: number };

// Create or replace the pending challenge for an email.
export async function upsertOtp(email: string, codeHash: string, expiresAt: Date): Promise<void> {
  const client = requireClient();
  const { error } = await client
    .from("email_otps")
    .upsert(
      { email, code_hash: codeHash, expires_at: expiresAt.toISOString(), attempts: 0 },
      { onConflict: "email" },
    );
  if (error) throw new Error(`Failed to store OTP: ${error.message}`);
}

export async function readOtp(email: string): Promise<StoredOtp | null> {
  const client = requireClient();
  const { data, error } = await client.from("email_otps").select().eq("email", email).maybeSingle();
  if (error) throw new Error(`Failed to read OTP: ${error.message}`);
  return (data as StoredOtp) ?? null;
}

export async function bumpOtpAttempts(email: string, attempts: number): Promise<void> {
  const client = requireClient();
  const { error } = await client.from("email_otps").update({ attempts }).eq("email", email);
  if (error) throw new Error(`Failed to update OTP attempts: ${error.message}`);
}

// Consume the challenge (on success or lock-out) so a code is single-use.
export async function deleteOtp(email: string): Promise<void> {
  const client = requireClient();
  const { error } = await client.from("email_otps").delete().eq("email", email);
  if (error) throw new Error(`Failed to delete OTP: ${error.message}`);
}
