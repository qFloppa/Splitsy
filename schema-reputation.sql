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
  -- Which contract the bill_id belongs to. A bare bill id is only meaningful
  -- next to its registry: BillSplitRegistry v2 restarts nextBillId at 1, so
  -- without this column every payment on new bill #1..#N would collide with the
  -- v1 rows and scoring would silently stop recording — no error, no log.
  registry_address text not null default '',
  created_at      timestamptz not null default now(),
  unique (wallet_address, registry_address, bill_id) -- one verdict per payer per bill per registry
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

-- Which role the NFT was minted as: 'splitsy-payer', 'splitsy-user-agent',
-- 'splitsy-settler', 'splitsy-auditor', 'splitsy-validator'. Each does a
-- different job and its metadata says so (AGENT_PROFILE in lib/erc8004.ts).
--
-- Stored rather than derived because minted metadata is IMMUTABLE: re-pointing a
-- token's URI later needs to know what that agent does, and the wallet address
-- alone does not say. Defaulting to payer is right for every row that predates
-- this column — the agent economy is newer than all of them.
alter table reputation_agents
  add column if not exists agent_type text not null default 'splitsy-payer';

-- --- registry re-key migration (BillSplitRegistry v2) ------------------------
-- Run once, before pointing the app at the v2 registry.
--
-- bill_id is a SHARED namespace: bare numeric ids come from BillSplitRegistry,
-- while "tab:<id>:cycle:<n>" keys come from RecurringTabFactory. Only the bare
-- ids were ever exposed to the id-restart collision, but stamping tab rows with
-- a bill-registry address they have nothing to do with would make every later
-- query lie — so the two are backfilled to their own contracts.
alter table reputation_feedback
  add column if not exists registry_address text not null default '';

update reputation_feedback
   set registry_address = lower('0x9Cc377C957255582BCa8084a950F52e59fB0a41E') -- RecurringTabFactory
 where registry_address = '' and bill_id like 'tab:%';

update reputation_feedback
   set registry_address = lower('0x867051b5F840F045B3c72a091B1b6453c86E120B') -- BillSplitRegistry v1
 where registry_address = '';

alter table reputation_feedback drop constraint if exists reputation_feedback_wallet_address_bill_id_key;
alter table reputation_feedback
  add constraint reputation_feedback_wallet_registry_bill_key
  unique (wallet_address, registry_address, bill_id);
