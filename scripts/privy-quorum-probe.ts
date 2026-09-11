// CAN TWO KEYS OWN ONE WALLET, EITHER SIGNING ALONE?
//
// This decides a promise made to a user, not just an implementation. The custody
// design so far has one unresolved cost: the owner key is derived from a password,
// so forgetting it loses the wallet permanently. The fix is a passkey — but a
// passkey CANNOT be Privy's owner key directly.
//
//   Privy verifies:  P256.verify(sig, sha256(canonicalize(payload)), ownerPubKey)
//   WebAuthn signs:  P256.sign(sha256(authenticatorData || sha256(clientDataJSON)))
//
// The authenticator prepends its own bytes and wraps our payload inside
// clientDataJSON.challenge, so we never control the signed pre-image and the
// signature can never verify against Privy's digest. That is not a gap to code
// around; it is what makes WebAuthn phishing-resistant. What a passkey CAN do is
// release a stable secret (the PRF extension), and that secret derives a P-256 key
// which signs normally.
//
// Which leaves the recovery question this probe exists to answer: if the wallet is
// owned by a KEY QUORUM holding {passkey key, password key} at threshold 1, does
// either one sign alone? If yes, a lost device is survivable and the password is a
// real recovery path. If no, passkey and password are two separate claims with no
// recovery, and the UI has to say so.
//
// PRF ITSELF IS NOT TESTED HERE and cannot be: it needs a real browser and a real
// authenticator. This probe uses two ordinary derived keys, because what is in
// question is Privy's quorum behaviour, not where the bytes came from.
//
// EVERY RUN MINTS A PERMANENTLY ORPHANED WALLET and a key quorum beside it.
// Never funded, and signTransaction does not broadcast, so nothing reaches a chain.
//
// NEVER PRINTS KEY MATERIAL. Verdicts, byte lengths and error class names only.
//
//   node --experimental-strip-types --env-file=.env.local scripts/privy-quorum-probe.ts
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

let controlsFailed = false;
let guaranteeBroken = false;
const ok = (label: string, pass: boolean, detail = "") => {
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
  if (!pass) controlsFailed = true;
};
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

// Sign with ONE member key, the way a browser holding only that key would.
const signWith = async (walletId: string, secretKey: Uint8Array) => {
  try {
    const response = await privy.wallets()._rpc(walletId, {
      method: "eth_signTransaction",
      params: { transaction },
      "privy-authorization-signature": signAuthorization(canonicalPayload(rpcRequestInput(walletId)), secretKey),
    } as never);
    const signed = (response as { data?: { signed_transaction?: string } }).data?.signed_transaction;
    return { signed, error: null as unknown };
  } catch (error) {
    return { signed: undefined, error };
  }
};

const serverSign = async (walletId: string) => {
  try {
    const r = await privy.wallets().ethereum().signTransaction(walletId, { params: { transaction }, authorization_context });
    return { signed: r.signed_transaction as string | undefined, error: null as unknown };
  } catch (error) {
    return { signed: undefined, error };
  }
};

const serverExport = async (walletId: string) => {
  try {
    const recipient = await createExportRecipient();
    await privy.wallets()._export(walletId, {
      encryption_type: "HPKE",
      recipient_public_key: recipient.publicKeySpkiBase64,
      "privy-authorization-signature": signAuthorization(
        canonicalPayload(exportRequestInput(walletId, appId, recipient.publicKeySpkiBase64)),
        await deriveOwnerSecretKey("a-key-splitsy-might-have-kept", "0x0"),
      ),
    });
    return { exported: true, error: null as unknown };
  } catch (error) {
    return { exported: false, error };
  }
};

const describe = (e: unknown) =>
  e instanceof AuthenticationError ? "HTTP 401 AuthenticationError" : `${(e as Error)?.constructor?.name ?? "nothing thrown"}`;

// 1. Mint the way production does: ours, both ways.
const wallet = await privy.wallets().create({
  chain_type: "ethereum",
  owner_id: quorum,
  additional_signers: [{ signer_id: quorum }],
  idempotency_key: `quorum-probe:${Date.now()}`,
});
console.log(`\nprobe wallet ${wallet.id} ${wallet.address}\n`);

