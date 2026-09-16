"use client";

// Make the keys, then mint the wallet under them. CLIENT ONLY.
//
// THE ORDER IS THE WHOLE POINT. Splitsy used to mint the wallet at login and hand
// it over later, which meant there was a window — however short — in which it
// could export the key, and the handover ceremony was an admission that the window
// existed. Here the keys are made FIRST, in the browser, and the wallet is minted
// under a quorum of them. There is nothing to hand over because Splitsy was never
// holding it.
//
// THE SETUP FLOW ONLY — a user who has no wallet at all. The claim flow
// (app/ExportTab.tsx) still derives its own keys inline: it needs the same two
// keys and the same proof, so deriveOwnerKeys is exported and ready for it, but
// that path posts to a different route and is not touched here. Unifying them is
// a separate change, and doing it as part of this one would mean editing the
// irreversible ceremony to refactor it.
import { rememberOwnerKey } from "./session-owner-key";
import { forgetClaimStatus } from "./signed-send";

export type OwnerKeys = {
  // What the user unlocks with day to day: the passkey's key where the platform
  // supports PRF, otherwise the password's.
  primaryKey: Uint8Array;
  primaryPublicKey: string;
  // The recovery member of the quorum, present only when the primary is a
  // passkey. Null means one key owns the wallet and losing it is terminal.
  recoveryPublicKey: string | null;
  passkeyCredentialId: string | null;
  ownerKind: "passkey+password" | "password";
};

// Derive both keys. The passkey is attempted only when asked for, and its failure
// is NOT fatal — a user whose authenticator refuses, or who dismisses the prompt,
// still gets a working password-owned wallet rather than a dead end.
//
// TAKES A SALT, not an address: at provisioning time there is no address yet. The
// caller decides which salt (lib/export-crypto.ts:accountSalt for a wallet being
// created, exportSalt for one that already exists) and BOTH derivations get the
// same one, so a wallet has one salt however it is unlocked.
export async function deriveOwnerKeys(args: {
  salt: string;
  password: string;
  handle: string;
  usePasskey: boolean;
}): Promise<OwnerKeys> {
  const crypto = await import("@/lib/export-crypto");

  // Always derived: the sole owner without a passkey, the recovery member with one.
  const passwordKey = await crypto.deriveOwnerSecretKey(args.password, args.salt);
  const passwordPublicKey = await crypto.ownerPublicKeySpki(passwordKey);

  if (!args.usePasskey) {
    return {
      primaryKey: passwordKey,
      primaryPublicKey: passwordPublicKey,
      recoveryPublicKey: null,
      passkeyCredentialId: null,
      ownerKind: "password",
    };
  }

  const passkey = await import("@/lib/passkey-owner");
  const registered = await passkey.registerPasskey(args.salt, args.handle);
  const primaryKey = crypto.ownerSecretFromPrf(registered.secret);
  return {
    primaryKey,
    primaryPublicKey: await crypto.ownerPublicKeySpki(primaryKey),
    recoveryPublicKey: passwordPublicKey,
    passkeyCredentialId: registered.credentialId,
    ownerKind: "passkey+password",
  };
}

// The proof the server demands before it points anything at a new wallet: a fresh
// HPKE recipient key and a signature over the export request, both made with the
// key that is about to own it.
//
// SENT WITH THE REQUEST, not in a second round trip. The server cannot verify the
// key works on its own — only this tab holds the private half — and a separate
// round trip would leave a window in which a wallet exists, is the user's, and
// nothing has recorded that it works.
export async function ownerProof(walletId: string, appId: string, key: Uint8Array) {
  const crypto = await import("@/lib/export-crypto");
  const recipient = await crypto.createExportRecipient();
  return {
    recipientPublicKey: recipient.publicKeySpkiBase64,
    signature: crypto.signAuthorization(
      crypto.canonicalPayload(crypto.exportRequestInput(walletId, appId, recipient.publicKeySpkiBase64)),
      key,
    ),
  };
}

export type ProvisionResult =
  | { ok: true; address: string; ownerKind: string; swept: { amountUsdc: number } | null; sweepError: string | null }
  | { ok: false; error: string };

