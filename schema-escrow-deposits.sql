-- schema-escrow-deposits.sql — run in the Supabase SQL editor (additive).
--
-- An index of HandleEscrow deposits, so login can find the money waiting for a
-- handle without walking chain logs. Arc's public RPC refuses an eth_getLogs
-- range wider than ~25k blocks, so "scan for deposits" is not a thing the
-- login path can do inside a request.
--
-- AN INDEX, NOT AN AUTHORITY. The contract is the authority: a row saying
-- 'open' for a deposit that has already been released is a stale row, and the
-- release call simply reverts with NoSuchDeposit. Nothing reads this table to
-- decide whether money may move — it reads it to decide what to TRY.
--
-- Keyed by (escrow_address, deposit_id), the same reasoning as
-- onchain_bill_preimages: deposit ids restart at 1 in every deployment, so a
-- bare id is only meaningful next to the escrow it came from. deposit_id is
-- text because it is a uint256 and can exceed numeric range.
create table if not exists escrow_deposits (
  escrow_address    text not null,            -- lowercased 0x escrow address
  deposit_id        text not null,            -- uint256 as decimal string
  provider          text not null,            -- 'x' | 'discord' | 'email'
  handle            text not null,            -- normalized: no leading @, lowercased
  depositor_address text not null,            -- lowercased 0x sender address
  amount_usdc       numeric(20,6) not null,
  status            text not null default 'open' check (status in ('open','released')),
  tx_hash           text,                     -- the deposit transaction
  release_tx_hash   text,
  created_at        timestamptz not null default now(),
  released_at       timestamptz,
  primary key (escrow_address, deposit_id)
);

-- The lookup login performs: "is anything waiting for this handle?"
-- `handle` plain rather than `lower(handle)`: every writer goes through
-- normalizeHandle (lib/escrow-deposits-repo.ts), so the column IS already
-- lowercased — and an expression index cannot serve the `handle = $2` filter
-- PostgREST actually sends.
create index if not exists idx_escrow_deposits_open
  on escrow_deposits (provider, handle)
  where status = 'open';

-- Deny-all to the anon and authenticated roles: RLS on, no policies, and the
-- service role bypasses it. Measured against splitsy-test on 2026-09-14 rather
-- than assumed — every table there has RLS enabled except x402_payments, which
-- is a gap in that table, not a precedent for this one.
alter table escrow_deposits enable row level security;
