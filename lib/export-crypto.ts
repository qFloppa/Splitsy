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

export function bytesFromBase64(b64: string): Uint8Array {
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
// formatRequestForAuthorizationSignature (lib/authorization.mjs:14-26). Copied
// rather than imported because the SDK module graph is server-only; the empty-body
// special case is copied verbatim because Privy's verifier has the same one.
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
