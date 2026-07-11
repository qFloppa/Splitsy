-- schema-generic-identity.sql — migrate the users table from X-specific columns
-- to a generic provider model so multiple sign-in providers (X, Discord, …) can
-- coexist. Run once in the Supabase SQL editor. Existing rows become provider='x'.

-- 1. Rename the X-specific columns to generic names.
alter table users rename column x_user_id to provider_user_id;
alter table users rename column x_handle to handle;
alter table users rename column x_name to name;
alter table users rename column x_avatar_url to avatar_url;

-- 2. Add the provider discriminator (existing rows are all X sign-ins).
alter table users add column if not exists provider text not null default 'x';

-- 3. Drop the email column — Splitsy no longer collects email from any provider.
alter table users drop column if exists email;

-- 4. Replace the single-column unique (auto-named users_x_user_id_key) with a
--    composite unique on (provider, provider_user_id): X and Discord ids are
--    both numeric snowflakes and could otherwise collide.
alter table users drop constraint if exists users_x_user_id_key;
alter table users add constraint users_provider_uid_key unique (provider, provider_user_id);

-- 5. Swap the handle index for a provider-scoped one.
drop index if exists idx_users_x_handle;
create index if not exists idx_users_provider_handle on users (provider, lower(handle));

-- 6. Tag each debt with the provider namespace of its handle (existing = 'x').
alter table bill_debts add column if not exists debtor_provider text not null default 'x';
create index if not exists idx_bill_debts_provider_handle on bill_debts (debtor_provider, lower(debtor_handle));
