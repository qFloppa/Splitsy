# Splitsy — Sign in with X identity + auto-provisioned wallets

**Status:** Draft for review · **Date:** 2026-07-04 · **Owner:** @mhm233

## 1. Problem

Today Splitsy identifies debtors by raw EVM wallet address. A bill is written on-chain
via `BillSplitRegistry.createBill(metadataHash, participantAddresses[], owedAmounts[])`,
and a debtor discovers what they owe by connecting the matching wallet
(`billIdsForParticipant(address)`). This means **you can only split a bill with someone
whose `0x…` address you already know** — useless for casual "you owe me for dinner"
splitting, and impossible for anyone who isn't already a crypto user.

We want: **split a bill with any X (Twitter) user by @handle.** The tagged person logs
in with X, and — even if they've never touched crypto — can see and settle what they owe.

## 2. Goals / Non-goals

**Goals**
- Sign in with X as the primary identity (friendly `@handle`, not `0x…`).
- Tag debtors by `@handle` before they've ever used the app ("pending" debts).
- Auto-provision a wallet on login so newcomers need no MetaMask and no crypto steps.
- Let a debtor settle on Arc in USDC, gaslessly.
- Keep the existing wallet-address flow working for users who already have wallets.

**Non-goals (this spec)**
- Mainnet / real funds (Arc Testnet only, consistent with the rest of the app).
- Posting to X, reading timelines, or any X data beyond identity (handle, optionally email).
- On-chain escrow for pending debts (settlement is direct transfer — §6).
- Replacing the browser-wallet (RainbowKit/wagmi) path; X identity is additive.

## 3. Key decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | **X = identity layer; Circle = wallet layer.** | Circle social-login supports Google/Apple/Facebook, **not** X. So X handles identity via our own OAuth; Circle provisions the wallet separately. |
| D2 | Wallet = **Circle developer-controlled wallet (DCW), created server-side and keyed to the X `user_id`**. **Custodial.** | Gives a unique wallet from the Twitter id alone — **no email, OTP, or PIN**, zero onboarding friction. Splitsy is a testnet demo with valueless USDC, so custody risk is moot. Mainnet would switch to non-custodial (future work). |
| D3 | Wallets are **SCA (smart-contract accounts)** + **Circle Gas Station** for gasless payments. | Debtor pays their debt without needing USDC for gas — only the debt amount. Verified: Arc Testnet supports SCA + Gas Station. |
| D4 | Debts are **off-chain-pending, resolved on login**; settlement is **direct USDC transfer** (§6). | The registry needs addresses upfront; a tagged `@handle` has none until login. Debts live in Supabase keyed by X identity; settlement moves money debtor→creditor directly. |
| D5 | OAuth is **confidential-client OAuth 2.0 + PKCE**, scopes `tweet.read users.read` (+ `offline.access`); `users.email` now **optional** (notifications/receipts only). | Built and verified (stages 1–2). Email no longer needed for the wallet. |

## 4. Verified facts (de-risking done)

- ✅ **X OAuth login works** end-to-end (stage 1) and `GET /2/users/me` returns handle
  (+ email) — currently **free** (self-read is unmetered; usage stayed at 0 across two
  accounts with no credit loaded).
- ✅ **Circle Wallets support Arc Testnet** (`ARC-TESTNET`, EOA + SCA) including
  `POST /transactions/contractExecution`, `transfer`, and **Gas Station (gasless)**.
  A DCW is a normal EVM address, so it interoperates with existing Arc contracts unchanged.
- ✅ Existing `BillSplitRegistry` + memo contract (`ARC_MEMO_ADDRESS`) remain available for
  the classic browser-wallet flow.

## 5. Architecture overview

```
Browser                         Next.js (server)                    External
───────                         ────────────────                    ────────
[Sign in with X] ─GET /api/auth/twitter──► build PKCE+state ─redirect─► X authorize
X consent ─────► /api/auth/twitter/callback
                                 ├─ exchange code → token            (X token endpoint)
                                 ├─ GET /2/users/me → handle          (X users/me)
                                 ├─ upsert users row                  (Supabase)
                                 ├─ create DCW (refId = x_user_id)    (Circle DCW API)
                                 └─ set signed session cookie
[app] ─────────► /api/me ──────► read session → user + wallet
[create bill] ─► POST /api/bills ► store bill + debts (by @handle)    (Supabase)
[debtor login] ─────────────────► match @handle → surface debts       (Supabase)
[pay] ─► POST /api/debts/:id/pay ► server: Circle DCW USDC transfer   (Circle → Arc)
                                 │   to creditor (+ optional memo), gasless via Gas Station
                                 └─ verify tx on Arc → mark debt paid  (Arc + Supabase)
```

Identity and money stay in separate, well-bounded layers: **X** answers "who is this
person," **Supabase** holds the off-chain ledger and the `@handle → wallet` mapping,
**Circle** owns the DCWs and signs transactions server-side, **Arc** is the settlement rail.

## 6. Settlement modes — routed by how the bill was created

