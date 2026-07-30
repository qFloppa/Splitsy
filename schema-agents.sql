-- schema-agents.sql — run in the Supabase SQL editor (additive; standalone).
--
-- Storage for the two agents in the agentic-settlement track:
--   * autopay_grants — the debtor-side rules an autopay agent must satisfy
--     before it spends a user's money. The agent NEVER decides on its own: it
--     evaluates these against on-chain facts (see lib/autopay.ts) and every
--     skip is logged with a reason.
--   * autopay_log — one row per decision, pay or skip. The skip rows are the
--     point: they are the evidence that the rules bind.
--   * dunning_log — one row per creditor-side action, and the mutex that stops
--     a cron overlap from double-nudging.
--
-- Money is stored as numeric USDC (never float) and compared in atomic units by
-- lib/x402/spend.ts, which is also what enforces the daily cap.

create table if not exists autopay_grants (
  user_id               text primary key,
  -- Per-bill ceiling. A bill above this is skipped with reason 'over_bill_cap'.
  max_per_bill_usdc     numeric(20,6) not null default 0,
  -- Rolling 24h ceiling across every bill the agent pays for this user.
  max_per_day_usdc      numeric(20,6) not null default 0,
  -- Lowercase creator addresses the user will autopay. EMPTY MEANS ANYONE —
  -- an empty allowlist is "no creator restriction", not "trust nobody".
  trusted_creators      text[] not null default '{}',
  -- ERC-8004 floor for the bill's creator. 0 = off. A creator with NO history
  -- passes: "no history" is neutral, never bad (see the consent policy in
  -- schema-reputation.sql). This rule fails open on purpose — the alternative
  -- is an agent that refuses every first-time creator forever.
  min_creator_score     int not null default 0,
  -- Require the off-chain preimage to recompute to the on-chain metadataHash
  -- before paying. Fails CLOSED: no preimage stored at all means no payment.
  require_verified_hash boolean not null default true,
  enabled               boolean not null default false,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- Every decision the autopay agent made, pay or skip. Also the idempotency key:
-- a redelivered BillCreated webhook must not pay twice. The contract's
-- `remaining` cap would make the second call revert anyway, but a revert is not
-- an idempotency key.
create table if not exists autopay_log (
  id               bigint generated always as identity primary key,
  user_id          text not null,
  registry_address text not null,
  bill_id          text not null,
  debtor_address   text not null,
  decision         text not null check (decision in ('pay','skip')),
  reason           text not null,
  amount_usdc      numeric(20,6) not null default 0,
  tx_hash          text,
  created_at       timestamptz not null default now(),
  unique (registry_address, bill_id, debtor_address)
);
create index if not exists autopay_log_user_idx on autopay_log (user_id, created_at desc);

create table if not exists dunning_log (
  id               bigint generated always as identity primary key,
  registry_address text not null,
  bill_id          text not null,
  debtor_address   text not null,
  action           text not null check (action in ('nudge','escalate','collect')),
  reason           text not null default '',
  amount_usdc      numeric(20,6) not null default 0,
  tx_hash          text,
  created_at       timestamptz not null default now()
);
create index if not exists dunning_log_bill_idx on dunning_log (registry_address, bill_id, debtor_address);

-- 'nudge' and 'escalate' are once-only per (registry, bill, debtor): a cron
-- overlap or retry must not spam the debtor. 'collect' is append-only — a
-- partial collection can legitimately repeat as the debtor tops up — so the
-- constraint is a partial index rather than a table-wide unique.
create unique index if not exists dunning_log_once_per_action
  on dunning_log (registry_address, bill_id, debtor_address, action)
  where action in ('nudge','escalate');
