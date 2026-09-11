// Browser-side crypto for wallet key export. ISOMORPHIC AND PURE: no network, no
// Privy SDK, no Node builtins — the same code runs in the export tab and under
// `node --test`, which is what makes any of it testable at all.
//
// NOTHING HERE EVER LOGS. Every function in this file touches either the user's
// export password, the P-256 secret derived from it, or the exported wallet key.
// A console.log added for debugging is a key disclosure.
//
// Design: docs/superpowers/specs/2026-09-08-privy-key-export-design.md
import { Chacha20Poly1305 } from "@hpke/chacha20poly1305";
import { CipherSuite, DhkemP256HkdfSha256, HkdfSha256 } from "@hpke/core";
import { p256 } from "@noble/curves/p256";
import { sha256 } from "@noble/hashes/sha2";
import canonicalize from "canonicalize";
import { privateKeyToAddress } from "viem/accounts";

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

// The sibling of the above, for SPENDING rather than exporting. Same rule, same
// reason: these bytes must match what the SDK puts on the wire or the signature
// covers a different request and Privy answers 401 with no clue why.
//
// WHY THIS EXISTS AT ALL: ownership grants more than export. An owner key can
// authorize eth_signTransaction — measured in scripts/privy-owner-sign-probe.ts,
// with a wrong key refused 401 on the same endpoint to prove the header is really
// the gate. So a user who has set an export password can sign their own payments,
// and Splitsy's additional-signer spend is left for what nobody is present for.
//
// `transaction` IS OPAQUE HERE ON PURPOSE. The server builds it — the nonce and the
// gas are chain reads, and ARC_TESTNET_RPC may be a keyed endpoint that must not
// reach a browser — and it is relayed back verbatim. Typing it as anything richer
// would invite this side to reshape a field, and a single re-serialised number is a
// different canonical payload and therefore a 401. The browser's job is to sign
// these bytes, not to understand them.
export function rpcRequestInput(
  walletId: string,
  appId: string,
  transaction: Record<string, unknown>,
): AuthorizationInput {
  return {
    version: 1,
    method: "POST",
    url: `${PRIVY_API_BASE}/v1/wallets/${walletId}/rpc`,
    // _rpc sends the params object minus the header keys, so this is the whole body.
    body: { method: "eth_signTransaction", params: { transaction } },
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

// Lowercased deliberately, and this is LOAD-BEARING even though the writer that
// motivated it was fixed on this branch. setUserWallet (lib/users-repo.ts:45)
// now lowercases, but rows written BEFORE that fix still hold Privy's
// CHECKSUMMED address, so the address a browser is handed can still arrive
// either way — and a salt that changed with the casing would silently derive a
// different owner key and lock the user out of their own wallet.
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

// The SAME owner key, derived from what a PASSKEY released instead of from a typed
// password. lib/passkey-owner.ts gets 32 stable bytes out of the authenticator's
// PRF extension; this turns them into the P-256 scalar everything downstream
// already expects, so there is one derivation path and one signing path regardless
// of how the wallet is unlocked.
//
// HASHED, NOT USED RAW, for two reasons. The PRF output is the authenticator's
// secret for this (credential, salt) pair and may be reused by other extensions or
// future callers, so it should not also BE the wallet's private key. And sha256
// gives validScalar a uniformly distributed 32 bytes, which is the input its
// re-hash loop assumes.
//
// No PBKDF2 here, deliberately. Stretching exists to make a guessable password
// expensive to attack offline; PRF output is 32 bytes of authenticator entropy
// with nothing to guess, so iterating would cost a second and buy nothing.
export function ownerSecretFromPrf(prfOutput: Uint8Array): Uint8Array {
  if (prfOutput.length < 32) {
    throw new Error(`Expected at least 32 bytes from the passkey, got ${prfOutput.length}`);
  }
  return validScalar(sha256(prfOutput));
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

// Privy's export suite, read off the SDK's own setupHPKERecipient
// (node_modules/@privy-io/node/lib/cryptography.mjs:76-95). Copied rather than
// imported: that module is @internal, is not re-exported from the package root,
// and pulls in the server-only SDK graph. Fifteen lines is cheaper than a deep
// import that breaks on the next SDK bump.
function exportSuite(): CipherSuite {
  return new CipherSuite({
    kem: new DhkemP256HkdfSha256(),
    kdf: new HkdfSha256(),
    aead: new Chacha20Poly1305(),
  });
}

export type ExportRecipient = {
  publicKeySpkiBase64: string;
  open: (encapsulatedKeyBase64: string, ciphertextBase64: string) => Promise<string>;
};

// The ephemeral keypair that makes the server a relay rather than a reader. Its
// private half exists only in this tab, for the life of one export, and is
// captured in the closure below — never returned, never serialisable, never sent.
// A NEW ONE PER EXPORT: reusing it would let a captured ciphertext be opened later.
export async function createExportRecipient(): Promise<ExportRecipient> {
  const suite = exportSuite();
  const keypair = await suite.kem.generateKeyPair();
  const spki = await crypto.subtle.exportKey("spki", keypair.publicKey as CryptoKey);
  return {
    publicKeySpkiBase64: base64FromBytes(new Uint8Array(spki)),
    open: async (encapsulatedKeyBase64, ciphertextBase64) => {
      const recipient = await suite.createRecipientContext({
        recipientKey: keypair.privateKey,
        enc: bytesFromBase64(encapsulatedKeyBase64),
      });
      const plaintext = await recipient.open(bytesFromBase64(ciphertextBase64));
      return new TextDecoder().decode(new Uint8Array(plaintext));
    },
  };
}

// THE GUARD. A decrypted key we cannot prove belongs to this wallet is not shown,
// not copied, not logged — a suite mismatch or a wrong-wallet export would
// otherwise hand the user 64 plausible hex characters that control nothing, or
// worse, something else. Returns a boolean rather than throwing because every
// caller is deciding whether to render, not whether to continue.
export function verifyExportedKey(privateKeyHex: string, walletAddress: string): boolean {
  const hex = privateKeyHex.startsWith("0x") ? privateKeyHex : `0x${privateKeyHex}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) return false;
  try {
    return privateKeyToAddress(hex as `0x${string}`).toLowerCase() === walletAddress.toLowerCase();
  } catch {
    return false;
  }
}
