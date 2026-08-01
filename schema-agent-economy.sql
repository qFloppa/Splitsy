-- schema-agent-economy.sql — run in the Supabase SQL editor (additive; standalone).
--
-- The agent economy adds no table. Everything it needs hangs off rows that
-- already exist, because the identity that matters was already there:
--   * autopay_log     — one row per decision, and now also per JOB. Its unique
--                       key (registry_address, bill_id, debtor_address) is
--                       still the idempotency lock, unchanged and unwidened:
--                       the claim is taken BEFORE createJob, so a redelivered
--                       webhook cannot even open a second job.
--   * autopay_grants  — gains the money mode, which decides where BILL money
--                       comes from. Not where the FEE comes from: the fee
--                       always comes from the user's agent, in both modes.
--   * users           — caches the agent wallet so it is not re-derived from
--                       Circle on every request.

-- The ERC-8183 job this decision opened. Display mirror only: getJob(jobId) on
-- chain is the source of truth and the UI refetches it. A skip has no job and
-- both columns stay null — paying gas to record a non-payment buys nothing.
alter table autopay_log add column if not exists job_id      text;
alter table autopay_log add column if not exists job_status  text;

-- What the settlement cost the user's agent in job fees, separate from
-- amount_usdc, which is the bill share. Two different pockets, two columns.
alter table autopay_log add column if not exists fee_usdc    numeric(20,6) not null default 0;

-- Where BILL money comes from.
--   'mandate' — the user's own wallet, pulled under AutopayMandate. The caps
--               that bind are the on-chain ones. This is the default, and it
--               is the default deliberately: it is the mode where the chain,
--               not this server, is the thing that says no.
--   'funded'  — the agent's own balance, via BillSplitRegistry.payDebtFor. The
--               mandate is not in the path, so the caps that bind are the ones
--               in THIS table, enforced off chain by lib/autopay.ts. The only
--               ceiling the chain still enforces is the agent's balance.
-- The weakening is real and the UI must say so in one sentence.
alter table autopay_grants add column if not exists money_mode text not null default 'mandate'
  check (money_mode in ('mandate','funded'));

-- The user's agent wallet — one per ACCOUNT, refId 'agent:<user_id>', covering
-- both the Splitsy DCW and any linked browser wallet. Cached here so a page
-- load does not re-list wallets against Circle. Circle remains authoritative;
-- these two columns are a cache that lib/user-agent.ts refills on a miss.
alter table users add column if not exists agent_wallet_address text;
alter table users add column if not exists agent_wallet_id      text;
