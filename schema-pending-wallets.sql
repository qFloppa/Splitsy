-- schema-pending-wallets.sql — run in the Supabase SQL editor (additive).
--
-- Bridges a social handle (X / Discord / email) to a Circle DCW that was
-- pre-minted when the handle was tagged on an ON-CHAIN bill, before that person
-- ever signed into Splitsy. createBill needs a real Arc address for every
-- participant, so we mint one here and remember it. When the person signs in,
-- the OAuth callback ADOPTS this wallet (sets it on their user row) and deletes
-- the pending row, so their escrow position is theirs.
--
-- Keyed by (provider, handle): the same normalized pair used to match debts.
create table if not exists pending_wallets (
  provider          text not null,   -- 'x' | 'discord' | 'email'
  handle            text not null,   -- normalized: leading @ stripped, lowercased
  wallet_address    text not null,   -- 0x Arc address of the pre-minted DCW
  circle_wallet_id  text not null,   -- Circle wallet id (for server-side signing)
  created_at        timestamptz not null default now(),
  primary key (provider, handle)
);
