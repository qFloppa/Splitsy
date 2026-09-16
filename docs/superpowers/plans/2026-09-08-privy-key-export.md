# Privy Wallet — User Key Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a Splitsy user on the Privy wallet stack export their pay wallet's private key, with an export credential only they hold, so the server can relay the export but never read it.

**Architecture:** Every Privy wallet is minted with our key quorum as **both** `owner_id` and `additional_signer`. The first time a user enables export, the browser derives a P-256 key from a password (PBKDF2, never sent to us) and the server transfers wallet **ownership** to that key — spending keeps working because it rides on the additional signer, not on ownership. To export, the browser generates an ephemeral HPKE keypair, builds and signs the Privy authorization payload itself, and our route relays the request and returns ciphertext it cannot decrypt.

**Tech Stack:** Next.js 16.2.9 (App Router), React 19, TypeScript, `@privy-io/node@0.34.0`, `@hpke/core` + `@hpke/chacha20poly1305`, `@noble/curves@1.4.2`, `@noble/hashes@1.8.0`, `canonicalize@2.1.0`, viem 2.52.2, Supabase, `node:test`.

**Spec:** `docs/superpowers/specs/2026-09-08-privy-key-export-design.md` (committed at `34d1916`). Read it before Task 1; every task below argues from it.

---

## Global Constraints

