-- schema-x402-payments.sql — run in the Supabase SQL editor (additive; standalone).
-- Ledger of x402 nanopayments in both directions: 'earned' when Splitsy's own
-- paid endpoints serve a buyer, 'spent' when Scout pays for a call.
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

-- Deny-all to anon and authenticated, matching every other table here: no
-- policies, and the service role bypasses RLS. This line was MISSING until
-- 2026-09-28 and this was the only table in the project without it — the ledger
-- names counterparty addresses and endpoint spend, so an anon key would have
-- read the whole payment history. Additive; safe to re-run.
alter table x402_payments enable row level security;
