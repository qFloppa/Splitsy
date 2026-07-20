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
  receipt_hash        text not null default '', -- keccak256 of the receipt image bytes ('' = no photo)
  due_date            bigint not null default 0, -- Unix seconds the bill is due (0 = no due date), committed in the hash
  created_at          timestamptz not null default now(),
  primary key (registry_address, bill_id)
);

-- Additive for existing deployments (no-op if the column already exists).
alter table onchain_bill_preimages
  add column if not exists receipt_hash text not null default '';

-- Additive: due date committed into the metadata hash (0 = none). Existing rows
-- default to 0, which hashes byte-identically to a pre-due-date bill.
alter table onchain_bill_preimages
  add column if not exists due_date bigint not null default 0;

-- Receipt images live in Supabase Storage, not on-chain — only their keccak256
-- goes into the commitment. Bucket is public-read so a payer's browser can fetch
-- and eyeball the image; writes go through the service role in the publish route.
-- Objects are keyed `<registry_address>/<bill_id>` (see onchain-bill-preimage-repo).
insert into storage.buckets (id, name, public)
values ('onchain-bill-receipts', 'onchain-bill-receipts', true)
on conflict (id) do nothing;
