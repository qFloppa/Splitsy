// ONE QUESTION: after ownership moves to the user's key, can THAT key authorize a
// transaction — or does it only authorize export?
//
// This is the gate on user-signed payments. If an owner key can sign, then a debt
// the user pays from their own tab can be signed BY the user, and our quorum's
// additional-signer spend is needed only for the things nobody is present for:
// autopay and pay-link claims. That is the difference between "Splitsy can move
// your assets" and "Splitsy signs only for autopay; anything you start, you sign."
//
// scripts/privy-export-probe.ts proved the export half and deliberately never asked
// this. Its step 6 signs AFTER the transfer with OUR quorum, which measures that we
// kept spending — not that the user gained it. Separate file so that proven probe
// stays untouched.
//
// The SDK cannot express this call. signTransaction()'s input type REPLACES the raw
// 'privy-authorization-signature' header with authorization_context, which takes
// PRIVATE KEYS (public-api/services/types.d.ts:19) — fine for our quorum, useless
// for a browser that must never hand its key over. So this goes through _rpc, the
// generated method, which still accepts the raw header
// (resources/wallets/wallets.d.ts:120,3860) — exactly why the export path uses
// _export rather than exportPrivateKey().
//
// EVERY RUN MINTS A PERMANENTLY ORPHANED WALLET, same as the export probe: ownership
// moves to a key derived from the throwaway password below, which nobody keeps. It is
// never funded, and signTransaction does NOT broadcast — nothing reaches a chain.
//
// NEVER PRINTS KEY MATERIAL. Verdicts, byte lengths and error class names only.
//
//   npx tsx --env-file=.env.local scripts/privy-owner-sign-probe.ts
import { AuthenticationError, PrivyClient } from "@privy-io/node";
import {
  type AuthorizationInput,
  PRIVY_API_BASE,
  canonicalPayload,
  deriveOwnerSecretKey,
  ownerPublicKeySpki,
  signAuthorization,
} from "../lib/export-crypto.ts";

// Read once, checked once, and narrowed by the check rather than by a cast. The
// export probe's loop is the same guard; this shape exists because `quorum` is
// compared against a value from Privy further down and a cast there would hide the
// one thing this file needs to be sure of.
const required = (name: string, value: string | undefined): string => {
  if (!value) throw new Error(`${name} is not set`);
  return value;
};
const appId = required("PRIVY_APP_ID", process.env.PRIVY_APP_ID);
const appSecret = required("PRIVY_APP_SECRET", process.env.PRIVY_APP_SECRET);
// Trimmed, to match resolveState (app/api/wallet/export/route.ts), which compares
// this id against the owner Privy reports — a padded value here would report a
// mismatch that is really a typo in the environment.
const quorum = required("PRIVY_KEY_QUORUM_ID", process.env.PRIVY_KEY_QUORUM_ID?.trim());
const authKey = required("PRIVY_AUTHORIZATION_PRIVATE_KEY", process.env.PRIVY_AUTHORIZATION_PRIVATE_KEY);

const privy = new PrivyClient({ appId, appSecret });
const authorization_context = { authorization_private_keys: [authKey] };

// A CONTROL failing voids the measurement, so it sets the exit code. THE QUESTION
// does not: this script exists to find out, and "the owner key cannot sign" is a
// real answer, not a failure. A probe that exits non-zero on the answer it was
// written to discover invites the next person to "fix" it.
let controlsFailed = false;
const ok = (label: string, pass: boolean, detail = "") => {
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
  if (!pass) controlsFailed = true;
};
const finding = (label: string, detail: string) => console.log(`  →     ${label}  — ${detail}`);

// The unsigned transaction every call below asks for. Nonce 0 against a wallet that
// has never transacted, a 1-wei-ish gas price, and address 0x…01 as the recipient:
// this is never broadcast, so none of it has to be spendable.
const transaction = {
  to: "0x0000000000000000000000000000000000000001",
  nonce: "0x0",
  chain_id: 5042002,
  type: 2,
  gas_limit: "0x5208",
  max_fee_per_gas: "0x3b9aca00",
  max_priority_fee_per_gas: "0x3b9aca00",
} as const;

// The bytes an owner key has to sign to authorize eth_signTransaction. Sibling of
// exportRequestInput (lib/export-crypto.ts:52) and the same rule applies: the body
// here must be BYTE-FOR-BYTE what the SDK puts on the wire, or the signature covers
// a different request and Privy rejects it. _rpc sends the params object minus the
// header keys, so `{method, params}` is the whole body.
const rpcRequestInput = (walletId: string): AuthorizationInput => ({
  version: 1,
  method: "POST",
  url: `${PRIVY_API_BASE}/v1/wallets/${walletId}/rpc`,
  body: { method: "eth_signTransaction", params: { transaction } },
  headers: { "privy-app-id": appId },
});

