-- schema-privy-wallets.sql — run in the Supabase SQL editor (additive).
--
-- Maps a Splitsy wallet key to the Privy user and wallet that serve it.
--
-- The Circle stack gets this idempotency free from listWallets({refId}); Privy
-- has no equivalent we depend on, so the mapping is ours. (namespace, key) is
-- the same composite the Circle refId encodes as "<namespace>:<key>" —
-- 'x'/'discord'/'email'/'wallet' for a signin wallet, 'prem' for a pre-mint,
-- 'agent' for a user's agent, 'splitsy' for a service wallet.
create table if not exists privy_wallets (
  namespace     text        not null,
  key           text        not null,
  privy_user_id text        not null,
  wallet_id     text        not null,   -- Privy wallet id (for server-side signing)
  address       text        not null,   -- 0x Arc address of the Privy embedded wallet
  created_at    timestamptz not null default now(),
  primary key (namespace, key)
);

create index if not exists idx_privy_wallets_address on privy_wallets (lower(address));

-- Deny-all to the anon and authenticated roles, matching every other table in
-- this project: no policies, and the service role bypasses RLS. wallet_id is
-- what the server signs with, so the published anon key must never read it.
alter table privy_wallets enable row level security;

-- Export ownership (2026-09-08). Additive; safe to re-run.
--
-- export_owner_key is a CACHE, NEVER AN AUTHORITY. Privy decides who may export;
-- this column only lets the browser reject a wrong password before making a
-- request, and lets the UI say which side of the line a wallet is on. Null means
-- "Splitsy still administers this wallet"; non-null means ownership has
-- transferred and only that key can export. A wrong value here is annoying — the
-- local pre-check fails until the user re-enters the right password — and never
-- dangerous, because Privy is the real gate.
alter table privy_wallets add column if not exists export_owner_key text;

-- Wallets are created via wallets().create() now, which has no Privy user at all,
-- so nothing writes this any more. Kept rather than dropped so the migration is
-- additive and the existing rows stay readable.
alter table privy_wallets alter column privy_user_id drop not null;

-- Non-custodial claim (2026-09-11). Additive; safe to re-run.
--
-- WHAT CHANGED, and it is a change of MEANING rather than of shape:
-- export_owner_key used to mean "ownership moved, so only this key can EXPORT",
-- while our quorum stayed an additional_signer and could still SPEND. A claim now
-- passes owner and additional_signers: [] in ONE wallets().update(), so a non-null
-- export_owner_key on a claimed row means something far stronger — Splitsy holds
-- NO key to this wallet and can neither spend from it nor export it. Measured, in
-- scripts/privy-claim-probe.ts: 401 on both, 0 signers remaining.
--
-- claimed_at is what tells the two apart, and it has to exist because the older
-- meaning is still out there. A row with export_owner_key set and claimed_at NULL
-- was exported under the old design and WE CAN STILL SPEND FROM IT. Reading only
-- export_owner_key would report those wallets as non-custodial, which is exactly
-- the custody lie this whole branch exists to refuse. Null means custodial.
alter table privy_wallets add column if not exists claimed_at timestamptz;

comment on column privy_wallets.claimed_at is
  'When the user took sole ownership: owner moved to their key AND our signer was revoked. '
  'Null means Splitsy can still sign for this wallet, even if export_owner_key is set '
  '(pre-claim exports moved ownership but left our additional_signer in place).';
