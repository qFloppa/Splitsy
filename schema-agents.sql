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

-- WHERE THE RULES ACTUALLY LIVE, since the on-chain mandate landed:
--
--   max_per_bill_usdc, max_per_day_usdc, trusted_creators and enabled are now a
--   DISPLAY MIRROR. The binding copies live in AutopayMandate.sol, which the
--   agent must call to move any money and which reverts on its own numbers
--   regardless of what this table says. The mirror exists so the settings form
--   can show what a user typed before they signed it, and so a chain read that
--   fails degrades to a stale figure rather than a blank one. Nothing reads
--   these to decide a payment — app/api/agents/grants/route.ts reads the chain.
--
--   min_creator_score and require_verified_hash are NOT mirrored. They are the
--   two rules a contract cannot evaluate — ERC-8004 stores individual feedback
--   rather than the aggregate, and no contract can see the off-chain preimage —
--   so this table is their only home and lib/autopay.ts is their only enforcer.
--
-- No migration and no column drops: the columns still carry the same meaning,
-- they simply stopped being the last word.
create table if not exists autopay_grants (
  user_id               text primary key,
  -- Per-bill ceiling. A bill above this is skipped with reason 'over_bill_cap'.
  -- Mirror of AutopayMandate.mandates(debtor).maxPerBill.
  max_per_bill_usdc     numeric(20,6) not null default 0,
  -- Rolling 24h ceiling across every bill the agent pays for this user. Mirror
  -- of AutopayMandate.mandates(debtor).maxPerDay, which enforces it as a token
  -- bucket refilling at maxPerDay per 24h rather than a calendar-day counter:
  -- a calendar boundary would let two full-cap spends straddle midnight.
  max_per_day_usdc      numeric(20,6) not null default 0,
  -- Lowercase creator addresses the user will autopay. EMPTY MEANS ANYONE —
  -- an empty allowlist is "no creator restriction", not "trust nobody".
  -- Mirror of AutopayMandate.allowedCreators(debtor); capped at 10 there.
  trusted_creators      text[] not null default '{}',
  -- ERC-8004 floor for the bill's creator. 0 = off. A creator with NO history
  -- passes: "no history" is neutral, never bad (see the consent policy in
  -- schema-reputation.sql). This rule fails open on purpose — the alternative
  -- is an agent that refuses every first-time creator forever.
  min_creator_score     int not null default 0,
  -- Require the off-chain preimage to recompute to the on-chain metadataHash
  -- before paying. Fails CLOSED: no preimage stored at all means no payment.
  require_verified_hash boolean not null default true,
  -- Mirror only. The real kill switch is AutopayMandate's `agent == address(0)`,
  -- which the debtor sets with revokeMandate() from their own wallet — so
  -- turning autopay off never depends on this server being reachable.
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

-- The browser wallet (EOA) this person autopays from, proven by a personal_sign
-- at POST /api/agents/link. It lives here rather than on `users` because it says
-- nothing about who someone is — only which wallet their agent may pull from —
-- and the identity tables are load-bearing across the whole app.
--
-- The partial unique index is what stops two accounts claiming one address and
-- making the debtor -> user lookup in the autopay route ambiguous.
alter table autopay_grants add column if not exists debtor_address text;
create unique index if not exists autopay_grants_debtor_idx
  on autopay_grants (debtor_address) where debtor_address is not null;

-- Whether the agent must also pass the bill's CONTENTS past a model before
-- paying: does the receipt cohere, and is this person's share proportionate to
-- what is attributed to them? require_verified_hash proves only that the
-- preimage recomputes to the on-chain metadataHash — it says nothing about
-- whether the contents are reasonable, and that is the one question no rule can
-- answer. Default ON, and fails CLOSED, for the same reasons as that column.
alter table autopay_grants add column if not exists require_bill_review boolean not null default true;
