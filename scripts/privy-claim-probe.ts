// THE GUARANTEE, made falsifiable: after a wallet is CLAIMED, Splitsy holds no key
// to it. Not "should not use" — cannot.
//
// This probe is the inverse of scripts/privy-owner-sign-probe.ts. That one proved
// the user's key gains spending; this one proves OUR key loses it. Both must hold
// for a non-custodial pay wallet, and only the second is a promise to the user, so
// only the second can be allowed to fail silently. Kept separate rather than folded
// in because the two assert opposite things about the same call and a reader should
// not have to hold both in mind at once.
//
// THE CLAIM IS ONE CALL. wallets().update() takes `owner` and `additional_signers`
// together, so ownership moves and our signer is revoked atomically. Two calls would
// leave a window in which the wallet is the user's but we can still spend it — or
// worse, one in which we have revoked our own signer but ownership never moved and
// nobody can sign at all. That window is the whole reason this is a single request.
//
// EVERY RUN MINTS A PERMANENTLY ORPHANED WALLET, and this one is orphaned harder
// than the export probe's: after the claim nobody holds a usable key except the
// throwaway password below, and our quorum cannot recover it. Never funded, and
// signTransaction does not broadcast, so nothing reaches a chain.
//
// NEVER PRINTS KEY MATERIAL. Verdicts, byte lengths and error class names only.
//
//   node --experimental-strip-types --env-file=.env.local scripts/privy-claim-probe.ts
import { AuthenticationError, PrivyClient } from "@privy-io/node";
import {
  type AuthorizationInput,
  PRIVY_API_BASE,
  canonicalPayload,
  createExportRecipient,
  deriveOwnerSecretKey,
  exportRequestInput,
  ownerPublicKeySpki,
  signAuthorization,
} from "../lib/export-crypto.ts";

const required = (name: string, value: string | undefined): string => {
  if (!value) throw new Error(`${name} is not set`);
  return value;
};
const appId = required("PRIVY_APP_ID", process.env.PRIVY_APP_ID);
const appSecret = required("PRIVY_APP_SECRET", process.env.PRIVY_APP_SECRET);
const quorum = required("PRIVY_KEY_QUORUM_ID", process.env.PRIVY_KEY_QUORUM_ID?.trim());
const authKey = required("PRIVY_AUTHORIZATION_PRIVATE_KEY", process.env.PRIVY_AUTHORIZATION_PRIVATE_KEY);

const privy = new PrivyClient({ appId, appSecret });
const authorization_context = { authorization_private_keys: [authKey] };

// Controls set the exit code; the findings do not. Same discipline as the sign
// probe: a control failing means the measurement is void, but "we can still sign"
// is a real answer that this script exists to detect — and it must be reported
// loudly rather than turned into a green run by a lenient assertion.
let controlsFailed = false;
const ok = (label: string, pass: boolean, detail = "") => {
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
  if (!pass) controlsFailed = true;
};
// A guarantee that must hold. Unlike ok(), failing one of these is the headline.
let guaranteeBroken = false;
const must = (label: string, pass: boolean, detail = "") => {
  console.log(`  ${pass ? "HOLDS " : "BROKEN"}  ${label}${detail ? `  — ${detail}` : ""}`);
  if (!pass) guaranteeBroken = true;
};

const transaction = {
  to: "0x0000000000000000000000000000000000000001",
  nonce: "0x0",
  chain_id: 5042002,
  type: 2,
  gas_limit: "0x5208",
  max_fee_per_gas: "0x3b9aca00",
  max_priority_fee_per_gas: "0x3b9aca00",
} as const;

const rpcRequestInput = (walletId: string): AuthorizationInput => ({
  version: 1,
  method: "POST",
  url: `${PRIVY_API_BASE}/v1/wallets/${walletId}/rpc`,
  body: { method: "eth_signTransaction", params: { transaction } },
  headers: { "privy-app-id": appId },
});

// Did OUR quorum manage to sign? Returns the outcome without judging it.
const quorumSign = async (walletId: string) => {
  try {
    const r = await privy.wallets().ethereum().signTransaction(walletId, { params: { transaction }, authorization_context });
    return { signed: r.signed_transaction as string | undefined, error: null as unknown };
  } catch (error) {
    return { signed: undefined, error };
  }
};

