# Mainnet launch checklist

The gate between `NEXT_PUBLIC_ARC_NETWORK=mainnet` and real money. It does not
replace `docs/superpowers/specs/2026-09-16-arc-mainnet-migration-design.md` — that
spec owns the *order of work* (stand up testnet, land the chain module, deploy
contracts, flip the apex). This owns what must be **true** before step 4, and it
exists because most of the items below fail silently: nothing errors, the app
looks fine, and the cost shows up later as money.

Each item says how to check it, not just what it is. An unverifiable item on a
launch checklist is a wish.

---

## 0. Migrations that must run before the flip

The mainnet database is created from **`schema-mainnet.sql`** and nothing else —
run it once, in the SQL editor of the new project. It is the whole schema in one
idempotent file.

It is not the same thing as replaying the other `schema-*.sql` files in filename
order, and the difference is not cosmetic. That chain is a migration *history*:
`schema.sql` creates legacy tables no code reads, `schema-generic-identity.sql`
renames `users.x_user_id` to `provider_user_id` **and drops `users.email`**, and
`schema-agent-economy.sql` and `schema-privy-wallets.sql` are largely `alter table`
against tables created elsewhere. Replaying it against a fresh project is how a
real-money deployment ends up one dropped column different from the one that was
tested. `schema-mainnet.sql` was generated from the live testnet schema
(`hvckneltkugnvtwfrzlb`) after the security work landed, and describes the end
state directly.

If you are instead applying the two new security migrations to an **existing**
database, they are additive and both are **required** — the code that reads them
ships in the same commit:

| File | What breaks without it |
|---|---|
| `schema-rate-limits.sql` | Every gate fails closed. The PIN unlock, the receipt scan and the email OTP all refuse, because `bump_rate_limit` does not exist and the limiter denies on error by design. Loud, not silent. |
| `schema-session-revocation.sql` | `users.sessions_valid_from` is missing, so `getSessionUser` reads `undefined`, skips the revocation check and logout cannot retire tokens. **Silent** — sign-in still works. |

```sql
-- verify the schema landed, in the mainnet project
select (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind = 'r')                    as tables,      -- 16
       (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity) as rls_on,    -- 16
       (select count(*) from pg_policy p join pg_class pc on pc.oid = p.polrelid
          join pg_namespace pn on pn.oid = pc.relnamespace
         where pn.nspname = 'public')                                       as policies,    -- 0
       to_regproc('public.bump_rate_limit(text,int)') is not null           as bump_fn,     -- true
       exists (select 1 from information_schema.columns
               where table_name = 'users' and column_name = 'sessions_valid_from') as revocation_col;
```

Expected: `16, 16, 0, true, true`.

**`rls_on` = `tables` and `policies` = `0` are not decoration.** Every table is
RLS-enabled with no policies, which denies `anon` and `authenticated` outright;
Splitsy only ever connects with the service role key, which bypasses RLS. So this
is the assertion that the published anon key can read **nothing** — and since every
authorization decision in this app is application code, it is the only thing
standing between that key and the whole database.

**And take the rate-limit functions off the public API.** Supabase runs `alter
default privileges in schema public grant execute on functions to anon,
authenticated, service_role`, so every new function in `public` is callable over
`/rest/v1/rpc/<name>` with the anon key. `schema-rate-limits.sql` revokes those
grants by name; confirm it stuck, because `revoke … from public` does **not** do
this (the grants are explicit) and the mistake is invisible:

```sql
select p.proname,
       has_function_privilege('anon', p.oid, 'execute') as anon_can,   -- must be false
       has_function_privilege('service_role', p.oid, 'execute') as service_can  -- must be true
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public';
```

Left open, `clear_rate_limit` is a public endpoint for erasing a wallet's PIN
lockout — one `POST /rest/v1/rpc/clear_rate_limit` with
`{"p_key":"pin:<userId>"}` — and `bump_rate_limit` is a way to push someone else's
key to its cap.

---

## 1. Secrets, and the one that is not rotated

- [ ] The Supabase variables are scoped to **Production** and point at the new
      project, not at `hvckneltkugnvtwfrzlb`. A variable set for All Environments
      is inherited by Preview *and* Production, so an unscoped one puts both hosts
      on one database — which `users.circle_wallet_id` cannot survive, since one
      row cannot name a wallet in both systems, and which puts a live user's writes
      in front of the testnet stack. Nothing in the code detects it: the failure
      reads as a returning user being shown a wallet they cannot sign for.
      `NEXT_PUBLIC_SUPABASE_URL` is inlined at build time, so correcting it needs a
      **redeploy**, not just a saved variable.
- [ ] `SESSION_SECRET` is **new** for mainnet, ≥32 chars, and not the testnet
      value. It signs the cookie that gates every money route; sharing it across
      networks means a testnet cookie is a mainnet session.
