# Privy Wallet Stack — User Key Export

**Date:** 2026-09-08
**Status:** accepted, not yet built
**Part of:** the `2026-09-01-privy-wallet-stack-design.md` effort (sections 2–6 here)
**Supersedes:** nothing. Complements the stack design.

## Problem

The Privy stack gives a user an exportable wallet *in principle* — that is the
whole reason it replaces Circle DCW — but there is no export path anywhere in
`app/` or `lib/`. Only comments mention it. Without it, moving from Circle DCW to
Privy hands a user a different address and nothing else.

Two things make this binary, not incremental:

1. **Export is owned by ownership, and ownership cannot be retrofitted.** Measured
   (see the spike results below): a wallet the server did not sign up as
   `additional_signer` can be *spent from* but never *exported* or *re-owned*.
   An additional signer spends; only the `owner` exports. There is no way in
   after the fact. So export has to be designed into wallet creation, or into a
   deliberate ownership transfer — it cannot be bolted on later.
2. **Every wallet this stack has already minted is permanently non-exportable.**
   `walletSpec()` (`lib/privy-wallet.ts:566-581`) sets `additional_signers` and no
   owner, so the existing 7 `privy_wallets` rows can never be exported. Restoring
   export means re-minting: new addresses, balances swept. Cheap today (Preview,
   testnet, one real funded wallet); impossible to repair after a production flip.

## Approved design — section 1

Three capabilities, deliberately held by three parties:

- **Spending stays ours.** Our key quorum remains an `additional_signer`.
  Measured to survive an ownership transfer, so this is safe.
- **Authorizing export becomes the user's.** The wallet's `owner` becomes a P-256
  public key whose private half is generated in the browser — from a password
  through PBKDF2 — and never sent to us. Privy's `OwnerInput` accepts
  `{public_key}` for exactly this. No JWKS endpoint, no token issuer, no JWT.
  (`user_jwts` was considered and **rejected**: our Privy users are
  `custom_auth` identities with no login of their own, so we would sign the
  user's token ourselves and could mint one any time. "Only you can export"
  would have been false.)
- **Reading the exported key becomes the user's.** `_export` takes a
  `recipient_public_key` and returns HPKE ciphertext. Make that the **browser's**
  ephemeral keypair, so the server relays the request and the ciphertext but
  cannot decrypt the result.
- **Ordering.** An owner must be set at creation, but the browser key cannot exist
  during a server-side OAuth callback. So mint wallets **owned by our quorum**,
  and **transfer ownership to the user's key** the first time they set up export.
  The login flow does not change.
- **Accepted failure mode.** Lose the credential and the wallet stays spendable
  through Splitsy but is never exportable again. Preferred over any recovery path
  that reinstates our ability to take the key.
- **Known caveat.** Between creation and transfer we *can* export. A user who
  never sets up export leaves us able to extract. Argues for prompting export
  setup early, and for stating it honestly.

### Spike results — measured, not inferred

Against throwaway probe wallet `gyusqqiel0o8th7ju94i7b1n`:

| attempt | result |
|---|---|
| `_export`, bare | 401 `No valid authorization keys or user signing keys available` |
| `_export`, signed with our authorization key | 401, identical |
| `wallets().update({owner_id})` to take ownership | 401, identical |
| **control:** `signTransaction`, same credentials | **OK** — 218-char RLP |

The control is what makes it conclusive: the credentials are fine. Our quorum is
only an `additional_signer`; the wallet's owner is a Privy-assigned quorum. An
additional signer can **spend** but cannot **export** or **take ownership**.

The full proof, created with `owner_id` **and** `additional_signers`:

```
create {chain_type:'ethereum', owner_id: QUORUM,
        additional_signers:[{signer_id: QUORUM}]}
spend BEFORE transfer     OK
export as owner, signed by us     OK — 80B ciphertext, 65B encap
update {owner:{public_key: <user SPKI>}}     OK — owner_id becomes a NEW quorum
export after transfer, signed by us     401
export after transfer, signed by user's key     OK — 80B ciphertext
spend AFTER transfer     OK
additional_signers after transfer     unchanged, still our quorum
```

A first run without `additional_signers` lost signing on transfer. With an
explicit additional signer, **spending and ownership are independent** — the
finding the whole design rests on.

### API shapes that cost time to discover

