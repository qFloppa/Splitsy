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

create table if not exists reputation_agents (
  wallet_address  text primary key,  -- 0x Arc address that owns the identity NFT
  agent_id        text not null,     -- IdentityRegistry tokenId (uint256 as text)
  register_tx     text,              -- registration tx hash
  created_at      timestamptz not null default now()
);

create table if not exists reputation_feedback (
  id              uuid primary key default gen_random_uuid(),
  wallet_address  text not null,     -- payer this feedback scores
  agent_id        text not null,
  bill_id         text not null,     -- on-chain BillSplitRegistry bill id
  score           int not null,      -- 0-100, mirrors the on-chain int128
  tag             text not null,     -- e.g. 'paid_in_full'
  payment_tx      text not null,     -- the payDebt tx (the consent anchor)
  feedback_tx     text,              -- the giveFeedback tx on the ReputationRegistry
  created_at      timestamptz not null default now(),
  unique (wallet_address, bill_id)   -- one verdict per payer per bill
);
create index if not exists idx_reputation_feedback_wallet on reputation_feedback (wallet_address);
