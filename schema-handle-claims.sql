-- schema-handle-claims.sql — run in the Supabase SQL editor (additive).
--
-- WHICH ACCOUNT OWNS A HANDLE, answered once, by first login, and never rewritten.
--
-- Every money path keys on the handle STRING rather than the provider's stable
-- id: an escrow deposit sits under keccak256("x:alice") (lib/handle-escrow.ts),
-- and a stranger's slot IS the low 160 bits of that same hash, on chain and
-- permanent (lib/handle-slot.ts). The account row survives a rename — it is keyed
-- on (provider, provider_user_id) — but the money does not. It stays filed under
-- the old string, where two things went wrong at once:
--
--   THE OWNER STOPPED FINDING IT. Login released escrow for `users.handle` alone,
--   which after a rename is the NEW handle, so the deposit under the old one was
--   invisible until the nightly sweep returned it to its sender. The same
--   mismatch made a slot's debts unreachable: the refund route derived the slot
--   from the current handle and the chain answered "not a participant".
--
--   SOMEONE ELSE COULD TAKE IT. X and Discord free an abandoned handle for
--   re-registration. The new owner of @alice signing in was indistinguishable
--   from the old one — the release path treats the handle as the whole claim —
--   and because {BillSplitRegistry.bind} is write-once, a slot refund bound to
--   them could never be undone by anyone, including the real owner.
--
-- This table is the statement that was missing. First login under a handle wins
-- it; a rename leaves the old row standing, so one account owns several handles
-- and the handles it owns are the ones its money is looked up under. Nothing ever
-- rewrites a row, which is what makes a re-registered handle harmless: the new
-- owner gets an account and no claim.
--
-- NOT AN AUTHORITY OVER THE CHAIN, the same caveat escrow_deposits carries. The
-- contracts still decide whether money may move. This decides whose name we are
-- willing to ask under — which, for a signature-authorised release and a
-- write-once binding, is the whole of the decision we actually make.
create table if not exists handle_claims (
  provider   text not null,                  -- 'x' | 'discord' | 'email' | 'google'
  handle     text not null,                  -- normalized: no leading @, lowercased
  user_id    uuid not null references users (id) on delete cascade,
  claimed_at timestamptz not null default now(),
  -- The handle is the key, so the claim cannot be duplicated and an insert that
  -- loses the race is a no-op rather than a second owner.
  primary key (provider, handle)
);

-- The read every login and every slot lookup performs: "which handles are this
-- account's?" Claims per account are 1 or 2, so this is a point lookup.
create index if not exists idx_handle_claims_user
  on handle_claims (user_id);

-- Deny-all to the anon and authenticated roles: RLS on, no policies, and the
-- service role bypasses it. Same stance as escrow_deposits.
alter table handle_claims enable row level security;

-- THE BACKFILL IS NOT OPTIONAL, and it is why this file is additive rather than a
-- table the app creates lazily. Without it every handle in use today is
-- unclaimed, and the first login to touch one wins it — including a stranger who
-- just re-registered a handle somebody renamed away from last week. Running this
-- claims every existing account's current handle in one statement, so the window
-- closes at deploy time instead of decaying as people happen to sign in.
--
-- OLDEST ROW WINS per (provider, handle), which is the tie-break
-- getUserByProviderHandle already applies (lib/users-repo.ts): case-insensitive
-- matching means two rows can share a handle, and the account that existed first
-- is the one holding the history. `claimed_at` is backdated to that account's
-- creation for the same reason — the claim is as old as the identity, not as old
-- as this migration.
--
-- Normalized the same way lib/iou.ts:normalizeHandle does (trim, drop a leading
-- @, lowercase), because the hash the money sits under is derived from exactly
-- that string. A different normalization here is a row that points at nothing.
insert into handle_claims (provider, handle, user_id, claimed_at)
select distinct on (u.provider, lower(ltrim(btrim(u.handle), '@')))
       u.provider,
       lower(ltrim(btrim(u.handle), '@')),
       u.id,
       u.created_at
  from users u
 where u.provider <> 'wallet'           -- a raw address has no handle namespace
   and coalesce(btrim(u.handle), '') <> ''
 order by u.provider, lower(ltrim(btrim(u.handle), '@')), u.created_at
    on conflict do nothing;             -- re-running this file must be a no-op