- `_export(walletId, {encryption_type:'HPKE', recipient_public_key, 'privy-authorization-signature'})`
  lives at `node_modules/@privy-io/node/resources/wallets/wallets.d.ts:65`.
  Returns `{ciphertext, encapsulated_key, encryption_type}`.
- **`recipient_public_key` must be base64 SPKI/DER P-256.** The SDK's own doc
  example is a raw uncompressed point and is **rejected** with "Must be a
  base64-encoded, SPKI-formatted ECDH or ECDSA public key."
- **`_export` and `wallets().create()` both reject `authorization_context`**
  (400 unrecognized-key error). `wallets().update()` accepts it.
- `_export` is authorized by the `privy-authorization-signature` header, built
  with `generateAuthorizationSignature({authorizationPrivateKey, input:{version:1,
  method:'POST', url, body, headers:{'privy-app-id': APP_ID}}})`. The signature is
  `base64(p256.sign(sha256(canonicalize(payload))).toBytes('der'))`.
- **`WalletCreateParams` has no user field** — only `chain_type`,
  `additional_signers`, `owner`, `owner_id`, `external_id`, `policy_ids`,
  `entity`. Owners can only be set via `wallets().create()`, and it takes a
  **`privy-idempotency-key` header, 24-hour window**. So `getOrCreateWallet`
  changes shape, not just gains a parameter.
- The SDK does **not** decrypt. The caller does HPKE
  (DHKEM_P256_HKDF_SHA256 / HKDF_SHA256 / CHACHA20_POLY1305, BASE mode).
  `node_modules/@privy-io/node/lib/cryptography.mjs:76-95` already contains
  `setupHPKERecipient()` built on `@hpke/core` + `@hpke/chacha20poly1305` —
  both installed as transitive deps. It is `@internal` and not re-exported, so
  we copy ~15 lines rather than deep-import. **No new hand-rolled RFC 9180.**
- `@privy-io/node@0.34.0` is the **latest**. `EmbeddedWallets` and
  `Aggregations` are both empty classes — conclude nothing from them.
- Privy docs: the export path is fixed by **where the wallet was created**.
  Server-created wallets can only be exported server-side, so the React
  `exportWallet` / client-SDK design is inapplicable here.

## §2 — The export flow, end to end

**Three secrets, three places.** The export password never leaves the tab. The
HPKE ephemeral private key never leaves the tab. The exported wallet key is only
ever plaintext in the tab. Our server sees a public key, a signature, and
ciphertext it cannot open.

### Setup — "Enable export" (once, per wallet)

```
browser  password + confirm, ≥12 chars
         sk = PBKDF2-SHA256(password, "splitsy-export:" + address.toLowerCase(),
                            600_000 iters, 32 bytes)        ← crypto.subtle, native
         pub = SPKI(P-256 public of sk), base64
  PUT    /api/wallet/export  { publicKey: pub }
server   unlock-cookie gated (the /api/wallet/send precedent, 403 "locked")
         wallets().update(walletId, {owner:{public_key}}) signed by our quorum
         → privy_wallets.export_owner_key = pub
```

The salt is lowercased deliberately, so the derivation is unaffected by the
`setUserWallet` casing bug (`lib/users-repo.ts:45`). PBKDF2 output is a uniform
32 bytes; if it lands outside `[1, n-1]` for the P-256 scalar field (~2⁻³²) it
is re-hashed once, deterministically, so the same password always yields the
same key.

### Export

```
browser  re-derive sk; check pub against export_owner_key LOCALLY
         → wrong password fails here, with no request and no 401 to interpret
         ephemeral HPKE keypair (DhkemP256HkdfSha256), export SPKI base64
         payload = {version:1, method:"POST",
                    url:".../v1/wallets/<id>/export",
                    body:{encryption_type:"HPKE", recipient_public_key:<its own key>},
                    headers:{"privy-app-id":<id>}}
         sig = base64(p256.sign(sha256(canonicalize(payload))).toBytes("der"))
  POST   /api/wallet/export { recipientPublicKey, signature }
server   unlock-gated; _export(walletId, {…, "privy-authorization-signature": sig})
         relays { ciphertext, encapsulated_key } verbatim. Never decrypts, never logs.
browser  HPKE open → 64 hex chars
         privateKeyToAddress(key) === wallet address  → ✓ shown to the user
         click-to-reveal, copy, "Done" clears state
```