Settlement is chosen by **creation mode**, not by wallet type, because the registry has one
hard constraint: `createBill` needs every participant's **address at creation time** and
cannot add participants later. So the registry can only serve bills where addresses are
known upfront; tagging by `@handle` makes that impossible regardless of what wallets people
later use. This gives a clean seam — one settlement engine per bill, decided at creation:

**Mode A — tag-by-@handle bill → off-chain ledger + direct transfer (the new Twitter flow).**
- Pending debts live in Supabase keyed by X identity (addresses unknown at creation).
- To settle, the debtor's wallet transfers USDC **directly to the creditor's wallet** on
  Arc. For a DCW this is a server-triggered Circle `transfer` (gasless via Gas Station);
  a self-custodial payer (Rabby/MetaMask) can settle the same debt by signing the transfer
  themselves — **direct transfer is not tied to DCWs**, it works for either payer.
- The transfer optionally carries a Splitsy **memo** (existing pattern) encoding the debt
  id for on-chain auditability; reconciliation does not depend on it, since the app knows
  which debt is being paid.
- The server verifies the tx on Arc, then marks the debt `paid`. No escrow, no `claim`.

**Mode B — address-known bill → registry escrow (the existing on-chain flow, unchanged).**
- For users who know each other's addresses and want the **blockchain as the source of
  truth**: on-chain escrow, `billIdsForParticipant` discovery with no dependency on
  Splitsy's database, auditable `payDebt`/`claim`. This is `lib/bill-split-contracts.ts`
  exactly as it is today — untouched by this work.

**Why the registry is not made redundant:** Mode B remains Splitsy's *on-chain / trustless
mode*, a distinct product mode from the *tag-anyone convenience mode* (A). They are
complementary. If the convenience flow later dominates, Mode B can become a maintained
power-user mode or be retired — a product call deferred; keeping it now costs nothing since
Mode A never touches it. *(A future option: because the server holds all DCW keys, it could
also materialize registry bills on a creator's behalf without them being online — i.e. give
Mode A on-chain escrow too — but that is out of scope here.)*

**MVP scope:** build Mode A (Twitter flow). Mode B ships as-is. This spec covers Mode A.

## 7. Data model (Supabase additions)

New tables (additive; existing `tabs/members/charges/settlements` untouched):

```sql
create table users (
  id            uuid primary key default gen_random_uuid(),
  x_user_id     text unique not null,        -- stable X id (also DCW refId)
  x_handle      text not null,               -- current @handle (may change on X)
  x_name        text,
  x_avatar_url  text,
  email         text,                        -- optional; from X if scope granted
  wallet_address text,                       -- DCW address on Arc
  circle_wallet_id text,                     -- Circle DCW id
  created_at    timestamptz not null default now()
);
create index on users (lower(x_handle));

create table bills (
  id            uuid primary key default gen_random_uuid(),
  creator_user_id uuid not null references users(id) on delete cascade,
  merchant      text,
  currency      text not null default 'USD',
  total_usdc    numeric(20,6) not null,
  metadata      jsonb not null default '{}'::jsonb,  -- line items, receipt ref
  created_at    timestamptz not null default now()
);

create table bill_debts (
  id            uuid primary key default gen_random_uuid(),
  bill_id       uuid not null references bills(id) on delete cascade,
  debtor_handle text not null,               -- lowercased @handle as tagged
  debtor_user_id uuid references users(id),  -- filled in when they log in
  amount_usdc   numeric(20,6) not null,
  status        text not null default 'pending'
                  check (status in ('pending','paid')),
  paid_tx_hash  text,
  paid_at       timestamptz,
  created_at    timestamptz not null default now()
);
create index on bill_debts (lower(debtor_handle));
create index on bill_debts (debtor_user_id);
```

**Handle-rename edge case:** X handles can change; the `x_user_id` is stable but a debt is
tagged by handle before the user is known. On login we match `bill_debts.debtor_handle`
against the user's *current* handle. If they renamed between being tagged and logging in,
the match misses. MVP accepts this as a **documented limitation** (surfaced in UI, not
silently dropped); a later refinement can resolve `@handle → x_user_id` at tag time.

## 8. Components & interfaces

| Module | Responsibility | Depends on |
|--------|----------------|-----------|
| `lib/twitter-oauth.ts` *(built)* | PKCE, authorize URL, token exchange, `fetchTwitterUser` | X API |
| `lib/session.ts` *(new)* | Issue/verify HMAC-signed session cookie; `getSessionUser()` | Node crypto |
| `lib/users-repo.ts` *(new)* | Upsert user by `x_user_id`; resolve by handle; set wallet fields | Supabase |
| `lib/bills-repo.ts` *(new)* | Create bill + debts; list debts owed / owed-to-me; mark paid | Supabase |
| `lib/circle-dcw.ts` *(new)* | Create DCW (refId=x_user_id), read address, USDC transfer(+memo) on Arc, verify tx — all server-side via entity secret | Circle DCW SDK, Arc |
| `app/api/auth/twitter/*` *(built, extend callback)* | Login + upsert user + create DCW + set session | above |
| `app/api/auth/logout` *(new)* | Clear session | session |
| `app/api/me` *(new)* | Current user + wallet + owed/owing summary | session, repos |
| `app/api/bills` *(new)* | Create bill (creator); list my bills | session, repos |
| `app/api/debts/[id]/pay` *(new)* | Trigger debtor DCW transfer → verify → mark paid | session, circle-dcw |
| UI: header login, "I owe / owed to me", pay button | Surface identity + debts | `/api/*` |

