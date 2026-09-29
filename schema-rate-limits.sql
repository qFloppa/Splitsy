-- schema-rate-limits.sql — run once in the Supabase SQL editor (additive).
--
-- Durable counters for every gate that has to hold across requests: the wallet
-- PIN, the public receipt scan, and the email-OTP send. It replaces the
-- in-memory Map that lib/rate-limit.ts used to keep, which counted per lambda
-- instance and therefore counted almost nothing — a serverless deployment gives
-- each concurrent request its own module scope, so N instances meant N × the
-- limit and a cold start reset it to zero.
--
-- ONE TABLE, NOT THREE. The three gates differ only in the key they count under
-- and in how they read the result (a fixed cap for the scan and the OTP, an
-- escalating delay for the PIN). The counting itself is the same question, and a
-- second copy of it is a second place for the atomicity below to be lost.

create table if not exists rate_limits (
  -- "<gate>:<subject>" — e.g. "pin:<userId>", "scan-ip:<ip>", "otp-email:<addr>".
  key          text primary key,
  count        int not null default 0,
  -- When the current window opened. The window is what expires the count.
  window_start timestamptz not null default now(),
  -- When the most recent attempt landed. The PIN gate needs THIS rather than
  -- window_start: its delay runs from the last failure, so that guessing does not
  -- get cheaper the longer someone has been at it.
  last_at      timestamptz not null default now()
);

-- Deny-all to anon and authenticated, matching every other table here: no
-- policies, and the service role bypasses RLS. The functions below are SECURITY
-- DEFINER, so they keep working; a published anon key can neither read how close
-- a key is to its cap nor delete a row to reset one.
alter table rate_limits enable row level security;

-- Count one attempt and report the state after it, in a single statement.
--
-- ATOMICITY IS THE WHOLE POINT. A read-then-write limiter is bypassed by simply
-- sending the requests at once: every one of them reads the same pre-increment
-- count and every one of them is allowed. `insert … on conflict do update …
-- returning` takes a row lock and serialises the concurrent callers, so N
-- simultaneous PIN guesses are counted as N.
--
-- SECURITY DEFINER so the gate cannot be bypassed by a caller that only holds
-- rights on the table; the search_path is pinned for the usual reason.
create or replace function bump_rate_limit(p_key text, p_window_seconds int)
returns table (count int, window_start timestamptz, last_at timestamptz)
language sql
security definer
set search_path = public
as $$
  insert into rate_limits as r (key, count, window_start, last_at)
  values (p_key, 1, now(), now())
  on conflict (key) do update
    set count = case
          when r.window_start < now() - make_interval(secs => p_window_seconds) then 1
          else r.count + 1
        end,
        window_start = case
          when r.window_start < now() - make_interval(secs => p_window_seconds) then now()
          else r.window_start
        end,
        last_at = now()
  returning r.count, r.window_start, r.last_at;
$$;

-- Read the state without counting an attempt.
--
-- The PIN gate needs this: it must answer "are you locked out right now" BEFORE
-- it verifies anything, and doing that with bump_rate_limit would make a locked
-- account extend its own lock on every poll — a lockout nothing could ever wait
-- out. Returns no row when the key has never been seen.
create or replace function peek_rate_limit(p_key text)
returns table (count int, window_start timestamptz, last_at timestamptz)
language sql
security definer
set search_path = public
as $$
  select r.count, r.window_start, r.last_at from rate_limits r where r.key = p_key;
$$;

create or replace function clear_rate_limit(p_key text)
returns void
language sql
security definer
set search_path = public
as $$
  delete from rate_limits where key = p_key;
$$;

-- THE LIMITER SHIPPED WITH ITS OWN BYPASS UNTIL THIS BLOCK EXISTED, and it is the
-- reason SECURITY DEFINER above is not enough on its own.
--
-- Supabase runs `alter default privileges in schema public grant execute on
-- functions to anon, authenticated, service_role`, so EVERY new function in
-- `public` is reachable over /rest/v1/rpc/<name> with the PUBLISHED anon key.
-- Which made `clear_rate_limit` a public endpoint for erasing a wallet's PIN
-- lockout — one POST with {"p_key":"pin:<userId>"} and the wallet-drain gate is
-- gone — and `bump_rate_limit` a way to push anyone else's key to its cap.
--
-- BOTH REVOKES, AND NEITHER IS REDUNDANT. Which one Postgres records depends on
-- how the function was created, and the two projects did not agree:
--   * `anon=X`  — an EXPLICIT grant, produced by the default privileges. Revoking
--                 PUBLIC leaves it, and anon keeps the function.
--   * `=X`      — a grant to PUBLIC, which anon then inherits. Revoking anon
--                 leaves it, and anon keeps the function all the same.
-- Measured both ways: the testnet project created them one way and the fresh
-- mainnet project the other, from the SAME file. So revoke both forms.
revoke execute on function bump_rate_limit(text, int)  from public, anon, authenticated;
revoke execute on function peek_rate_limit(text)       from public, anon, authenticated;
revoke execute on function clear_rate_limit(text)      from public, anon, authenticated;

grant execute on function bump_rate_limit(text, int)  to service_role;
grant execute on function peek_rate_limit(text)       to service_role;
grant execute on function clear_rate_limit(text)      to service_role;

-- Housekeeping. Nothing reads a row whose window closed long ago, and the table
-- would otherwise grow one row per IP forever. Run it from a cron or by hand;
-- no gate depends on it having run.
create index if not exists idx_rate_limits_last_at on rate_limits (last_at);
