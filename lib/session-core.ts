import { createHmac, timingSafeEqual } from "crypto";

export const SESSION_COOKIE_NAME = "splitsy_session";
export const SESSION_MAX_AGE = 2592000; // 30 days in seconds

// EXPORTED for lib/tx-ticket.ts, which needs the same primitive under its own
// domain prefix. One implementation of the HMAC, not two — the cookies and the
// transaction tickets must never disagree about what signing means.
export function sign(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

// Constant-time compare of two base64url signatures. Length is checked first
// because timingSafeEqual THROWS on a length mismatch rather than returning false.
export function signaturesMatch(providedSig: string, expectedSig: string): boolean {
  const provided = Buffer.from(providedSig);
  const expected = Buffer.from(expectedSig);
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

// Token format: "<userId>.<issuedAtMs>.<hmac>". The userId is opaque (a Supabase
// uuid) and contains no ".".
//
// THE ISSUE TIME IS SIGNED, and this is the whole reason the format changed. The
// token used to be "<userId>.<hmac-of-userId>" — no time in it at all. Its 30-day
// life was the cookie's Max-Age, which is a hint to the browser holding it and
// nothing to the server: a token captured once verified forever, and there was no
// value anywhere that could make it stop. For a cookie that gates every money
// route that is not a session, it is a bearer key with no expiry.
//
// Signing the issue time buys two things at once. The token now EXPIRES on its
// own, server-side, at SESSION_MAX_AGE. And because the instant it was minted is
// verifiable, `users.sessions_valid_from` can retire every token issued before a
// chosen moment — which is the only REVOCATION a stateless session can have. See
// getSessionUser in lib/session.ts for that comparison, and
// schema-session-revocation.sql for the column.
//
// DOMAIN-SEPARATED, like the other two tokens. Without the prefix a wallet-unlock
// value — same three-part shape, same secret — could be replayed into this cookie
// and verify here.
const SESSION_DOMAIN = "session.";

export function signSession(userId: string, issuedAtMs: number, secret: string): string {
  const payload = `${userId}.${issuedAtMs}`;
  return `${payload}.${sign(`${SESSION_DOMAIN}${payload}`, secret)}`;
}

export type VerifiedSession = { userId: string; issuedAtMs: number };

/**
 * The session this token stands for, or null.
 *
 * Takes `now` rather than reading the clock so it stays pure and testable, the
 * same shape as verifyWalletUnlock.
 */
export function verifySession(token: string, secret: string, now: number): VerifiedSession | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [userId, issuedAtStr, providedSig] = parts;
  if (!userId) return null;

  const issuedAtMs = Number(issuedAtStr);
  if (!Number.isFinite(issuedAtMs)) return null;
  // Expired, and — the other direction — issued in the future. A future stamp is
  // not a clock-skew allowance to make: the only way to hold one is to have minted
  // it, and letting it through would be a token that outlives the window by
  // however far ahead it was dated.
  if (issuedAtMs + SESSION_MAX_AGE * 1000 <= now) return null;
  if (issuedAtMs > now + 60_000) return null;

  const expectedSig = sign(`${SESSION_DOMAIN}${userId}.${issuedAtStr}`, secret);
  if (!signaturesMatch(providedSig, expectedSig)) return null;

  return { userId, issuedAtMs };
}

export const WALLET_UNLOCK_COOKIE = "splitsy_wallet_unlock";
export const WALLET_UNLOCK_TTL = 300; // seconds — re-auth every 5 minutes

// DOMAIN-SEPARATED from the session cookie above, which it was not before: both
// are "<id>.<number>.<hmac>" over the same secret, so an unsigned-prefix unlock
// token was a value that could verify in either place. Harmless in practice only
// because a uuid carries no ".", which is a property of the id rather than a check
// anything made.
const UNLOCK_DOMAIN = "wunlock.";

// Short-lived wallet-unlock token: "<userId>.<expiresAtMs>.<hmac>". Signing the
// expiry means the client can't extend it. Verification takes `now` so it's pure
// and testable.
export function signWalletUnlock(userId: string, expiresAtMs: number, secret: string): string {
  const payload = `${userId}.${expiresAtMs}`;
  return `${payload}.${sign(`${UNLOCK_DOMAIN}${payload}`, secret)}`;
}

export function verifyWalletUnlock(token: string, secret: string, now: number): string | null {
  return verifyStamped(token, secret, now, UNLOCK_DOMAIN);
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