- **Branch:** `privy-wallet-stack`. Do not merge to `main`. Production (`splitsy.xyz`) never sets `WALLET_PROVIDER` and must stay on the Circle stack.
- **Preview environment only.** Supabase project `splitsy-test` (`hdyioojrozodmutpldsu`). Never run any script or migration against production project `hvckneltkugnvtwfrzlb`.
- **`AGENTS.md`:** "This is NOT the Next.js you know." Before writing any route handler or client component, read the relevant guide in `node_modules/next/dist/docs/`. APIs and conventions may differ from your training data.
- **Never print, log, or write to disk any plaintext private key, password, or derived secret key — including in tests and scripts.** Report byte lengths and boolean verdicts only. This applies to `console.log`, error messages, and thrown exceptions.
- **Never use `privy().wallets().exportPrivateKey()` or `.exportSeedPhrase()` or `.export()`.** They exist in the SDK (`node_modules/@privy-io/node/public-api/services/wallets.js:94-121`) and they generate the HPKE recipient keypair **on the server and return plaintext**, which is exactly what this design rejects. Use the raw generated `privy().wallets()._export(...)` with a browser-supplied `recipient_public_key`.
- **`@noble/curves` has two installed versions.** Root is **1.4.2** (viem's) — import from `@noble/curves/p256`, and signatures use `.toDERRawBytes()`. Privy's nested copy is 1.9.7 and uses `@noble/curves/nist` + `.toBytes('der')` — **that subpath does not resolve from our code.** Always use the 1.4.2 API.
- **Test runner:** `node --test --experimental-strip-types <files…>`. There is no `npm test`. A new `lib/*.test.ts` is invisible until added to a named script line in `package.json`.
- **Import style in `lib/`:** relative imports carry the `.ts` extension (types are stripped, not compiled). In `app/`, use the `@/lib/...` alias.
- **Commit frequently**, one commit per task minimum. Do not push.
- **Precondition:** `docs/deployments.md` has an uncommitted 19-line addition on this branch. Commit or stash it before starting so task diffs stay clean.
- **Required env vars** (already set on Preview; needed locally in `.env.local` for scripts): `PRIVY_APP_ID`, `PRIVY_APP_SECRET`, `PRIVY_KEY_QUORUM_ID`, `PRIVY_AUTHORIZATION_PRIVATE_KEY`, `WALLET_PROVIDER=privy`, `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SESSION_SECRET`, `ARC_TESTNET_RPC_URL`.

---

## File Structure

| File | Responsibility |
|---|---|
| `lib/export-crypto.ts` (create) | Isomorphic, pure. Password→P-256 derivation, SPKI encoding, canonical authorization payload, DER signature, HPKE recipient + decrypt, exported-key verification. No network, no SDK, no secrets logged. Runs identically in the browser and under `node --test`. |
| `lib/export-crypto.test.ts` (create) | The six offline checks for the above. |
| `lib/privy-wallets-repo.ts` (modify) | Gains `export_owner_key` on the row type, `getPrivyWalletByWalletId`, `setExportOwnerKey`; `privy_user_id` becomes optional. |
| `lib/privy-wallet.ts` (modify) | `walletSpec` gains `owner_id` + idempotency key; `getOrCreateWallet` rewritten onto `wallets().create()`; three new exported server functions for ownership and export relay. |
| `schema-privy-wallets.sql` (modify) | Additive migration: `export_owner_key`, `privy_user_id` nullable. |
| `app/api/wallet/export/route.ts` (create) | GET status, PUT enable/restore, POST export relay. Session + unlock-cookie gated, `no-store`. |
| `app/ExportTab.tsx` (create) | Client component. The whole browser-side ceremony: enable, verify, export, reveal, discard. |
| `app/XAuthControl.tsx` (modify) | Fifth tab entry + switch branch; custody disclosure under the address. |
| `app/api/stack/route.ts` (modify) | Creation-property assertion for the newest wallet. |
| `scripts/privy-export-probe.ts` (create) | One-off live proof of the whole Privy round-trip. |
| `scripts/privy-remint.ts` (create) | One-off: mint the exportable pay wallet, sweep, repoint the rows, delete dead probe rows. |

---

### Task 1: Declare the dependencies we are already using

**Files:**
- Modify: `package.json:37-75` (dependencies block)

**Interfaces:**
- Consumes: nothing.
- Produces: resolvable bare imports for `@hpke/core`, `@hpke/chacha20poly1305`, `@noble/curves`, `@noble/hashes`, `canonicalize` from both `lib/` and `app/`.

**Why:** `@privy-io/node` is imported by `lib/privy-wallet.ts` but is **not declared** in `package.json` — it only works because it is installed. The HPKE and noble packages are transitive dependencies of that undeclared package. Relying on a transitive dependency of an undeclared dependency in *client* bundle code is how a build breaks on a clean `npm ci`.

- [ ] **Step 1: Confirm the installed versions before declaring them**

Run:
```bash
node -e "for (const p of ['@privy-io/node','@hpke/core','@hpke/chacha20poly1305','@noble/curves','@noble/hashes','canonicalize']) console.log(p, require(\`./node_modules/\${p}/package.json\`).version)"
```
Expected output (exactly these — if any differ, stop and report):
```
@privy-io/node 0.34.0
@hpke/core 1.9.0
@hpke/chacha20poly1305 1.8.0
@noble/curves 1.4.2
@noble/hashes 1.8.0
canonicalize 2.1.0
```

- [ ] **Step 2: Add the six dependencies**

In `package.json`, inside `"dependencies"`, add these entries (keep the block alphabetically sorted — `@hpke/*` sort before `@marsidev`, `@noble/*` after `@nomicfoundation` is wrong, they go after `@marsidev`; place by exact string order):

```json
    "@hpke/chacha20poly1305": "1.8.0",
    "@hpke/core": "1.9.0",
    "@noble/curves": "1.4.2",
    "@noble/hashes": "1.8.0",
    "canonicalize": "2.1.0",
```

`@privy-io/node` is already present at `"0.34.0"` — verify it is there and do not duplicate it.

**Pin exact versions, no `^`.** `@noble/curves` especially: a `^1.4.2` range would float to 1.9.x, whose signature API is `.toBytes('der')` instead of `.toDERRawBytes()`, silently breaking every signature this feature produces.

- [ ] **Step 3: Verify the tree is consistent and nothing was re-resolved**

Run:
```bash
npm install --package-lock-only && node -e "console.log(require('./node_modules/@noble/curves/package.json').version)"
```
Expected: `1.4.2`. If npm hoisted a different version, stop and report — do not proceed.

- [ ] **Step 4: Verify the bare imports resolve**

Run:
```bash
node --input-type=module -e "
import { CipherSuite, DhkemP256HkdfSha256, HkdfSha256 } from '@hpke/core';
import { Chacha20Poly1305 } from '@hpke/chacha20poly1305';
import { p256 } from '@noble/curves/p256';
import { sha256 } from '@noble/hashes/sha2';
import canonicalize from 'canonicalize';
console.log('resolved', typeof CipherSuite, typeof Chacha20Poly1305, typeof p256.sign, typeof sha256, typeof canonicalize);
"
```
Expected: `resolved function function function function function`

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(deps): declare the packages the Privy stack already imports"
```

---

### Task 2: Canonical authorization payload and DER signature

**Files:**
- Create: `lib/export-crypto.ts`
- Create: `lib/export-crypto.test.ts`
- Modify: `package.json` (the `test:wallet-provider` script line)

**Interfaces:**
- Consumes: Task 1's declared dependencies.
- Produces:
  - `PRIVY_API_BASE: string` — `"https://api.privy.io"`
  - `type AuthorizationInput = { version: 1; method: string; url: string; body: unknown; headers: { "privy-app-id": string } }`
  - `exportRequestInput(walletId: string, appId: string, recipientPublicKey: string): AuthorizationInput`
  - `canonicalPayload(input: AuthorizationInput): Uint8Array`
  - `signAuthorization(payload: Uint8Array, secretKey: Uint8Array): string` — base64 DER
  - `base64FromBytes(bytes: Uint8Array): string`
  - `bytesFromBase64(b64: string): Uint8Array`

**Why this is the load-bearing test:** the canonical payload is the *only* thing we reimplement from the SDK. Privy verifies the signature over bytes it reconstructs itself; one byte of drift is a 401 with no diagnostic. We must be byte-identical to `formatRequestForAuthorizationSignature`.

- [ ] **Step 1: Write the failing test**

Create `lib/export-crypto.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { formatRequestForAuthorizationSignature, generateAuthorizationSignature, generateP256KeyPair } from "@privy-io/node";
import { p256 } from "@noble/curves/p256";
import { sha256 } from "@noble/hashes/sha2";
import {
  base64FromBytes,
  bytesFromBase64,
  canonicalPayload,
  exportRequestInput,
  signAuthorization,
} from "./export-crypto.ts";

// The one thing we reimplement from the SDK. Privy rebuilds these bytes on its
// side and verifies the signature over them, so drift here is a 401 carrying no
// clue about why. structuredClone because the SDK's formatter MUTATES its input.
test("the canonical payload is byte-identical to the SDK's", () => {
  const input = exportRequestInput("wal_123", "app_456", "c3Bpa2k=");
  const ours = canonicalPayload(input);
  const theirs = formatRequestForAuthorizationSignature(structuredClone(input) as never);
  assert.deepEqual(ours, theirs);
});

test("an empty body serialises as an empty string, as the SDK does", () => {
  const input = { version: 1 as const, method: "POST", url: "https://x/y", body: {}, headers: { "privy-app-id": "a" } };
  assert.deepEqual(canonicalPayload(input), formatRequestForAuthorizationSignature(structuredClone(input) as never));
});

// WebCrypto's ECDSA sign returns raw r||s; Privy wants DER. Getting this wrong
// produces a well-formed request that is rejected, so it gets its own check.
test("our signature is DER and verifies under the derived public key", () => {
  const secretKey = p256.utils.randomPrivateKey();
  const input = exportRequestInput("wal_123", "app_456", "c3Bpa2k=");
  const payload = canonicalPayload(input);
  const signature = signAuthorization(payload, secretKey);
  const der = bytesFromBase64(signature);
  assert.equal(der[0], 0x30, "a DER ECDSA signature starts with SEQUENCE (0x30)");
  assert.ok(p256.verify(der, sha256(payload), p256.getPublicKey(secretKey, false)));
});

test("a signature the SDK produced verifies under our verifier", async () => {
  const keypair = await generateP256KeyPair();
  const input = exportRequestInput("wal_123", "app_456", "c3Bpa2k=");
  const payload = canonicalPayload(input);
  const signature = generateAuthorizationSignature({ authorizationPrivateKey: keypair.privateKey, input: payload });
  // The last 65 bytes of a P-256 SPKI are the uncompressed point.
  const point = bytesFromBase64(keypair.publicKey).slice(-65);
  assert.equal(point[0], 0x04, "an uncompressed EC point starts with 0x04");
  assert.ok(p256.verify(bytesFromBase64(signature), sha256(payload), point));
});

test("base64 round-trips without Buffer", () => {
  const bytes = new Uint8Array([0, 1, 127, 128, 255, 254]);
  assert.deepEqual(bytesFromBase64(base64FromBytes(bytes)), bytes);
});
```

- [ ] **Step 2: Add the test file to a runnable script**

In `package.json`, change the `test:wallet-provider` line to include the new file:

```json
    "test:wallet-provider": "node --test --experimental-strip-types lib/wallet-provider.test.ts lib/privy-wallet.test.ts lib/arc-explorer.test.ts lib/export-crypto.test.ts",
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm run test:wallet-provider`
Expected: FAIL — `Cannot find module './export-crypto.ts'`

- [ ] **Step 4: Write the minimal implementation**

Create `lib/export-crypto.ts`:

```ts
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
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run test:wallet-provider`
Expected: PASS — all five new tests, plus the pre-existing `wallet-provider` / `privy-wallet` / `arc-explorer` tests still green.

- [ ] **Step 6: Commit**

```bash
git add lib/export-crypto.ts lib/export-crypto.test.ts package.json
git commit -m "feat(export): canonical Privy authorization payload and DER signature"
```

---

### Task 3: Derive the export credential from a password

**Files:**
- Modify: `lib/export-crypto.ts`
- Modify: `lib/export-crypto.test.ts`

**Interfaces:**
- Consumes: `base64FromBytes` from Task 2.
- Produces:
  - `PBKDF2_ITERATIONS: number` — `600_000`
  - `MIN_PASSWORD_LENGTH: number` — `12`
  - `exportSalt(walletAddress: string): string`
  - `validScalar(bytes: Uint8Array): Uint8Array`
  - `deriveOwnerSecretKey(password: string, walletAddress: string): Promise<Uint8Array>`
  - `ownerPublicKeySpki(secretKey: Uint8Array): Promise<string>` — base64 SPKI

- [ ] **Step 1: Write the failing tests**

Append to `lib/export-crypto.test.ts`:

```ts
import { deriveOwnerSecretKey, exportSalt, ownerPublicKeySpki, validScalar } from "./export-crypto.ts";

const ADDRESS = "0xa264A3818F20f878380B5Af9154080605de9a704";

// The salt is lowercased so the derivation cannot be broken by the casing bug in
// setUserWallet (lib/users-repo.ts:45), which stores Privy's checksummed address
// verbatim while every other writer lowercases.
test("the salt is case-insensitive in the address", () => {
  assert.equal(exportSalt(ADDRESS), exportSalt(ADDRESS.toLowerCase()));
  assert.equal(exportSalt(ADDRESS), `splitsy-export:${ADDRESS.toLowerCase()}`);
});

// PBKDF2 output is uniform over 2^256, so a value outside the P-256 scalar range
// is a ~2^-32 event that will never be seen in practice and must still be TOTAL
// and DETERMINISTIC — re-hash, never randomise, or the same password stops
// producing the same wallet owner.
test("an out-of-range scalar is re-hashed deterministically, never randomised", () => {
  const zero = new Uint8Array(32);
  const first = validScalar(zero);
  assert.notDeepEqual(first, zero, "zero is not a valid P-256 secret key");
  assert.deepEqual(validScalar(zero), first, "the repair must be deterministic");

  const order = new Uint8Array(32);
  const n = p256.CURVE.n;
  for (let i = 0; i < 32; i++) order[31 - i] = Number((n >> BigInt(8 * i)) & 0xffn);
  assert.notDeepEqual(validScalar(order), order, "the curve order itself is out of range");
});

test("a valid scalar is returned untouched", () => {
  const key = p256.utils.randomPrivateKey();
  assert.deepEqual(validScalar(key), key);
});

test("derivation is deterministic, and the salt separates wallets", async () => {
  const a = await deriveOwnerSecretKey("correct horse battery staple", ADDRESS);
  const b = await deriveOwnerSecretKey("correct horse battery staple", ADDRESS);
  const c = await deriveOwnerSecretKey("correct horse battery staple", "0x0000000000000000000000000000000000000001");
  assert.equal(a.length, 32);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
});

// Privy rejects a raw uncompressed point with "Must be a base64-encoded,
// SPKI-formatted ECDH or ECDSA public key" — and the SDK's own documented example
// for recipient_public_key IS a raw point. This asserts the format Privy wants.
test("the owner public key is base64 SPKI that WebCrypto will re-import", async () => {
  const secretKey = p256.utils.randomPrivateKey();
  const spki = await ownerPublicKeySpki(secretKey);
  const bytes = bytesFromBase64(spki);
  assert.equal(bytes.length, 91, "a P-256 SPKI is 91 bytes");
  assert.deepEqual(bytes.slice(-65), p256.getPublicKey(secretKey, false));
  const imported = await crypto.subtle.importKey("spki", bytes, { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"]);
  assert.equal(imported.type, "public");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test:wallet-provider`
Expected: FAIL — `The requested module './export-crypto.ts' does not provide an export named 'deriveOwnerSecretKey'`

- [ ] **Step 3: Write the implementation**

Append to `lib/export-crypto.ts`:

```ts
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
  const point = p256.getPublicKey(secretKey, false);
  const key = await crypto.subtle.importKey("raw", point, { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"]);
  return base64FromBytes(new Uint8Array(await crypto.subtle.exportKey("spki", key)));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test:wallet-provider`
Expected: PASS — all tests green.

- [ ] **Step 5: Commit**

```bash
git add lib/export-crypto.ts lib/export-crypto.test.ts
git commit -m "feat(export): derive the owner P-256 key from an export password"
```

---

### Task 4: HPKE recipient, decryption, and the address check

**Files:**
- Modify: `lib/export-crypto.ts`
- Modify: `lib/export-crypto.test.ts`

**Interfaces:**
- Consumes: `base64FromBytes` / `bytesFromBase64` from Task 2.
- Produces:
  - `type ExportRecipient = { publicKeySpkiBase64: string; open(encapsulatedKeyBase64: string, ciphertextBase64: string): Promise<string> }`
  - `createExportRecipient(): Promise<ExportRecipient>`
  - `verifyExportedKey(privateKeyHex: string, walletAddress: string): boolean`

**Why:** the suite must match Privy's exactly (`DHKEM(P-256, HKDF-SHA256)` / `HKDF-SHA256` / `ChaCha20-Poly1305`), read from the SDK's own `setupHPKERecipient` at `node_modules/@privy-io/node/lib/cryptography.mjs:76-95`. The address check is what stops a key we cannot prove belongs to this wallet from ever reaching the screen.

- [ ] **Step 1: Write the failing tests**

Append to `lib/export-crypto.test.ts`:

```ts
import { CipherSuite, DhkemP256HkdfSha256, HkdfSha256 } from "@hpke/core";
import { Chacha20Poly1305 } from "@hpke/chacha20poly1305";
import { generatePrivateKey, privateKeyToAddress } from "viem/accounts";
import { createExportRecipient, verifyExportedKey } from "./export-crypto.ts";

// Proves our copied suite matches Privy's. A mismatch here fails as an opaque
// "decryption failed" against live infrastructure, so it is settled offline.
// The plaintext is a fixed non-secret string, never a real key.
test("HPKE decrypt round-trips against a sender built on the same suite", async () => {
  const recipient = await createExportRecipient();
  const suite = new CipherSuite({
    kem: new DhkemP256HkdfSha256(),
    kdf: new HkdfSha256(),
    aead: new Chacha20Poly1305(),
  });
  const recipientPublicKey = await suite.kem.deserializePublicKey(bytesFromBase64(recipient.publicKeySpkiBase64));
  const sender = await suite.createSenderContext({ recipientPublicKey });
  const plaintext = "not-a-key-just-a-fixture";
  const ciphertext = await sender.seal(new TextEncoder().encode(plaintext));

  const opened = await recipient.open(
    base64FromBytes(new Uint8Array(sender.enc)),
    base64FromBytes(new Uint8Array(ciphertext)),
  );
  assert.equal(opened, plaintext);
});

test("each recipient is ephemeral — two calls produce different public keys", async () => {
  const a = await createExportRecipient();
  const b = await createExportRecipient();
  assert.notEqual(a.publicKeySpkiBase64, b.publicKeySpkiBase64);
});

// The guard that keeps an unprovable key off the screen. A decrypted key that
// does not derive to this wallet's address is a hard failure, never a display.
test("the exported key is accepted only for its own address", () => {
  const key = generatePrivateKey();
  const address = privateKeyToAddress(key);
  assert.ok(verifyExportedKey(key, address));
  assert.ok(verifyExportedKey(key.slice(2), address), "a key with no 0x prefix is still this key");
  assert.ok(verifyExportedKey(key, address.toLowerCase()), "the comparison is case-insensitive");
  assert.equal(verifyExportedKey(key, "0x0000000000000000000000000000000000000001"), false);
});

test("malformed key material is rejected rather than thrown at the caller", () => {
  assert.equal(verifyExportedKey("", "0x0000000000000000000000000000000000000001"), false);
  assert.equal(verifyExportedKey("not-hex", "0x0000000000000000000000000000000000000001"), false);
  assert.equal(verifyExportedKey("0xdeadbeef", "0x0000000000000000000000000000000000000001"), false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test:wallet-provider`
Expected: FAIL — `does not provide an export named 'createExportRecipient'`

- [ ] **Step 3: Write the implementation**

Append to `lib/export-crypto.ts`. Add these imports at the top of the file with the others:

```ts
import { Chacha20Poly1305 } from "@hpke/chacha20poly1305";
import { CipherSuite, DhkemP256HkdfSha256, HkdfSha256 } from "@hpke/core";
import { privateKeyToAddress } from "viem/accounts";
```

Then append:

```ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test:wallet-provider`
Expected: PASS — all tests green. This is the full offline suite from spec §6.

- [ ] **Step 5: Commit**

```bash
git add lib/export-crypto.ts lib/export-crypto.test.ts
git commit -m "feat(export): HPKE recipient, decryption, and the address check"
```

---

### Task 5: Prove the whole round-trip against live Privy

**Files:**
- Create: `scripts/privy-export-probe.ts`
- Modify: `package.json` (add a `privy:export-probe` script)

**Interfaces:**
- Consumes: everything from Tasks 2–4.
- Produces: a verdict, not code other tasks depend on. **This is the gate for Tasks 7–10** — if the suite or the signature shape is wrong, the route and the UI are built on sand.

**Why first:** the spike behind the spec proved every step of this *except decryption* — it reported byte lengths only. The HPKE suite is read from the SDK, not measured. Settle it before any route exists.

- [ ] **Step 1: Write the probe**

Create `scripts/privy-export-probe.ts`:

```ts
// One-off proof that the export design works end to end against live Privy.
// Throwaway wallet, testnet, no user data. Run once; keep it committed so the
// next person can re-run it after an SDK bump.
//
// NEVER PRINTS KEY MATERIAL. Verdicts and byte lengths only — the exported key
// is checked by deriving its address and comparing, which proves it is right
// without showing it.
//
//   npm run privy:export-probe
import { PrivyClient } from "@privy-io/node";
import { privateKeyToAddress } from "viem/accounts";
import {
  canonicalPayload,
  createExportRecipient,
  deriveOwnerSecretKey,
  exportRequestInput,
  ownerPublicKeySpki,
  signAuthorization,
  verifyExportedKey,
} from "../lib/export-crypto.ts";

const appId = process.env.PRIVY_APP_ID!;
const appSecret = process.env.PRIVY_APP_SECRET!;
const quorum = process.env.PRIVY_KEY_QUORUM_ID!;
const authKey = process.env.PRIVY_AUTHORIZATION_PRIVATE_KEY!;
for (const [name, value] of Object.entries({ PRIVY_APP_ID: appId, PRIVY_APP_SECRET: appSecret, PRIVY_KEY_QUORUM_ID: quorum, PRIVY_AUTHORIZATION_PRIVATE_KEY: authKey })) {
  if (!value) throw new Error(`${name} is not set`);
}

const privy = new PrivyClient({ appId, appSecret });
const authorization_context = { authorization_private_keys: [authKey] };
const ok = (label: string, pass: boolean, detail = "") => {
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
  if (!pass) process.exitCode = 1;
};

// 1. Mint with owner_id AND additional_signers — the shape the whole design rests on.
const wallet = await privy.wallets().create({
  chain_type: "ethereum",
  owner_id: quorum,
  additional_signers: [{ signer_id: quorum }],
  idempotency_key: `probe:${Date.now()}`,
});
console.log(`probe wallet ${wallet.id} ${wallet.address}`);
ok("owner_id is our quorum at creation", wallet.owner_id === quorum, String(wallet.owner_id));
ok(
  "our quorum is an additional signer at creation",
  (wallet.additional_signers ?? []).some((s) => s.signer_id === quorum),
);

// 2. Spend before the transfer — signTransaction is the control.
const signedBefore = await privy
  .wallets()
  .ethereum()
  .signTransaction(wallet.id, {
    params: { transaction: { to: "0x0000000000000000000000000000000000000001", nonce: "0x0", chain_id: 5042002, type: 2, gas_limit: "0x5208", max_fee_per_gas: "0x3b9aca00", max_priority_fee_per_gas: "0x3b9aca00" } },
    authorization_context,
  });
ok("the server can sign BEFORE the transfer", signedBefore.signed_transaction.startsWith("0x02"), `${signedBefore.signed_transaction.length} chars`);

// 3. Transfer ownership to a password-derived key.
const PROBE_PASSWORD = "probe-password-not-a-real-credential";
const secretKey = await deriveOwnerSecretKey(PROBE_PASSWORD, wallet.address);
const publicKey = await ownerPublicKeySpki(secretKey);
const updated = await privy.wallets().update(wallet.id, { owner: { public_key: publicKey }, authorization_context });
ok("ownership moved off our quorum", updated.owner_id !== quorum, String(updated.owner_id));
ok(
  "our quorum is STILL an additional signer after the transfer",
  (updated.additional_signers ?? []).some((s) => s.signer_id === quorum),
);

// 4. Our authorization signature must now be REQUIRED — the server's must fail.
let serverExportRefused = false;
try {
  const rejected = await createExportRecipient();
  await privy.wallets()._export(wallet.id, {
    encryption_type: "HPKE",
    recipient_public_key: rejected.publicKeySpkiBase64,
    "privy-authorization-signature": signAuthorization(
      canonicalPayload(exportRequestInput(wallet.id, appId, rejected.publicKeySpkiBase64)),
      await deriveOwnerSecretKey("a-different-password", wallet.address),
    ),
  });
} catch {
  serverExportRefused = true;
}
ok("export signed by the WRONG key is refused", serverExportRefused);

// 5. The real thing: browser-shaped signature, browser-held recipient key.
const recipient = await createExportRecipient();
const signature = signAuthorization(
  canonicalPayload(exportRequestInput(wallet.id, appId, recipient.publicKeySpkiBase64)),
  secretKey,
);
const response = await privy.wallets()._export(wallet.id, {
  encryption_type: "HPKE",
  recipient_public_key: recipient.publicKeySpkiBase64,
  "privy-authorization-signature": signature,
});
console.log(`ciphertext ${response.ciphertext.length} b64 chars, encap ${response.encapsulated_key.length} b64 chars`);

const plaintext = await recipient.open(response.encapsulated_key, response.ciphertext);
ok("the decrypted key derives to THIS wallet", verifyExportedKey(plaintext, wallet.address));
ok(
  "the decrypted key is 64 hex characters",
  /^(0x)?[0-9a-fA-F]{64}$/.test(plaintext),
  `${plaintext.length} chars`,
);
// Derived, not printed. This is the only place the address is recomputed from the key.
const hex = plaintext.startsWith("0x") ? plaintext : `0x${plaintext}`;
console.log(`derived address ${privateKeyToAddress(hex as `0x${string}`)} (expected ${wallet.address})`);

// 6. Spending must still work after the transfer.
const signedAfter = await privy
  .wallets()
  .ethereum()
  .signTransaction(wallet.id, {
    params: { transaction: { to: "0x0000000000000000000000000000000000000001", nonce: "0x0", chain_id: 5042002, type: 2, gas_limit: "0x5208", max_fee_per_gas: "0x3b9aca00", max_priority_fee_per_gas: "0x3b9aca00" } },
    authorization_context,
  });
ok("the server can STILL sign after the transfer", signedAfter.signed_transaction.startsWith("0x02"), `${signedAfter.signed_transaction.length} chars`);

console.log(process.exitCode ? "\nPROBE FAILED — do not proceed to the route or the UI." : "\nPROBE PASSED — the design holds against live Privy.");
```

- [ ] **Step 2: Add the script**

In `package.json`, next to the other `privy:*` scripts, add:

```json
    "privy:export-probe": "node --experimental-strip-types --env-file=.env.local scripts/privy-export-probe.ts",
```

- [ ] **Step 3: Run the probe**

Run: `npm run privy:export-probe`

Expected: every line `PASS`, ending in `PROBE PASSED — the design holds against live Privy.`

**If any line reads FAIL, stop and report before writing any further code.** The likely causes, in order:
- *"the decrypted key derives to THIS wallet" fails* — the HPKE suite is wrong. Re-read `node_modules/@privy-io/node/lib/cryptography.mjs:76-95` and match `exportSuite()` to it exactly.
- *the export call 401s* — the canonical payload or the URL differs from what Privy reconstructs. Compare `exportRequestInput`'s `url` against `node_modules/@privy-io/node/public-api/services/wallets.js:106`.
- *"export signed by the WRONG key is refused" fails* — ownership did not actually transfer; the whole design is void. Report immediately.

- [ ] **Step 4: Commit**

```bash
git add scripts/privy-export-probe.ts package.json
git commit -m "test(export): prove the Privy export round-trip end to end"
```

---

### Task 6: Record the export credential in `privy_wallets`

**Files:**
- Modify: `schema-privy-wallets.sql:10-25`
- Modify: `lib/privy-wallets-repo.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `PrivyWalletRow` gains `export_owner_key: string | null`; `privy_user_id` becomes `string | null` and optional on insert.
  - `getPrivyWalletByWalletId(walletId: string): Promise<PrivyWalletRow | null>`
  - `setExportOwnerKey(namespace: string, key: string, publicKey: string): Promise<void>`

- [ ] **Step 1: Add the migration to the schema file**

Append to `schema-privy-wallets.sql`:

```sql
-- Export ownership (2026-09-08). Additive; safe to re-run.
--
-- export_owner_key is a CACHE, NEVER AN AUTHORITY. Privy decides who may export;
-- this column only lets the browser reject a wrong password before making a
-- request, and lets the UI say which side of the line a wallet is on. Null means
-- "Splitsy still administers this wallet"; non-null means ownership has
-- transferred and only that key can export. A wrong value here is annoying — the
-- local pre-check fails until the user re-enters the right password — and never
-- dangerous, because Privy is the real gate.
alter table privy_wallets add column if not exists export_owner_key text;

-- Wallets are created via wallets().create() now, which has no Privy user at all,
-- so nothing writes this any more. Kept rather than dropped so the migration is
-- additive and the existing rows stay readable.
alter table privy_wallets alter column privy_user_id drop not null;
```

- [ ] **Step 2: Apply the migration to Preview**

Run the two `alter table` statements above in the Supabase SQL editor for project `splitsy-test` (`hdyioojrozodmutpldsu`). **Not** against production `hvckneltkugnvtwfrzlb`.

Verify:
```sql
select column_name, is_nullable from information_schema.columns
where table_name = 'privy_wallets' order by ordinal_position;
```
Expected: `export_owner_key` present and nullable; `privy_user_id` `is_nullable = YES`.

- [ ] **Step 3: Update the repository module**

In `lib/privy-wallets-repo.ts`, replace the row type and add the two functions:

```ts
export type PrivyWalletRow = {
  namespace: string;
  key: string;
  privy_user_id?: string | null;
  wallet_id: string;
  address: string;
  export_owner_key?: string | null;
};
```

Change the `select` in `getPrivyWallet` (line 20) to include the new column:

```ts
    .select("namespace, key, privy_user_id, wallet_id, address, export_owner_key")
```

Then append:

```ts
// The route holds a wallet id (users.circle_wallet_id, which on this stack holds
// the PRIVY wallet id) and needs the row it belongs to. Deliberately keyed on
// wallet_id rather than address: address casing is inconsistent across writers —
// setUserWallet stores Privy's checksummed form, setUserAgentWallet lowercases —
// and a lookup that can miss on casing would read as "no wallet" and 404 a user
// out of their own export.
export async function getPrivyWalletByWalletId(walletId: string): Promise<PrivyWalletRow | null> {
  const client = requireClient();
  const { data, error } = await client
    .from("privy_wallets")
    .select("namespace, key, privy_user_id, wallet_id, address, export_owner_key")
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
```

- [ ] **Step 4: Verify it type-checks**

Run: `npx tsc --noEmit`
Expected: no errors. (`insertPrivyWallet` callers still pass `privy_user_id`; it is optional now, so both shapes compile.)

- [ ] **Step 5: Commit**

```bash
git add schema-privy-wallets.sql lib/privy-wallets-repo.ts
git commit -m "feat(export): record the export owner key on privy_wallets"
```

---

### Task 7: Server-side ownership transfer and export relay

**Files:**
- Modify: `lib/privy-wallet.ts` (add exports near the bottom, after `serverCanSign`)

**Interfaces:**
- Consumes: `privy()`, `quorumId()`, `authorizationContext()` — all module-private in `lib/privy-wallet.ts`, which is why these live there rather than in a new file.
- Produces:
  - `getWalletOwnerId(walletId: string): Promise<string | null>`
  - `transferExportOwnership(walletId: string, publicKeyBase64: string): Promise<string | null>` — returns the new `owner_id`
  - `exportWalletCiphertext(walletId, recipientPublicKey, authorizationSignature): Promise<{ ciphertext: string; encapsulated_key: string }>`

- [ ] **Step 1: Add the three functions**

Append to `lib/privy-wallet.ts`, immediately before `export const backend: WalletBackend = {`:

```ts
// ── User key export ────────────────────────────────────────────────────────────
// Design: docs/superpowers/specs/2026-09-08-privy-key-export-design.md
//
// These are NOT part of the WalletBackend seam. The seam has four methods and a
// Circle implementation, and a fifth would need a throwing stub over there for a
// capability Circle DCW does not have at all — its keys cannot be exported. The
// route checks walletProviderName() and imports this module directly instead.

// Who Privy says owns this wallet. The privy_wallets.export_owner_key column is a
// cache of the user's public key; THIS is the authority, and it is what the status
// route asks when the cache is empty — a wallet Privy says we no longer own, with
// no key recorded, is a half-finished setup rather than a fresh wallet.
export async function getWalletOwnerId(walletId: string): Promise<string | null> {
  return (await privy().wallets().get(walletId)).owner_id;
}

// Hand ownership to the user's P-256 key. Signed by OUR quorum because at this
// point we are still the owner — this is the one and only call in the system that
// can make this transition, and it is not reversible: afterwards our quorum is
// only an additional signer, which can spend but can never export or take
// ownership back (measured; see the spec's spike table).
//
// Spending is UNAFFECTED. additional_signers is untouched by this call, and the
// probe in scripts/privy-export-probe.ts asserts the server still signs afterwards.
export async function transferExportOwnership(walletId: string, publicKeyBase64: string): Promise<string | null> {
  const updated = await privy()
    .wallets()
    .update(walletId, { owner: { public_key: publicKeyBase64 }, authorization_context: authorizationContext() });
  return updated.owner_id;
}

// Relay, not reader. The recipient_public_key belongs to the USER'S TAB and the
// signature was produced there over a payload containing it, so we can neither
// substitute a recipient key we could decrypt (the signature would not verify) nor
// open what comes back.
//
// DELIBERATELY the raw generated _export, not wallets().exportPrivateKey() or
// .exportSeedPhrase() or .export(). Those three generate the HPKE recipient
// keypair ON THIS SERVER and return the private key in plaintext
// (public-api/services/wallets.js:94-121) — the exact outcome this design exists
// to prevent. They are also the ones you will find first when grepping for
// "export". Do not use them.
export async function exportWalletCiphertext(
  walletId: string,
  recipientPublicKey: string,
  authorizationSignature: string,
): Promise<{ ciphertext: string; encapsulated_key: string }> {
  const response = await privy().wallets()._export(walletId, {
    encryption_type: "HPKE",
    recipient_public_key: recipientPublicKey,
    "privy-authorization-signature": authorizationSignature,
  });
  // Only these two fields, explicitly. Whatever else the response carries has no
  // business reaching a browser.
  return { ciphertext: response.ciphertext, encapsulated_key: response.encapsulated_key };
}
```

- [ ] **Step 2: Verify it type-checks and the existing tests still pass**

Run: `npx tsc --noEmit && npm run test:wallet-provider`
Expected: no type errors; all tests pass. (`lib/privy-wallet.test.ts` imports only pure helpers, so adding SDK-calling exports does not affect it.)

- [ ] **Step 3: Commit**

```bash
git add lib/privy-wallet.ts
git commit -m "feat(export): server-side ownership transfer and export relay"
```

---

### Task 8: Mint wallets that can be exported

**Files:**
- Modify: `lib/privy-wallet.ts:16` (imports), `:552-606` (`walletSpec`, `ethereumWallet`, `serverCanSign`), `:620-694` (`getOrCreateWallet`)

**Interfaces:**
- Consumes: `getPrivyWallet` / `insertPrivyWallet` from Task 6.
- Produces: `backend.getOrCreateWallet(namespace, key)` — same signature, same return type `Promise<ProviderWallet | null>`. **No caller changes anywhere.** All ten call sites (`lib/oauth-callback.ts:100`, `lib/wallet-resolve.ts:25`, `lib/user-agent.ts:41`, `lib/erc8004.ts:373/387/429`, `app/api/pay/[token]/gateway/route.ts:42`, `app/api/agents/review/route.ts:61`, `app/api/agents/autopay/route.ts:562`, `scripts/service-agents-setup.ts:36`) keep working untouched.

**Why this is a rewrite and not a parameter:** `WalletCreationInput` — the shape `walletSpec()` returns, passed as `wallets:` to `users().create()` — **has no owner field**. Owners can only be set through `wallets().create()`, which has no Privy user at all. So the Privy-user indirection has nothing left to hold, and the four mechanisms that existed to work around `users().create()` not being idempotent go with it.

- [ ] **Step 1: Replace `walletSpec`**

Replace `lib/privy-wallet.ts:552-581` (the comment block and `const walletSpec`) with:

```ts
// Every wallet is created with the key quorum as BOTH owner and additional signer.
//
// OWNER is what makes export possible at all, and it is the one thing that cannot
// be added later: an additional signer can spend but can never export or take
// ownership, and taking ownership is itself owner-gated (measured — see the spike
// table in the design doc). Every wallet minted before this change is therefore
// permanently non-exportable, which is why scripts/privy-remint.ts exists.
//
// ADDITIONAL SIGNER is what keeps the server transacting after the user takes
// ownership of export. A first spike run without it lost signing on transfer,
// because signing had been riding on ownership. With both set explicitly,
// spending and ownership are independent — the finding the whole design rests on.
//
// A function, not a const, so a missing quorum id fails the call that needed it
// rather than the import — this module is loaded lazily by the seam and must not
// throw on load.
//
// The namespace is a parameter because the AGENT wallet gets one thing no other
// wallet does: the enclave policy. Only at creation. An agent wallet minted before
// PRIVY_AGENT_POLICY_ID was set carries no policy and cannot be given one from
// here, which is why this carries no backfill.
const walletSpec = (namespace: string, idempotencyKey: string) => ({
  chain_type: "ethereum" as const,
  owner_id: quorumId(),
  additional_signers: [
    {
      signer_id: quorumId(),
      // The agent is the one wallet a server spends from with no user in the
      // loop, so it is the one that gets an enclave-enforced ceiling. Pay wallets
      // are only ever spent on a request the user made.
      ...(namespace === "agent" && process.env.PRIVY_AGENT_POLICY_ID
        ? { override_policy_ids: [process.env.PRIVY_AGENT_POLICY_ID] }
        : {}),
    },
  ],
  idempotency_key: idempotencyKey,
});
```

- [ ] **Step 2: Delete `ethereumWallet` and `serverCanSign`**

Delete `lib/privy-wallet.ts:583-606` entirely — both functions and their comment blocks. Nothing else calls them.

`serverCanSign` going is a real loss of a guard, and it is deliberate: it only ever checked a wallet **adopted** from a pre-existing Privy user, and there are no longer Privy users to adopt from. Every wallet is now created by this module with our quorum by construction.

- [ ] **Step 3: Replace `getOrCreateWallet`**

Replace the whole `getOrCreateWallet` method inside `export const backend` (`lib/privy-wallet.ts:620-694`) with:

```ts
  // Our own table is the idempotency, not a Privy query. Every caller already
  // guards on a row of its own (lib/oauth-callback.ts:90, lib/wallet-resolve.ts,
  // lib/user-agent.ts); this is the net under that.
  async getOrCreateWallet(namespace: string, key: string): Promise<ProviderWallet | null> {
    const existing = await getPrivyWallet(namespace, key);
    if (existing) return { address: existing.address, walletId: existing.wallet_id };

    // create() is not idempotent on its own, and the IDEMPOTENCY KEY is what
    // replaces the users().getByCustomAuthID lookup this used to do: a retry —
    // one whose row insert failed, say — gets the SAME wallet back for 24 hours
    // rather than minting a second one and orphaning whatever the first was
    // funded with. Beyond that window our own row is the guard it always was, and
    // a wallet whose row never landed was never returned to a caller, so it was
    // never displayed and never funded.
    const wallet = await privy().wallets().create(walletSpec(namespace, `splitsy:${namespace}:${key}`));

    // Without a wallet id the server cannot sign, so stop here rather than after
    // somebody has funded an address that can never spend.
    if (!wallet.id) {
      throw new Error(
        `Privy wallet ${wallet.address} has no wallet id, so the server cannot sign for it — check ` +
          "PRIVY_KEY_QUORUM_ID, and that this PRIVY_APP_ID owns the wallet.",
      );
    }

    await insertPrivyWallet({ namespace, key, wallet_id: wallet.id, address: wallet.address });
    // Re-read rather than returning what WE got from Privy. Two concurrent
    // first-time resolutions of one key both miss the row and both create, and
    // ignoreDuplicates makes the loser's write a silent no-op — so the loser would
    // otherwise hand its own wallet to lib/oauth-callback.ts:100 to persist and
    // display while the table holds the winner's, and money sent to it would be
    // invisible to every later lookup. The idempotency key makes them the same
    // wallet inside the 24-hour window; outside it, this is still the tiebreak.
    const row = await getPrivyWallet(namespace, key);
    return row
      ? { address: row.address, walletId: row.wallet_id }
      : { address: wallet.address, walletId: wallet.id };
  },
```

- [ ] **Step 4: Clean up the now-unused imports**

At `lib/privy-wallet.ts:16`, the import becomes:

```ts
import { PrivyClient } from "@privy-io/node";
```

`NotFoundError`, `isEmbeddedWalletLinkedAccount` and `type User` are no longer referenced.

- [ ] **Step 5: Verify nothing else referenced the deleted code**

Run:
```bash
grep -rn "serverCanSign\|ethereumWallet\|getByCustomAuthID\|pregenerateWallets\|isEmbeddedWalletLinkedAccount" lib/ app/ scripts/ 2>/dev/null
```
Expected: no output. If anything is found, it must be handled before proceeding.

Run: `npx tsc --noEmit && npm run test:wallet-provider`
Expected: no type errors, tests pass.

- [ ] **Step 6: Verify a real wallet is minted with the new shape**

Run:
```bash
node --experimental-strip-types --env-file=.env.local -e "
process.env.WALLET_PROVIDER = 'privy';
const { backend } = await import('./lib/privy-wallet.ts');
const key = 'plan-task8-' + Date.now();
const w = await backend.getOrCreateWallet('spike', key);
const { PrivyClient } = await import('@privy-io/node');
const privy = new PrivyClient({ appId: process.env.PRIVY_APP_ID, appSecret: process.env.PRIVY_APP_SECRET });
const full = await privy.wallets().get(w.walletId);
console.log('owner_id === quorum:', full.owner_id === process.env.PRIVY_KEY_QUORUM_ID);
console.log('quorum is additional signer:', (full.additional_signers ?? []).some(s => s.signer_id === process.env.PRIVY_KEY_QUORUM_ID));
console.log('idempotent on retry:', (await backend.getOrCreateWallet('spike', key)).walletId === w.walletId);
"
```
Expected: three `true` lines.

- [ ] **Step 7: Clean up the probe row**

In the Supabase SQL editor for `splitsy-test`:
```sql
delete from privy_wallets where namespace = 'spike' and key like 'plan-task8-%';
```

- [ ] **Step 8: Commit**

```bash
git add lib/privy-wallet.ts
git commit -m "feat(export): mint wallets our quorum owns, so they can be exported later"
```

---

### Task 9: The export route

**Files:**
- Create: `app/api/wallet/export/route.ts`

**Interfaces:**
- Consumes: `getWalletOwnerId` / `transferExportOwnership` / `exportWalletCiphertext` (Task 7); `getPrivyWalletByWalletId` / `setExportOwnerKey` (Task 6).
- Produces (the contract `app/ExportTab.tsx` codes against in Task 10):
  - `GET /api/wallet/export` → `200 { state: "not_enabled" | "enabled" | "needs_restore", walletId: string, appId: string, address: string, exportOwnerKey: string | null }`
  - `PUT /api/wallet/export` body `{ publicKey: string }` → `200 { ok: true, state: "enabled" }`
  - `POST /api/wallet/export` body `{ recipientPublicKey: string, signature: string }` → `200 { ciphertext: string, encapsulated_key: string }`
  - Errors, all `{ error: string }`: `401` not signed in, `403` `"locked"`, `404` wrong stack, `409` no wallet, `400` malformed input, `502` Privy refused.

- [ ] **Step 1: Read the Next.js route handler guide**

Per `AGENTS.md`, before writing the route:
```bash
ls node_modules/next/dist/docs/
```
Read the guide covering route handlers and `Response`/`Request` conventions for this Next version (16.2.9). Follow it where it differs from `app/api/wallet/send/route.ts`.

- [ ] **Step 2: Write the route**

Create `app/api/wallet/export/route.ts`:

```ts
import { cookies } from "next/headers";
import {
  exportWalletCiphertext,
  getWalletOwnerId,
  transferExportOwnership,
} from "@/lib/privy-wallet";
import { getPrivyWalletByWalletId, setExportOwnerKey } from "@/lib/privy-wallets-repo";
import { getSessionUser } from "@/lib/session";
import { verifyWalletUnlock, WALLET_UNLOCK_COOKIE } from "@/lib/session-core";
import { walletProviderName } from "@/lib/wallet-provider";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Wallet key export. THE SERVER IS A RELAY, NOT A READER: the recipient key and
// the authorization signature are both made in the user's tab, and what comes back
// is ciphertext addressed to a private key only that tab holds.
//
// Design: docs/superpowers/specs/2026-09-08-privy-key-export-design.md
//
// no-store on every response. None of this is cacheable, and a shared cache
// holding an export response would hand ciphertext to the next reader — which is
// useless to them, but there is no reason to find out.
const NO_STORE = { "Cache-Control": "no-store" } as const;
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: NO_STORE });

// Base64 that decodes to a 91-byte P-256 SPKI. Validated at the boundary rather
// than passed through: an unchecked value here becomes a wallet owner nobody can
// reproduce, which is unrecoverable by construction.
function isSpkiBase64(value: unknown): value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length > 256) return false;
  try {
    return Buffer.from(value, "base64").length === 91;
  } catch {
    return false;
  }
}

// A DER ECDSA P-256 signature: SEQUENCE tag, and in the length band DER allows for
// two 32-byte integers with optional leading zero bytes.
function isDerSignatureBase64(value: unknown): value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length > 256) return false;
  try {
    const bytes = Buffer.from(value, "base64");
    return bytes.length >= 64 && bytes.length <= 80 && bytes[0] === 0x30;
  } catch {
    return false;
  }
}

type Gate =
  | { error: Response }
  | { userId: string; walletId: string; address: string; namespace: string; key: string; exportOwnerKey: string | null };

// Session, stack, wallet, and the PIN unlock — in that order, because each one
// makes the next question meaningful. Identical unlock treatment to
// app/api/wallet/send/route.ts: export is strictly more dangerous than a transfer,
// so it gets at least the same gate.
async function gate(): Promise<Gate> {
  if (walletProviderName() !== "privy") {
    // Not 403: on the Circle stack this capability does not exist at all. A DCW
    // key cannot be exported, so there is nothing here to be forbidden from.
    return { error: json({ error: "Export is not available on this wallet stack." }, 404) };
  }
  const user = await getSessionUser();
  if (!user) return { error: json({ error: "Not signed in" }, 401) };
  if (!user.circle_wallet_id || !user.wallet_address) {
    return { error: json({ error: "Your wallet isn't provisioned yet." }, 409) };
  }

  const secret = process.env.SESSION_SECRET ?? "";
  const unlockToken = (await cookies()).get(WALLET_UNLOCK_COOKIE)?.value ?? "";
  if (verifyWalletUnlock(unlockToken, secret, Date.now()) !== user.id) {
    return { error: json({ error: "locked" }, 403) };
  }

  // users.circle_wallet_id holds the PRIVY wallet id on this stack — the column
  // name is legacy from the Circle era (lib/users-repo.ts:45 writes wallet.walletId
  // into it) and is not renamed here.
  const row = await getPrivyWalletByWalletId(user.circle_wallet_id);
  if (!row) return { error: json({ error: "Your wallet isn't provisioned yet." }, 409) };

  return {
    userId: user.id,
    walletId: user.circle_wallet_id,
    address: user.wallet_address,
    namespace: row.namespace,
    key: row.key,
    exportOwnerKey: row.export_owner_key ?? null,
  };
}

// Which side of the ownership line this wallet is on.
//
// A RECORDED KEY IS TRUSTED WITHOUT ASKING PRIVY. Privy is still the real gate at
// export time — a stale cache surfaces as a 401 there, which the restore path
// handles — so spending an API call to re-confirm what we already recorded buys
// nothing. When the cache is EMPTY the call is worth making: a wallet Privy says
// we no longer own, with no key recorded, is a setup whose column write failed,
// and telling that apart from a fresh wallet is the difference between a restore
// prompt and a dead end.
async function resolveState(walletId: string, exportOwnerKey: string | null) {
  if (exportOwnerKey) return "enabled" as const;
  return (await getWalletOwnerId(walletId)) === process.env.PRIVY_KEY_QUORUM_ID
    ? ("not_enabled" as const)
    : ("needs_restore" as const);
}

export async function GET() {
  const g = await gate();
  if ("error" in g) return g.error;

  const appId = process.env.PRIVY_APP_ID;
  if (!appId) return json({ error: "Privy is not configured." }, 500);

  try {
    return json({
      state: await resolveState(g.walletId, g.exportOwnerKey),
      walletId: g.walletId,
      // Not a secret: it is in every Privy request the browser's signature covers,
      // and the browser cannot build that signature without it.
      appId,
      address: g.address,
      exportOwnerKey: g.exportOwnerKey,
    });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : "Could not read wallet ownership." }, 502);
  }
}

// Enable, or restore a record we lost. The state is resolved HERE rather than
// taken from the client: a client that could claim "needs_restore" could record an
// owner key for a wallet whose ownership never moved.
export async function PUT(request: Request) {
  const g = await gate();
  if ("error" in g) return g.error;

  const body = (await request.json().catch(() => null)) as { publicKey?: unknown } | null;
  if (!isSpkiBase64(body?.publicKey)) {
    return json({ error: "Expected a base64 SPKI P-256 public key." }, 400);
  }
  const publicKey = body.publicKey;

  try {
    const state = await resolveState(g.walletId, g.exportOwnerKey);
    if (state === "enabled") {
      return json({ error: "Export is already enabled for this wallet." }, 409);
    }

    // TRANSFER FIRST, RECORD SECOND, and never the other way round. If the write
    // below fails we under-claim — the UI says "not enabled" for a wallet only the
    // user can export — and the restore path repairs it. The inverse ordering would
    // tell a user only they can export while we still can, which is a lie about
    // custody.
    if (state === "not_enabled") {
      await transferExportOwnership(g.walletId, publicKey);
    }
    // state === "needs_restore": ownership already moved on a previous attempt whose
    // record was lost. Recording the key without re-transferring is safe because the
    // column is a cache — a wrong key written here fails the browser's local
    // pre-check until the user retries with the right password, and Privy refuses a
    // signature from it either way.
    await setExportOwnerKey(g.namespace, g.key, publicKey);
    return json({ ok: true, state: "enabled" });
  } catch (err) {
    // The message can name the failure; it must never carry the request body.
    return json({ error: err instanceof Error ? err.message : "Could not enable export." }, 502);
  }
}

export async function POST(request: Request) {
  const g = await gate();
  if ("error" in g) return g.error;

  const body = (await request.json().catch(() => null)) as
    | { recipientPublicKey?: unknown; signature?: unknown }
    | null;
  if (!isSpkiBase64(body?.recipientPublicKey)) {
    return json({ error: "Expected a base64 SPKI P-256 recipient key." }, 400);
  }
  if (!isDerSignatureBase64(body?.signature)) {
    return json({ error: "Expected a base64 DER authorization signature." }, 400);
  }

  try {
    // Relayed verbatim. We do not decrypt, and we could not: the matching private
    // key is in the tab that asked.
    return json(await exportWalletCiphertext(g.walletId, body.recipientPublicKey, body.signature));
  } catch (err) {
    // Privy refusing the signature is the expected failure — a stale cached owner
    // key, or a wallet whose ownership moved elsewhere — and the browser turns it
    // into the restore prompt. Nothing about the ciphertext or the body is logged.
    const message = err instanceof Error ? err.message : "Export failed.";
    return json({ error: `Splitsy could not authorise this export: ${message}` }, 502);
  }
}
```

- [ ] **Step 3: Verify it type-checks**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Verify the gates reject correctly**

Start the dev server (`npm run dev`) with `WALLET_PROVIDER=privy` in `.env.local`, then, signed out:

```bash
curl -s -i localhost:3000/api/wallet/export | head -1
```
Expected: `HTTP/1.1 401`

And with `WALLET_PROVIDER` unset or set to `circle` in `.env.local` (restart the server):
```bash
curl -s -i localhost:3000/api/wallet/export | head -1
```
Expected: `HTTP/1.1 404`

Restore `WALLET_PROVIDER=privy` before continuing.

- [ ] **Step 5: Commit**

```bash
git add app/api/wallet/export/route.ts
git commit -m "feat(export): the export route — status, enable, and relay"
```

---

### Task 10: The export tab

**Files:**
- Create: `app/ExportTab.tsx`
- Modify: `app/XAuthControl.tsx:13-20` (the `Tab` type and `TABS`), `:347-352` (the tab body switch)
- Modify: `app/globals.css` (two new rules)

**Interfaces:**
- Consumes: the three route methods from Task 9; `lib/export-crypto.ts` from Tasks 2–4.
- Produces: `export default function ExportTab({ address }: { address: string })`.

**Read first:** per `AGENTS.md`, the client-component and dynamic-import guides in `node_modules/next/dist/docs/` for Next 16.2.9 before writing this.

**Follow the panel's existing class vocabulary — do not invent class names.** `app/XAuthControl.tsx:536-700` (`SendTab`) is the model. The panel has exactly these:
- `<p className="settle-label">caption</p>` — the caps heading
- `<div className="wallet-line" data-mono><input …/></div>` — a text input; `data-pin` for the PIN, `data-figure` for amounts, `data-mono` for anything monospace
- `<button type="button" className="settle-action">label ›</button>` — the action button, lowercase label, trailing ` ›`
- `<p className="wallet-note">` for prose, `data-tone="warn"` plus `role="status"` for errors, and `<b>` for emphasis inside it (`.wallet-note > b` is already styled)
- `<p className="wallet-proof">` — monospace address/key display

- [ ] **Step 1: Write the component**

Create `app/ExportTab.tsx`:

```tsx
"use client";

import { Check, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

// The browser half of wallet key export. EVERY SECRET IN THIS FILE STAYS IN THIS
// FILE: the password, the P-256 key derived from it, the ephemeral HPKE private
// key, and the exported wallet key. Nothing is sent to Splitsy, nothing is written
// to localStorage or sessionStorage, and nothing is logged.
//
// lib/export-crypto is imported DYNAMICALLY so @hpke/* and @noble/* — around 30KB
// the rest of the app has no use for — stay out of the main bundle and load only
// when someone opens this tab.
//
// Design: docs/superpowers/specs/2026-09-08-privy-key-export-design.md
type Status = {
  state: "not_enabled" | "enabled" | "needs_restore";
  walletId: string;
  appId: string;
  address: string;
  exportOwnerKey: string | null;
};

export default function ExportTab({ address }: { address: string }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [locked, setLocked] = useState(false);
  const [pin, setPin] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [verified, setVerified] = useState(false);
  const [revealed, setRevealed] = useState<string | null>(null);

  async function load() {
    const res = await fetch("/api/wallet/export");
    const data = await res.json();
    if (res.status === 403) return setLocked(true);
    if (!res.ok) return setLoadError(data.error ?? "Could not load export.");
    setLocked(false);
    setStatus(data as Status);
  }

  useEffect(() => {
    load().catch(() => setLoadError("Network error — please try again."));
  }, []);

  // Same inline unlock SendTab does (app/XAuthControl.tsx:557-567) — export is
  // gated on the same 5-minute cookie, so sending the user to another tab to get
  // it would be a detour the panel does not make anywhere else.
  async function unlock() {
    setMessage(null);
    const res = await fetch("/api/wallet/unlock", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin }),
    });
    const data = await res.json();
    if (!res.ok) return setMessage(data.error ?? "Incorrect PIN.");
    setPin("");
    await load();
  }

  // Everything below runs in ONE function so the derived key never becomes
  // component state. It lives for the length of this call and is dropped when it
  // returns.
  async function runExport(current: Status, pwd: string, reveal: boolean) {
    const crypto = await import("@/lib/export-crypto");
    const secretKey = await crypto.deriveOwnerSecretKey(pwd, current.address);
    const publicKey = await crypto.ownerPublicKeySpki(secretKey);

    // The local pre-check. A wrong password fails HERE, with no request made and
    // no 401 to interpret — possible only because the PUBLIC half of the
    // credential is recorded server-side.
    if (current.exportOwnerKey && current.exportOwnerKey !== publicKey) {
      throw new Error("That password doesn't match this wallet's export credential.");
    }

    const recipient = await crypto.createExportRecipient();
    const signature = crypto.signAuthorization(
      crypto.canonicalPayload(
        crypto.exportRequestInput(current.walletId, current.appId, recipient.publicKeySpkiBase64),
      ),
      secretKey,
    );

    const res = await fetch("/api/wallet/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recipientPublicKey: recipient.publicKeySpkiBase64, signature }),
    });
    const data = await res.json();
    if (res.status === 403) {
      setLocked(true);
      throw new Error("Wallet locked — enter your PIN.");
    }
    if (!res.ok) throw new Error(data.error ?? "Splitsy could not authorise this export.");

    let plaintext: string;
    try {
      plaintext = await recipient.open(data.encapsulated_key, data.ciphertext);
    } catch {
      // Distinguished from a 401 on purpose: a suite or ephemeral-key fault, not a
      // credential fault. Telling the user to check their password would send them
      // down the wrong path.
      throw new Error("Could not decrypt the exported key. Please try again.");
    }

    // THE GUARD. A key we cannot prove belongs to this wallet is not shown, not
    // copied, not logged — not even quoted back in the error.
    if (!crypto.verifyExportedKey(plaintext, current.address)) {
      throw new Error("The exported key did not match this wallet. Nothing was revealed.");
    }
    return reveal ? plaintext : null;
  }

  async function enable() {
    if (!status) return;
    setMessage(null);
    const { MIN_PASSWORD_LENGTH } = await import("@/lib/export-crypto");
    if (password.length < MIN_PASSWORD_LENGTH) {
      return setMessage(`Use at least ${MIN_PASSWORD_LENGTH} characters.`);
    }
    if (password !== confirm) return setMessage("The passwords don't match — try again.");

    setBusy(true);
    try {
      const crypto = await import("@/lib/export-crypto");
      const secretKey = await crypto.deriveOwnerSecretKey(password, status.address);
      const publicKey = await crypto.ownerPublicKeySpki(secretKey);

      const res = await fetch("/api/wallet/export", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ publicKey }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not enable export.");

      const next: Status = { ...status, state: "enabled", exportOwnerKey: publicKey };
      setStatus(next);

      // ENABLING ENDS WITH A PROOF, NOT A KEY. A real export runs, the plaintext is
      // checked against the address and then dropped. It closes the worst hole in a
      // typed credential: a password mistyped identically in both fields transfers
      // ownership to a key nobody can reproduce, and the wallet is non-exportable
      // forever with no signal. Revealing is a separate, deliberate click.
      await runExport(next, password, false);
      setVerified(true);
      setPassword("");
      setConfirm("");
      setMessage(null);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Could not enable export.");
    } finally {
      setBusy(false);
    }
  }

  async function reveal() {
    if (!status) return;
    setMessage(null);
    setBusy(true);
    try {
      setRevealed(await runExport(status, password, true));
      setPassword("");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Export failed.");
    } finally {
      setBusy(false);
    }
  }

  const warn = message ? (
    <p className="wallet-note" data-tone="warn" role="status">
      {message}
    </p>
  ) : null;

  if (locked) {
    return (
      <div>
        <p className="settle-label">unlock to export</p>
        <p className="wallet-note">Enter your PIN once — stays unlocked for 5 minutes.</p>
        <div className="wallet-line" data-pin>
          <input
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
            type="password"
            inputMode="numeric"
            maxLength={8}
            aria-label="Wallet PIN"
            placeholder="••••"
            onKeyDown={(e) => e.key === "Enter" && pin && unlock()}
          />
        </div>
        <button type="button" onClick={unlock} disabled={!pin} className="settle-action">
          unlock ›
        </button>
        {warn}
      </div>
    );
  }

  if (loadError) {
    return (
      <p className="wallet-note" data-tone="warn" role="status">
        {loadError}
      </p>
    );
  }

  if (!status) {
    return (
      <p className="wallet-note">
        <Loader2 size={11} className="animate-spin" /> loading…
      </p>
    );
  }

  if (revealed) {
    return (
      <div>
        <p className="settle-label">your private key</p>
        <p className="wallet-proof wallet-export-key">{revealed}</p>
        <p className="wallet-note">
          This is the key <b>Privy</b> has been holding for you. Splitsy never sees it. Import it into
          any Ethereum wallet to control {address} directly — and anyone who has it controls this
          wallet.
        </p>
        <button type="button" onClick={() => setRevealed(null)} className="settle-action">
          done ›
        </button>
      </div>
    );
  }

  if (status.state === "enabled") {
    return (
      <div>
        {verified ? (
          <p className="wallet-note" data-tone="ok">
            <Check size={11} /> verified — this password exports this wallet. <b>Privy</b> will only
            ever release this key to it.
          </p>
        ) : null}
        <p className="settle-label">export your key</p>
        <p className="wallet-note">
          Your assets are held by <b>Privy</b>, the custodian. Only your export password can
          authorise releasing this wallet&apos;s private key — Splitsy cannot, and cannot reset it.
        </p>
        <div className="wallet-line">
          <input
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            type="password"
            autoComplete="off"
            aria-label="Export password"
            placeholder="export password"
            onKeyDown={(e) => e.key === "Enter" && password && !busy && reveal()}
          />
        </div>
        <button type="button" onClick={reveal} disabled={busy || !password} className="settle-action">
          {busy ? "…" : "reveal private key"} ›
        </button>
        {warn}
      </div>
    );
  }

  const restoring = status.state === "needs_restore";
  return (
    <div>
      <p className="settle-label">{restoring ? "restore your export record" : "enable export"}</p>
      <p className="wallet-note">
        Your assets are held by <b>Privy</b>, the custodian. Splitsy is the app that operates this
        wallet on your behalf.
      </p>
      <p className="wallet-note">
        {restoring
          ? "Export is already enabled for this wallet, but we lost our record of it. Re-enter the password you set to restore it."
          : "Until you set an export password, Splitsy can export this wallet's private key itself, and is authorised to move your assets on your behalf. Setting one ends the first of those, not the second: only your password can release this wallet's private key — with no recovery — while Splitsy goes on spending from this wallet on your behalf, which is what keeps sending and paying working. Choose something you will not forget."}
      </p>
      <div className="wallet-line">
        <input
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          type="password"
          autoComplete="off"
          aria-label="Export password"
          placeholder="export password"
        />
      </div>
      <div className="wallet-line">
        <input
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          type="password"
          autoComplete="off"
          aria-label="Confirm export password"
          placeholder="confirm password"
        />
      </div>
      <button type="button" onClick={enable} disabled={busy} className="settle-action">
        {busy ? "…" : restoring ? "restore" : "enable export"} ›
      </button>
      {warn}
      <p className="wallet-note">
        Your <b>pay wallet</b> is exportable. Your <b>agent wallet</b> is not yet — if you have topped
        it up, that USDC cannot be exported today.
      </p>
      <p className="wallet-note">
        Splitsy serves this page&apos;s code, so a compromised Splitsy could capture your password as
        you type it. Setting an export password protects you against a later breach, not against us
        at the moment you use this feature.
      </p>
    </div>
  );
}
```

- [ ] **Step 2: Wire the tab into the panel**

In `app/XAuthControl.tsx`, add the import near the other local imports (after line 10):

```tsx
import ExportTab from "./ExportTab";
```

Change line 13:
```tsx
type Tab = "info" | "send" | "receive" | "history" | "export";
```

Change `TABS` (lines 15-20) to add the fifth entry:
```tsx
const TABS: { id: Tab; label: string }[] = [
  { id: "info", label: "wallet" },
  { id: "send", label: "send" },
  { id: "receive", label: "receive" },
  { id: "history", label: "history" },
  { id: "export", label: "export" },
];
```

In the tab body switch, change the final `) : (` branch that renders history so `export` gets its own branch. Locate the chain at lines 318-352 and add, immediately before the closing branch that renders the history tab:

```tsx
                    ) : tab === "export" && me.walletAddress ? (
                      <ExportTab address={me.walletAddress} />
```

- [ ] **Step 3: Add the two new CSS rules**

Every class the component uses already exists in `app/globals.css` except two. Confirm that first:

```bash
grep -n "^\.wallet-export-key\|^\.wallet-note\[data-tone=\"ok\"\]" app/globals.css
```
Expected: no output (neither exists yet).

Add both beside the existing `.wallet-proof` and `.wallet-note` rules (around `app/globals.css:7998-8040`):

```css
/* A 64-character private key in a 352px column. .wallet-proof already sets the
   mono face for an address, which is 42 characters and fits; this one has to
   wrap, and selects whole so a copy cannot take half a key. */
.wallet-export-key {
  word-break: break-all;
  user-select: all;
}

/* The verified tick after enabling. .wallet-note only carries a "warn" tone
   today; .wallet-figure's "ok" is the colour this borrows. */
.wallet-note[data-tone="ok"] { color: var(--success); }
```

- [ ] **Step 4: Verify it type-checks and builds**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Verify in the browser**

With `WALLET_PROVIDER=privy`, run `npm run dev`, sign in, open the wallet panel, unlock with the PIN, and open the **export** tab.

Expected: the enable form renders with the custody copy. Do **not** enable yet — the live pay wallet is still the non-exportable one, and Task 12 re-mints it. Confirm only that the tab loads and the status request returns `state: "not_enabled"` in the network panel.

- [ ] **Step 6: Commit**

```bash
git add app/ExportTab.tsx app/XAuthControl.tsx app/globals.css
git commit -m "feat(export): the export tab — enable, verify, reveal, discard"
```

---

### Task 11: Custody disclosure on the wallet panel

**Files:**
- Modify: `app/XAuthControl.tsx:324-332` (the info tab's address block)

**Interfaces:**
- Consumes: `walletProviderName` is a server function and cannot be called here; the panel already knows the stack indirectly. Add a `provider` field to the `Me` type instead.
- Modify: `app/api/me/route.ts` to return it.

**Why:** spec §5. The custody line is a **standing** element, visible whether or not export is set up — the first sight of the wallet is where trust is made. It must not appear only inside the export flow.

- [ ] **Step 1: Return the wallet stack from `/api/me`**

In `app/api/me/route.ts`, add the import and the field:

```ts
import { walletProviderLabel } from "@/lib/wallet-provider";
```

and inside the returned `user` object, after `walletAddress`:

```ts
      // Which custodian actually holds this wallet's keys. The panel says so out
      // loud (spec §5) and the two stacks have different answers, so it cannot be
      // a hard-coded string in the component.
      custodian: walletProviderLabel(),
```

- [ ] **Step 2: Add it to the client type**

In `app/XAuthControl.tsx`, change line 12:

```tsx
type Me = { id: string; provider?: AccountProvider | null; handle: string; name: string | null; avatarUrl: string | null; walletAddress: string | null; custodian?: "Circle" | "Privy" };
```

- [ ] **Step 3: Render the disclosure under the address**

In the info tab, immediately after the `<p className="wallet-proof">{me.walletAddress}</p>` line (currently line 332), add:

```tsx
                            {me.custodian === "Privy" ? (
                              <p className="wallet-note">
                                <b>Held by Privy.</b> Your assets are held by Privy, the custodian.
                                Splitsy is the app that operates this wallet on your behalf. Privy is
                                a SOC&nbsp;2–audited custody provider, independently reviewed by
                                Cure53, Zellic and Doyensec, with a public bug bounty and keys that
                                are encrypted and segmented so no single party holds a whole key.{" "}
                                <a
                                  href="https://privy.io/security"
                                  target="_blank"
                                  rel="noreferrer"
                                  className="wallet-handle"
                                >
                                  privy.io/security
                                </a>
                                . Until you set an export password, Splitsy can <b>also</b> export
                                this wallet&rsquo;s private key itself — set one in the{" "}
                                <b>export</b> tab.
                              </p>
                            ) : null}
```

Uses only classes the panel already has: `.wallet-note` for the prose, `<b>` for emphasis (`.wallet-note > b` is styled at `app/globals.css:8037`), and `.wallet-handle` for the link, which is what `OwnHandle` uses for the same treatment. **No new CSS.**

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit`, then `npm run dev` and open the wallet panel's info tab.
Expected: the custody paragraph renders under the address on the Privy stack. Set `WALLET_PROVIDER=circle`, restart, and confirm it does **not** render — the claim is false for Circle DCW, whose keys no one can export.

Restore `WALLET_PROVIDER=privy`.

- [ ] **Step 5: Commit**

```bash
git add app/api/me/route.ts app/XAuthControl.tsx
git commit -m "feat(export): say who holds the assets, on the wallet panel itself"
```

---

### Task 12: Re-mint the live pay wallet

**Files:**
- Create: `scripts/privy-remint.ts`
- Modify: `package.json` (add `privy:remint`)
- Modify: `lib/users-repo.ts:45-54` (`setUserWallet` lowercase)

**Interfaces:**
- Consumes: `backend.getOrCreateWallet` (Task 8), `transferUsdc` from the seam.
- Produces: nothing other tasks consume. This is a one-off operation.

**Why:** `walletSpec()` before Task 8 set no owner, so **every wallet this stack has ever minted is permanently non-exportable** — including the live pay wallet. Preview holds 7 `privy_wallets` rows: 5 dead spike probes with no user attached, the live pay wallet `x:21068173` → `0xa264A3818F20f878380B5Af9154080605de9a704` (`jla7zhktvth6r5j6utwx0pet`, 18.997073 USDC as of 2026-09-08), and the live agent wallet, which section 1 defers and this task does not touch.

**The casing fix is in scope here** and is flagged in the spec's loose ends as offered-but-unapproved: `setUserWallet` stores Privy's checksummed address verbatim while `setUserAgentWallet` lowercases and `getUsersByWallets` matches lowercase, so Privy pay wallets never resolve to a handle. This task writes a new pay address, so it is the moment to write it in the form every reader expects. **Confirm with the user before Step 5 if you want the code change held back** — the script writes lowercase either way.

- [ ] **Step 1: Confirm the starting state**

Run against `splitsy-test` in the Supabase SQL editor:
```sql
select namespace, key, wallet_id, address from privy_wallets order by created_at;
select id, handle, wallet_address, circle_wallet_id from users where wallet_address is not null;
```
Expected: 7 rows; exactly one user (`qFloppa`) with `wallet_address = '0xa264A3818F20f878380B5Af9154080605de9a704'` and `circle_wallet_id = 'jla7zhktvth6r5j6utwx0pet'`.

**If the state differs, stop and report.** The script below hard-codes nothing, but the plan's assumptions about scope do.

- [ ] **Step 2: Write the script**

Create `scripts/privy-remint.ts`:

```ts
// One-off: replace the pay wallets minted before export ownership existed.
//
// walletSpec() used to set additional_signers and no owner, and ownership cannot
// be retrofitted — an additional signer can spend but can never export or take
// ownership. So every wallet minted before that change is permanently
// non-exportable and the only repair is a new wallet plus a sweep. Cheap today
// (Preview, testnet, one funded wallet); impossible after a production flip.
//
// SCOPE: pay wallets only. Agent wallets are deferred (spec section 1) and are
// left alone deliberately — re-minting one would orphan its ERC-8004 identity,
// which is registered on chain against its address, and would need
// PRIVY_AGENT_POLICY_ID, whose setup script is currently missing from HEAD.
//
//   npm run privy:remint -- --dry-run     (default: prints the plan, changes nothing)
//   npm run privy:remint -- --commit
import { createPublicClient, erc20Abi, formatUnits, getAddress, http } from "viem";
import { arcTestnet } from "viem/chains";
import { backend } from "../lib/privy-wallet.ts";
import { createSupabaseServerClient } from "../lib/supabase.ts";
import { ARC_TESTNET_RPC, ARC_TESTNET_USDC } from "../lib/x402/constants.ts";

const commit = process.argv.includes("--commit");
const PAY_NAMESPACES = ["x", "discord", "email", "wallet"];
// Arc charges gas in USDC, so a wallet cannot send its entire balance — the
// transfer itself has to be paid for. Left behind as dust in an abandoned wallet.
const GAS_RESERVE_USDC = 0.05;

const supabase = createSupabaseServerClient();
if (!supabase) throw new Error("Supabase is not configured");
const publicClient = createPublicClient({ chain: arcTestnet, transport: http(ARC_TESTNET_RPC) });

const balanceOf = async (address: string) =>
  Number(
    formatUnits(
      await publicClient.readContract({
        address: ARC_TESTNET_USDC,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [getAddress(address)],
      }),
      6,
    ),
  );

// 1. The dead probe rows: keys no real login will ever produce, left by the spikes.
//    Deleted so a future login cannot adopt one, and so the table says what is real.
const { data: rows, error } = await supabase.from("privy_wallets").select("namespace, key, wallet_id, address");
if (error) throw new Error(error.message);

const { data: users, error: usersError } = await supabase
  .from("users")
  .select("id, handle, wallet_address, circle_wallet_id")
  .not("wallet_address", "is", null);
if (usersError) throw new Error(usersError.message);

const liveWalletIds = new Set(users.map((u) => u.circle_wallet_id));
const orphans = rows.filter((r) => !liveWalletIds.has(r.wallet_id) && r.namespace !== "agent" && r.namespace !== "splitsy");
console.log(`orphan rows to delete: ${orphans.length}`);
for (const row of orphans) console.log(`  ${row.namespace}:${row.key}  ${row.address}`);

// 2. The live pay wallets.
const payUsers = users.filter((u) => rows.some((r) => r.wallet_id === u.circle_wallet_id && PAY_NAMESPACES.includes(r.namespace)));
console.log(`\npay wallets to re-mint: ${payUsers.length}`);

for (const user of payUsers) {
  const row = rows.find((r) => r.wallet_id === user.circle_wallet_id)!;
  const balance = await balanceOf(row.address);
  console.log(`  ${user.handle}  ${row.namespace}:${row.key}  ${row.address}  ${balance} USDC`);

  if (!commit) continue;

  // Mint the replacement FIRST — the sweep needs somewhere to go. A distinct key
  // so getOrCreateWallet does not return the old row; the real row is repointed
  // below and this scratch row is removed.
  const mintKey = `${row.key}-export-remint`;
  const fresh = await backend.getOrCreateWallet(row.namespace, mintKey);
  if (!fresh) throw new Error(`Could not mint a replacement for ${row.namespace}:${row.key}`);
  console.log(`    new wallet ${fresh.walletId} ${fresh.address}`);

  // Sweep, leaving gas behind. Arc charges gas in USDC, so the full balance can
  // never move.
  const sweep = Math.max(0, balance - GAS_RESERVE_USDC);
  if (sweep > 0) {
    const tx = await backend.transferUsdc(row.wallet_id, fresh.address, sweep.toFixed(6));
    console.log(`    swept ${sweep.toFixed(6)} USDC — ${tx.state} ${tx.txHash ?? tx.id}`);
  } else {
    console.log("    nothing to sweep");
  }

  // Repoint the real row at the new wallet, then drop the scratch row.
  const updated = await supabase
    .from("privy_wallets")
    .update({ wallet_id: fresh.walletId, address: fresh.address, export_owner_key: null })
    .eq("namespace", row.namespace)
    .eq("key", row.key);
  if (updated.error) throw new Error(updated.error.message);
  await supabase.from("privy_wallets").delete().eq("namespace", row.namespace).eq("key", mintKey);

  // Lowercased on the way in: setUserWallet stores Privy's checksummed address
  // verbatim while getUsersByWallets matches lowercase, so a checksummed row never
  // resolves to a handle.
  const swapped = await supabase
    .from("users")
    .update({ wallet_address: fresh.address.toLowerCase(), circle_wallet_id: fresh.walletId })
    .eq("id", user.id);
  if (swapped.error) throw new Error(swapped.error.message);

  const after = await balanceOf(fresh.address);
  console.log(`    new balance ${after} USDC`);
}

if (commit) {
  for (const row of orphans) {
    await supabase.from("privy_wallets").delete().eq("namespace", row.namespace).eq("key", row.key);
  }
  console.log(`\ndeleted ${orphans.length} orphan rows`);
} else {
  console.log("\nDRY RUN — nothing changed. Re-run with --commit to apply.");
}
```

- [ ] **Step 3: Add the script**

In `package.json`, beside the other `privy:*` scripts:

```json
    "privy:remint": "node --experimental-strip-types --env-file=.env.local scripts/privy-remint.ts",
```

- [ ] **Step 4: Dry-run, then commit the change**

Run: `npm run privy:remint`
Expected: lists 5 orphan rows and 1 pay wallet (`qFloppa`, ~18.99 USDC), ending in `DRY RUN — nothing changed.`

Check the output names exactly the rows from Step 1. Then:

Run: `npm run privy:remint -- --commit`
Expected: a new wallet id and address, a sweep of ~18.947 USDC with a `COMPLETE` state and a tx hash, a new balance close to 18.94, and 5 orphan rows deleted.

- [ ] **Step 5: Fix the casing at the source**

In `lib/users-repo.ts`, change `setUserWallet` (line 45-54) so the address is stored the way every reader expects:

```ts
export async function setUserWallet(id: string, walletAddress: string, circleWalletId: string): Promise<void> {
  const client = requireClient();
  const { error } = await client
    .from("users")
    // LOWERCASED, matching setUserAgentWallet (:72) and the lookup in
    // getUsersByWallets (:133). Privy hands back a CHECKSUMMED address and this
    // used to store it verbatim, so a Privy pay wallet never resolved to a handle
    // and the comment at :127 claiming every wallet_address is lowercase was false.
    .update({ wallet_address: walletAddress.toLowerCase(), circle_wallet_id: circleWalletId })
    .eq("id", id);
  if (error) {
    throw new Error(`Failed to set wallet: ${error.message}`);
  }
}
```

- [ ] **Step 6: Verify the end state**

Run against `splitsy-test`:
```sql
select namespace, key, wallet_id, address, export_owner_key from privy_wallets order by created_at;
select handle, wallet_address, circle_wallet_id from users where wallet_address is not null;
```
Expected: 2 rows in `privy_wallets` (the re-minted pay wallet and the untouched agent wallet); the user's `wallet_address` lowercase and matching the new pay address.

Then confirm the new wallet is actually exportable:
```bash
node --experimental-strip-types --env-file=.env.local -e "
const { PrivyClient } = await import('@privy-io/node');
const privy = new PrivyClient({ appId: process.env.PRIVY_APP_ID, appSecret: process.env.PRIVY_APP_SECRET });
const { createSupabaseServerClient } = await import('./lib/supabase.ts');
const { data } = await createSupabaseServerClient().from('privy_wallets').select('namespace, wallet_id').eq('namespace','x').single();
const w = await privy.wallets().get(data.wallet_id);
console.log('owner is our quorum:', w.owner_id === process.env.PRIVY_KEY_QUORUM_ID);
console.log('quorum can still sign:', (w.additional_signers ?? []).some(s => s.signer_id === process.env.PRIVY_KEY_QUORUM_ID));
"
```
Expected: both `true`.

- [ ] **Step 7: Commit**

```bash
git add scripts/privy-remint.ts package.json lib/users-repo.ts
git commit -m "fix(privy): re-mint the pay wallet as exportable, and lowercase the address"
```

---

### Task 13: Catch the next creation-only property

**Files:**
- Modify: `app/api/stack/route.ts`

**Interfaces:**
- Consumes: `getWalletOwnerId` (Task 7), `createSupabaseServerClient`.
- Produces: an extra field on the existing `/api/stack` response.

**Why:** `owner_id` is the **third** property that attaches only at wallet creation and cannot be backfilled — after `PRIVY_AGENT_POLICY_ID` (`docs/deployments.md:125-138`) and now export ownership. Nothing detects the failure and no migration repairs it. Documentation did not catch the second one; an assertion might catch the fourth.

- [ ] **Step 1: Read the existing route**

Run: `cat app/api/stack/route.ts`

Note the shape it already has: gated on `NEXT_PUBLIC_STACK_LABEL` so it is inert on Production, **names never values**, every credential reported as a bare boolean, and the `privy_wallets` reachability probe that reports a caught error rather than throwing. The new check follows all four rules.

- [ ] **Step 2: Add the assertion**

Add the import at the top of `app/api/stack/route.ts`:

```ts
import { createSupabaseServerClient } from "@/lib/supabase";
```

Add this function above `export async function GET()`:

```ts
// The newest wallet, checked against the properties that can ONLY be set at
// creation. owner_id is the THIRD of these — after PRIVY_AGENT_POLICY_ID
// (docs/deployments.md:125-138) — and the pattern is always the same: nothing
// detects the omission, no backfill repairs it, so a wallet minted wrong is wrong
// forever and only a re-mint fixes it. Documentation did not catch the second one.
//
// Reports booleans and ids, never keys, matching the rest of this route. Never
// throws: a probe that can take the route down is worse than one that says it
// could not look.
async function walletCreationProperties() {
  const client = createSupabaseServerClient();
  if (!client) return { checked: false, reason: "supabase not configured" };

  const { data, error } = await client
    .from("privy_wallets")
    .select("namespace, wallet_id")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return { checked: false, reason: error?.message ?? "no wallets yet" };

  try {
    const { PrivyClient } = await import("@privy-io/node");
    const privy = new PrivyClient({
      appId: process.env.PRIVY_APP_ID ?? "",
      appSecret: process.env.PRIVY_APP_SECRET ?? "",
    });
    const wallet = await privy.wallets().get(data.wallet_id);
    const quorum = process.env.PRIVY_KEY_QUORUM_ID;
    return {
      checked: true,
      walletId: data.wallet_id,
      namespace: data.namespace,
      // Owned by SOMEONE. A wallet whose ownership the user has taken for export
      // is correct, not broken, so this asserts only that an owner was set at all —
      // which is the thing creation can silently stop doing.
      ownerSet: wallet.owner_id !== null,
      // And owned by US, which is what a freshly minted wallet must look like
      // before anyone enables export on it.
      ownedByQuorum: wallet.owner_id === quorum,
      // Without this the server cannot sign at all once ownership moves.
      quorumIsAdditionalSigner: (wallet.additional_signers ?? []).some((s) => s.signer_id === quorum),
      // Only the agent namespace carries the enclave cap; null means "not applicable".
      agentPolicyExpected: data.namespace === "agent" ? Boolean(process.env.PRIVY_AGENT_POLICY_ID) : null,
    };
  } catch (caught) {
    return { checked: false, reason: caught instanceof Error ? caught.message : "privy unreachable" };
  }
}
```

Then add one key to the object `GET` already returns, immediately after `privyWalletsTable`:

```ts
    walletCreation: await walletCreationProperties(),
```

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit`, then with the dev server running and `NEXT_PUBLIC_STACK_LABEL` set in `.env.local`:
```bash
curl -s localhost:3000/api/stack | python3 -m json.tool | grep -A8 walletCreation
```
Expected: `"checked": true`, `"ownerSet": true`, `"ownedByQuorum": true`, `"quorumIsAdditionalSigner": true`.

If `NEXT_PUBLIC_STACK_LABEL` is unset the route 404s by design — set it locally to run this check.

- [ ] **Step 4: Commit**

```bash
git add app/api/stack/route.ts
git commit -m "feat(privy): assert the properties that can only be set at wallet creation"
```

---

### Task 14: Verify the build and run the manual pass

**Files:** none modified.

**Interfaces:**
- Consumes: everything.
- Produces: the evidence that this is done.

**Why:** `npm run build` has **never completed on this branch** — two prior attempts died when the box hit load average 47 with orphaned `next build` workers. `npx tsc --noEmit` was clean, which is not the same thing, and this change puts `@hpke/*` and `@noble/*` into a **client** bundle for the first time — exactly what a type check cannot vet.

- [ ] **Step 1: Run the full offline test suite**

```bash
npm run test:wallet-provider && npm run test:agents && npm run test:settle
```
Expected: all pass. Report the actual output; do not claim success without it.

- [ ] **Step 2: Build, carefully**

Kill any stale workers first, then build with a bounded worker count so the box does not fall over:

```bash
pkill -f "next build" || true
NEXT_BUILD_WORKERS=1 npm run build 2>&1 | tail -40
```

Expected: the build completes and prints the route table. `/api/wallet/export` must appear in it.

If the build dies again from load, report it as a blocker rather than skipping this step — an unverified client bundle is the specific risk this task exists to close.

- [ ] **Step 3: Confirm the crypto stayed out of the main bundle**

```bash
grep -rl "hpke\|chacha" .next/static/chunks/ | head
```
Expected: matches only in a lazily-loaded chunk, not in the main or framework chunk. If `@hpke/*` landed in the entry bundle, the dynamic `import("@/lib/export-crypto")` in `app/ExportTab.tsx` is not being honoured — investigate before proceeding.

- [ ] **Step 4: Manual pass on Preview**

Deploy the branch to Preview, sign in as `qFloppa`, and walk the whole ceremony:

1. Wallet panel → info tab shows the **Held by Privy** custody paragraph under the address.
2. Unlock with the PIN. Open the **export** tab → the enable form renders with the three admissions (Splitsy can currently export; agent wallet not yet; we serve the JS).
3. Enable with a password of at least 12 characters → **✓ Verified — this password exports this wallet.**
4. Confirm in the database: `select export_owner_key from privy_wallets where namespace='x';` is non-null.
5. Reveal with the correct password → 64 hex characters appear.
6. Import that key into a fresh wallet (MetaMask or `viem`) and confirm the address and the ~18.94 USDC balance match.
7. Press **Done** → the key is gone from the screen. Switch tabs and back → it does not reappear.
8. Try to reveal with a **wrong** password → *"That password doesn't match this wallet's export credential."* Confirm in the network panel that **no request was made** — the check is local.
9. Confirm spending still works after the ownership transfer: send 0.1 USDC from the **send** tab, then confirm a pay-link claim and an autopay run still sign from the same wallet.

- [ ] **Step 5: Report**

State plainly what passed, what failed, and anything skipped. If step 9 shows any signing failure, that is a design-invalidating result — ownership was supposed to be independent of signing — and must be reported immediately rather than worked around.

- [ ] **Step 6: Final commit**

```bash
git add -A
git commit -m "chore(export): verified build and manual pass on Preview"
```

---

## Deliberately not in this plan

- **Agent wallet export.** Spec section 1 defers it. The UI says so out loud rather than implying otherwise.
- **Existing Circle DCW users.** A DCW key cannot be exported at all; covering them means new addresses plus a fund migration, which is Task 8 of the wallet-stack design.
- ~~**Recovering `scripts/privy-setup.ts` / `scripts/privy-policy.ts`**, absent from HEAD but referenced by `package.json` and `docs/deployments.md:131`. Recover with `git show a269e5b:scripts/privy-setup.ts` and `git show 85d24a5:scripts/privy-policy.ts`.~~ **STRUCK 2026-09-11 — this was false, and acting on it is destructive.** Both files are present at HEAD and always were (`scripts/privy-setup.ts`, `scripts/privy-policy.ts`). Running either `git show` would overwrite a live file with an older revision — and for `privy-setup.ts` it would specifically revert `5ee4981`, which added the missing `owner_id` to `WALLET_SPEC`. That field is creation-only with no backfill, so the reverted script would silently mint permanently non-exportable wallets again, which is the exact defect that commit exists to fix. Do not run these commands. Task 12 re-mints only the pay wallet, which carries no agent policy.
- **RLS on `x402_payments`** in production project `hvckneltkugnvtwfrzlb` (596 rows readable and writable by the anon key). Flagged in the spec, out of scope here, and worth raising separately.
- **`privy-request-expiry`.** The SDK only signs it when present, and the recipient key already binds each signature to one tab. Add it if Privy ever makes expiry mandatory.
