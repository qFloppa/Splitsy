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
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [userId, expiresAtStr, providedSig] = parts;
  const expiresAt = Number(expiresAtStr);
  if (!Number.isFinite(expiresAt) || expiresAt < now) return null;

  const expectedSig = sign(`${userId}.${expiresAtStr}`, secret);
  const provided = Buffer.from(providedSig);
  const expected = Buffer.from(expectedSig);
  if (provided.length !== expected.length) return null;
  if (!timingSafeEqual(provided, expected)) return null;

  return userId;
}