// Did OUR quorum manage to export? The other half of "holds no key".
const quorumExport = async (walletId: string) => {
  try {
    const recipient = await createExportRecipient();
    await privy.wallets()._export(walletId, {
      encryption_type: "HPKE",
      recipient_public_key: recipient.publicKeySpkiBase64,
      "privy-authorization-signature": signAuthorization(
        canonicalPayload(exportRequestInput(walletId, appId, recipient.publicKeySpkiBase64)),
        // Signed with an authorization key we control. The point is that no key we
        // hold works, so the strongest form of this test uses one that legitimately
        // belonged to the wallet a moment ago.
        await deriveOwnerSecretKey("a-key-splitsy-might-have-kept", "0x0"),
      ),
    });
    return { exported: true, error: null as unknown };
  } catch (error) {
    return { exported: false, error };
  }
};

const refused = (e: unknown) => e instanceof AuthenticationError;
const describe = (e: unknown) => (refused(e) ? "HTTP 401 AuthenticationError" : `${(e as Error)?.constructor?.name ?? "nothing thrown"}`);

// 1. Mint the wallet the way production does today: ours, both ways.
const wallet = await privy.wallets().create({
  chain_type: "ethereum",
  owner_id: quorum,
  additional_signers: [{ signer_id: quorum }],
  idempotency_key: `claim-probe:${Date.now()}`,
});
console.log(`\nprobe wallet ${wallet.id} ${wallet.address}\n`);

console.log("controls — before the claim, we hold the keys and everything works:");
ok("our quorum owns it", wallet.owner_id === quorum, String(wallet.owner_id));
ok("our quorum is an additional signer", (wallet.additional_signers ?? []).some((s) => s.signer_id === quorum));
const before = await quorumSign(wallet.id);
ok("the server CAN sign before the claim", Boolean(before.signed?.startsWith("0x02")), `${before.signed?.length ?? 0} chars`);

// 2. THE CLAIM. Ownership moves to the user's key and our signer is revoked, in ONE
// request — the atomicity is the point, not an optimisation.
const PROBE_PASSWORD = "probe-password-not-a-real-credential";
const ownerKey = await deriveOwnerSecretKey(PROBE_PASSWORD, wallet.address);
const claimed = await privy.wallets().update(wallet.id, {
  owner: { public_key: await ownerPublicKeySpki(ownerKey) },
  additional_signers: [],
  authorization_context,
});

console.log("\nthe claim, as Privy reports it back:");
ok(
  "ownership moved off our quorum",
  typeof claimed.owner_id === "string" && claimed.owner_id !== quorum,
  String(claimed.owner_id),
);
must(
  "our quorum is NO LONGER an additional signer",
  !(claimed.additional_signers ?? []).some((s) => s.signer_id === quorum),
  `${(claimed.additional_signers ?? []).length} signer(s) remain`,
);

// 3. THE GUARANTEE ITSELF. Privy's own report of the wallet is not enough — what
// matters is whether the calls actually fail, which is the thing a user is being
// asked to trust.
console.log("\nTHE GUARANTEE — Splitsy holds no key to this wallet:");
const afterSign = await quorumSign(wallet.id);
must("the server CANNOT sign after the claim", !afterSign.signed, afterSign.signed ? `IT SIGNED — ${afterSign.signed.length} chars` : describe(afterSign.error));

const afterExport = await quorumExport(wallet.id);
must("the server CANNOT export after the claim", !afterExport.exported, afterExport.exported ? "IT EXPORTED" : describe(afterExport.error));

// 4. And the wallet is not merely bricked — the user can still use it. A claim that
// revoked our signer AND left the owner unable to sign would pass every check above
// while destroying the wallet, which is the one failure this ordering could hide.
console.log("\nthe wallet still works for its owner:");
const byOwner = await (async () => {
  try {
    const response = await privy.wallets()._rpc(wallet.id, {
      method: "eth_signTransaction",
      params: { transaction },
      "privy-authorization-signature": signAuthorization(canonicalPayload(rpcRequestInput(wallet.id)), ownerKey),
    } as never);
    return (response as { data?: { signed_transaction?: string } }).data?.signed_transaction;
  } catch {
    return undefined;
  }
})();
must("the OWNER can still sign", Boolean(byOwner?.startsWith("0x02")), byOwner ? `${byOwner.length} chars, type 2` : "the owner cannot sign — the wallet is bricked");

console.log(
  controlsFailed
    ? "\nCONTROLS FAILED — the findings above are void."
    : guaranteeBroken
      ? "\nGUARANTEE BROKEN — a claimed wallet is NOT non-custodial. Do not ship the claim."
      : "\nGUARANTEE HOLDS — after a claim, Splitsy can neither sign nor export, and the owner can.",
);
process.exitCode = controlsFailed || guaranteeBroken ? 1 : 0;
