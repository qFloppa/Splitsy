-- schema-bills.sql — run in the Supabase SQL editor (additive; needs the users
-- table from schema-users.sql).
create table if not exists bills (
  id              uuid primary key default gen_random_uuid(),
  creator_user_id uuid not null references users(id) on delete cascade,
  merchant        text,
  currency        text not null default 'USD',
  total_usdc      numeric(20,6) not null,
  metadata        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);

create table if not exists bill_debts (
  id             uuid primary key default gen_random_uuid(),
  bill_id        uuid not null references bills(id) on delete cascade,
  debtor_handle  text not null,               -- lowercased @handle, no leading @
  debtor_user_id uuid references users(id),   -- filled when that user logs in
  amount_usdc    numeric(20,6) not null,
  status         text not null default 'pending' check (status in ('pending','paid')),
  paid_tx_hash   text,
  paid_at        timestamptz,
  created_at     timestamptz not null default now()
);
create index if not exists idx_bill_debts_handle on bill_debts (lower(debtor_handle));
create index if not exists idx_bill_debts_debtor on bill_debts (debtor_user_id);
create index if not exists idx_bills_creator on bills (creator_user_id);
