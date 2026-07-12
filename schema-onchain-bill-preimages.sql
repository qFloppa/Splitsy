-- schema-onchain-bill-preimages.sql — run in the Supabase SQL editor (additive).
--
-- Stores the plaintext "preimage" of an on-chain BillSplitRegistry bill so a
-- payer can recompute its keccak256 and verify it against the immutable hash in
-- the BillCreated event. Only the hash is on-chain; these human-readable details
-- are not. No FK to `bills` — registry bills are on-chain, not rows in `bills`.
--
-- Keyed by (registry_address, bill_id): bill ids restart per registry
-- deployment, so the pair is what's globally unique. bill_id is text because it
-- is a uint256 and can exceed numeric range.
create table if not exists onchain_bill_preimages (
  registry_address    text not null,           -- lowercased 0x registry address
  bill_id             text not null,            -- uint256 as decimal string
  merchant            text not null default '',
  currency            text not null default 'USD',
  total_usd           numeric(20,2) not null,   -- exact dollars used in the hash
  participant_labels  text[] not null,          -- ordered, as hashed (join '|')
  created_at          timestamptz not null default now(),
  primary key (registry_address, bill_id)
);
