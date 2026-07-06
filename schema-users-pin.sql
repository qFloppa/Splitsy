-- schema-users-pin.sql — adds a wallet PIN hash to users (additive).
alter table users add column if not exists pin_hash text;
