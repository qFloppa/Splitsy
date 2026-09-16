import { createSupabaseServerClient } from "./supabase.ts";

export type PrivyWalletRow = {
  namespace: string;
  key: string;
  privy_user_id?: string | null;
  wallet_id: string;
  address: string;
  export_owner_key?: string | null;
  // How the owner key is held, once claimed: 'password' (one key, no recovery) or
  // 'passkey+password' (a quorum at threshold 1, either key signs alone). Null
  // until a claim lands. The two are different PROMISES and must not be conflated.
  owner_kind?: string | null;
  // A WebAuthn handle, not a secret: useless without the authenticator. Lets the
  // browser name the right passkey when resident-key discovery misses.
  passkey_credential_id?: string | null;
  // The salt the owner key was derived with. Null means the legacy address salt —
  // see schema-privy-wallets.sql. NOT optional information: the same password
  // under a different salt is a different key, so this is what makes a provisioned
  // wallet openable on the next page load.
  owner_salt?: string | null;
  // Non-null ONLY when the user took sole ownership: their key owns the wallet AND
  // our additional_signer was revoked in the same call. Null with a non-null
  // export_owner_key is the OLD shape — ownership moved, we kept spending — so the
  // two must never be conflated. See schema-privy-wallets.sql.
  claimed_at?: string | null;
};

// Whether Splitsy can still sign for this wallet. The one place that question is
// answered, because getting it wrong in either direction is expensive: reading a
// claimed wallet as custodial sends the server to Privy for a 401 it could have
// predicted, and reading a custodial one as claimed tells a user we hold no key
// when we do.
export const isCustodial = (row: Pick<PrivyWalletRow, "claimed_at">): boolean => !row.claimed_at;

function requireClient() {
  const client = createSupabaseServerClient();
  if (!client) throw new Error("Supabase is not configured");
  return client;
}

export async function getPrivyWallet(namespace: string, key: string): Promise<PrivyWalletRow | null> {
  const client = requireClient();
  const { data, error } = await client
    .from("privy_wallets")
    .select("namespace, key, privy_user_id, wallet_id, address, export_owner_key, claimed_at, owner_kind, passkey_credential_id, owner_salt")
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

// The route holds a wallet id (users.circle_wallet_id, which on this stack holds
// the PRIVY wallet id) and needs the row it belongs to. Deliberately keyed on
// wallet_id rather than address: address casing was inconsistent across writers
// until setUserWallet was fixed on this branch, and rows written before that
// still hold the checksummed form — a lookup that can miss on casing would read
// as "no wallet" and 404 a user out of their own export.
//
// WALLET_ID CARRIES NO UNIQUE INDEX, AND MUST NOT. Ruled 2026-09-11, after the
// question was parked twice. .maybeSingle() raises PGRST116 on two rows sharing
// one wallet_id, which reads as the constraint's absence being a bug — it is not.
// scripts/privy-remint.ts holds exactly that state ON PURPOSE: the scratch row it
// mints through and the real row it repoints both carry the new wallet id between
// the update at :194 and the delete at :216, and that ordering is chosen so a
// crash never strands swept funds in a wallet no row references. A unique index
// turns that deliberate window into a guaranteed failure of the repoint, which is
// the one write in the script that must not fail. The duplicate is already
// handled at both ends instead: gate() catches the throw and answers a retryable
// 502 (app/api/wallet/export/route.ts:102-110), and the script's orphan filter
// matches scratch keys by suffix, so re-running it clears a crashed run's leftover.
export async function getPrivyWalletByWalletId(walletId: string): Promise<PrivyWalletRow | null> {
  const client = requireClient();
  const { data, error } = await client
    .from("privy_wallets")
    .select("namespace, key, privy_user_id, wallet_id, address, export_owner_key, claimed_at, owner_kind, passkey_credential_id, owner_salt")
    .eq("wallet_id", walletId)
    .maybeSingle();
  if (error) throw new Error(`Failed to read privy_wallets: ${error.message}`);
  return (data as PrivyWalletRow) ?? null;
}

// Records the public half of the user's export credential AFTER Privy has accepted
// the ownership transfer. Never before: a false "enabled" would tell a user only
// they can export while we still can, and under-claiming is the safe direction.
export async function setExportOwnerKey(namespace: string, key: string, publicKey: string): Promise<void> {
  const client = requireClient();
  const { error } = await client
    .from("privy_wallets")
    .update({ export_owner_key: publicKey })
    .eq("namespace", namespace)
    .eq("key", key);
  if (error) throw new Error(`Failed to record the export owner key: ${error.message}`);
}

// Records a COMPLETED claim: the user owns the wallet and our signer is gone.
//
// Written only after Privy has confirmed both halves and an export has actually
// been proven against the new key — same prove-before-record rule the restore path
// learned the hard way (76b912a). The row is what every other route reads to decide
// whether the server may sign, so a premature write here would make the server skip
// a signature it could still make, or attempt one it cannot.
//
// claimed_at and export_owner_key are set TOGETHER. A row carrying one without the
// other is the ambiguous state this column was added to eliminate, so there is no
// code path that writes just one.
//
// `salt` rides along for the same reason: it is part of what makes the recorded key
// reproducible, so it is written in the same statement as the key itself. Omitted
// by the claim path, which uses the address salt — null is that, not "unknown".
export async function setClaimed(
  namespace: string,
  key: string,
  publicKey: string,
  owner: { ownerKind: string; passkeyCredentialId: string | null; salt?: string | null },
): Promise<void> {
  const client = requireClient();
  const { error } = await client
    .from("privy_wallets")
    .update({
      export_owner_key: publicKey,
      claimed_at: new Date().toISOString(),
      owner_kind: owner.ownerKind,
      passkey_credential_id: owner.passkeyCredentialId,
      owner_salt: owner.salt ?? null,
    })
    .eq("namespace", namespace)
    .eq("key", key);
  if (error) throw new Error(`Failed to record the wallet claim: ${error.message}`);
}
