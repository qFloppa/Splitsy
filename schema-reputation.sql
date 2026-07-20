-- schema-reputation.sql — run in the Supabase SQL editor (additive).
--
-- ERC-8004 payment reputation. reputation_agents maps a wallet address to the
-- identity NFT (agent id) minted for it on Arc's ERC-8004 IdentityRegistry.
-- reputation_feedback mirrors each giveFeedback the Splitsy validator wallet
-- recorded on the ReputationRegistry, anchored to the bill + payment tx it
-- scores. The mirror exists because Arc's eth_getLogs is range-capped, so full
-- history can't be re-scanned on demand; the chain stays the audit trail —
-- every row is re-verifiable against the BillSplitRegistry DebtPaid event and
-- the ReputationRegistry feedback whose hash commits to that bill + tx.
--
-- Consent policy (why there is no negative feedback here): feedback is only
-- ever recorded for a payment the wallet itself made — paying is the consent.
-- A debt someone merely tagged you into can never touch your score.

-- Claim-based dedupe: a DCW payment fires both the pay route's after() hook
-- and the DebtPaid webhook, so registration/scoring must be serialized.
-- agent_id NULL = an in-flight registration claim (the PK is the mutex);
-- feedback_tx NULL = an in-flight scoring claim (the unique key is the mutex).
-- created_at doubles as the claim timestamp for stale-claim takeover.
create table if not exists reputation_agents (
  wallet_address  text primary key,  -- 0x Arc address that owns the identity NFT
  agent_id        text,              -- IdentityRegistry tokenId (uint256 as text); null = claim
  register_tx     text,              -- registration tx hash
  created_at      timestamptz not null default now()
);

create table if not exists reputation_feedback (
  id              uuid primary key default gen_random_uuid(),
  wallet_address  text not null,     -- payer this feedback scores
  agent_id        text not null,
  bill_id         text not null,     -- payment key: a BillSplitRegistry bill id,
                                     -- or a recurring cycle key "tab:<id>:cycle:<n>"
  score           int not null,      -- 0-100, mirrors the on-chain int128
  tag             text not null,     -- 'paid_in_full' | 'paid_on_time' | 'paid_late'
  payment_tx      text not null,     -- the payDebt tx (the consent anchor)
  feedback_tx     text,              -- the giveFeedback tx on the ReputationRegistry
  -- Amount weighting: the payer's own share on this bill, in USDC base units
  -- (6 dp), read from chain at scoring time. The badge average is weighted by
  -- this, so a large late payment drags a score more than a small one. 0 for
  -- rows written before amount-weighting existed (treated as weight 1 = neutral).
  share_units     numeric(78,0) not null default 0,
  -- Timing context, for display + audit. due_date is the committed Unix seconds
  -- (0 = the bill had no due date, scored as on-time). paid_at is the payDebt
  -- block timestamp the score was graded against (not the server clock).
  due_date        bigint not null default 0,
  paid_at         bigint not null default 0,
  created_at      timestamptz not null default now(),
  unique (wallet_address, bill_id)   -- one verdict per payer per bill
);
create index if not exists idx_reputation_feedback_wallet on reputation_feedback (wallet_address);

-- Additive for existing deployments (no-ops if the columns already exist).
alter table reputation_feedback
  add column if not exists share_units numeric(78,0) not null default 0;
alter table reputation_feedback
  add column if not exists due_date bigint not null default 0;
alter table reputation_feedback
  add column if not exists paid_at bigint not null default 0;
alter table reputation_agents
  alter column agent_id drop not null; -- claim rows (see header comment)
