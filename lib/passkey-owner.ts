"use client";

// The passkey half of wallet ownership. CLIENT ONLY, and nothing here is ever sent
// to Splitsy except a public key and a credential id.
//
// WHY A PASSKEY IS NOT THE OWNER KEY. Privy verifies an owner's signature as
// P256.verify(sig, sha256(canonicalize(payload)), ownerPubKey). WebAuthn signs
// sha256(authenticatorData || sha256(clientDataJSON)) — the authenticator prepends
// its own bytes and buries our payload inside clientDataJSON.challenge, so the
// pre-image is not ours to choose and the signature can never verify against
// Privy's digest. That is not an obstacle to route around; it is the property that
// makes WebAuthn phishing-resistant.
//
// SO THE PASSKEY RELEASES A KEY RATHER THAN BEING ONE. The PRF extension (WebAuthn
// L3, `prf.eval.first` in / `prf.results.first` out) returns a stable 32 bytes for
// a given credential and salt — the same bytes every time, on every synced device,
// and only after the user verification the authenticator demands. Those bytes feed
// the SAME validScalar → ownerPublicKeySpki path the password already uses
// (lib/export-crypto.ts), so there is no second derivation and no new curve code.
//
// The secret is never stored. It is re-derived per session from the authenticator
// and cached in memory exactly like the password-derived one
// (app/session-owner-key.ts), so a Face ID prompt is once per tab, not per payment.

// The relying party is the ORIGIN, enforced by the browser. A passkey registered
// on splitsy.xyz cannot be used by any other site, which is what makes the
// credential id safe to store in plain text.
const RP_NAME = "Splitsy";

// base64url, because a credential id travels in JSON and comes back as a
// BufferSource. Kept local rather than imported from export-crypto: that module's
// helpers are standard base64 (for SPKI and DER), and mixing the two alphabets is
// exactly the kind of silent corruption that surfaces as "no passkey found".
const toBase64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// The ArrayBuffer parameter is not decoration: since TS 5.7 a bare Uint8Array is
// Uint8Array<ArrayBufferLike>, which WebAuthn's BufferSource rejects. Same note
// bytesFromBase64 carries in lib/export-crypto.ts, for the same reason.
const fromBase64Url = (value: string): Uint8Array<ArrayBuffer> => {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
};

// The PRF salt. Per-wallet, and deliberately the SAME string the password
// derivation salts with: one wallet, one secret, whichever way it is unlocked.
// Domain-prefixed by exportSalt, so the bytes a passkey releases for this wallet
// are useless anywhere else.
//
// TAKES A SALT STRING, not an address, because a wallet minted under the user's
// own keys has no address until those keys exist — see accountSalt in
// lib/export-crypto.ts for why that circularity is real and how it is broken.
// Callers pass exportSalt(address) for an existing wallet and accountSalt(...)
// for one being created.
const prfSalt = (salt: string): Uint8Array<ArrayBuffer> => {
  const encoded = new TextEncoder().encode(salt);
  const out = new Uint8Array(new ArrayBuffer(encoded.length));
  out.set(encoded);
  return out;
};

export type PasskeyRegistration = { credentialId: string; secret: Uint8Array };

// Whether this browser can do PRF at all. Firefox and Safari before 18 cannot, and
// those users get the password-only claim instead of a broken button.
//
// OPTIMISTIC BY NECESSITY: there is no reliable synchronous capability check
// across browsers. getClientCapabilities() is the standard one and is itself new,
// so its absence says nothing — the real answer comes from the registration
// attempt, which reports `prf.enabled`. This exists to skip the attempt where we
// can already be sure it is pointless.
export async function prfSupported(): Promise<boolean> {
  if (typeof window === "undefined" || !window.PublicKeyCredential) return false;
  try {
    const caps = await (
      window.PublicKeyCredential as unknown as {
        getClientCapabilities?: () => Promise<Record<string, boolean>>;
      }
    ).getClientCapabilities?.();
    // Explicit false is a real answer; undefined means the browser cannot say, and
    // the registration attempt below will find out for certain.
    if (caps && caps["extension:prf"] === false) return false;
  } catch {
    /* fall through — an unreadable capability list is not a no */
  }
  return typeof window.PublicKeyCredential === "function";
}

