# Run prompt — HandleEscrow

Paste the block below into a fresh chat in this repo.

---

Implement the HandleEscrow plan in this repo.

Plan: docs/superpowers/plans/2026-09-13-handle-escrow.md
Spec: docs/superpowers/specs/2026-09-13-handle-escrow-design.md

Read AGENTS.md first — this is not the Next.js you know, so check
node_modules/next/dist/docs/ before writing any Next code.

Use the superpowers:subagent-driven-development skill to work through the
plan task by task. Do the tasks in order; they build on each other.

Things the plan says that are easy to get wrong, so hold onto them:

- Tasks 1-7 must NOT delete pregenerateWallet, defaultMintPending or
  pending_wallets. The three bill/recurring routes still need them. That
  deletion is spec §3, which is out of scope here and blocked on a product
  decision.
- Task 5 is additive only. Do not change resolveParticipantAddress or
  resolveParticipants — add lookupParticipantAddress beside them.
- The EIP-712 digest is computed in three places (HandleEscrow.sol,
  lib/handle-escrow.ts, the contract test). If they disagree, every release
  fails in production and nowhere else. Both tests exist to pin that.
- Task 3 deploys a contract with an IMMUTABLE attester address. Generate a
  fresh key. Getting it wrong means redeploying, not reconfiguring.
- Task 6 must read the deposit amount from the chain, never from the request
  body.
- Task 7 must no-op when walletAddress is null — the Privy login route calls
  finishProviderLogin twice and the first call has no wallet yet.

Stop and ask me before: running the deploy in Task 3 (it spends real testnet
funds and the attester cannot be changed afterwards), and running the SQL in
Task 4 against Supabase.

Done means the "Definition of done" section at the end of the plan passes,
with the commands actually run and their output shown.
