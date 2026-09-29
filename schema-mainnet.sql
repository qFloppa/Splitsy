-- schema-mainnet.sql — THE WHOLE DATABASE, in one file, for a NEW project.
--
-- Run this once in the SQL editor of a fresh Supabase project to stand up the
-- mainnet database. Nothing else needs running: this file supersedes every other
-- schema-*.sql here for a clean install.
--
-- WHY THIS FILE EXISTS. The other schema-*.sql files are a migration HISTORY, not
-- a bootstrap, and running them in filename order does not produce this schema:
--   * schema.sql creates legacy tables no code reads any more.
--   * schema-generic-identity.sql RENAMES users.x_user_id to provider_user_id and
--     DROPS users.email — so the column list depends on running order.
--   * schema-agent-economy.sql and schema-privy-wallets.sql are largely ALTER TABLE
--     on tables created elsewhere.
-- Replaying that chain against a mainnet project is how a real-money deployment
-- ends up one dropped column different from the one that was tested. So this file
-- was generated from the LIVE testnet project (hvckneltkugnvtwfrzlb) on
-- 2026-09-28, after the security migrations landed, and describes the end state
-- directly.
--
-- IDEMPOTENT. Every statement is `if not exists` / `or replace`, so a partial run
-- can be re-run. It creates nothing and drops nothing outside these 16 tables.
--
-- RLS IS ON FOR EVERY TABLE, WITH NO POLICIES. That is deliberate and it is the
-- whole authorization story at the database layer: anon and authenticated can read
-- nothing, and the SERVICE ROLE KEY bypasses RLS entirely. Which means every
-- authorization decision in Splitsy is application code, and that key is
-- equivalent to the whole database. Treat it accordingly (docs/mainnet-launch-checklist.md §1).
--
-- gen_random_uuid() is core in Postgres 13+, so no extension is required.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Identity
-- ─────────────────────────────────────────────────────────────────────────────

-- One row per person per sign-in provider. (provider, provider_user_id) is the
-- identity; Google and email-OTP both resolve to provider 'email', so a person
-- who uses either shares one row and therefore one wallet.
create table if not exists users (
  id                   uuid primary key default gen_random_uuid(),
  provider_user_id     text not null,
  handle               text not null,
  name                 text,
  avatar_url           text,
  wallet_address       text,
  circle_wallet_id     text,
  created_at           timestamptz not null default now(),
  -- scrypt hash of the wallet PIN. Null means no PIN set yet.
  pin_hash             text,
  provider             text not null default 'x',
  -- The user's own agent wallet (autopay + dunning spend from this one).
  agent_wallet_address text,
  agent_wallet_id      text,
  -- Sessions issued before this instant are refused. THE KILL SWITCH.
  sessions_valid_from  timestamptz,
  constraint users_provider_uid_key unique (provider, provider_user_id)
);

create index if not exists idx_users_provider_handle on users (provider, lower(handle));

comment on column users.sessions_valid_from is
  'Sessions issued before this instant are rejected. Set by POST /api/auth/logout; '
  'an operator can force-logout one account with `update users set sessions_valid_from = now() '
  'where id = ...`, or everyone by omitting the where clause.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Off-chain bills (the pre-chain draft path)
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists bills (
  id              uuid primary key default gen_random_uuid(),
  creator_user_id uuid not null references users(id) on delete cascade,
  merchant        text,
  currency        text not null default 'USD',
  total_usdc      numeric(20,6) not null,
  metadata        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);

create index if not exists idx_bills_creator on bills (creator_user_id);

create table if not exists bill_debts (
  id              uuid primary key default gen_random_uuid(),
  bill_id         uuid not null references bills(id) on delete cascade,
  debtor_handle   text not null,
  -- Null until the debtor signs up: a debt can name someone who has no row yet.
  debtor_user_id  uuid references users(id),
  amount_usdc     numeric(20,6) not null,
  status          text not null default 'pending'
                    check (status in ('pending','settling','paid')),
  paid_tx_hash    text,
  paid_at         timestamptz,
  created_at      timestamptz not null default now(),
  debtor_provider text not null default 'x'
);

