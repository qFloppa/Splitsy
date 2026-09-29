-- schema-session-revocation.sql — run once in the Supabase SQL editor (additive).
--
-- The one piece of server state a stateless session needs: the moment before
-- which this account's tokens no longer count.
--
-- The session cookie is a signed "<userId>.<issuedAtMs>.<hmac>" and carries no
-- server-side record (lib/session-core.ts explains why — ~40 route handlers read
-- it, and a table lookup per request was not worth it). That leaves no way to
-- retire one early: a cookie captured from a shared machine or a browser backup
-- was good for its full thirty days and nothing could stop it.
--
-- Comparing the token's signed issue time against this column fixes that without
-- adding a read — getUserById already loads the row every request, so the check
-- is a field on data the session path was fetching anyway.
--
-- NULL means "never revoked", which is every existing account. It is deliberately
-- not defaulted to now(): a default would sign out every live session the moment
-- this migration ran.
alter table users add column if not exists sessions_valid_from timestamptz;

comment on column users.sessions_valid_from is
  'Sessions issued before this instant are rejected. Set by POST /api/auth/logout; '
  'an operator can force-logout one account with '
  '`update users set sessions_valid_from = now() where id = ...`, or everyone with '
  '`update users set sessions_valid_from = now()`.';