The browser building its own payload is what makes this real: because
`recipient_public_key` is inside the signed bytes, a server that substitutes its
own recipient key produces a signature Privy rejects. Replay gives us nothing
either — a replayed signature re-encrypts to a key only that tab held.

### Where it lives

- `lib/export-crypto.ts` — isomorphic and pure: derivation, canonical payload,
  DER signature, HPKE decrypt. `setupHPKERecipient` copied from the SDK's
  internal module. Never logs key material.
- Two SDK-calling functions added to `lib/privy-wallet.ts` (they need the cached
  client and the quorum, both module-private there).
- `app/api/wallet/export/route.ts` — GET status, PUT enable, POST export.
- `app/ExportTab.tsx` — client component, dynamically imported so `@hpke/*`
  stays out of the main bundle; wired as a fifth entry in `TABS`
  (`app/XAuthControl.tsx:14-20`) and a branch in the switch at `:317`.

Not through the seam: `WalletBackend` has four methods and a Circle
implementation; a fifth would need a throwing stub there. The route checks
`walletProviderName() === "privy"` and 404s otherwise, importing
`lib/privy-wallet.ts` directly.

Nothing is persisted client-side — no `localStorage`, no `sessionStorage`; the
plaintext lives in component state that the tab switch unmounts.

## §3 — Re-minting the pay wallet, and the wallet-creation rewrite

**Scope: one live wallet.** Preview holds 11 users, of which exactly 1 has a
wallet — `qFloppa`, pay wallet `0xa264A3818F20f878380B5Af9154080605de9a704`
(`jla7zhktvth6r5j6utwx0pet`) holding 18.997073 USDC. The other 5 `privy_wallets`
rows are dead spike probes with no user attached. `pending_wallets` is empty,
`reputation_feedback` is empty, and the 3 `reputation_agents` rows are agent
identities — the deferred wallet — so nothing follows the pay address into
another table.

**Not a migration, a scripted repoint.** `privy_wallets` is our idempotency
table and `getOrCreateWallet` resolves through it, so swapping the row to point at
the new wallet is the whole trigger — no login, no data migration, and nothing in
the app knows the difference.

```
1. mint     scripts/privy-remint.ts — one-off, committed, run once against Preview.
            wallets().create() with owner_id + additional_signers + idempotency key.
2. sweep    transferUsdc(old walletId → new address). Arc charges gas in USDC, so
            the transfer cannot be for the entire balance: leave 0.05, sweep the
            remainder, then verify on chain.
3. swap     UPDATE privy_wallets SET wallet_id, address WHERE namespace='x' AND key='21068173'
            UPDATE users SET wallet_address = lower(new), circle_wallet_id = new_id
            -- On this stack users.circle_wallet_id holds the PRIVY wallet id
            -- (setUserWallet writes wallet.walletId into it); the column name is
            -- legacy from the Circle era and is not renamed here.
4. verify   /api/me reports the new address; balance reads on the new address
```

The old wallet is left in Privy, empty and unreferenced — deleting it buys
nothing, and a failed sweep is recoverable only while it exists. The 5 probe
rows are deleted in the same script: they are unreachable keys that a future
login colliding on `x:round3-…`-shaped keys would otherwise adopt.

**`getOrCreateWallet` gets shorter, not longer.** Today it does a
`users().getByCustomAuthID` lookup, a `users().create()` on `NotFoundError`, a
`pregenerateWallets` fallback for an identity that outlived a failed wallet
creation, and a `serverCanSign` check for the adopted case
(`lib/privy-wallet.ts:625-694`). All four exist because `users().create()` is
not idempotent and the Privy user is the addressable thing. With
`wallets().create()` there is no Privy user:

```ts
const spec = {
  chain_type: "ethereum",
  owner_id: quorumId(),                    // ← the change section 1 rests on
  additional_signers: [{ signer_id: quorumId(), ...policy }],
  "privy-idempotency-key": `splitsy:${namespace}:${key}`,
};
```

`owner_id` **and** `additional_signers`, both ours, both at creation — the
spike's proven shape, which is what keeps spending independent of ownership
across the later transfer. The idempotency key replaces the lookup: Privy dedupes
within 24 hours, and beyond that our own `privy_wallets` row is the guard it
always was. `privy_user_id` becomes vestigial — kept nullable so the migration is
additive, no longer written.

