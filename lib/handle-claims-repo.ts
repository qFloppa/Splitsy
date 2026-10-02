// The index of which account owns a handle — the table is schema-handle-claims.sql.
//
// WRITE-ONCE, LIKE THE BINDING IT GUARDS. {claimHandle} never overwrites, so a
// handle's owner is whoever signed in under it first and a re-registered handle
// earns its new holder nothing. That is the same shape as
// {BillSplitRegistry.bind}, one layer up: the contract refuses to change where a
// handle's refunds go, and this refuses to change whose handle it is.
import { normalizeHandle } from "./iou.ts";
import { createSupabaseServerClient } from "./supabase.ts";

function requireClient() {
  const client = createSupabaseServerClient();
  if (!client) throw new Error("Supabase is not configured");
  return client;
}

/**
 * Record that this account owns this handle. First login under it wins, forever.
 *
 * Ignores duplicates rather than reporting them, so a returning user's every
 * login is a no-op and the caller has nothing to branch on: the question
 * "is it mine?" is answered by {handlesForUser}, which reads the row that stood.
 */
export async function claimHandle(provider: string, handle: string, userId: string): Promise<void> {
  const client = requireClient();
  const { error } = await client.from("handle_claims").upsert(
    {
      provider: provider.toLowerCase(),
      // The same normalization lib/handle-escrow.ts hashes, because a claim that
      // normalizes differently from the hash is a claim over nothing.
      handle: normalizeHandle(handle),
      user_id: userId,
    },
    { onConflict: "provider,handle", ignoreDuplicates: true },
  );
  if (error) throw new Error(`Failed to claim handle: ${error.message}`);
}

/**
 * Every handle this account owns, newest claim first.
 *
 * MORE THAN ONE AFTER A RENAME, which is the entire reason this exists. The
 * current handle is where the money of anyone who never renamed sits, and it is
 * the newest claim, so the common case is answered by the first element.
 *
 * Throws rather than answering an empty list on failure. The callers use this to
 * decide which handles to release money under, and a silent `[]` is
 * indistinguishable from "this account owns nothing" — which would quietly stop
 * paying people out.
 */
export async function handlesForUser(userId: string): Promise<string[]> {
  const client = requireClient();
  const { data, error } = await client
    .from("handle_claims")
    .select("handle")
    .eq("user_id", userId)
    .order("claimed_at", { ascending: false });
  if (error) throw new Error(`Failed to read handle claims: ${error.message}`);
  return (data ?? []).map((row) => String(row.handle));
}