- [ ] `SUPABASE_SERVICE_ROLE_KEY` is the mainnet project's. It bypasses RLS
      entirely — every authorization in this app is application code, so this key
      is equivalent to the whole database.
- [ ] `ESCROW_ATTESTER_PRIVATE_KEY` and `REFUND_SLOT_ATTESTER_PRIVATE_KEY` hold
      the **same** new mainnet key, and its address is `ESCROW_ATTESTER_ADDRESS`.
      `scripts/deploy-bill-split-registry.ts` now refuses to deploy when the
      private key does not derive the attester address — but that only guards the
      deploy. Re-check after any later env edit:

      ```bash
      node -e "import('viem/accounts').then(({privateKeyToAccount})=>\
        console.log(privateKeyToAccount(process.env.REFUND_SLOT_ATTESTER_PRIVATE_KEY).address))"
      # must equal ESCROW_ATTESTER_ADDRESS, and the attester of the deployed registry
      ```

- [ ] The attester key is **treated as money**. A stolen one misdirects every
      release the escrow currently holds and every slot refund, one signature at
      a time (`contracts/HandleEscrow.sol` header states the concession). It
      cannot be rotated — both contracts take it as `immutable`. Recovery is
      depositor `reclaim()` plus a redeploy.
- [ ] `.env.local` is not committed (`git ls-files | grep -c '^\.env\.local$'`
      returns `0`) and `.env*` remains in `.gitignore`.

---

## 2. The gates that must be configured, not merely present

- [ ] `TURNSTILE_SECRET_KEY` is set. It now **fails closed**: unset means email
      sign-in and anonymous receipt scans are refused outright. Verify by posting
      a scan with no token and expecting `400`, not `200`.
- [ ] `TURNSTILE_DISABLED` is **absent** in Production. It is ignored when
      `NODE_ENV=production` regardless, but an absent variable needs no argument.
- [ ] `NEXT_PUBLIC_TURNSTILE_SITE_KEY` is set and is the mainnet host's key —
      it is inlined at build time, so changing it needs a **redeploy**, not a
      saved variable.
- [ ] `SCAN_MAX_PER_IP` is deliberate (default 20). This is a per-address daily
      ceiling on model spend, and on mainnet it matters more than on testnet:
      x402 batching is unavailable on Arc mainnet, so `buildScoutDeps` throws and
      **every** scan takes the unpaid direct-to-Gemini path.
- [ ] `RECEIPT_SCANNER_API_KEY` has a **hard spend cap set at the Google
      console**, not only in this app. The in-app caps bound what Splitsy asks
      for; only the provider bounds what a bug can spend.
- [ ] `CRON_SECRET` / `AGENT_SECRET` / `RECURRING_SETTLER_SECRET` are set. Both
      cron routes refuse with `500` when their secret is missing and `401` when
      it does not match — they do not run open.

---

## 3. Chain configuration

- [ ] `NEXT_PUBLIC_ARC_NETWORK=mainnet` — the exact string. Anything else lands
      on testnet, which is the safe direction and is why it is not asserted.
- [ ] Every `_MAINNET` address slot is populated. Mainnet **never** falls back to
      the testnet slot; a missing one resolves to the zero address and its
      consumer refuses. Check all four:
      `NEXT_PUBLIC_BILL_SPLIT_REGISTRY_ADDRESS_MAINNET`,
      `NEXT_PUBLIC_RECURRING_TAB_FACTORY_ADDRESS_MAINNET`,
      `NEXT_PUBLIC_HANDLE_ESCROW_ADDRESS_MAINNET`,
      `NEXT_PUBLIC_AUTOPAY_MANDATE_ADDRESS_MAINNET`.
- [ ] Each of those addresses has **code on chain 5042**, not just a plausible
      shape:

      ```bash
      cast code <address> --rpc-url https://rpc.mainnet.arc.io   # must not be 0x
      ```

- [ ] The deployed registry's `attester()` and `usdc()` read back as expected,
      and `HandleEscrow.attester()` matches. All three are immutable.
- [ ] The **running build** resolved chain 5042, not just the dashboard variable.
      `/api/stack` now reports `arc.network`, `arc.chainId` and `arc.rpcHost` —
      but it is gated on `NEXT_PUBLIC_STACK_LABEL`, which **Production leaves
      unset**, so it answers `404` on the apex by design. Two ways round that, and
      the second is the one that proves the live site:

      - Set the label on a Preview deployment built from the **same commit and the
        same mainnet variables**, read `/api/stack`, then unset it. Proves the
        build, not the host.
      - On the apex itself, read the registry address out of the served bundle and
        compare it to the mainnet deployment — `NEXT_PUBLIC_*` is inlined at build
        time, so this is what the browser will actually transact against:

        ```bash
        curl -s https://splitsy.xyz/app | grep -o '0x[0-9a-fA-F]\{40\}' | sort -u
        # the registry, factory, escrow and mandate addresses must be the _MAINNET set
        ```

