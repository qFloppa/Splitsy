-- schema-iou-journal.sql — the ledger of IOUs, so the IOU tab can show an
-- archive of the ones that have already landed. (Additive; needs the users
-- table from schema-users.sql.)
--
-- WHY A TABLE AND NOT A CHAIN READ. Half of an IOU is invisible on chain. "X owes
-- me" files a registry bill and its settlement emits DebtPaid, so that half could
-- be reconstructed by scanning logs. "I owe X" is a bare USDC transfer with
-- nothing attached — no bill, no memo, no id — and the chain cannot tell it apart
-- from any other transfer out of the wallet. So the sentence has to be written
-- down when it is made, or it does not exist.
--
-- A JOURNAL, NOT AN AUTHORITY. Nothing here decides whether money may move: every
-- row is written AFTER its transaction has already settled, and the chain is still
-- the only thing that says a bill was paid. What this table is for is the sentence
-- and the reason — the two facts the chain never has.
--
-- `status` IS THE STATE AT WRITE TIME, NOT A LIVE ONE. There is no update path: an
-- 'open' row is not "still unpaid", it is "not known to be finished when it was
-- written". Whether it has landed since is DERIVED on read and never stored here —
-- that is what keeps this table a single-writer append log with no races.
--   'open'      — an ask (a registry bill), or a settle that went straight to a
--                 wallet. Its landing is answered by the chain.
--   'escrowed'  — a settle to a handle with no wallet yet. Its landing is answered
--                 by its row in escrow_deposits flipping to 'released'.
-- 'landed' and 'cancelled' exist so a later writer has somewhere to go without a
-- migration; nothing writes them today.
create table if not exists iou_journal (
  id                   uuid primary key default gen_random_uuid(),
  signer_address       text not null,               -- lowercased 0x wallet that signed this IOU
  kind                 text not null check (kind in ('ask','settle')),
  counterparty_label   text not null,               -- as displayed: "@dani" or "0xb2a1…cdef"
  counterparty_address text,                        -- lowercased 0x when known; null for an escrowed handle
  amount_usdc          numeric(20,6) not null,
  note                 text not null default '',    -- the sentence's "what for", kept verbatim
  status               text not null default 'open' check (status in ('open','escrowed','landed','cancelled')),
  registry_address     text,                        -- ask: the registry the bill lives in
  bill_id              text,                        -- ask: uint256 as decimal string
  escrow_address       text,                        -- escrowed settle: the escrow holding the money
  escrow_deposit_id    text,                        -- escrowed settle: uint256 as decimal string
  tx_hash              text,                        -- the transaction that made this IOU real
  created_at           timestamptz not null default now()
);

-- The archive's only query: "everything this wallet signed, newest first". A
-- closed-in-time range scan rather than a filter over an index on created_at,
-- since signer_address is always the first predicate.
create index if not exists idx_iou_journal_signer on iou_journal (signer_address, created_at desc);

-- The lookups the read path makes: ask rows are gathered per registry (bill ids
-- restart at 1 in every deployment, so a bare bill_id is only meaningful next to
-- the registry it came from — the same reasoning as onchain_bill_preimages and
-- escrow_deposits), and escrow rows are joined against escrow_deposits.
create index if not exists idx_iou_journal_bill on iou_journal (registry_address, bill_id) where bill_id is not null;
create index if not exists idx_iou_journal_deposit on iou_journal (escrow_address, escrow_deposit_id) where escrow_deposit_id is not null;