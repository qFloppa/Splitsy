# Continue prompt — HandleEscrow (resume mid-run)

Paste the block below into a fresh chat in this repo. Run it in inline mode:
do the work yourself, no subagents.

---

Continue executing the HandleEscrow plan in this repo. Most of it is already
built — you are resuming a run that is nearly finished, **in inline mode: do
every remaining step yourself, do not dispatch subagents.**

Plan: docs/superpowers/plans/2026-09-13-handle-escrow.md
Spec: docs/superpowers/specs/2026-09-13-handle-escrow-design.md
Ledger: .superpowers/sdd/2026-09-13-handle-escrow/progress.md

**Read the ledger first.** It is the record of the whole run: a pre-flight
conflict table, 31 numbered rulings with their reasoning and what each costs
if wrong, 30 deferred minor findings, and a per-task history. Trust it and
`git log` over any assumption. Per-task reports sit beside it as
`task-N-report.md`.

Read AGENTS.md too — this is not the Next.js you know (16.2.9), so check
`node_modules/next/dist/docs/` before writing any Next code.

## Where the run stands

Branch `privy-wallet-stack`, clean tree at `aeba232`. Merge-base with main is
`4930c3f`. Tasks 1-8 are all committed and every task review passed except as
noted below.

Two things are outstanding, one of them blocking:

**1. Task 8's scoped re-review never ran.** Commit `aeba232` fixed four review
findings — the load-bearing one being that the false "links a real account"
claim had survived verbatim at `lib/wallet-resolve.ts:24-28`, directly above
the live `pregenerateWallet` call, which is the exact sentence that cost 3.11
USDC. The implementer also fixed a fifth copy the review missed
(`app/api/auth/privy/route.ts:62-69`). I verified by grep that no live copy of
the claim survives anywhere in `*.ts`/`*.tsx` (the only hit is the corrected
comment quoting it in order to negate it) and that `tsc --noEmit` is clean.
A re-review package is already written:
`.superpowers/sdd/2026-09-13-handle-escrow/review-297a149..aeba232.diff`.
Verify that fix diff yourself: every finding addressed, no behaviour changed
(docs and comments only — check for non-comment lines), nothing now asserting
something *else* false, and in particular nothing implying spec §3 shipped or
that the pre-mint is dead. It is not dead: `defaultMintPending` still calls it
and the bill routes still need it.

**2. Task 7 has no independent review, and this is the one real gap.** Three
separate reviewer dispatches completed but their report text was lost in
transit every time — a harness failure, not a code signal. Rather than sit in
the reviewer's seat myself, I established the mechanically checkable ground
truth and deferred the judgement to the final review (Ruling 10 in the ledger).
Already verified: Ruling 5 holds (only relative imports at module scope), the
`test:escrow` suite is green at 10/10, and the EIP-712 digest binding is exact
— `releaseDomain(5042002, <escrow>)` produces
`{name:"Splitsy HandleEscrow", version:"1", chainId:5042002, verifyingContract:<escrow>}`
against `contracts/HandleEscrow.sol:121-124`, the type string is exactly
`Release(uint256 id,address to,uint256 deadline)` (contract `:91`), and the
escrow address is threaded per-row rather than being a module constant.
What has never been read by anyone but its author is `lib/escrow-release.ts`'s
code quality. Read it properly, with its four disclosed concerns in hand (they
are in `task-7-report.md`): the payload-vs-calldata `relay` seam, the Circle
first-login delay, the unfunded releaser, and `amount_usdc` deliberately unused.

## Then: the final whole-branch review

Review `4930c3f..HEAD` yourself. Build the package with
`.claude/plugins/cache/claude-plugins-official/superpowers/6.3.0/skills/subagent-driven-development/scripts/review-package docs/superpowers/plans/2026-09-13-handle-escrow.md 4930c3f HEAD`.

Triage the ledger's 30 deferred minors — decide which must be fixed before
merge. Four are worth your attention because they can cost money or lie to a
user:

- `MAX_LEGS` exhaustion reports a false `escrowed` with confetti and no
  deposit (`app/signed-send.ts:96` → `app/IouClient.tsx:715-722`).
- `void confetti(...)` sits inside `commit`'s try (`app/IouClient.tsx:902`),
  so a throw there reaches the catch and runs `promote()`, dropping an
  already-escrowed row and restoring the composer after money moved.
- `recallable` (`app/IouClient.tsx:1169`) lets an `escrow-unrecorded` row be
  tapped back into the composer — the row that says "don't resend" offers a
  resend.
- A permanently-`open` row makes every future sign-in submit a reverting tx,
  and Arc charges gas in USDC, so it drains the releaser slowly and forever.

If the final review finds anything, fix it in one pass, then re-verify.

## The Definition of done, and what is gated

The plan's "Definition of done" is the bar. These you can run:

- `npx hardhat test` — 122 tests (110 baseline + 12 `HandleEscrowTest`)
- `npm run audit:contracts` — Slither; needs `slither-analyzer` on PATH (it
  was installed to `~/.local/bin` during the run, nothing added to the repo)
- `node --test --experimental-strip-types lib/handle-escrow.test.ts lib/escrow-release.test.ts lib/wallet-resolve.test.ts`
- `npx tsc --noEmit`

**Four things need the user and must not be done without asking.** They are
gated because they spend real testnet funds, write to a live database, or are
irreversible:

1. **Task 3 Steps 4-5** — generate the attester key and deploy `HandleEscrow`
   to Arc Testnet. The attester is **immutable in the deployed contract**:
   getting it wrong means redeploying, not reconfiguring. Handover with exact
   commands is in `task-3-report.md`.
2. **Task 4 Step 2** — run `schema-escrow-deposits.sql` against the
   `splitsy-test` Supabase project. Expect eleven columns.
3. **Task 6 Step 6 / Task 7 Step 6** — the end-to-end Preview run, which needs
   both of the above plus a funded releaser wallet. **Arc charges gas in USDC,
   so an unfunded releaser fails every release silently** — that is the most
   likely way the run "doesn't work". `task-7-report.md` has the handover:
   how to find the releaser's address on each stack, and the two log lines that
   mean the money did not move but the login still succeeded.
4. Anything else irreversible, outward-facing, or beyond this branch.

Ask about all four together in one message rather than interrupting four times.

## When you finish

Use `superpowers:finishing-a-development-branch`. Before deleting the
workspace, collect every ledger line containing `Ruling:` into your final
message under "Rulings I made", in order, each with what it costs if wrong —
that list is the only place those decisions reach the user.

Report honestly: the escrow rail is **not verified end to end** until the
gated steps run. Do not describe it as working; describe it as built, tested
where testable, and awaiting the deploy.