// Returns the signed transaction, or the error, without deciding what either means.
const rpcSignedBy = async (walletId: string, secretKey: Uint8Array) => {
  try {
    const response = await privy.wallets()._rpc(walletId, {
      method: "eth_signTransaction",
      params: { transaction },
      "privy-authorization-signature": signAuthorization(canonicalPayload(rpcRequestInput(walletId)), secretKey),
    });
    const signed = (response as { data?: { signed_transaction?: string } }).data?.signed_transaction;
    return { signed, error: null as unknown };
  } catch (error) {
    return { signed: undefined, error };
  }
};

// 1. Mint the shape the design rests on: our quorum as owner AND additional signer.
const wallet = await privy.wallets().create({
  chain_type: "ethereum",
  owner_id: quorum,
  additional_signers: [{ signer_id: quorum }],
  idempotency_key: `owner-sign-probe:${Date.now()}`,
});
console.log(`\nprobe wallet ${wallet.id} ${wallet.address}\n`);
console.log("controls, before the transfer:");
ok("owner_id is our quorum at creation", wallet.owner_id === quorum, String(wallet.owner_id));

const signedBefore = await privy.wallets().ethereum().signTransaction(wallet.id, { params: { transaction }, authorization_context });
ok("the server can sign BEFORE the transfer", signedBefore.signed_transaction.startsWith("0x02"), `${signedBefore.signed_transaction.length} chars`);

// 2. Move ownership to a password-derived key, exactly as the export tab does.
const PROBE_PASSWORD = "probe-password-not-a-real-credential";
const ownerKey = await deriveOwnerSecretKey(PROBE_PASSWORD, wallet.address);
const updated = await privy.wallets().update(wallet.id, { owner: { public_key: await ownerPublicKeySpki(ownerKey), }, authorization_context });
ok(
  "ownership moved off our quorum",
  typeof updated.owner_id === "string" && updated.owner_id !== quorum,
  String(updated.owner_id),
);
ok(
  "our quorum is STILL an additional signer",
  (updated.additional_signers ?? []).some((s) => s.signer_id === quorum),
);

// 3. THE CONTROL THAT MAKES THE ANSWER MEAN ANYTHING. A wrong key must be refused.
// If Privy ignores this header for spending, a wrong key succeeds too — and then the
// owner key succeeding below would prove nothing about the owner key.
console.log("\nis the signature actually checked on this endpoint?");
const wrong = await rpcSignedBy(wallet.id, await deriveOwnerSecretKey("a-different-password", wallet.address));
const wrongRefused = wrong.error instanceof AuthenticationError;
ok(
  "a WRONG key is refused",
  wrongRefused,
  wrongRefused
    ? "HTTP 401 AuthenticationError"
    : wrong.signed
      ? "NOT refused — it SIGNED, so the header is not gating this endpoint"
      : `inconclusive — ${(wrong.error as Error)?.constructor?.name ?? "nothing thrown"}`,
);

// 4. THE QUESTION.
console.log("\nTHE QUESTION — can the owner key authorize eth_signTransaction?");
const byOwner = await rpcSignedBy(wallet.id, ownerKey);
if (byOwner.signed?.startsWith("0x02")) {
  finding("YES — the owner key signed", `${byOwner.signed.length} chars, type 2`);
  console.log("\n  User-signed payments are POSSIBLE. Splitsy's signer can be scoped to autopay and claims.");
} else if (byOwner.error instanceof AuthenticationError) {
  finding("NO — the owner key was refused", "HTTP 401 AuthenticationError");
  console.log("\n  Option (c) is dead as designed: ownership grants export, not spending. A user-signed");
  console.log("  payment would need a second credential the wallet knows about, not the export key.");
} else {
  finding(
    "INCONCLUSIVE",
    `${(byOwner.error as Error)?.constructor?.name ?? "no signature and nothing thrown"} — not a 401, so this is not a refusal`,
  );
}

// 5. Whatever the answer, our own spending must be intact — otherwise the finding is
// about a broken wallet rather than about ownership.
console.log("\ncontrols, after the transfer:");
const signedAfter = await privy.wallets().ethereum().signTransaction(wallet.id, { params: { transaction }, authorization_context });
ok("the server can STILL sign after the transfer", signedAfter.signed_transaction.startsWith("0x02"), `${signedAfter.signed_transaction.length} chars`);

console.log(
  controlsFailed
    ? "\nCONTROLS FAILED — the finding above is void. Do not design on it."
    : "\nControls held. The finding above is real.",
);
process.exitCode = controlsFailed ? 1 : 0;
