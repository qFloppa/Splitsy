-- schema-escrow-reclaim.sql — run in the Supabase SQL editor (additive).
--
-- Adds the third terminal state a deposit can reach. HandleEscrow has always had
-- two exits (release and reclaim) but this index only ever recorded one, because
-- a reclaim used to be something a sender did by hand and nothing automated
-- cared. The nightly sweep (/api/escrow/reclaim-stale) changes that: it reclaims
-- deposits older than a week so the balance a leaked attester key could reach
-- stays near one week of inflow instead of accumulating forever.
--
-- 'reclaimed' is NOT 'released' with a different tx hash. A released deposit
-- reached its recipient; a reclaimed one went back to the sender and the debt it
-- was settling is still outstanding. Collapsing them would make the IOU view
-- lie about who is owed what.

alter table escrow_deposits
  drop constraint if exists escrow_deposits_status_check;

alter table escrow_deposits
  add constraint escrow_deposits_status_check
  check (status in ('open', 'released', 'reclaimed'));

alter table escrow_deposits
  add column if not exists reclaim_tx_hash text,
  add column if not exists reclaimed_at timestamptz;

-- The sweep's own lookup: "what is still open and old enough to pull back?"
-- Partial on status so it stays small — released and reclaimed rows are the
-- overwhelming majority over time and the sweep never looks at them.
create index if not exists idx_escrow_deposits_stale
  on escrow_deposits (created_at)
  where status = 'open';