- [ ] The footer's explorer links point at `explorer.arc.io`, not
      `testnet.arcscan.app`. Cheapest visual confirmation that the profile the UI
      resolved is the mainnet one.

---

## 4. Money-path smoke test, on mainnet, with small amounts

Do these in order against the real deployment before announcing. Each one
exercises a different signer.

- [ ] Provision a wallet, set a PIN, unlock, send **0.01 USDC** to a second
      address. Confirms the custody stack and the unlock cookie.
- [ ] Enter a wrong PIN five times. The fifth must return `429` with a
      `Retry-After`, and a correct PIN afterwards must still be refused until the
      wait elapses. This is the wallet-drain gate; it is worth proving once for
      real rather than trusting the unit test.
- [ ] Create a bill, pay a share from a second account, claim it.
- [ ] Create an **escrowed** bill, let it fail past its due date, refund. Then do
      the same for a handle **slot** — that path signs with the attester key and
      is the one that silently reverts if the key and the contract disagree.
- [ ] Deposit to `HandleEscrow` against a handle, sign that handle in, confirm
      the release lands. Confirms the attester key and a funded
      `splitsy`/`escrow-releaser` wallet.
- [ ] Confirm the `escrow-releaser` wallet **holds USDC**. Arc charges gas in
      USDC, so an unfunded releaser fails every release silently, on every
      sign-in.

---

## 5. Sessions and revocation

- [ ] Sign in, then sign out, then replay the old cookie. It must be rejected —
      that is `sessions_valid_from` working. If it still authenticates, the
      migration in §0 did not run.
- [ ] Confirm the operator kill switch works on one account:

      ```sql
      update users set sessions_valid_from = now() where id = '<user-id>';
      ```

- [ ] Know the whole-fleet stop: rotating `SESSION_SECRET` invalidates every
      cookie at once. Write it in the runbook before you need it at 3am.

---

## 6. Agent NFTs

- [ ] Mint one agent on mainnet and **look at the image**. The network stamp now
      reads from `ARC.network`, but NFT images are immutable once minted — a
      wrong stamp is permanent for every agent minted before anyone notices.
- [ ] ERC-8004 registries stay **off** unless `ERC8004_*_MAINNET` are set
      deliberately. Off is the default and the safe state.

---

## 7. Known and accepted, going in

State these now so they are decisions rather than discoveries.

- **Existing users get a new wallet at a new address.** Unavoidable — Circle has
  no Arc mainnet. The old Supabase project stays as a record. **Announce before
  the flip**, not after.
- **A compromised attester key can misdirect held escrow and slot refunds.** No
  pause, no rotation, no key revocation. Mitigation is depositor `reclaim()` plus
  redeploy. The documented upgrade is moving the key into a TEE, worth doing once
  the typical held balance exceeds roughly a year of enclave cost.
- **A buyer who sends a malformed `/api/ocr` request is still charged.**
  `withGateway` settles the x402 payment *before* the handler runs, so a `400`
  keeps the $0.005 and does not ledger it. Pre-existing for every `400` on that
  route; the amount is small and the fix is a paywall restructure.
- **12 high-severity advisories remain**, all inside `@circle-fin/*`'s Solana
  sub-tree (`axios`, `toml`, `socket.io-parser`) and a `viem@2.23.2` pinned by
  `@walletconnect/utils`. Not fixable without upstream releases; forcing an
  override on the walletconnect viem risks breaking wallet connection, which is a
  money path. Re-check at each Circle SDK release.
- **`NEXT_PUBLIC_PIMLICO_API_KEY` ships to the browser.** Paymaster keys are
  billable — set a spend limit on it in the Pimlico dashboard, and treat it as
  public.
- **Rate-limit rows grow one per IP.** `rate_limits` has no sweeper. Harmless for
  a long time; add a `pg_cron` delete on `last_at < now() - interval '7 days'`
  when it matters.

---

## 8. After the flip

- [ ] `X-Robots-Tag: noindex` on `testnet.splitsy.xyz` — an indexed testnet host
      beside a real-money apex is a page someone pays into by mistake. Four lines
      in `proxy.ts`, which already sets per-request headers.
- [ ] Verify the x402 Gateway receipt URL on the mainnet host against a real
      transfer id (open question 1 of the migration spec). The neighbouring
      namespace 404s, which reads as "this payment never happened".
- [ ] Watch the first day's `rate_limits` table for `scan-ip:` keys hitting the
      cap. That is either abuse or a cap set too low, and the row tells you which.