// Register a passkey for this wallet and get the secret it releases.
//
// CREATE THEN IMMEDIATELY GET, and this is the part that is easy to get wrong.
// Many authenticators answer `prf.enabled: true` on create() but return no
// `prf.results` until the first assertion — so a registration that reads the
// secret from the create() response works on some devices and silently yields
// nothing on others. Doing the assertion here means the caller always has real
// bytes or a real error, never an empty success.
export async function registerPasskey(salt: string, userHandle: string): Promise<PasskeyRegistration> {
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const created = (await navigator.credentials.create({
    publicKey: {
      challenge,
      rp: { name: RP_NAME },
      user: {
        // The SALT is the credential's user id — stable for the life of the wallet,
        // and the one value that is known both when the wallet is created and on
        // every later device. The address would have been the obvious choice and
        // cannot be used: at provisioning time it does not exist yet.
        id: new TextEncoder().encode(salt),
        // What a passkey manager SHOWS. It has to name what it unlocks, so it is
        // the user's handle rather than an address or a salt they have never read.
        name: userHandle,
        displayName: `Splitsy — ${userHandle}`,
      },
      // ES256 only. The whole design rests on P-256, and offering RS256 would let
      // an authenticator pick a curve the rest of this cannot use.
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      authenticatorSelection: {
        // Platform, so it is Face ID / Touch ID / Windows Hello and syncs through
        // the OS keychain — which is the entire recovery argument for passkeys.
        authenticatorAttachment: "platform",
        // Resident, so a later get() finds it with no allowlist and works on a
        // fresh device where we hold no credential id.
        residentKey: "required",
        userVerification: "required",
      },
      extensions: { prf: {} } as AuthenticationExtensionsClientInputs,
      timeout: 120_000,
    },
  })) as PublicKeyCredential | null;

  if (!created) throw new Error("Passkey registration was cancelled.");

  const enabled = (created.getClientExtensionResults() as { prf?: { enabled?: boolean } }).prf?.enabled;
  if (enabled === false) {
    throw new Error("This browser registered a passkey but cannot derive a key from it (no PRF support).");
  }

  const credentialId = toBase64Url(new Uint8Array(created.rawId));
  // The assertion that actually yields the bytes.
  const secret = await passkeyOwnerSecret(salt, credentialId);
  return { credentialId, secret };
}

// The 32 bytes this wallet's passkey releases. Same input, same output, every time
// and on every synced device — which is what makes it usable as a key.
//
// THROWS RATHER THAN RETURNING EMPTY. A caller that got zero bytes and carried on
// would derive a key from nothing and hand it to Privy as a wallet owner, which is
// unrecoverable by construction.
export async function passkeyOwnerSecret(salt: string, credentialId?: string | null): Promise<Uint8Array> {
  const assertion = (await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      // The allowlist is a HINT, not a requirement: the credential is resident, so
      // discovery works without it. Passing it when we have it is what makes the
      // prompt name the right passkey instead of offering every one on the device.
      ...(credentialId ? { allowCredentials: [{ type: "public-key" as const, id: fromBase64Url(credentialId) }] } : {}),
      userVerification: "required",
      extensions: { prf: { eval: { first: prfSalt(salt) } } } as AuthenticationExtensionsClientInputs,
      timeout: 120_000,
    },
  })) as PublicKeyCredential | null;

  if (!assertion) throw new Error("Passkey was cancelled.");

  const results = (assertion.getClientExtensionResults() as { prf?: { results?: { first?: ArrayBuffer } } }).prf?.results;
  if (!results?.first) {
    throw new Error("This passkey did not return a key. Your browser may not support PRF — use your recovery password.");
  }
  return new Uint8Array(results.first);
}
