# Agentic Settlement: BillSplitRegistry v2 + two agents

**Goal:** ship the agentic-economy track on Splitsy: a debtor-side autopay agent, a
creditor-side dunning/collection agent, and true batch settlement — on top of ONE
redeployed `BillSplitRegistry` that is audited to mainnet standard and scores clean
on automated scanners.

**Status:** Code complete on `feat/agentic-settlement-registry-v2`. Two steps
remain and both are operator actions, not code: run the `schema-agents.sql` and
`schema-reputation.sql` migrations, then deploy v2 and swap the env addresses
(`scripts/deploy-bill-split-registry.ts` prints both). `npm run audit:contracts`
is wired but Slither is not installed locally, so it has not been run.
**Created:** 2026-07-29
**Owner:** mhm233

## Why one redeploy

`BillSplitRegistry` has no owner, no proxy, no upgrade path — that is a security
feature we are keeping, and it means every contract change in this plan must land in
a single new deployment. Three separate redeploys would fragment bill ids three ways.
So all four contract changes below ship together or not at all.

## What the contract cannot do today

1. `payDebt` credits `msg.sender` only. An agent holding its own DCW cannot pay on
   your behalf. This blocks autopay entirely.
2. There is no way for a creditor to pull from a debtor who has approved the
   registry. This blocks deadline collection.
3. Both fund-movers are `external nonReentrant`, so no batch function can call them.
   Browser-EOA users get N+M+1 wallet prompts; Circle SCA users only escape this via
   wallet-level `executeBatch`, which cannot express a cross-user settle.
4. No due date is stored on chain. "Collect at the deadline" would be pure server
   policy — unverifiable, and unenforceable by the contract.

## Global constraints

- **Solidity 0.8.28**, `production` profile (optimizer, runs 200). No new
  dependencies, no OpenZeppelin — the repo has its own `SafeERC20`,
  `ReentrancyGuard`, `IERC20` and they stay.
- **Preserve the audit posture verbatim:** custom errors only (no revert strings),
  checks-effects-interactions everywhere, no owner, no upgrade, no pause, no sweep,
  no `selfdestruct`, no `delegatecall`, no low-level `call`. Funds leave only to a
  bill's own splitter.
- **No `try/catch` per leg.** Batch entrypoints are all-or-nothing. A partial batch is
  a state we would have to report and unwind; atomicity is cheaper than both.
- **Money is `uint256` base units** end to end. No float anywhere near an amount.
- **Every amount is read from chain**, never taken from a request body. Request
  bodies select *which* legs run.
- **TDD.** Every task below writes the failing test first, in the existing harness
  (`contracts/test/Test.sol` + hevm cheatcodes, run via `npm run test:contracts`;
  `node --test --experimental-strip-types` for TS).
- **AGENTS.md applies:** this is not the Next.js in your training data. Read the
  relevant guide in `node_modules/next/dist/docs/` before writing any route code.

## File structure

New:

```
contracts/BillSplitRegistry.sol          (rewritten in place — v2)
contracts/mocks/MaliciousUSDC.sol        reentrant token for the guard tests
contracts/mocks/FeeOnTransferUSDC.sol    under-delivering token for the accounting test
slither.config.json                      scanner config (none exists today)
lib/autopay.ts                           pure decision core: does this debt pass my rules?
lib/autopay.test.ts
lib/dunning.ts                           pure decision core: nudge, escalate, or collect?
lib/dunning.test.ts
lib/registry-calldata.ts                 (extended: payDebtFor, authorizeCollect, collectDebt, settle)
schema-agents.sql                        autopay_grants + dunning_log
app/api/agents/autopay/route.ts          debtor agent: evaluate + pay
app/api/agents/dunning/route.ts          creditor agent: nudge/escalate/collect (cron)
app/api/agents/grants/route.ts           user CRUD for autopay rules + collect mandates
app/agents/AgentEconomyPanel.tsx         the surface: rules, agent log, mandate toggles
```

Touched:

- `contracts/BillSplitRegistry.t.sol` — grows from 7 tests to the full v2 suite
- `scripts/deploy-bill-split-registry.ts` — v2 constructor is unchanged, but the
  script must print the new address for the env swap
- `lib/bill-metadata.ts` — `dueDate` moves from optional-off-chain to a stored field
- `lib/arc-read.ts` — read `dueDate`, `escrowUntilFull` + `collectMandate`
- every `createBill` caller — the signature gains two params (Tasks 2 and 2b); the
  bill-creation UI needs a due-date input and an escrow toggle, and the toggle must be
  disabled until a due date is set (the contract rejects that pair outright)
- `lib/erc8004.ts` — new feedback tags, registry-namespaced storage keys
- `app/api/treasury/settle/route.ts` — one `settle` call instead of a hand-built batch
- `app/HomeClient.tsx:1484` — `settleNetWithWallet` collapses to a single tx
- `app/api/webhooks/circle/route.ts` — new event branches
- `schema-reputation.sql` — the unique-key landmine (Task 12)
- `vercel.json` — dunning cron
- `.env.example` — new keys

## Phase 1 — Contract v2

### Task 1: Refactor the fund-movers into private internals

The reentrancy guard is why no batch function can exist today: `settle` calling
`this.payDebt` would revert on the second leg. Fix it by moving the logic down and
leaving `nonReentrant` only on outer entrypoints.

