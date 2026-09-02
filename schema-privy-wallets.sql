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
