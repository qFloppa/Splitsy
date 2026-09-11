// The user's export credential, for the life of one browser session. CLIENT ONLY.
//
// WHAT THIS IS: the P-256 secret derived from the user's export password, which is
// the OWNER of their wallet. With it the tab can authorize a transaction directly,
// which is what lets a user sign their own sends instead of asking Splitsy to.
// See scripts/privy-owner-sign-probe.ts for the measurement that made this possible.
//
// IT IS ALSO THE EXPORT CREDENTIAL. The same key that signs a payment reveals the
// wallet's private key, so an XSS during a session in which this is populated can
// do both. That is the accepted cost of asking for the password once per session
// rather than once per payment; the alternative (re-derive from a typed password
// every time) was the other option and was declined for friction. Do not "improve"
// this by persisting it anywhere.
//
// NEVER IN sessionStorage OR localStorage, and never in React state. Module scope
// only: it dies with the tab, is not serialisable by anything that walks the DOM or
// a component tree, and cannot outlive a reload. The key is also bound to the
// wallet ADDRESS it was derived for, so a cached key is never used to sign for a
// different wallet — the salt is the address, so the wrong key would not verify
// anyway, but a mismatch should fail as "not cached" rather than as a mystery 401.
import type { deriveOwnerSecretKey } from "@/lib/export-crypto";

type SessionKey = { address: string; key: Uint8Array };

let cached: SessionKey | null = null;

// Lowercased on both sides. The address reaches the browser from the DB and from
// Privy, and the two have historically disagreed on casing (see
// lib/export-crypto.ts:exportSalt, which lowercases for the same reason) — a
// case-sensitive comparison here would silently re-prompt on every send.
export function rememberOwnerKey(address: string, key: Uint8Array): void {
  cached = { address: address.toLowerCase(), key };
}

export function ownerKeyFor(address: string): Uint8Array | null {
  return cached && cached.address === address.toLowerCase() ? cached.key : null;
}

export function forgetOwnerKey(): void {
  cached = null;
}

// Kept as a type reference so the shape cannot drift from the derivation that
// produces it. `typeof` on the import keeps this erasure-only — no runtime import
// of the crypto module, which is the point of importing the type.
export type OwnerKey = Awaited<ReturnType<typeof deriveOwnerSecretKey>>;
