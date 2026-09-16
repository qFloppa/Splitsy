# Handoff: user key export for the Privy wallet stack

Paste the whole of this file into a fresh chat. Written 2026-09-08 from a
brainstorming session that ran two spikes; the measured results below are the
expensive part and should not be re-derived.

---

## Goal

Design user key export for the Privy wallet stack. Without it, moving from Circle
DCW to Privy gives a user a different address and nothing else — export is the
whole justification, and `docs/superpowers/specs/2026-09-01-privy-wallet-stack-design.md`
says so itself ("**Users can export their wallet.** DCW has no such exit. This alone
justifies it"). It is not implemented: there is no export path anywhere in `app/` or
`lib/`, only comments mentioning it.

We are mid-brainstorming on the **architectural** path. Section 1 of the design is
approved. Sections 2+ remain, then a spec, then the `writing-plans` skill.

## Scope, already decided — do not re-litigate

- **Reveal-and-copy export only.** The server keeps signing everything. No
  client-side signing, no self-custody rewrite. Autopay, the dunning cron,
  `/api/recurring/settle`, pay-link claims and the settlement ceremony must not
  change.
- **Privy stack only.** Existing production Circle DCW users are out of scope: a DCW
  key cannot be exported at all, so covering them would mean new addresses plus a
  fund migration, which is Task 8 territory.
- **Pay wallet first**, agent wallet in a later pass. Until the agent wallet is
  covered, the UI must say "your pay wallet is exportable" rather than "your wallets
  are yours" — a user who topped up their agent still has USDC they cannot walk out
  with.

## Approved design — section 1

Three capabilities, deliberately held by three parties:

**Spending stays ours.** Our key quorum remains an `additional_signer`. Measured to
survive an ownership transfer (see below), so this is safe.

**Authorizing export becomes the user's.** The wallet's `owner` becomes a P-256
public key whose private half is generated in the browser — from a passkey, or a
password through a KDF — and never sent to us. Privy's `OwnerInput` accepts
`{public_key}` for exactly this. No JWKS endpoint, no token issuer, no JWT.

> `user_jwts` was considered and **rejected**: our wallets' Privy users are
> `custom_auth` identities with no login of their own, so we would be signing the
> user's token ourselves and could mint one any time. "Only you can export" would
> have been false.

**Reading the exported key becomes the user's.** `_export` takes a
`recipient_public_key` and returns HPKE ciphertext. Make that the **browser's**
ephemeral keypair, so the server relays the request and the ciphertext but cannot
decrypt the result. Plaintext key material exists only in the tab that asked.

**Ordering.** An owner must be set at creation, but the browser key cannot exist
during a server-side OAuth callback. So mint wallets **owned by our quorum**, and
**transfer ownership to the user's key** the first time they set up export. The login
flow does not change. Explainable in one sentence: *until you set an export
credential, Splitsy administers this wallet; after that, only you can export it.*

**Accepted failure mode.** Lose the credential and the wallet stays spendable through
Splitsy but is never exportable again. Preferred over any recovery path that
reinstates our ability to take the key.

**Known caveat to surface in the spec.** Between creation and transfer we *can*
export. A user who never sets up export leaves us able to extract. That argues for
prompting export setup early, and for saying so honestly rather than implying
otherwise.

## Spike results — measured, not inferred

### Ownership is the gate, and it cannot be retrofitted

Against throwaway probe wallet `gyusqqiel0o8th7ju94i7b1n`:

| attempt | result |
|---|---|
| `_export`, bare | 401 `No valid authorization keys or user signing keys available` |
| `_export`, signed with our authorization key | 401, identical |
| `wallets().update({owner_id})` to take ownership | 401, identical |
| **control:** `signTransaction`, same credentials | **OK** — 218-char RLP |

The control is what makes it conclusive: the credentials are fine. Our quorum
`jsd3fczbnwdk07yf9ndreoot` is only an `additional_signer`; the wallet's owner is a
Privy-assigned quorum `f05rjfzlbq0s82avewbdw39j`. An additional signer can **spend**
but cannot **export** or **take ownership**. Taking ownership is itself owner-gated,
so there is no way in after the fact.

### The design works, proven end to end

Created with `owner_id` **and** `additional_signers`:

```
create {chain_type:'ethereum', owner_id: QUORUM,
        additional_signers:[{signer_id: QUORUM}]}   owner_id === ours, signers set
spend BEFORE transfer                               OK — 218 chars
export as owner, signed by us                       OK — 80B ciphertext, 65B encap
update {owner:{public_key: <user SPKI>}}            OK — owner_id becomes a NEW
                                                    quorum Privy wraps around the key
export after transfer, signed by us                 401
export after transfer, signed by the user's key     OK — 80B ciphertext
spend AFTER transfer                                OK — 218 chars
additional_signers after transfer                   unchanged, still our quorum
```

A first run without `additional_signers` lost signing on transfer — signing had
ridden on ownership. With an explicit additional signer, **spending and ownership are
independent**. That is the finding the whole design rests on.

### API shapes that cost time to discover

- `_export(walletId, {encryption_type:'HPKE', recipient_public_key, 'privy-authorization-signature'})`
  lives at `node_modules/@privy-io/node/resources/wallets/wallets.d.ts:65`; REST is
  `POST /v1/wallets/{id}/export`. Returns `{ciphertext, encapsulated_key, encryption_type}`.
- **`recipient_public_key` must be base64 SPKI/DER P-256.** The SDK's own doc example
  (`'BDAZLOId…'`, a raw uncompressed point) is **wrong** and is rejected with
  "Must be a base64-encoded, SPKI-formatted ECDH or ECDSA public key."
- **`_export` and `wallets().create()` both reject `authorization_context`** with a
  400 unrecognized-key error. `wallets().update()` accepts it.
- `_export` is authorized by the `privy-authorization-signature` header. Build it with
  `generateAuthorizationSignature({authorizationPrivateKey, input:{version:1,
  method:'POST', url, body, headers:{'privy-app-id': APP_ID}}})`, exported from the
  package root. `authorizationPrivateKey` is base64 PKCS8 DER with no PEM headers —
  which is also the format for the user's browser key.
- **`WalletCreationInput` — the shape `walletSpec()` returns, passed as `wallets:` to
  `users().create()` — has NO owner field** (only `chain_type`, `additional_signers`,
  `create_smart_wallet`, `external_id`, `policy_ids`). Owners can only be set via
  `wallets().create()`. So `getOrCreateWallet` has to change shape, not just gain a
  parameter.
- The SDK does **not** decrypt: the caller does HPKE
  (DHKEM_P256_HKDF_SHA256 / HKDF_SHA256 / CHACHA20_POLY1305, BASE mode). Whether that
  needs a dependency or is ~60 lines of RFC 9180 on Node's `crypto` is an open
  implementation question — do not hand-roll it carelessly.
- `@privy-io/node@0.34.0` is the **latest** version. `EmbeddedWallets` and
  `Aggregations` are both **empty classes** — conclude nothing from them. (An earlier
  session wrongly concluded from `EmbeddedWallets` that server export did not exist.)
- Privy docs: the export path is fixed by **where the wallet was created**.
  Server-created wallets can only be exported server-side, so the React
  `exportWallet` / client-SDK design is inapplicable here.

### Consequence for existing wallets

`walletSpec()` (`lib/privy-wallet.ts:566-581`) sets `additional_signers` and no owner,
so **every wallet this stack has ever minted is permanently non-exportable** — 7 rows
in `privy_wallets`, including the live user's pay and agent wallets. Enabling export
means changing wallet creation and **re-minting**: new addresses, balances swept.
Cheap today (testnet, no real money); impossible to repair after a production flip.

This is the **second instance of one bug class**: a property that attaches only at
wallet creation, that nothing detects and no backfill can fix. The first is
`PRIVY_AGENT_POLICY_ID` (`docs/deployments.md:125-138`). The spec should name the
class and say what would catch a third.

## Remaining work

1. Design sections 2+ in chat, approval after each: the export flow end to end
   (including where HPKE decryption happens and how the key is displayed and then
   discarded), re-minting and sweeping the 7 existing wallets, how
   `getOrCreateWallet` changes now that owners need `wallets().create()`, error
   handling, testing.
2. Write `docs/superpowers/specs/2026-09-08-privy-key-export-design.md`, self-review
   for placeholders / contradictions / ambiguity / scope, commit it.
3. Ask the user to review the spec.
4. Invoke the `writing-plans` skill. Do not invoke any other implementation skill.

An open design question for section 2: `wallets().create()` supports a write-once
`external_id` and there is a get-wallet-by-external-id endpoint, which might let the
stack drop the Privy-user indirection (`getByCustomAuthID`) entirely and key wallets
directly on `<provider>:<providerUserId>`. Worth evaluating — `privy_wallets` is
already our own idempotency table — but it changes the adoption path in
`getOrCreateWallet`, so it is a decision, not a cleanup.

## Repo state and loose ends

- Branch `privy-wallet-stack` @ `b0da464`. `docs/deployments.md` carries an
  **uncommitted** 19-line addition documenting the Preview Supabase scoping
  precondition — the cause of an earlier bug where Preview read the **live** database
  because the three Supabase vars were inherited from All Environments. Commit or
  discard as preferred.
- **`scripts/privy-setup.ts` and `scripts/privy-policy.ts` are absent from HEAD** but
  referenced by `package.json` and `docs/deployments.md:131`. Recover with
  `git show a269e5b:scripts/privy-setup.ts` and
  `git show 85d24a5:scripts/privy-policy.ts`. `npm run privy:policy` is broken today,
  and re-minting needs it: a fresh agent wallet minted without
  `PRIVY_AGENT_POLICY_ID` is uncapped forever.
- **`@privy-io/node` is not declared in `package.json`**, only installed. Verify
  before any dependency work.
- **Casing bug, live in the database.** `setUserWallet` (`lib/users-repo.ts:45`)
  stores Privy's checksummed address verbatim while `setUserAgentWallet` (`:72`)
  lowercases, and `getUsersByWallets` (`:133`) matches lowercase — so Privy pay
  wallets never resolve to a handle, and the comment at `:127` claiming every
  `wallet_address` is lowercase is now false. Fix is `.toLowerCase()` plus an UPDATE
  for existing rows. Offered, not yet approved.
- Preview database is `splitsy-test` (`hdyioojrozodmutpldsu`); all Circle wallet
  references were cleared. Current wallets for user `qFloppa` (X id `21068173`): pay
  `0xa264A3818F20f878380B5Af9154080605de9a704` (`jla7zhktvth6r5j6utwx0pet`), agent
  `0x16a62bd12077224653f4a9b4ee72bec86aac6b09` (`k7bgxwx7inqz6visjvbv9hkm`). Both
  need re-minting for export.
- Two **orphan test wallets** were left in Privy by the spike, unattached to any user
  and empty: `lk3j6d2fhdk6zfae2drs6gz4` (`0x65C1Ec57ff51C8A4474A1481DAe35279F6f80452`)
  and `zrzrmvkplxoucjt6p9t4wc5y` (`0xCB6DA68637c456165C259eE5718Acd1d48B974A1`). The
  second is owned by a discarded key, so nobody can export it. Harmless; delete if
  tidiness matters.
- `npm run build` has **not** been verified on this branch — two attempts were killed
  when the box hit load average 47 with orphaned `next build` workers.
  `npx tsc --noEmit` was clean.
- Production project `hvckneltkugnvtwfrzlb` has RLS **disabled** on `x402_payments`
  (596 rows), so the anon key can read or modify every row. Flagged, not acted on.

## Constraints

- `AGENTS.md`: this is not the Next.js you know. Read the relevant guide in
  `node_modules/next/dist/docs/` before writing code.
- Ponytail mode: laziest solution that actually works, root cause over symptom,
  shortest diff — but never simplify away validation at trust boundaries, error
  handling that prevents data loss, or security measures. This feature is all three.
- Never print or log plaintext key material, including in tests. The spikes reported
  byte lengths only.
