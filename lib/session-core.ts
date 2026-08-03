import { createHmac, timingSafeEqual } from "crypto";

export const SESSION_COOKIE_NAME = "splitsy_session";
export const SESSION_MAX_AGE = 2592000; // 30 days in seconds

function sign(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

// Token format: "<userId>.<base64url-hmac-of-userId>". The userId is opaque
// (a Supabase uuid) and contains no ".", so we split on the last ".".
export function signSession(userId: string, secret: string): string {
  return `${userId}.${sign(userId, secret)}`;
}

export function verifySession(token: string, secret: string): string | null {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;

  const userId = token.slice(0, dot);
  const providedSig = token.slice(dot + 1);
  const expectedSig = sign(userId, secret);

  const provided = Buffer.from(providedSig);
  const expected = Buffer.from(expectedSig);
  if (provided.length !== expected.length) return null;
  if (!timingSafeEqual(provided, expected)) return null;

  return userId;
}

export const WALLET_UNLOCK_COOKIE = "splitsy_wallet_unlock";
export const WALLET_UNLOCK_TTL = 300; // seconds — re-auth every 5 minutes

// Short-lived wallet-unlock token: "<userId>.<expiresAtMs>.<hmac>". Signing the
// expiry means the client can't extend it. Verification takes `now` so it's pure
// and testable.
export function signWalletUnlock(userId: string, expiresAtMs: number, secret: string): string {
  const payload = `${userId}.${expiresAtMs}`;
  return `${payload}.${sign(payload, secret)}`;
}

export function verifyWalletUnlock(token: string, secret: string, now: number): string | null {
  return verifyStamped(token, secret, now, "");
}

// A SECOND identity in the same browser: the account a browser wallet signed into
// while a social session was already live (/api/auth/wallet leaves that session
// alone). Not a session and it authorizes no action — it is only proof that
// whoever holds this browser also held that wallet's key, which is what lets the
// Agents tab show that account's agent and its decisions beside this one's.
//
// Necessary because the alternative is a client-supplied address, and the reader
// of a decision log learns which of someone's private rules declined which bill.
// An address is a claim; this is evidence.
//
// DOMAIN-SEPARATED from both other tokens despite the identical shape: the signed
// payload carries a prefix, so a value lifted out of one cookie cannot verify as
// another. Without it, this cookie replayed as splitsy_session would BE that
// account, and replayed as the unlock cookie would bypass the wallet PIN for a
// month.
export const WALLET_PROOF_COOKIE = "splitsy_wallet_proof";
export const WALLET_PROOF_TTL = SESSION_MAX_AGE;
const PROOF_DOMAIN = "wproof.";

export function signWalletProof(userId: string, expiresAtMs: number, secret: string): string {
  const payload = `${userId}.${expiresAtMs}`;
  return `${payload}.${sign(`${PROOF_DOMAIN}${payload}`, secret)}`;
}

export function verifyWalletProof(token: string, secret: string, now: number): string | null {
  return verifyStamped(token, secret, now, PROOF_DOMAIN);
}

// One parser for both stamped tokens. `domain` is prefixed before signing only —
// never stored — so the two cookies share a format and no signatures.
function verifyStamped(token: string, secret: string, now: number, domain: string): string | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [userId, expiresAtStr, providedSig] = parts;
  const expiresAt = Number(expiresAtStr);
  if (!Number.isFinite(expiresAt) || expiresAt < now) return null;

  const expectedSig = sign(`${domain}${userId}.${expiresAtStr}`, secret);
  const provided = Buffer.from(providedSig);
  const expected = Buffer.from(expectedSig);
  if (provided.length !== expected.length) return null;
  if (!timingSafeEqual(provided, expected)) return null;

  return userId;
}