console.log("controls — before the claim:");
ok("our quorum owns it", wallet.owner_id === quorum, String(wallet.owner_id));
const before = await serverSign(wallet.id);
ok("the server CAN sign before the claim", Boolean(before.signed?.startsWith("0x02")), `${before.signed?.length ?? 0} chars`);

// 2. Two independent owner keys. In production one comes from the passkey's PRF
// output and one from the password; here both are derived, because the question is
// Privy's behaviour and not the provenance of 32 bytes.
const passkeyKey = await deriveOwnerSecretKey("stands-in-for-the-passkey-prf-secret", wallet.address);
const passwordKey = await deriveOwnerSecretKey("the-users-recovery-password", wallet.address);
const strangerKey = await deriveOwnerSecretKey("not-a-member-of-this-quorum", wallet.address);

// 3. The quorum. THRESHOLD 1 is the whole question: two members, either sufficient.
const ownerQuorum = await privy.keyQuorums().create({
  authorization_threshold: 1,
  display_name: `probe ${wallet.id}`,
  public_keys: [await ownerPublicKeySpki(passkeyKey), await ownerPublicKeySpki(passwordKey)],
});
console.log("\nthe quorum:");
ok("it has two authorization keys", (ownerQuorum.authorization_keys ?? []).length === 2, `${(ownerQuorum.authorization_keys ?? []).length} keys`);
ok("its threshold is 1", ownerQuorum.authorization_threshold === 1, String(ownerQuorum.authorization_threshold));

// 4. THE CLAIM, to a quorum id rather than a bare key — and still one atomic call.
const claimed = await privy.wallets().update(wallet.id, {
  owner_id: ownerQuorum.id,
  additional_signers: [],
  authorization_context,
});

console.log("\nthe claim, as Privy reports it back:");
ok("ownership moved to the new quorum", claimed.owner_id === ownerQuorum.id, String(claimed.owner_id));
must(
  "our quorum is NO LONGER an additional signer",
  !(claimed.additional_signers ?? []).some((s) => s.signer_id === quorum),
  `${(claimed.additional_signers ?? []).length} signer(s) remain`,
);

// 5. THE QUESTION: does either member sign ALONE?
console.log("\nTHE QUESTION — threshold 1 means one signature is enough:");
const byPasskey = await signWith(wallet.id, passkeyKey);
must("the PASSKEY key signs alone", Boolean(byPasskey.signed?.startsWith("0x02")), byPasskey.signed ? `${byPasskey.signed.length} chars` : describe(byPasskey.error));

const byPassword = await signWith(wallet.id, passwordKey);
must("the PASSWORD key signs alone", Boolean(byPassword.signed?.startsWith("0x02")), byPassword.signed ? `${byPassword.signed.length} chars` : describe(byPassword.error));

// 6. THE CONTROL THAT MAKES THAT MEAN ANYTHING. If a non-member also signs, the
// quorum is not gating and the two successes above prove nothing.
console.log("\nis membership actually checked?");
const byStranger = await signWith(wallet.id, strangerKey);
ok(
  "a key OUTSIDE the quorum is refused",
  !byStranger.signed,
  byStranger.signed ? "NOT refused — it SIGNED, so the quorum is not gating" : describe(byStranger.error),
);

// 7. And Splitsy still holds nothing.
console.log("\nSplitsy holds no key to this wallet:");
const afterSign = await serverSign(wallet.id);
must("the server CANNOT sign", !afterSign.signed, afterSign.signed ? `IT SIGNED — ${afterSign.signed.length} chars` : describe(afterSign.error));
const afterExport = await serverExport(wallet.id);
must("the server CANNOT export", !afterExport.exported, afterExport.exported ? "IT EXPORTED" : describe(afterExport.error));

console.log(
  controlsFailed
    ? "\nCONTROLS FAILED — the findings above are void."
    : guaranteeBroken
      ? "\nBROKEN — a two-key quorum does not behave as the recovery design needs. Do not promise recovery."
      : "\nHOLDS — passkey and password can both own one wallet, either signs alone, and Splitsy holds neither.",
);
process.exitCode = controlsFailed || guaranteeBroken ? 1 : 0;
