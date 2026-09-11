import assert from "node:assert/strict";
import { test } from "node:test";
import { Chacha20Poly1305 } from "@hpke/chacha20poly1305";
import { CipherSuite, DhkemP256HkdfSha256, HkdfSha256 } from "@hpke/core";
import { formatRequestForAuthorizationSignature, generateAuthorizationSignature, generateP256KeyPair } from "@privy-io/node";
import { p256 } from "@noble/curves/p256";
import { sha256 } from "@noble/hashes/sha2";
import { generatePrivateKey, privateKeyToAddress } from "viem/accounts";
import {
  base64FromBytes,
  bytesFromBase64,
  canonicalPayload,
  createExportRecipient,
  deriveOwnerSecretKey,
  exportRequestInput,
  exportSalt,
  ownerPublicKeySpki,
  rpcRequestInput,
  signAuthorization,
  validScalar,
  verifyExportedKey,
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
  assert.deepEqual(input.body, {});
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

// The user-signed spend path. Same risk as the export payload above, same check,
// and the failure mode is identical and opaque: Privy rebuilds these bytes and
// verifies the signature over them, so any drift is a 401 that says nothing about
// why. The transaction is passed through verbatim, which is why this compares the
// WHOLE canonical payload rather than just the envelope.
const SIGN_TX = {
  to: "0x09BCd0d3C7A0c0f7E5C0a1DdcCe8B3D6e0eB6df1",
  data: "0xa9059cbb0000000000000000000000000000000000000000000000000000000000000001",
  nonce: "0x0",
  chain_id: 5042002,
  type: 2,
  gas_limit: "0x5208",
  max_fee_per_gas: "0x3b9aca00",
  max_priority_fee_per_gas: "0x3b9aca00",
};

test("the rpc payload is byte-identical to the SDK's", () => {
  const input = rpcRequestInput("wal_123", "app_456", SIGN_TX);
  assert.deepEqual(canonicalPayload(input), formatRequestForAuthorizationSignature(structuredClone(input) as never));
});

// The two payloads must not be interchangeable: a signature over the export request
// replayed against the rpc endpoint (or vice versa) has to be a different payload,
// or one authorization would cover the other.
test("the rpc payload is not the export payload", () => {
  const rpc = canonicalPayload(rpcRequestInput("wal_123", "app_456", SIGN_TX));
  const exp = canonicalPayload(exportRequestInput("wal_123", "app_456", "c3Bpa2k="));
  assert.notDeepEqual(rpc, exp);
});

// The transaction reaches the signed bytes intact. A helper that reshaped a field —
// re-serialising the nonce, dropping chain_id — would still produce a well-formed
// request that Privy rejects, so this asserts the values survive rather than that
// the object is merely non-empty.
test("every transaction field reaches the canonical payload", () => {
  const payload = new TextDecoder().decode(canonicalPayload(rpcRequestInput("wal_123", "app_456", SIGN_TX)));
  assert.match(payload, /eth_signTransaction/);
  for (const [field, value] of Object.entries(SIGN_TX)) {
    const rendered = typeof value === "string" ? value : String(value);
    assert.ok(payload.includes(rendered), `${field} (${rendered}) is missing from the signed payload`);
  }
});

test("base64 round-trips without Buffer", () => {
  const bytes = new Uint8Array([0, 1, 127, 128, 255, 254]);
  assert.deepEqual(bytesFromBase64(base64FromBytes(bytes)), bytes);
});

const ADDRESS = "0xa264A3818F20f878380B5Af9154080605de9a704";

// The salt is lowercased so the derivation cannot be broken by address casing.
// setUserWallet (lib/users-repo.ts:45) lowercases as of this branch, but rows
// written before that fix still hold Privy's checksummed address verbatim.
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
  // importKey, NOT suite.kem.deserializePublicKey: the latter wants a raw 65-byte
  // uncompressed point and throws DeserializeError on our 91-byte SPKI. Feeding
  // the sender the exact artifact we send Privy, unmodified, also proves that
  // SPKI is well-formed — slicing the DER header off would hide a malformed one.
  const recipientPublicKey = await crypto.subtle.importKey(
    "spki",
    bytesFromBase64(recipient.publicKeySpkiBase64),
    { name: "ECDH", namedCurve: "P-256" },
    true,
    [],
  );
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
