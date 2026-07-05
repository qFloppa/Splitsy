-- schema-users.sql — run in the Supabase SQL editor (additive; does not touch
-- the existing tabs/members/charges/settlements tables).
create table if not exists users (
  id               uuid primary key default gen_random_uuid(),
  x_user_id        text unique not null,
  x_handle         text not null,
  x_name           text,
  x_avatar_url     text,
  email            text,
  wallet_address   text,
  circle_wallet_id text,
  created_at       timestamptz not null default now()
);
create index if not exists idx_users_x_handle on users (lower(x_handle));