This drops `getByCustomAuthID`, `users().create()`, `pregenerateWallets`,
`ethereumWallet`, `serverCanSign` and the `adopted` bookkeeping: roughly 70
lines out, 15 in. `serverCanSign` going is a real loss of a guard — but it only
guarded a wallet adopted from a prior Privy user, and there are no longer Privy
users to adopt from. Nothing else calls it.

Open question 2 in the wallet-stack design closes here: pregeneration against a
social handle is moot, because pregeneration is gone. The `pending_wallets`
adoption branch survives untouched — it is keyed on our own table, not Privy's.

**Schema — one additive migration:**
`privy_wallets` gains `export_owner_key text` (null = "we still administer this
wallet"; non-null = ownership has transferred and only that key can export), and
`privy_user_id` loses `not null`. The column is what lets the UI name the
wallet's state, and it is the honest answer to the §1 caveat.

**The bug class this belongs to.** `owner_id` is the third property that attaches
only at wallet creation and cannot be backfilled — after `PRIVY_AGENT_POLICY_ID`
(`docs/deployments.md:125-138`) and now export ownership. What catches a fourth
is a startup assertion rather than more documentation: `/api/stack` already
probes reachability, and it gains a check that the newest `privy_wallets` row's
wallet reports `owner_id === PRIVY_KEY_QUORUM_ID` and carries the expected
signer and policy.

## §4 — Failure modes, and what the UI admits

**`export_owner_key` is a cache, never an authority.** Privy decides who may
export; the column only lets the browser reject a wrong password before making a
request, and names the wallet's state. That framing makes every write-ordering
problem cheap:

| Failure | What the user sees | Why it is safe |
|---|---|---|
| Ownership transferred, column write failed | "Export is enabled, but we lost our record — re-enter your password" | Transfer happens **first**, write second. Only possible drift is a false *negative*: we under-claim. A `PUT` writes the key without re-transferring; a wrong key written there just fails the local pre-check until they retry — self-correcting, because Privy is the real gate. |
| Transfer 401s (already transferred) | same as above | We read `wallets().get().owner_id !== quorum` and fall into the restore path instead of a dead end. |
| Wrong password at export | "That password doesn't match this wallet's export credential" — no request sent | Caught locally against the cached key. |
| Privy 401 despite a matching pre-check | "Splitsy could not authorise this export" | Cache is stale; falls into restore. |
| HPKE open fails | "Could not decrypt the exported key" | Distinguished from 401 — a suite or ephemeral-key fault, not a credential fault. |
| Decrypted key does not derive to this address | **hard fail, nothing displayed** | The one check that must never be skipped. A key we cannot prove belongs to this wallet is not shown, copied, or logged. |
| Locked / no PIN | 403 `locked` | Identical to `/api/wallet/send`. |
| `WALLET_PROVIDER=circle` | 404 | Circle keys cannot be exported at all. |
| Network failure mid-export | retry | Export is a read; nothing moved. |

**Enabling ends with a proof, not a key.** After the transfer, the flow
immediately performs a real export and checks the plaintext derives to the wallet
address, then discards it and reports "✓ verified — this password exports this
wallet." Same code path as export, one boolean apart. It closes the worst hole in
a typed credential: a password mistyped identically in both fields transfers
ownership to a key nobody can reproduce, and the wallet is non-exportable forever
with no signal.

**What the copy has to say, because it is true.** Three admissions, in the UI and
not only the spec:

- **Before you enable, Splitsy can export this wallet.** That is the price of
  minting wallets during a server-side OAuth callback where no browser key
  exists. Prompt early, say it plainly.
- **Your pay wallet is exportable. Your agent wallet is not, yet.** A user who
  topped up their agent (0.995553 USDC today) has USDC they cannot walk out with.
- **We serve this page's JavaScript.** A malicious or compromised Splitsy could
  capture the password as you type it. Ownership transfer defends against a
  *later* breach, not against us at the moment you use the feature. No
  browser-based scheme fixes this, passkeys included.

**Never logged, never cached.** The route sets `Cache-Control: no-store`; error
paths log the failure class, never the request body, the ciphertext, or the
plaintext — including in tests.

Skipped: `privy-request-expiry` (the SDK only signs it when present, and the
recipient key already binds the signature to one tab). Add it if Privy ever makes
expiry mandatory.

## §5 — Custody disclosure: the user sees who holds their assets

Trust is not a sidebar to this feature; it is why the feature exists. Moving from Circle DCW to Privy is a move *to a known, audited custodian*, and the
UI has to say so the way a professional finance site would — prominently, in plain
language, and at every point where custody is in question. The honest version:

> **"Your assets are held by Privy, the custodian. Splitsy is the app that
> operates this wallet on your behalf. Privy is a SOC 2–audited custody
> provider: independent security reviews (Cure53, Zellic, Doyensec), a public
> bounty program, and keys that are encrypted and segmented so no single party
> holds a whole key."**

That is truthful and it is the framing the rest of the copy hangs off. It must
not overclaim: until the user sets an export password, Splitsy also holds an
authorization key and can export the wallet. The disclosure states that plainly
next to the custody line, not instead of it.

### Where the disclosure appears

1. **The wallet panel**, under the address (first thing a user sees about their
   wallet). Two short lines: "**Held by Privy** (custody provider)" with a link to
   Privy's security page, and the custody sentence above. This is a standing
   element, visible whether or not export is set up — the first sight of the
   wallet is where trust is made.
2. **The "Enable export" modal**, leading with the custody statement, then the
   honest sequence: *until you set an export password, Splitsy also has access;
   after you set it, only your password can, and there is no reset.*
3. **The post-transfer verify screen**, confirming the private key now belongs
   solely to the user ("Privy will only ever release it to this key").
4. **The export reveal screen**, wording it as *this is the key Privy has been
   holding for you; Splitsy never sees it* — not "here is your key" alone.
5. **Rewording the §1 sentence.** Instead of "until you set an export credential,
   Splitsy administers this wallet," the panel copy becomes: *"Your assets are
   held by Privy. Until you set an export password, Splitsy is also authorised to
   move them on your behalf. After you set an export password, only your password
   can move them — and there is no recovery.*"

### What this does not change

The architecture is untouched — the disclosure is copy and placement, not
structure. `@privy-io/server-auth` is not used, and the app still owns the four
OAuth flows and the session cookie (the stack design's "Privy owns custody, not
login" line holds). The agent-wallet exception is stated where the agent wallet
is shown too: *your agent wallet is administered by Splitsy; export for it is
coming.* The claim "your assets are held by Privy" refers to the pay wallet; the
agent wallet is a separate matter and the UI must not let the custody line
smooth over that.

## §6 — Testing

One new test file, `lib/export-crypto.test.ts`, added to the `test:wallet-provider`
script line. `node:test`, `assert/strict`, no framework. Everything below runs
offline, with no secrets and no network, because `lib/export-crypto.ts` is pure
and isomorphic and Node has `crypto.subtle` as a global.

1. **Canonical payload is byte-identical to the SDK's.**
   `canonicalPayload(...)` vs `formatRequestForAuthorizationSignature` imported
   from `@privy-io/node`. The load-bearing test — it is the only thing we
   reimplement, and one byte of drift is a 401 with no diagnostic. A deliberate
   exception to `lib/privy-wallet.test.ts`'s no-SDK rule: SDK agreement *is* the
   property.
2. **Signatures verify, both directions.** Ours verifies under `p256.verify`
   against the derived public key; a signature produced by the SDK's
   `generateAuthorizationSignature` over a `generateP256KeyPair()` key verifies
   under our verifier. Catches DER-vs-raw (WebCrypto's `sign` returns raw `r‖s`,
   Privy wants DER — the trap worth a test).
3. **Derivation is deterministic and total.** Same password + salt → identical
   key twice; a different salt → a different key; the scalar-validity branch
   driven directly with `0` and `n`, which PBKDF2 will not produce on demand.
4. **SPKI round-trips.** Our base64 SPKI imports via
   `crypto.subtle.importKey("spki", …)` as an ECDSA P-256 public key. The
   handoff records that the SDK's documented example `recipient_public_key` is a
   raw point and is rejected — this test stops us shipping that mistake twice.
5. **HPKE round-trip.** An eight-line sender built on `@hpke/core` encrypts a
   fixed non-secret string to our recipient key; `decryptExport` returns it.
   Proves our copied suite matches the SDK's
   `DhkemP256HkdfSha256 / HkdfSha256 / Chacha20Poly1305`.
6. **The address check rejects.** A plaintext that derives to a different address
   makes the verifier return false — the guard that keeps an unprovable key off
   the screen.

**What no unit test can reach: the live Privy round-trip.**
`scripts/privy-export-probe.ts`, run once against a throwaway wallet — mint with
`owner_id` + `additional_signers`, transfer ownership to a derived key, export
with a browser-shaped signature, decrypt, assert the derived address equals the
wallet address, spend once after the transfer to confirm signing survived. It
prints verdicts and byte lengths only. The spike proved every step except
decryption; this closes the last one, and it is the plan's first task — before
any route or component exists, because a suite mismatch there invalidates §2.

**Manual, on Preview, after re-minting:** enable → verify → reveal → import the
key into a fresh wallet and confirm the address and balance; then confirm
autopay, `/api/recurring/settle` and a pay-link claim still sign from the same
wallet post-transfer.

**Standing blocker to clear first:** `npm run build` has never completed on this
branch (two attempts died at load average 47). `npx tsc --noEmit` was clean,
which is not the same thing — and this change adds `@hpke/*` and `@noble/*` to a
**client** bundle for the first time, exactly what a type check cannot vet.

## Remaining work

1. Approve sections 2–6 (this file is the record of them).2. Self-review the spec for placeholders / contradictions / ambiguity / scope.
3. User reviews the spec.
4. Invoke `writing-plans`. Do not invoke any other implementation skill.

## Open questions

1. `wallets().create()` supports a write-once `external_id` and a
   get-wallet-by-external-id endpoint, which might let the stack drop the
   Privy-user indirection entirely and key wallets directly on
   `<provider>:<providerUserId>`. Worth evaluating (see §3 — this is the
   direction §3 takes), but it changes the adoption path in `getOrCreateWallet`,
   so it is a decision, not a cleanup. `privy_wallets` is already our own
   idempotency table.

## Repo state and loose ends

- Branch `privy-wallet-stack` @ `b0da464`. `docs/deployments.md` carries an
  **uncommitted** 19-line addition documenting the Preview Supabase scoping
  precondition — the cause of an earlier bug where Preview read the **live**
  database because the three Supabase vars were inherited from All Environments.
  Commit or discard as preferred.
- **`scripts/privy-setup.ts` and `scripts/privy-policy.ts` are absent from HEAD** but
  referenced by `package.json` and `docs/deployments.md:131`. Recover with
  `git show a269e5b:scripts/privy-setup.ts` and
  `git show 85d24a5:scripts/privy-policy.ts`. `npm run privy:policy` is broken today,
  and re-minting needs it. (This does not block export: §3 re-mints only the pay
  wallet, which carries no agent policy.)
- **`@privy-io/node` is not declared in `package.json`**, only installed. Verify
  before any dependency work. `@hpke/core` and `@hpke/chacha20poly1305` are
  present as transitive deps and must be declared, plus `@noble/curves`,
  `@noble/hashes` and `canonicalize` for the browser-side signature.
- **Casing bug, live in the database.** `setUserWallet` (`lib/users-repo.ts:45`)
  stores Privy's checksummed address verbatim while `setUserAgentWallet` (`:72`)
  lowercases, and `getUsersByWallets` (`:133`) matches lowercase — so Privy pay
  wallets never resolve to a handle, and the comment at `:127` claiming every
  `wallet_address` is lowercase is now false. Fix is `.toLowerCase()` plus an UPDATE
  for existing rows. Offered, not yet approved.
- Preview database is `splitsy-test` (`hdyioojrozodmutpldsu`). Current wallets
  for user `qFloppa` (X id `21068173`): pay
  `0xa264A3818F20f878380B5Af9154080605de9a704` (`jla7zhktvth6r5j6utwx0pet`),
  agent `0x16a62bd12077224653f4a9b4ee72bec86aac6b09` (`k7bgxwx7inqz6visjvbv9hkm`).
  Only the pay wallet needs re-minting for export.
- Two **orphan test wallets** were left in Privy by the spike, unattached to any
  user and empty. Harmless; delete if tidiness matters.
- `npm run build` has **not** been verified on this branch. `npx tsc --noEmit` was
  clean.
- Production project `hvckneltkugnvtwfrzlb` has RLS **disabled** on `x402_payments`
  (596 rows), so the anon key can read or modify every row. Flagged, not acted on.

## Constraints

- `AGENTS.md`: this is not the Next.js you know. Read the relevant guide in
  `node_modules/next/dist/docs/` before writing code.
- Ponytail mode: laziest solution that actually works, root cause over symptom,
  shortest diff — but never simplify away validation at trust boundaries, error
  handling that prevents data loss, or security measures. This feature is all
  three.
- Never print or log plaintext key material, including in tests. The spikes
  reported byte lengths only.