Repos hide Supabase, `circle-dcw` hides Circle, so the UI and routes never touch a vendor
SDK directly. The existing client-side `lib/bill-split-contracts.ts` (browser-wallet path)
is untouched.

## 9. End-to-end flow (MVP)

1. **Login + wallet.** X OAuth → profile → upsert `users` → **create a Circle DCW server-side
   with `refId = x_user_id`** (idempotent: reuse if it exists) → store `wallet_address` +
   `circle_wallet_id` → signed session cookie. No email/OTP/PIN step. *(extend the callback,
   which today renders a debug page)*.
2. **Create a bill.** Creator scans a receipt (existing OCR), splits equally/manually, tags
   debtors by `@handle`. `POST /api/bills` stores the bill + one `bill_debts` row per debtor
   (status `pending`). No on-chain action.
3. **Discover.** A tagged user logs in → `bill_debts` matched by handle → `debtor_user_id`
   filled → "You owe $X to @creator for [merchant]" appears.
4. **Fund (if needed).** Debtor tops up USDC via the app's existing CCTP bridge / on-ramp.
   Gas Station covers gas, so they only need the debt amount.
5. **Pay.** `POST /api/debts/:id/pay` → server tells the debtor's DCW to transfer USDC to the
   creator's `wallet_address` on Arc (gasless), optionally with a memo → verifies the tx on
   Arc → flips the debt to `paid`.
6. **Creator view** reflects paid/pending per debtor.

## 10. Security & privacy

- Session cookie: `HttpOnly`, `Secure` (prod), `SameSite=Lax`, HMAC-signed with a server
  secret; stores only the Splitsy `users.id`. Short TTL + refresh via X `offline.access`.
- OAuth `state` + PKCE already protect the login handshake (built).
- **Custody:** DCWs are controlled by the server via the **Circle entity secret** — Splitsy
  is the signer for every user's wallet. This is the accepted testnet trade-off (valueless
  test USDC). The entity secret lives only in server env, never shipped to the client.
- Supabase access is server-side only via the service-role key (existing pattern).
- Privacy Policy (`/privacy`) already discloses the X data we store; update it to note the
  auto-created custodial wallet (and drop the email mention if we drop the scope).

## 11. Known trade-offs / open questions

1. **Custodial.** The server holds keys for all DCWs (entity secret). Fine for a testnet
   demo; a mainnet version would move to non-custodial (UCW with PIN/email, or user-brought
   wallets). Explicitly deferred.
2. **Handle renames** (§7) — accepted as a documented MVP limitation.
3. **Profile-read cost at scale.** Free today; if X starts metering, it's one self-read per
   user (cached after), ~\$0.01 — negligible.
4. **`offline.access`** must be added to scopes for durable sessions (access token = 2h).
5. **Circle entity-secret setup** is a one-time prerequisite (register secret + create a
   wallet set) before DCW creation works.

## 12. Already built (stages 1–2, verified)

- `lib/twitter-oauth.ts`, `app/api/auth/twitter/route.ts`,
  `app/api/auth/twitter/callback/route.ts`, `app/auth-test/page.tsx`.
- Legal pages `app/privacy`, `app/terms` (+ footer/sitemap wiring) for the X app review.
- Env: `X_CLIENT_ID`, `X_CLIENT_SECRET`, optional `X_OAUTH_REDIRECT_ORIGIN`.
  (Circle: `CIRCLE_API_KEY` already present; add `CIRCLE_ENTITY_SECRET` + wallet-set id.)

## 13. Suggested build phases (for the implementation plan)

- **P1 — Identity spine:** `lib/session.ts`, `lib/users-repo.ts`, extend callback to upsert
  + session, `/api/me`, `/api/auth/logout`, header login UI. Add `offline.access`.
- **P2 — Wallet provisioning:** `lib/circle-dcw.ts` — register entity secret + wallet set,
  create an SCA DCW on Arc keyed to `x_user_id` at login, store address/id.
- **P3 — Off-chain bills:** `lib/bills-repo.ts`, `POST /api/bills`, tag-by-@handle UI on the
  existing split flow, "I owe / owed to me" views, debt discovery on login.
- **P4 — Settlement:** DCW USDC transfer (+ optional memo) to the creditor, gasless via Gas
  Station, `POST /api/debts/:id/pay`, verify on Arc, mark paid, creator status view.
- **P5 — Polish:** funding hand-off (reuse bridge), handle-rename messaging, privacy-page
  update, tests.

Each phase is independently shippable and testable on Arc Testnet.
