// Browser-side crypto for wallet key export. ISOMORPHIC AND PURE: no network, no
// Privy SDK, no Node builtins — the same code runs in the export tab and under
// `node --test`, which is what makes any of it testable at all.
//
// NOTHING HERE EVER LOGS. Every function in this file touches either the user's
// export password, the P-256 secret derived from it, or the exported wallet key.
// A console.log added for debugging is a key disclosure.
//
// Design: docs/superpowers/specs/2026-09-08-privy-key-export-design.md
import { p256 } from "@noble/curves/p256";
import { sha256 } from "@noble/hashes/sha2";
import canonicalize from "canonicalize";

export const PRIVY_API_BASE = "https://api.privy.io";

export type AuthorizationInput = {
  version: 1;
  method: string;
  url: string;
  body: unknown;
  headers: { "privy-app-id": string };
};

// btoa/atob rather than Buffer: Buffer is not a browser global and Next.js does
// not polyfill it for client bundles. Both are available in Node 18+ too, so the
// tests exercise the same path the browser takes.
export function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

// The ArrayBuffer parameter is not decoration: since TS 5.7 a bare `Uint8Array`
// is `Uint8Array<ArrayBufferLike>`, which WebCrypto's `BufferSource` rejects.
// This function always allocates a fresh ArrayBuffer, so the narrower type is
// simply the truth — and it is what lets callers hand the bytes to crypto.subtle.
export function bytesFromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

// THE BROWSER BUILDS THIS, NOT THE SERVER, and that is the whole security
// property. recipient_public_key is inside the signed bytes, so a server that
// substitutes its own recipient key — and could then decrypt the result —
// produces a signature Privy rejects. If the server ever computed these bytes
// and asked the browser to sign them, it could ask it to sign anything.
export function exportRequestInput(walletId: string, appId: string, recipientPublicKey: string): AuthorizationInput {
  return {
    version: 1,
    method: "POST",
    url: `${PRIVY_API_BASE}/v1/wallets/${walletId}/export`,
    body: { encryption_type: "HPKE", recipient_public_key: recipientPublicKey },
    headers: { "privy-app-id": appId },
  };
}

// A byte-for-byte reimplementation of the SDK's
// formatRequestForAuthorizationSignature. Copied rather than imported because the
// SDK module graph is server-only; the empty-body special case is copied verbatim
// because Privy's verifier has the same one.
//
// Deliberately NOT mutating the caller's object, which the SDK does. The
// canonical output is identical either way, and the test compares against a
// structuredClone for exactly that reason.
export function canonicalPayload(input: AuthorizationInput): Uint8Array {
  const payload: AuthorizationInput = { ...input };
  const body = payload.body;
  if (typeof body === "object" && body !== null && Object.keys(body).length === 0) {
    payload.body = "";
  }
  const serialized = canonicalize(payload);
  if (!serialized) throw new Error("Could not serialise the authorization payload");
  return new TextEncoder().encode(serialized);
}

// DER, not raw r||s. crypto.subtle.sign({name:'ECDSA'}) would return the latter
// and Privy rejects it, so this goes through noble instead of WebCrypto.
// @noble/curves is pinned to 1.4.2 (viem's copy, the one that resolves from here):
// its signature object exposes toDERRawBytes(). Privy's own nested 1.9.7 uses
// toBytes('der') — same output, different method name, wrong package path.
export function signAuthorization(payload: Uint8Array, secretKey: Uint8Array): string {
  return base64FromBytes(p256.sign(sha256(payload), secretKey).toDERRawBytes());
}

// OWASP-current for PBKDF2-SHA256. Roughly a second in a browser, which is the
// point: this is the only thing standing between a stolen app secret plus a
// stolen owner public key and an offline crack of the user's password.
export const PBKDF2_ITERATIONS = 600_000;
export const MIN_PASSWORD_LENGTH = 12;

// Lowercased deliberately. setUserWallet (lib/users-repo.ts:45) stores Privy's
// CHECKSUMMED address while setUserAgentWallet lowercases, so the address a
// browser is handed can arrive either way — and a salt that changed with the
// casing would silently derive a different owner key and lock the user out.
export function exportSalt(walletAddress: string): string {
  return `splitsy-export:${walletAddress.toLowerCase()}`;
}

// A P-256 secret key must lie in [1, n-1]. PBKDF2 gives a uniform 32 bytes, so
// landing outside that is a ~2^-32 event — but "astronomically unlikely" is not
// "impossible", and the failure mode is a user whose password derives nothing.
// Re-hashing keeps the repair DETERMINISTIC: randomising here would mean the same
// password produced a different wallet owner on every attempt.
export function validScalar(bytes: Uint8Array): Uint8Array {
  let candidate = bytes;
  for (let attempt = 0; attempt < 8; attempt++) {
    if (p256.utils.isValidPrivateKey(candidate)) return candidate;
    candidate = sha256(candidate);
  }
  throw new Error("Could not derive a valid P-256 scalar from this password");
}

// The user's export credential. NEVER LEAVES THE BROWSER — only the public half
// is sent to us, and only so we can transfer wallet ownership to it once.
export async function deriveOwnerSecretKey(password: string, walletAddress: string): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const material = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: encoder.encode(exportSalt(walletAddress)),
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    material,
    256,
  );
  return validScalar(new Uint8Array(bits));
}

// Base64 SPKI/DER, which is the ONE format Privy's `owner.public_key` accepts.
// Built by round-tripping the raw point through WebCrypto rather than prepending
// a hard-coded 26-byte DER header — same bytes, and no magic constant to get wrong.
export async function ownerPublicKeySpki(secretKey: Uint8Array): Promise<string> {
  // Copied into a view WebCrypto's types accept: noble returns the wider
  // `Uint8Array<ArrayBufferLike>` (see bytesFromBase64). 65 bytes, once.
  const point = new Uint8Array(p256.getPublicKey(secretKey, false));
  const key = await crypto.subtle.importKey("raw", point, { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"]);
  return base64FromBytes(new Uint8Array(await crypto.subtle.exportKey("spki", key)));
}
