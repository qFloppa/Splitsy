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
  // `idempotency_key`, NOT `'privy-idempotency-key'`: `privy.wallets()` returns
  // PrivyWalletsService, which OVERRIDES create (public-api/services/wallets.js:41-46)
  // and destructures `idempotency_key` into the header itself. Its input type is
  // WithIdempotency<WalletCreateParams>, which omits the header key and adds this
  // one — so the header spelling is a TS2353 excess-property error here, and
  // `npx tsc --noEmit` catches it. Both spellings reach the same header at runtime.
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
const derivesToThisWallet = verifyExportedKey(plaintext, wallet.address);
ok("the decrypted key derives to THIS wallet", derivesToThisWallet);
ok(
  "the decrypted key is 64 hex characters",
  /^(0x)?[0-9a-fA-F]{64}$/.test(plaintext),
  `${plaintext.length} chars`,
);
// Derived, not printed. This is the only place the address is recomputed from the
// key — and ONLY from a key already proven to be this wallet's. Unguarded, an
// out-of-range scalar makes privateKeyToAddress throw noble's "expected valid
// private key: 1 <= n < ..., got <n>", which echoes the key in decimal. A FAIL
// above must not turn into a disclosure below.
if (derivesToThisWallet) {
  const hex = plaintext.startsWith("0x") ? plaintext : `0x${plaintext}`;
  console.log(`derived address ${privateKeyToAddress(hex as `0x${string}`)} (expected ${wallet.address})`);
}

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
