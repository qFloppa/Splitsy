import { createPublicKey, createVerify, type KeyObject } from "node:crypto";

// Circle Notification API v2 signature verification (Programmable Wallets).
// Every webhook POST carries X-Circle-Key-Id + X-Circle-Signature headers; the
// signature is ECDSA_SHA_256 over the raw request body. The public key for a
// given keyId is static, so we fetch it once and cache it for the process.
// Docs: developers.circle.com/wallets/webhook-notifications ("Verify Digital Signature")

const publicKeyCache = new Map<string, KeyObject>();

async function getCirclePublicKey(keyId: string): Promise<KeyObject> {
  const cached = publicKeyCache.get(keyId);
  if (cached) return cached;

  const apiKey = process.env.CIRCLE_API_KEY;
  if (!apiKey) throw new Error("Circle is not configured");

  // keyId comes from a request header — pin it to UUID shape before it touches a URL.
  if (!/^[0-9a-f-]{36}$/i.test(keyId)) throw new Error("bad key id");

  const res = await fetch(`https://api.circle.com/v2/notifications/publicKey/${keyId}`, {
    headers: { accept: "application/json", authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`Failed to fetch Circle public key: ${res.status}`);
  const body = (await res.json()) as { data?: { publicKey?: string } };
  const publicKeyBase64 = body.data?.publicKey;
  if (!publicKeyBase64) throw new Error("Circle public key response had no key");

  const key = createPublicKey({
    key: Buffer.from(publicKeyBase64, "base64"),
    format: "der",
    type: "spki",
  });
  publicKeyCache.set(keyId, key);
  return key;
}

// Verify the raw body string exactly as received — re-serialising the JSON can
// reorder keys or change whitespace and break the signature.
export async function verifyCircleSignature(
  rawBody: string,
  keyId: string | null,
  signature: string | null,
): Promise<boolean> {
  if (!keyId || !signature) return false;
  try {
    const publicKey = await getCirclePublicKey(keyId);
    const verifier = createVerify("SHA256");
    verifier.update(rawBody, "utf8");
    verifier.end();
    return verifier.verify(publicKey, Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}

// v2 envelope. `notification` is the changed resource; for transactions.* it's
// a Transaction object (same shape the DCW SDK returns from getTransaction).
export type CircleNotification = {
  subscriptionId: string;
  notificationId: string;
  notificationType: string; // "transactions.outbound" | "transactions.inbound" | "webhooks.test" | ...
  notification: {
    id?: string;
    state?: string; // QUEUED | SENT | CONFIRMED | COMPLETE | FAILED | DENIED | CANCELLED
    txHash?: string;
    walletId?: string;
    sourceAddress?: string;
    destinationAddress?: string;
    amounts?: string[];
    [key: string]: unknown;
  };
  timestamp: string;
  version: number;
};