create index if not exists idx_bill_debts_debtor on bill_debts (debtor_user_id);
create index if not exists idx_bill_debts_handle on bill_debts (lower(debtor_handle));
create index if not exists idx_bill_debts_provider_handle
  on bill_debts (debtor_provider, lower(debtor_handle));

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Sign-in: email OTP and the rate limiter
-- ─────────────────────────────────────────────────────────────────────────────

-- One pending code per address, overwritten on resend. code_hash is scrypt.
create table if not exists email_otps (
  email      text primary key,
  code_hash  text not null,
  expires_at timestamptz not null,
  attempts   int not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists idx_email_otps_expires on email_otps (expires_at);

-- Durable counters for every gate that has to hold ACROSS requests: the wallet
-- PIN, the public receipt scan, and the email-OTP send. See schema-rate-limits.sql
-- for the full reasoning; the short version is that the in-memory Map this
-- replaced counted per lambda instance and therefore counted almost nothing.
create table if not exists rate_limits (
  -- "<gate>:<subject>" — e.g. "pin:<userId>", "scan-ip:<ip>", "otp-email:<addr>".
  key          text primary key,
  count        int not null default 0,
  window_start timestamptz not null default now(),
  -- The PIN gate reads THIS rather than window_start: its delay runs from the
  -- last failure, so guessing does not get cheaper the longer someone is at it.
  last_at      timestamptz not null default now()
);

create index if not exists idx_rate_limits_last_at on rate_limits (last_at);

-- Count one attempt and report the state after it, IN A SINGLE STATEMENT.
-- A read-then-write limiter is bypassed by sending the requests at once: each one
-- reads the same pre-increment count and each one is allowed. `insert … on
-- conflict do update … returning` takes a row lock and serialises them, so N
-- simultaneous PIN guesses are counted as N.
create or replace function bump_rate_limit(p_key text, p_window_seconds int)
returns table (count int, window_start timestamptz, last_at timestamptz)
language sql
security definer
set search_path = public
as $$
  insert into rate_limits as r (key, count, window_start, last_at)
  values (p_key, 1, now(), now())
  on conflict (key) do update
    set count = case
          when r.window_start < now() - make_interval(secs => p_window_seconds) then 1
          else r.count + 1
        end,
        window_start = case
          when r.window_start < now() - make_interval(secs => p_window_seconds) then now()
          else r.window_start
        end,
        last_at = now()
  returning r.count, r.window_start, r.last_at;
$$;

-- Read the state WITHOUT counting an attempt. The PIN gate needs this: it must
-- answer "are you locked out right now" before verifying anything, and doing that
-- with bump_rate_limit would make a locked account extend its own lock on every
-- poll — a lockout nothing could ever wait out.
create or replace function peek_rate_limit(p_key text)
returns table (count int, window_start timestamptz, last_at timestamptz)
language sql
security definer
set search_path = public
as $$
  select r.count, r.window_start, r.last_at from rate_limits r where r.key = p_key;
$$;

create or replace function clear_rate_limit(p_key text)
returns void
language sql
security definer
set search_path = public
as $$
  delete from rate_limits where key = p_key;
$$;

-- AND TAKE THE FUNCTIONS BACK OFF THE PUBLIC API. Supabase runs `alter default
-- privileges in schema public grant execute on functions to anon, authenticated,
-- service_role`, so every new function in `public` is callable over
-- /rest/v1/rpc/<name> with the PUBLISHED anon key. Without these lines
-- `clear_rate_limit` is a public endpoint for erasing a wallet's PIN lockout.
--
-- BOTH REVOKES, AND NEITHER IS REDUNDANT. Which one Postgres records depends on
-- how the function was created, and two projects given the SAME file did not
-- agree: one got an explicit `anon=X`, the other `=X` (PUBLIC, which anon
-- inherits). Revoking only one leaves the function reachable from the one anon
-- actually uses. Revoke both — verified with
-- has_function_privilege('anon', …, 'execute') = false afterwards.
revoke execute on function bump_rate_limit(text, int)  from public, anon, authenticated;
revoke execute on function peek_rate_limit(text)       from public, anon, authenticated;
revoke execute on function clear_rate_limit(text)      from public, anon, authenticated;

grant execute on function bump_rate_limit(text, int)  to service_role;
grant execute on function peek_rate_limit(text)       to service_role;
grant execute on function clear_rate_limit(text)      to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Wallets
-- ─────────────────────────────────────────────────────────────────────────────

-- A wallet minted for a handle that has not signed up yet, so an IOU can be sent
-- to a stranger. Claimed by the first sign-in that matches (provider, handle).
create table if not exists pending_wallets (
  provider         text not null,
  handle           text not null,
  wallet_address   text not null,
  circle_wallet_id text not null,
  created_at       timestamptz not null default now(),
  primary key (provider, handle)
);

-- Maps a Splitsy wallet key to the Privy wallet that serves it. (namespace, key)
-- is the same composite the Circle refId encodes as "<namespace>:<key>" —
-- 'x'/'discord'/'email'/'wallet' for a signin wallet, 'prem' for a pre-mint,
-- 'agent' for a user's agent, 'splitsy' for a service wallet.
create table if not exists privy_wallets (
  namespace             text not null,
  key                   text not null,
  -- Nothing writes this any more (wallets are created via wallets().create(),
  -- which has no Privy user); kept so existing rows stay readable.
  privy_user_id         text,
  wallet_id             text not null,   -- what the server signs with
  address               text not null,   -- 0x Arc address
  created_at            timestamptz not null default now(),
  -- A CACHE, NEVER AN AUTHORITY. Privy decides who may export; this only lets the
  -- browser reject a wrong password before making a request.
  export_owner_key      text,
  -- The difference between "ownership moved but we still hold a signer" (the old
  -- export) and "Splitsy holds NO key to this wallet" (a claim). Null = custodial.
  claimed_at            timestamptz,
  -- 'password' or 'passkey+password'. Two different PROMISES to the user.
  owner_kind            text,
  -- WebAuthn credential id, base64url. Not a secret: a handle, useless without
  -- the authenticator holding the key.
  passkey_credential_id text,
  -- The salt the owner key was DERIVED with. Losing it loses the wallet.
  owner_salt            text,
  primary key (namespace, key)
);

create index if not exists idx_privy_wallets_address on privy_wallets (lower(address));

comment on column privy_wallets.claimed_at is
  'When the user took sole ownership: owner moved to their key AND our signer was revoked. '
  'Null means Splitsy can still sign for this wallet, even if export_owner_key is set '
  '(pre-claim exports moved ownership but left our additional_signer in place).';

comment on column privy_wallets.owner_salt is
  'The salt owner keys for this wallet are derived with. Null means the legacy '
  'address salt (splitsy-export:<address>); non-null is set at provision time, when '
  'no address exists yet. Losing this value loses the wallet.';

-- Circle webhook replay guard. notification_id is the PK, so a redelivery is a
-- conflict rather than a second effect.
create table if not exists circle_webhook_events (
  notification_id   uuid primary key,
  notification_type text not null,
  tx_id             text,
  tx_state          text,
  received_at       timestamptz not null default now()
);

create index if not exists idx_circle_webhook_events_tx on circle_webhook_events (tx_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. On-chain state that the chain does not keep
-- ─────────────────────────────────────────────────────────────────────────────

-- The contract stores a HASH of the bill. This is the preimage, so a bill can be
-- displayed and re-verified. Keyed by registry too: bill ids restart at 1 per
-- deployment, so an id only means something next to its own registry.
create table if not exists onchain_bill_preimages (
  registry_address      text not null,
  bill_id               text not null,
  merchant              text not null default '',
  currency              text not null default 'USD',
  total_usd             numeric(20,2) not null,
  participant_labels    text[] not null,
  created_at            timestamptz not null default now(),
  receipt_hash          text not null default '',
  due_date              bigint not null default 0,
  participant_providers text[],
  -- The unguessable token in a share link. Unique where present.
  share_token           text,
  primary key (registry_address, bill_id)
);

create unique index if not exists onchain_bill_preimages_share_token_idx
  on onchain_bill_preimages (share_token) where share_token is not null;

-- An IOU held in HandleEscrow for someone who has not signed up yet. Deposit ids
-- restart at 1 per escrow deployment, hence the composite key.
create table if not exists escrow_deposits (
  escrow_address    text not null,
  deposit_id        text not null,
  provider          text not null,
  handle            text not null,
  depositor_address text not null,
  amount_usdc       numeric(20,6) not null,
  status            text not null default 'open' check (status in ('open','released')),
  tx_hash           text,
  release_tx_hash   text,
  created_at        timestamptz not null default now(),
  released_at       timestamptz,
  primary key (escrow_address, deposit_id)
);

-- The lookup the sign-in path makes on every login: "is anything waiting for this
-- handle". Partial, because a released deposit is never looked up again.
create index if not exists idx_escrow_deposits_open
  on escrow_deposits (provider, handle) where status = 'open';

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. ERC-8004 payment reputation
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists reputation_agents (
  wallet_address text primary key,
  agent_id       text,
  register_tx    text,
  created_at     timestamptz not null default now(),
  agent_type     text not null default 'splitsy-payer'
);

create table if not exists reputation_feedback (
  id               uuid primary key default gen_random_uuid(),
  wallet_address   text not null,
  agent_id         text not null,
  bill_id          text not null,
  score            int not null,
  tag              text not null,
  payment_tx       text not null,
  feedback_tx      text,
  created_at       timestamptz not null default now(),
  -- numeric(78,0) holds a full uint256 without loss.
  share_units      numeric(78,0) not null default 0,
  due_date         bigint not null default 0,
  paid_at          bigint not null default 0,
  registry_address text not null default '',
  -- One score per wallet per bill per registry: the idempotency that stops a
  -- retried settle writing feedback twice.
  constraint reputation_feedback_wallet_registry_bill_key
    unique (wallet_address, registry_address, bill_id)
);

create index if not exists idx_reputation_feedback_wallet on reputation_feedback (wallet_address);

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. x402 nanopayments
-- ─────────────────────────────────────────────────────────────────────────────

-- Both directions: 'earned' when Splitsy's paid endpoints serve a buyer, 'spent'
-- when Scout pays for a call.
create table if not exists x402_payments (
  id           bigint generated always as identity primary key,
  direction    text not null check (direction in ('earned','spent')),
  endpoint     text not null,
  counterparty text not null,
  amount_usdc  numeric(20,6) not null,
  gateway_tx   text,
  bill_ref     text,
  confidence   numeric(4,3),
  created_at   timestamptz not null default now()
);

create index if not exists x402_payments_created_idx on x402_payments (created_at desc);
create index if not exists x402_payments_dir_idx on x402_payments (direction, created_at desc);

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. The agent economy: autopay and dunning
-- ─────────────────────────────────────────────────────────────────────────────

-- What the user has permitted their agent to spend with nobody in the loop. The
-- caps are the user's own ceiling; PRIVY_AGENT_POLICY_ID is the enclave's, and the
-- two are deliberately separate so this server's judgment is not the only gate.
create table if not exists autopay_grants (
  user_id               text primary key,
  max_per_bill_usdc     numeric(20,6) not null default 0,
  max_per_day_usdc      numeric(20,6) not null default 0,
  trusted_creators      text[] not null default '{}'::text[],
  min_creator_score     int not null default 0,
  require_verified_hash boolean not null default true,
  enabled               boolean not null default false,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  debtor_address        text,
  require_bill_review   boolean not null default true,
  -- 'funded' spends from the agent wallet's own balance; 'mandate' pulls under an
  -- on-chain AutopayMandate allowance.
  money_mode            text not null default 'funded'
                          check (money_mode in ('mandate','funded'))
);

-- One grant per debtor ADDRESS as well as per user: the settler finds the grant
-- from the address on the bill, and two users pointing at one address would make
-- that lookup ambiguous — which is a wrong wallet being debited.
create unique index if not exists autopay_grants_debtor_idx
  on autopay_grants (debtor_address) where debtor_address is not null;

-- Every autopay decision, paid or skipped. The UNIQUE is the idempotency: one
-- decision per (registry, bill, debtor), so a retried cron cannot pay twice.
create table if not exists autopay_log (
  id               bigint generated always as identity primary key,
  user_id          text not null,
  registry_address text not null,
  bill_id          text not null,
  debtor_address   text not null,
  decision         text not null check (decision in ('pay','skip')),
  reason           text not null,
  amount_usdc      numeric(20,6) not null default 0,
  tx_hash          text,
  created_at       timestamptz not null default now(),
  job_id           text,
  job_status       text,
  fee_usdc         numeric(20,6) not null default 0,
  constraint autopay_log_registry_address_bill_id_debtor_address_key
    unique (registry_address, bill_id, debtor_address)
);

create index if not exists autopay_log_user_idx on autopay_log (user_id, created_at desc);

create table if not exists dunning_log (
  id               bigint generated always as identity primary key,
  registry_address text not null,
  bill_id          text not null,
  debtor_address   text not null,
  action           text not null check (action in ('nudge','escalate','collect')),
  reason           text not null default '',
  amount_usdc      numeric(20,6) not null default 0,
  tx_hash          text,
  created_at       timestamptz not null default now()
);

create index if not exists dunning_log_bill_idx
  on dunning_log (registry_address, bill_id, debtor_address);

-- A nudge and an escalate happen ONCE each; a collect may be retried, so it is
-- excluded from the uniqueness rather than the whole action column being unique.
create unique index if not exists dunning_log_once_per_action
  on dunning_log (registry_address, bill_id, debtor_address, action)
  where action in ('nudge','escalate');

-- ─────────────────────────────────────────────────────────────────────────────
-- 9. Row level security — LAST, so it applies to everything above
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Enabled with NO POLICIES on every table. anon and authenticated read nothing;
-- the service role bypasses RLS. Splitsy only ever connects with the service role
-- key, so this is a closed door rather than a rule set.
--
-- Listed explicitly rather than looped over pg_tables: a loop would also enable it
-- on a table someone adds later without thinking about it, and silently pass
-- either way. This list is the assertion.

alter table users                  enable row level security;
alter table bills                  enable row level security;
alter table bill_debts             enable row level security;
alter table email_otps             enable row level security;
alter table rate_limits            enable row level security;
alter table pending_wallets        enable row level security;
alter table privy_wallets          enable row level security;
alter table circle_webhook_events  enable row level security;
alter table onchain_bill_preimages enable row level security;
alter table escrow_deposits        enable row level security;
alter table reputation_agents      enable row level security;
alter table reputation_feedback    enable row level security;
alter table x402_payments          enable row level security;
alter table autopay_grants         enable row level security;
alter table autopay_log            enable row level security;
alter table dunning_log            enable row level security;

-- ─────────────────────────────────────────────────────────────────────────────
-- 10. Verify. Run this after the file and read the three numbers.
-- ─────────────────────────────────────────────────────────────────────────────
--
--   select count(*) as tables,
--          count(*) filter (where relrowsecurity) as rls_on,
--          (select count(*) from pg_policy p
--             join pg_class pc on pc.oid = p.polrelid
--             join pg_namespace pn on pn.oid = pc.relnamespace
--            where pn.nspname = 'public') as policies
--     from pg_class c join pg_namespace n on n.oid = c.relnamespace
--    where n.nspname = 'public' and c.relkind = 'r';
--
-- Expected: tables 16, rls_on 16, policies 0.
--
--   select to_regproc('public.bump_rate_limit(text,int)') is not null as bump_fn,
--          to_regproc('public.peek_rate_limit(text)')     is not null as peek_fn,
--          to_regproc('public.clear_rate_limit(text)')    is not null as clear_fn;
--
-- All three must be true, or every rate-limited route fails closed by design.