- [ ] Write `test_payDebt_stillWorksAfterRefactor` and
      `test_claim_stillWorksAfterRefactor` — the existing 7 tests must pass untouched.
- [ ] Extract `_payDebt(uint256 billId, address debtor, address funder, uint256 amount)`
      as `private`. It does the participant lookup, the remaining check, the state
      writes, the `DebtPaid` emit, then `usdc.safeTransferFrom(funder, address(this), amount)`.
- [ ] Extract `_claim(uint256 billId, uint256 amount) private` likewise.
- [ ] `payDebt(billId, amount) external nonReentrant` becomes
      `_payDebt(billId, msg.sender, msg.sender, amount)`.
- [ ] `claim(billId, amount) external nonReentrant` keeps the splitter check in the
      *outer* function (it is an authorization check, and `settle` needs the same one).
- [ ] Verify CEI still holds inside each internal: every state write and the event
      precede the single token interaction.
- [ ] Run `npm run test:contracts`. All 7 original tests green.

**Trap:** do not put `nonReentrant` on the internals. Do not make them `internal`
(no inheritance here) or `public` (that would re-expose an unguarded path).

### Task 2: Stored due date

Turns "collect at the deadline" from server policy into a contract precondition.

- [ ] Write `test_createBill_storesDueDate` and
      `test_getBill_returnsDueDate`.
- [ ] Add `uint64 dueDate` to the `Bill` struct, packed next to `bool exists` and
      `address splitter` (splitter 20 + dueDate 8 + exists 1 = 29 bytes, one slot).
- [ ] `createBill(bytes32 metadataHash, address[] participants, uint256[] owed, uint64 dueDate)`.
      `dueDate == 0` means "no deadline" and must remain legal — most bills have none.
- [ ] Add `dueDate` to the `BillCreated` event and to `getBill`'s return tuple.
- [ ] Write `test_createBill_rejectsPastDueDate` — a non-zero `dueDate` in the past
      is `InvalidConfiguration`. A bill created already-collectible is not a feature.
- [ ] Run the suite.

**Trap:** `uint64` for a timestamp is deliberate and safe past year 2500, but the
comparison must be `block.timestamp >= bill.dueDate` with an explicit
`bill.dueDate != 0` guard — otherwise every no-deadline bill is instantly collectible.
Write that comparison once as `function _isDue(Bill storage) private view returns (bool)`
— Task 2b and Task 4 both need it, and two copies of a timestamp rule drift.

### Task 2b: `escrowUntilFull` — hold the claim until everyone has paid

The "release escrow when all payers have paid" half of the programmable-money story.
It lives here and only here: this contract has no owner, no proxy and no upgrade path,
so a claim-side gate ships in this redeploy or costs a second one.

- [ ] Write `test_claim_revertsWhileEscrowed` and `test_claim_succeedsOnceFullyPaid`.
- [ ] Add `bool escrowUntilFull` to `Bill`. Task 2's slot has room: splitter 20 +
      dueDate 8 + exists 1 + escrow 1 = 30 bytes, still one slot.
- [ ] `createBill(bytes32 metadataHash, address[] participants, uint256[] owed, uint64 dueDate, bool escrowUntilFull)`.
      Add it to `BillCreated` and `getBill` alongside `dueDate`.
- [ ] New error `Escrowed(uint256 billId, uint256 paid, uint256 owed)`.
- [ ] Gate it inside **`_claim`, not the outer `claim`**. The splitter check stays
      outer (Task 1) because it is an authorization check `settle` re-does per bill;
      this is a state precondition, so putting it in the internal means `settle`'s
      claim loop inherits it for free and cannot be used to bypass escrow.
- [ ] Release condition: `bill.totalPaid >= bill.totalOwed`. **Superseded — see
      Task 2c.** The original plan released escrow at `_isDue` as well, on the
      reasoning that one debtor who never pays would otherwise lock the creditor's
      funds forever in a contract with no owner, no pause and no sweep. That escape
      hatch was real but pointed the wrong way: it let a creditor simply wait out
      the deadline and keep a partial pot for a purchase that never happened, which
      is exactly what the payer ticks the box to prevent. Task 2c replaces it with a
      hatch that points at the payers instead.
- [ ] Write `test_createBill_rejectsEscrowWithoutDueDate` → `InvalidConfiguration`.
      `escrowUntilFull` with `dueDate == 0` is an unbounded lock either way — with
      Task 2c it is the `refund` that would never become reachable. Refuse it at
      creation rather than trusting every caller to pair the two.
- [ ] `claimable(billId)` returns 0 while escrowed, or the treasury UI offers a claim
      that reverts. Write `test_claimable_isZeroWhileEscrowed`.
- [ ] Write `test_settle_claimLegRespectsEscrow` — this is the proof the gate landed
      in `_claim` and not in the outer function.
- [ ] Run the suite.

### Task 2c: `refund` — make the escrow an escrow

Task 2b as first written was a *claim delay*, not an escrow: a payer's money was
never coming back, deadline or no deadline. "Hold the money until everyone has paid"
reads to the person handing over the money as a conditional refund, and shipping the
weaker meaning under that label is the kind of gap that costs trust exactly once.

Landed in the same redeploy as 2b — v2 had not been deployed yet, so this cost
nothing beyond the diff. It would have cost a second redeploy a week later.

