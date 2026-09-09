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
