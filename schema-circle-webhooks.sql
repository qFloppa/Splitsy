-- schema-circle-webhooks.sql — run in the Supabase SQL editor (additive; needs
-- bill_debts from schema-bills.sql).

-- 'settling' = transfer accepted by Circle, awaiting the COMPLETE webhook.
alter table bill_debts drop constraint if exists bill_debts_status_check;
alter table bill_debts add constraint bill_debts_status_check
  check (status in ('pending', 'settling', 'paid'));

-- Dedup ledger: Circle delivers at-least-once and notificationId is stable
-- across retries, so a PK insert that conflicts means "already handled".
create table if not exists circle_webhook_events (
  notification_id   uuid primary key,
  notification_type text not null,
  tx_id             text,
  tx_state          text,
  received_at       timestamptz not null default now()
);
create index if not exists idx_circle_webhook_events_tx on circle_webhook_events (tx_id);