- [x] `_isEscrowed` drops its `!_isDue` term: escrow releases on full payment and on
      nothing else. Past the deadline a short bill has **failed** and the splitter's
      claim never opens.
- [x] `refund(uint256 billId)`, `nonReentrant`, callable by any participant when the
      bill is `escrowUntilFull`, `_isDue`, and still short of `totalOwed`. Returns the
      caller's whole `paid`; no partial variant, no amount argument.
- [x] New error `NotRefundable(uint256 billId)`; new event `DebtRefunded` mirroring
      `DebtPaid`'s field shape so an indexer can net the two.
- [x] `bill.claimed` is untouched by a refund and provably cannot be non-zero on a
      refundable bill: `_claim` only succeeds at `totalPaid >= totalOwed`, and a bill
      at that mark is not refundable. The two paths are mutually exclusive by
      construction, so neither can drain the other's funds.
- [x] Tests: refund after the deadline, before the deadline (`NotYetDue`), on a fully
      paid bill and a non-escrow bill (`NotRefundable`), from a non-payer and a
      non-participant (`InvalidAmount`), twice (second call reverts, and another
      payer's money is untouched), and a full revive-then-claim round trip proving
      `totalPaid` stayed consistent.
- [x] `test_claim_escrowReleasesAtDueDate` inverted to
      `testClaimStaysEscrowedAtDueDateWhenShort`.

**Composition note for the audit write-up:** `collectDebt` eligibility and the
refund window are the same instant by construction — both are `_isDue`. At the
deadline the creditor can still pull from mandated debtors, because that is exactly
what can carry a short bill over the line and make it claimable. Anything pulled into
a bill that stays short is refundable to the debtor it came from, so the mandate
cannot be used to extract money from a failed bill; the splitter only burns their own
gas trying. That interaction is intended, not an accident; it is in the NatSpec and
in `testCollectedFundsOnAFailedEscrowBillAreRefundableToTheDebtor`.

**Off-chain mirrors that must not drift:** `claimableNow` in `lib/treasury.ts` (lost
its `nowSeconds` argument — claimability is pure bill state now) and its new sibling
`refundableNow`, which is the half that still needs a clock.

### Task 3: `payDebtFor` — third-party funding (unlocks autopay)

An agent's DCW pays *your* debt from *its* balance. The debt is credited to you; the
USDC comes from the agent.

- [ ] Write `test_payDebtFor_creditsDebtorAndPullsFromFunder`: agent approves, calls
      `payDebtFor(billId, alice, amount)`, assert `getParticipant(billId, alice).paid`
      increased and the agent's USDC balance dropped.
- [ ] Write `test_payDebtFor_emitsDebtPaidWithDebtorAsPayer` — the `payer` topic must
      be the debtor, not the funder, or every existing indexer and the ERC-8004
      scorer silently stops matching.
- [ ] Add `event DebtFunded(uint256 indexed billId, address indexed debtor, address indexed funder, uint256 amount);`
      so the funder is still discoverable on chain.
- [ ] Implement `payDebtFor(uint256 billId, address debtor, uint256 amount) external nonReentrant`
      → `_payDebt(billId, debtor, msg.sender, amount)` then the `DebtFunded` emit.
- [ ] Write `test_payDebtFor_revertsForNonParticipantDebtor` → `NotParticipant`.
- [ ] Write `test_payDebtFor_revertsWhenOverRemaining` → `InvalidAmount`.
- [ ] Write `test_payDebtFor_revertsOnZeroDebtor` → `InvalidConfiguration`. `address(0)`
      can never be a participant, but assert the explicit error rather than relying on it.
- [ ] Run the suite.

**Authorization note for the audit write-up:** `payDebtFor` needs *no* permission
check and that is not an oversight. It only ever moves the caller's own USDC, and it
only ever reduces someone's debt. There is no griefing vector: paying a stranger's
bill is a gift, and the `remaining` cap means you cannot overpay to inflate
`totalPaid` beyond `totalOwed`. State this reasoning in the NatSpec so a scanner's
"missing access control" heuristic has an auditor answer sitting next to it.

### Task 4: `authorizeCollect` + `collectDebt` — creditor pull (unlocks dunning)

This is the one genuinely dangerous addition, so it gets four gates.

- [ ] Write `test_collectDebt_revertsWithoutMandate` → new error `NoCollectMandate(billId, debtor)`.
- [ ] Add `mapping(uint256 billId => mapping(address debtor => bool)) public collectMandate;`
- [ ] Implement `authorizeCollect(uint256 billId) external` — participant-only
      (`NotParticipant` otherwise), sets `collectMandate[billId][msg.sender] = true`,
      emits `CollectAuthorized(billId, debtor)`. Write
      `test_authorizeCollect_onlyParticipant`.
- [ ] Implement `revokeCollect(uint256 billId) external` — same gate, clears the flag,
      emits `CollectRevoked`. Write `test_revokeCollect_thenCollectReverts`. **A
      consent you cannot withdraw is not consent**, and a scanner that sees a
      one-way authorization flag will flag it.
- [ ] Implement `collectDebt(uint256 billId, address debtor, uint256 amount) external nonReentrant`:
  - [ ] splitter-only → `NotSplitter`. Write `test_collectDebt_onlySplitter`.
  - [ ] mandate must be set → `NoCollectMandate`.
  - [ ] `_isDue(bill)` (Task 2's shared helper) → else new error
        `NotYetDue(billId, dueDate)`. Write `test_collectDebt_revertsBeforeDueDate`
        and `test_collectDebt_revertsWhenNoDueDate` (a bill with no deadline is
        never collectible — there is no moment that "the deadline" names).
  - [ ] cap at `_min(amount, _min(remaining, _min(allowance, balance)))`, mirroring
        `RecurringTab._settleMember`. If the capped amount is 0, revert
        `NothingCollectible(billId, debtor)` — `collectDebt` is a single-target call,
        so unlike `RecurringTab`'s multi-member loop there is nothing to salvage by
        continuing.
  - [ ] then `_payDebt(billId, debtor, debtor, collected)` and emit
        `DebtCollected(billId, debtor, splitter, collected)`.
- [ ] Write `test_collectDebt_collectsPartialWhenAllowanceShort` — approve half,
      assert exactly half moves and the debt is half paid, no revert.
- [ ] Run the suite.

**The `_min` cap is the whole safety story.** Write it into the NatSpec: a debtor's
exposure is bounded by *four* independent things they control or that are immutable —
their own approval, their own balance, their own `remaining` on this specific bill,
and a mandate they set per-bill and can revoke. The splitter cannot invent an amount.

### Task 5: `settle` — the batch entrypoint

One transaction for "claim everything owed to me, pay everything I owe". Works for
browser EOAs (which have no wallet-level batching) and collapses the SCA path to a
single registry call.

- [ ] Write `test_settle_claimsThenPays` — a wallet with zero USDC but a funded bill
      it created settles a debt purely out of the claim proceeds. This is the ordering
      contract: claims execute first so their USDC funds the pay legs in the same tx.
- [ ] Add `uint256 public constant MAX_BATCH = 64;` and error
      `BatchTooLarge(uint256 provided, uint256 maximum)`.
- [ ] Implement:
      `settle(uint256[] calldata claimBillIds, uint256[] calldata payBillIds, uint256[] calldata payAmounts) external nonReentrant`
  - [ ] `payBillIds.length != payAmounts.length` → `InvalidConfiguration`.
  - [ ] either array over `MAX_BATCH` → `BatchTooLarge`. Write
        `test_settle_revertsOverMaxBatch`.
  - [ ] both arrays empty → `InvalidConfiguration`. Write `test_settle_revertsWhenEmpty`.
  - [ ] loop claims: splitter check per bill, then `_claim(id, claimable)` where
        `amount == 0` means "everything claimable". Skip nothing — a zero-claimable
        bill in the list is caller error, so revert `ClaimExceedsBalance`.
  - [ ] loop pays: `_payDebt(id, msg.sender, msg.sender, amount)` where `amount == 0`
        means "my whole remaining share". Write `test_settle_zeroAmountMeansRemaining`.
- [ ] Write `test_settle_revertsWholeBatchOnOneBadLeg` — assert the claim that
      succeeded earlier in the same call is rolled back too.
- [ ] Write `test_settle_isNotReentrantViaBatch` — proves Task 1's refactor did not
      leave a reentrancy hole (see Task 7 for the malicious token).
- [ ] Run the suite.

**Why no `deadline`/nonce/signature on `settle`:** it only ever moves `msg.sender`'s
own funds to and from bills they are party to. There is nothing to replay.

**Gas note:** `MAX_BATCH = 64` with two arrays is well inside Arc's block limit;
64 pay legs is ~64 `transferFrom` calls. Do not raise it without measuring — an
unbounded loop over caller-supplied arrays is the single most common scanner finding
and a real DoS-by-gas footgun.

### Task 6: `_min` and final read surface

- [ ] Add `function _min(uint256 a, uint256 b) private pure returns (uint256)`.
      Copy the shape from `RecurringTab` — do not import across files for four bytes.
- [ ] Extend `getBill` to return `dueDate` and `escrowUntilFull`. Update every ABI
      consumer in Task 9.
- [ ] Add `function collectible(uint256 billId, address debtor) external view returns (uint256)`
      returning the same `_min` cap `collectDebt` would use, or 0 if not yet due /
      no mandate. The dunning agent must be able to ask "would this succeed?" without
      simulating a revert.
- [ ] Write `test_collectible_matchesWhatCollectDebtMoves` — the view and the
      state-changing function must never disagree. Assert equality, then call
      `collectDebt` and assert the moved amount equals the earlier view result.
- [ ] Run the suite.

## Phase 2 — Audit

This phase exists because the contract will hold mainnet funds and will be scanned.
Nothing here is optional and none of it ships after the agents.

### Task 7: Adversarial token mocks

The real reentrancy risk in v2 is not USDC — it is that `settle` and `collectDebt`
now call `_payDebt` in a loop, so a token with a callback gets N chances.

- [ ] Write `contracts/mocks/MaliciousUSDC.sol`: a 6-decimal token whose
      `transferFrom` calls back into a configurable `(target, calldata)` once.
- [ ] Write `test_settle_reentrancyIsBlocked` — malicious token re-enters `settle`
      mid-loop, assert `ReentrancyGuardReentrantCall`.
- [ ] Write `test_collectDebt_reentrancyIsBlocked` and
      `test_payDebtFor_reentrancyIsBlocked` likewise.
- [ ] Write `test_claim_reentrancyIsBlocked` — re-enter via `transfer` on the claim path.
- [ ] Write `contracts/mocks/FeeOnTransferUSDC.sol` — delivers `amount - fee`.
- [ ] Write `test_feeOnTransferTokenBreaksAccounting_documented`: assert that with a
      fee-on-transfer token the registry's `totalPaid` exceeds its actual balance, and
      that `claim` therefore reverts on the token transfer. **This is a known and
      accepted limitation** — the registry is deployed against a specific immutable
      USDC address, set once in the constructor, with no rebasing or fee behaviour.
      The test pins the behaviour so nobody "fixes" it with balance-delta accounting
      (which would add a reentrancy surface for no gain). Add a `ponytail:` comment at
      the `usdc` declaration naming the assumption and the upgrade path.
- [ ] Run the suite.

### Task 8: Slither, invariants, and the audit note

No Slither config exists in this repo today, though `slither-disable-next-line`
comments in `RecurringTab.sol` show it has been run by hand. Make it reproducible.

- [ ] Write `slither.config.json`: `solc_version` 0.8.28, `filter_paths` covering
      `contracts/test|contracts/mocks|node_modules`, optimizer settings matching the
      `production` profile.
- [ ] Add `npm run audit:contracts` → `slither . --config-file slither.config.json`.
- [ ] Run it. Triage every finding into exactly one of: **fixed**, or **suppressed
      with a one-line `slither-disable-next-line <detector>` plus a reason comment**.
      Zero un-triaged findings at high or medium. Expect and handle:
  - `reentrancy-*` on the loops → guarded; suppress with the guard named.
  - `calls-loop` on `settle`/`collectDebt` → bounded by `MAX_BATCH`; suppress.
  - `timestamp` on the `dueDate` comparison → a due date is inherently a wall-clock
    concept and miner drift of seconds is immaterial to a bill deadline; suppress
    with that reason.
  - `missing-zero-check` → add explicit `address(0)` guards rather than suppressing.
- [ ] Add invariant tests to `BillSplitRegistry.t.sol`, each asserted after a mixed
      sequence of `payDebt`/`payDebtFor`/`collectDebt`/`claim`/`settle`:
  - [ ] `test_invariant_paidNeverExceedsOwed` — per participant and in aggregate.
  - [ ] `test_invariant_claimedNeverExceedsPaid`.
  - [ ] `test_invariant_contractBalanceCoversUnclaimed` — the registry's USDC balance
        is always `>= sum(totalPaid - claimed)` across all bills. This is the
        solvency invariant; if it can break, funds are stealable.
  - [ ] `test_invariant_billsAreIndependent` — actions on bill A never change any
        field of bill B. Guards against a storage-collision class of bug.
- [ ] Add an access-control matrix test: for each of `claim`, `collectDebt`,
      `authorizeCollect`, `revokeCollect`, `settle`, assert the unauthorized caller
      reverts with the *specific* expected error. One test per function, no loops —
      a failing loop tells you less than a failing named test.
- [ ] Write the audit note as a NatSpec `@dev` block at the top of the contract,
      extending the existing one: the four new authorization gates, the `_min` cap
      rationale, the fee-on-transfer assumption, the `MAX_BATCH` bound, and the
      unchanged "no owner, no upgrade, no pause, no sweep" guarantee. Scanners and
      human reviewers both read this first.
- [ ] Run `npm run test:contracts` and `npm run audit:contracts`. Both clean.

## Phase 3 — Redeploy and migration

### Task 9: Deploy v2 and re-key the reputation table

**This task contains the landmine.** `schema-reputation.sql:49` has
`unique (wallet_address, bill_id)` on a bare bill id, and v2 restarts at
`nextBillId = 1`. After redeploy, every payment on new bill #1..#N collides with the
v1 rows and ERC-8004 scoring silently stops recording. No error, no log — just a
reputation system that quietly flatlines.

- [ ] Write `schema-agents.sql` (additive, run by hand in the SQL editor per repo
      convention) — see Task 10 for its columns.
- [ ] Add a migration to `schema-reputation.sql`: add `registry_address text not null
      default '<v1 address>'`, drop the old unique, add
      `unique (wallet_address, registry_address, bill_id)`. The default backfills
      existing rows to v1 so history survives.
- [ ] **Backfill recurring rows separately.** `reputation_feedback.bill_id` is a
      shared namespace: bare numeric ids from `BillSplitRegistry` *and*
      `tab:<id>:cycle:<n>` keys written by `recordRecurringPaidFeedback`
      (`lib/erc8004.ts:605`). Backfill `where bill_id like 'tab:%'` to the
      `RecurringTabFactory` address and everything else to the v1 registry. The
      `tab:` prefix is why recurring rows were never exposed to the id-collision
      landmine — only bare ids restart at 1 — but stamping them with a bill-registry
      address they have nothing to do with makes every later query lie.
- [ ] Update `lib/erc8004.ts`: every storage key and every dedupe query includes the
      registry address. The `feedbackHash` preimage becomes
      `keccak256("splitsy:<registry>:<feedbackTag>:<paymentTxHash>")`.
- [ ] `hasFeedbackForBill` and `commitFeedback` gain a registry argument, so **every**
      caller changes — including the recurring path, which is not otherwise in this
      plan. Grep for all four `record*PaidFeedback*` entrypoints before declaring
      Task 9 done; missing the recurring one flatlines tab scoring the same way the
      landmine flatlines bill scoring, and just as silently.
- [ ] Write a TS test asserting the same bill id under two registry addresses
      produces two distinct feedback hashes and two distinct dedupe keys.
- [ ] `schema-onchain-bill-preimages.sql` is already keyed
      `(registry_address, bill_id)` — verify, don't change.
- [ ] Deploy: `npx hardhat run scripts/deploy-bill-split-registry.ts --network arcTestnet`
      with the `production` profile. Record the address.
- [ ] Verify the deployed bytecode matches the `production` build (source verification
      on the explorer). A scanner scoring unverified bytecode scores nothing.
- [ ] Swap `NEXT_PUBLIC_REGISTRY_ADDRESS` (and any server-side twin) to v2. **Leave v1
      readable** — `lib/arc-read.ts` must still resolve v1 bills for history. Add
      `REGISTRY_ADDRESS_V1` and read both when listing.
- [ ] Manual smoke on testnet, in order: create a bill with a due date and
      `escrowUntilFull` → `payDebtFor` from a second wallet → assert `claimable` is 0
      → `authorizeCollect` → warp past due (or use a 2-minute deadline) →
      `collectDebt` → assert escrow released → `settle` with one claim and one pay leg.

### Task 10: Grant storage

Two tables, both additive.

- [ ] `autopay_grants`: `user_id`, `max_per_bill_usdc numeric`, `max_per_day_usdc
      numeric`, `trusted_creators text[]` (lowercase addresses, empty = anyone),
      `min_creator_score int` (0 = off), `require_verified_hash boolean default true`,
      `enabled boolean`, timestamps. One row per user.
- [ ] `dunning_log`: `id`, `registry_address`, `bill_id`, `debtor_address`,
      `action text` (`nudge` | `escalate` | `collect`), `tx_hash`, `created_at`.
      `unique (registry_address, bill_id, debtor_address, action)` for `nudge` and
      `escalate` so a cron retry cannot spam. `collect` rows are append-only (a
      partial collection can legitimately repeat).
- [ ] The daily autopay cap needs a spend ledger: reuse the pattern from
      `lib/x402/spend.ts` (`canSpend`, `remainingBudget`, atomic-unit math) rather
      than inventing a second one.

## Phase 4 — The debtor-side agent (autopay)

### Task 11: `lib/autopay.ts` — pure decision core

Follow the `lib/scout/decide.ts` shape: pure function, injected deps, no I/O, no clock
reads inside. That is what makes it testable and what makes the demo explainable.

- [ ] Write `lib/autopay.test.ts` first, one case per rule:
  - [ ] under the per-bill cap → pay
  - [ ] over the per-bill cap → skip, reason `over_bill_cap`
  - [ ] would breach the daily cap → skip, reason `over_daily_cap`
  - [ ] creator not in `trusted_creators` (non-empty list) → skip, reason `untrusted_creator`
  - [ ] creator's ERC-8004 score below `min_creator_score` → skip, reason `low_creator_score`
  - [ ] `min_creator_score` set and the creator has **no** score yet → pay. A new user
        is not a bad user; treat "no history" as neutral, exactly as the existing
        reputation consent policy does. This is the one rule that fails *open*, and
        it does so because the alternative is an agent that refuses every first-time
        creator forever.
  - [ ] `require_verified_hash` and the recomputed `metadataHash` mismatches the
        on-chain one → skip, reason `hash_mismatch`
  - [ ] no preimage stored at all → skip, reason `unverifiable`. **Fail closed.**
  - [ ] `enabled: false` → skip, reason `disabled`
  - [ ] already fully paid → skip, reason `nothing_owed`
- [ ] Implement `decideAutopay(input): { pay: boolean; amount: bigint; reason: string }`.
      `amount` is always the full remaining share — partial autopay is a rule nobody
      asked for.
- [ ] Reuse `verifyBillPreimage` from `lib/bill-metadata.ts`. Do not re-derive the
      hash by hand.
- [ ] The score comes from `getReputationSummaryForWallets` (`lib/reputation-repo.ts:178`),
      read by the route and *injected* — `decideAutopay` stays pure and clock-free, so
      the score is an input field, never a fetch inside the decision core.
- [ ] Run `node --test --experimental-strip-types lib/autopay.test.ts`.

### Task 12: `app/api/agents/autopay/route.ts`

- [ ] Read `node_modules/next/dist/docs/` for the route-handler and `after()` guides
      before writing this.
- [ ] Trigger: the `contracts.eventLog` branch of `app/api/webhooks/circle/route.ts`
      on `BillCreated`. The existing SCP event monitor already delivers `DebtPaid`;
      add a `BillCreated` monitor and route it here.
- [ ] For each participant of the new bill who has an enabled grant: read `remaining`
      and the stored preimage, call `decideAutopay`, and on `pay` execute
      `approve` + `payDebtFor(billId, debtor, amount)` from **the agent's own DCW** as
      one `executeBatch`.
- [ ] Record the spend against the daily ledger *before* sending, and roll it back on
      failure. A cap that is checked after the money moves is not a cap.
- [ ] Log every decision, pay or skip, with its reason. The skip log is the demo: it
      shows the agent declining a $400 bill because the rule said $50.
- [ ] `after(() => recordPaidFeedbackSafely(...))` with a distinct `feedbackTag`
      `autopaid:bill:<n>` — the existing consent policy says feedback is recorded only
      for a payment *the wallet itself executed*, and an agent paying on your behalf
      is a different act. Keep it positive-only and keep "no history" neutral.
- [ ] Authorize the route with the same `Bearer` pattern as
      `app/api/recurring/settle/route.ts` (`authorize()` at line 192) — this endpoint
      spends money and must never be publicly callable.
- [ ] Idempotency: dedupe on `(registry_address, bill_id, debtor_address)`. A redelivered
      webhook must not pay twice. The contract's `remaining` cap would make the second
      call revert anyway, but do not rely on a revert as your idempotency key.

## Phase 5 — The creditor-side agent (dunning)

### Task 13: `lib/dunning.ts` — pure decision core

- [ ] Write `lib/dunning.test.ts` first:
  - [ ] no due date → `none` (nothing to escalate toward)
  - [ ] 3 days before due, nothing logged → `nudge`
  - [ ] 3 days before due, nudge already logged → `none`
  - [ ] past due, no mandate → `escalate` (a nudge is all we can do)
  - [ ] past due, mandate set, `collectible > 0` → `collect`
  - [ ] past due, mandate set, `collectible == 0` → `escalate`, reason
        `no_funds` — the debtor authorized us but is empty; pulling nothing and
        logging a failure is worse than nudging.
  - [ ] fully paid → `none`
- [ ] Implement `decideDunning(input, now): { action: "none"|"nudge"|"escalate"|"collect"; amount: bigint; reason: string }`.
      `now` is a parameter, never `Date.now()` inside — that is what makes the
      time-travel tests possible.
- [ ] Escalation ladder is exactly two rungs (nudge → escalate) plus collect. Three
      rungs is a product decision nobody has made yet.
- [ ] Run the test.

### Task 14: `app/api/agents/dunning/route.ts` (cron)

- [ ] `vercel.json` currently runs `/api/recurring/settle` at `0 0 * * *`. Add
      `/api/agents/dunning`. Six-hourly (`0 */6 * * *`) is the cadence this wants —
      a 00:00-only cron leaves a debt due at 09:00 uncollected for 15 hours — but
      **Vercel Hobby rejects any cron that fires more than once a day and fails the
      deployment**, so what shipped is `0 12 * * *`. Claim "within a day", never "at
      the deadline"; move to `0 */6 * * *` if the account goes Pro.
- [ ] Reuse `authorize()`'s `Bearer ${CRON_SECRET}` pattern.
- [ ] For every bill the caller's users created that has a non-zero `dueDate` and an
      unpaid participant: read `collectible(billId, debtor)` from chain, call
      `decideDunning`, then act:
  - `nudge` / `escalate` → send email via Resend (the repo's existing sender). **X and
    Discord DMs are not available**: the OAuth scopes here are signin-only and the
    Twitter DM API is gated. Do not plan for them.
  - `collect` → `approve`-free (the debtor's standing approval is the point) single
    `collectDebt` call from the creditor's DCW or EOA.
- [ ] Write the log row before sending, keyed by the unique constraint from Task 10, so
      a cron overlap cannot double-nudge.
- [ ] Reuse the `ignorableSettlementErrors` pattern from `app/api/recurring/settle`:
      `NotYetDue`, `NoCollectMandate`, `NothingCollectible` are expected outcomes in a
      sweep, not failures. Log and continue; anything else fails the run loudly.
- [ ] Reputation for a *pulled* payment gets its own tag `collected:bill:<n>`. Do not
      reuse the voluntary-payment tag — being auto-debited at a deadline is not the
      same signal as paying on time, and conflating them corrupts the score. Consider
      recording it as neutral (no feedback) and note the choice in the code comment.

## Phase 6 — Wire the existing surfaces to v2

### Task 15: Collapse both settle paths onto `settle`

- [ ] `app/api/treasury/settle/route.ts`: replace the hand-built claim/approve/payDebt
      call array with one `approve(total)` + one `settle(claimIds, payIds, amounts)`
      inside the existing `executeBatch`. Keep the pre-flight balance check and the
      `insufficient_funds` 402 — Circle reports an on-chain revert as a bare
      "execution failed", which reads as a bug rather than an empty wallet.
- [ ] `app/HomeClient.tsx:1484` `settleNetWithWallet`: the sequential loop becomes
      `approve` then `settle`. **N+M+1 prompts → 2.** This is the browser-EOA parity win
      and the most visible improvement in the whole plan.
- [ ] `lib/treasury.ts:119` `grossTxCount` currently computes `2 * payLegCount +
      claimBills.length`. Add `batchedTxCount: 2` and surface the comparison. Update the
      existing treasury test.
- [ ] Verify `shouldPayLeg` still gates both paths identically — a mismatch means
      charging someone for a bill they unticked.
- [ ] `lib/arc-read.ts` reads must stay within `batch: { batchSize: 3 }` (the drpc free
      plan rejects more). Adding `dueDate` and `collectMandate` reads means more
      multicalls, not bigger ones.

### Task 16: `app/agents/AgentEconomyPanel.tsx`

- [ ] Three sections: autopay rules (caps, trusted creators, the verified-hash
      toggle), per-bill collect mandates with a visible revoke, and the agent decision
      log showing skips with reasons.
- [ ] Match the existing shadcn token mapping and theme hook — no new design system.
- [ ] The mandate toggle must state plainly what it authorizes: "after the due date,
      <creator> can pull up to your remaining share from your approved balance". A
      consent UI that hides the scope is the actual security bug in this feature.

## Phase 7 — Verification gate

Nothing in this plan is "done" until this phase passes. Evidence before assertions.

- [ ] `npm run test:contracts` — the full v2 suite green, including the 7 original tests.
- [ ] `npm run audit:contracts` — zero un-triaged high or medium findings; every
      suppression carries a reason comment.
- [ ] `node --test --experimental-strip-types lib/autopay.test.ts lib/dunning.test.ts`
      and the existing treasury test — all green.
- [ ] `npm run build` — the Next.js build passes with the new routes.
- [ ] Testnet smoke, recorded: the Task 9 sequence plus one autopay skip (to prove the
      rule engine declines) and one dunning collect.
- [ ] Confirm ERC-8004 scoring still records after redeploy — pay a v2 bill and check
      the row lands with the v2 `registry_address`. This is the Task 9 landmine's only
      real proof.
- [ ] Settle one recurring tab cycle and confirm its feedback row still lands, keyed
      to the factory address. The recurring path is untouched by this plan except
      through Task 9's shared helpers, which is exactly why it is the one that breaks
      unnoticed.

## Recurring tabs: already shipped, deliberately untouched

`RecurringTab` + its factory already do recurring payments, and they do them the same
way this plan does collection: a member's standing USDC approval, a pull capped to
`fixedShare` and to their own allowance and balance, settled by the `0 0 * * *` cron
at `app/api/recurring/settle`. `collectDebt` (Task 4) is deliberately modelled on
`_settleMember` — that is why the `_min` cap has the same shape.

**Nothing in this plan changes `RecurringTab`.** It is a separate contract with its own
address and it holds no reference to `BillSplitRegistry`, so the v2 redeploy cannot
reach it. Existing tabs keep running across the swap. Do not "unify" them: a tab's
membership and shares are immutable at construction, which is the property that makes
anyone-can-settle safe, and folding it into a registry with mutable per-bill state
would forfeit exactly that.

The three real seams, all already handled above:

- **Shared reputation table.** Task 9's re-key touches the recurring path through
  `hasFeedbackForBill`/`commitFeedback`. See the two bullets there.
- **Shared cron file.** Task 14 adds `/api/agents/dunning` alongside the existing
  recurring entry in `vercel.json`; check your plan's cron allowance before assuming
  a second schedule is free.
- **Shared error-swallowing pattern.** Task 14 reuses `ignorableSettlementErrors`
  (`app/api/recurring/settle/route.ts:43`) rather than inventing a second list.

What is *not* covered, and would be new work: **"pay my share on payday"** — a
date-triggered payment of a one-off debt. A tab cannot express it (a tab is a fixed
recurring charge, not a schedule for settling arbitrary bills). It needs no contract
change though, so it can land any time after Phase 3: a `payday_dom` column on
`autopay_grants` and a branch in the dunning cron that re-runs `decideAutopay` for
debts it previously deferred. Deferring it past this plan costs nothing; building it
into Phase 1 costs a wider `createBill`.

## Deliberately not in scope

- **Per-leg `try/catch` in `settle`.** Atomic or nothing.
- **A registry-wide collect allowance.** Per-bill `collectMandate` only. A blanket
  "this creditor may pull from me" is a standing liability nobody should sign.
- **Three-rung escalation, SMS, X/Discord DMs.** Email covers it; the DM APIs are not
  available to these OAuth scopes.
- **Partial autopay.** Full remaining share or nothing.
- **Scheduled ("payday") autopay.** Needs no contract change, so it is not
  redeploy-gated; see the recurring section.
- **Any change to `RecurringTab`.** Separate contract, unaffected by the redeploy.
- **Balance-delta accounting for fee-on-transfer tokens.** The USDC address is
  immutable and known; see Task 7.
- **Any owner, pause, or upgrade hook.** Adding one to "manage" the agents would undo
  the strongest property this contract has.

## Open decisions for the implementer

1. **Reputation for pulled payments** (Task 14): distinct `collected:` tag, or no
   feedback at all. Leaning neutral — an auto-debit is not evidence of good faith. Pick
   one and comment the reasoning; do not leave it ambiguous in code.
2. **Dunning cron cadence**: settled as daily (`0 12 * * *`) — not a preference, a
   Vercel Hobby limit: a more-than-daily cron expression fails the deployment. Six-hourly
   is a plan upgrade away. If the demo needs "instantly at the deadline", that is a
   per-bill scheduled job, not a cron — a bigger change, and worth deferring past the
   hackathon.

## Execution handoff

Two ways to run this:

- **Subagent-driven** (`superpowers:subagent-driven-development`) — one subagent per
  task, in order, with a review checkpoint after Phase 2. Best fit here: the contract
  phases are strictly sequential but Phases 4 and 5 are independent of each other.
- **Inline** (`superpowers:executing-plans`) — I work through it in this session.

Phase 1 → Phase 2 → Phase 3 must be sequential. Phases 4 and 5 can run in parallel
once Phase 3 lands. Phase 6 needs Phase 3. Phase 7 needs everything.