// Mint this user's wallet, owned by keys made a moment ago in this tab.
//
// TWO ROUND TRIPS, AND THE SECOND ONE IS NOT A CHOICE. The proof is a signature
// over Privy's export request for this wallet, and that request names the wallet
// in its URL (lib/export-crypto.ts:exportRequestInput) — so the signed bytes
// contain a wallet id that only exists once Privy has minted. The browser cannot
// sign it earlier, and the server cannot sign it at all. Any single-request design
// would therefore have to accept a weaker proof: a signature over bytes we chose,
// which shows the tab holds a key matching the public half it just sent us and
// NOTHING about whether Privy accepts that key as the wallet's owner. That second
// property is the one worth having — a mis-encoded quorum member is exactly the
// failure that leaves a wallet no one can ever sign — so the round trip stays.
//
// GIVEN a second trip, the recording happens after the proof rather than before
// it with a rollback. A rollback is a compensating write that can fail on its own,
// and if it does it leaves precisely the state it was added to prevent: a user
// pointed at a wallet nothing ever proved. Here nothing points at the wallet until
// the proof has landed.
//
// WHAT AN ABANDONED FIRST TRIP LEAVES: a Privy wallet owned by a quorum of the
// user's keys, with no row anywhere and no funds. Nothing reads it, nothing routes
// to it, and the next attempt simply makes another. That is the whole cost.
export async function provisionWallet(args: {
  provider: string;
  providerUserId: string;
  password: string;
  handle: string;
  usePasskey: boolean;
}): Promise<ProvisionResult> {
  const crypto = await import("@/lib/export-crypto");

  // The salt, computed HERE from the account rather than fetched, because the
  // wallet it will own does not exist yet and has no address to be salted with.
  // The server derives the same string from the same session identity and records
  // it on the row (privy_wallets.owner_salt), which is what lets tomorrow's unlock
  // re-derive this exact key.
  const keys = await deriveOwnerKeys({
    salt: crypto.accountSalt(args.provider, args.providerUserId),
    password: args.password,
    handle: args.handle,
    usePasskey: args.usePasskey,
  });

  // 1. MINT. Only public halves go up: the quorum is built from them, and the
  //    wallet is minted under it before anything of ours is recorded.
  const minted = await postProvision({
    publicKey: keys.primaryPublicKey,
    recoveryPublicKey: keys.recoveryPublicKey,
  });
  if (!minted.ok) return { ok: false, error: minted.error };

  // 2. PROVE, THEN RECORD. The same request carries the proof and the details to
  //    record, so the server can run them in that order without a third trip.
  const proof = await ownerProof(minted.data.walletId as string, minted.data.appId as string, keys.primaryKey);
  const done = await postProvision({
    walletId: minted.data.walletId,
    publicKey: keys.primaryPublicKey,
    recoveryPublicKey: keys.recoveryPublicKey,
    passkeyCredentialId: keys.passkeyCredentialId,
    ...proof,
  });
  if (!done.ok) return { ok: false, error: done.error };

  // Cached so the first payment needs no second prompt, and the claim-status memo
  // dropped so that payment takes the user-signed path — this wallet is born
  // claimed, and anything still holding the old answer would ask a server that has
  // no key for it to sign.
  rememberOwnerKey(done.data.address as string, keys.primaryKey);
  forgetClaimStatus();
  return {
    ok: true,
    address: done.data.address as string,
    ownerKind: done.data.ownerKind as string,
    swept: (done.data.swept as { amountUsdc: number } | null) ?? null,
    sweepError: (done.data.sweepError as string | null) ?? null,
  };
}

// The one place this route is called, so the error handling is written once. A
// failed first trip and a failed second trip read the same to the caller: nothing
// was recorded either way, and the fix for both is to try again.
async function postProvision(
  body: Record<string, unknown>,
): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; error: string }> {
  const res = await fetch("/api/wallet/provision", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, error: data.error ?? "Could not set up your wallet." };
  return { ok: true, data };
}
