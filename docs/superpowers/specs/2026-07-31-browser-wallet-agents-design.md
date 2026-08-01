# Browser-wallet agents — design

Date: 2026-07-31
Status: approved, ready for an implementation plan

## Problem

The on-chain autopay mandate landed, and browser-wallet users got none of it.

The mechanism is `app/api/agents/autopay/route.ts:85`. The agent resolves a
debtor to a Splitsy account with `getUsersByWallets`, which matches on
`users.wallet_address` — a column populated only by Circle DCW provisioning. A
browser EOA is not in that table, so the participant loop hits `continue` and
the wallet is never evaluated. Not skipped with a reason: never seen.

The second problem is one the first was hiding. `lib/autopay.ts` is a pure
deterministic function — caps, a score floor, a hash comparison. A standing
mandate plus a webhook running if-statements is verifiable direct debit, which
banks have had since 1968. The on-chain mandate is genuinely the good part, but
it is *substrate for* agents rather than an agent. `lib/scout/decide.ts` is the
same shape: `confidence < 0.8 && canAfford → pay again`. Calling either an agent
is a claim the code does not support, and it is the first thing worth probing.

## Decisions

| Question | Decision | Why |
|---|---|---|
| Can Circle Agent Wallets serve as per-user wallets? | No | They are single-operator: `circle wallet login <email>` + emailed OTP, 7-day session, 2-of-2 MPC, created from a terminal. There is no multi-tenant provisioning path |
| Can the hosted agent become a Circle Agent Wallet? | No | Deployment is Vercel (`vercel.json` crons). Circle CLI is a global npm binary with a session in a home directory; it cannot run in a serverless function |
| Then where does the Circle agent stack fit? | The user runs their own | `AutopayMandate.setMandate(agent, …)` already takes an arbitrary address. A user names their own Circle Agent Wallet and drives it from their own terminal. The 7-day OTP becomes theirs, not production's |
| Where does the EOA↔account link live? | `autopay_grants.debtor_address` | The identity system is load-bearing across the whole app and this has nothing to do with who you are, only which wallet you autopay from |
| Link proof | `personal_sign`, verified statelessly | A claimed address would let anyone attach their own score floor to someone else's wallet and read their decision log |
| EOA signing order | `setMandate`, then `approve` | An EOA has no `executeBatch`. This order makes every partial state safe (below) |
| What makes the hosted path agentic | A model-judged review of the bill's contents | The one question no rule can answer. Bounded absolutely by the mandate, which is the argument the architecture already makes |
| Review failure direction | Fail closed | Matches the stated stance on `require_verified_hash` in `schema-agents.sql`. A model outage must not move money |
| Model provider | Gemini over raw `fetch` | `lib/ocr-core.ts` already does exactly this with `RECEIPT_SCANNER_API_KEY`. No new dependency |

## Architecture

Two operators, one mandate contract. The contract does not know or care which
is calling.

```
                       AutopayMandate.sol  (unchanged, not redeployed)
                        mandates[debtor].agent
                                 │
              ┌──────────────────┴───────────────────┐
              │                                      │
     agent == Splitsy's DCW                agent == user's Circle Agent Wallet
              │                                      │
   BillCreated ──(SCP monitor)──> webhook   user's terminal, on their schedule
              │                                      │
   POST /api/agents/autopay                 GET /api/agents/skill   (how)
     1. deterministic rules                 GET /api/agents/queue   (what)
        (lib/autopay.ts)                            │
     2. model review                        the model decides
        (lib/autopay-review.ts)                     │
              │                             circle wallet execute
              ▼                                     ▼
                    AutopayMandate.payFor(billId, debtor)
                                 │
                    usdc.transferFrom(debtor → mandate)
                    registry.payDebtFor(...)  ──> DebtPaid
```

`app/api/agents/autopay/route.ts:136` already compares the mandate's agent
against Splitsy's own. A user who names their own agent wallet therefore makes
the hosted agent stand down automatically — no flag and no opt-out field. That
check was written for a different reason and turns out to be the whole routing
rule.

### Standing down must be silent

One correction is needed to make it so. Today a foreign agent yields
`grant = null`, `decideAutopay` returns `disabled`, and `claimAutopayDecision`
writes a skip row (`route.ts:137-196`). A BYO user's decision log would fill with
"Autopay is off" for every bill — which is false. Autopay is on; it is simply not
ours.

So `settleOne` returns `null` before claiming when a mandate exists and names an
agent that is not this one, exactly as `route.ts:88` already does for a
participant with no Splitsy account. The two cases stay distinct:

| State | Behaviour |
|---|---|
| No mandate at all | `disabled` skip row. Correct — autopay really is off |
| Mandate naming another agent | No row. Not this agent's business |
| Mandate naming us | Evaluated as today |

The BYO path is the headline. It is a model with tools deciding to spend money,
which is what an agent is; the hosted path is a policy engine with one genuine
judgment step bolted on. Both are honest descriptions and the docs should use
them.

## The EOA↔account link

```sql
alter table autopay_grants add column if not exists debtor_address text;
create unique index if not exists autopay_grants_debtor_idx
  on autopay_grants (debtor_address) where debtor_address is not null;
```

One nullable column, one partial unique index. `users` is untouched.

`autopay_grants.user_id` stays the primary key, so one row per person covers
both their DCW and their linked EOA. That is correct: `min_creator_score`,
`require_verified_hash` and the new `require_bill_review` are preferences about
a *person*. The caps are not shared — they live per-debtor in `AutopayMandate`,
so the two wallets can carry different ceilings, and the panel must show that
rather than implying one setting binds both.

The unique index is what stops two accounts claiming the same address and making
the debtor→user lookup ambiguous.

### `POST /api/agents/link`

Body `{ address, signature }` over exactly:

```
Splitsy: link <address> to @<handle> for autopay
<ISO-8601 timestamp>
```

The server recovers the signer with viem's `verifyMessage`, requires it to equal
`address`, requires the timestamp within 5 minutes, and writes the column.

No nonce table. A replayed signature needs the victim's session cookie *and*
produces an identical result, so the state a replay can reach is the state that
already exists. Storing nonces would buy nothing and cost a table.

`DELETE` on the same route clears the column. Unlinking must never be harder than
linking, for the same reason the settings panel is not behind the wallet-unlock
cookie.

### Debtor → user resolution

`app/api/agents/autopay/route.ts:85` becomes the union of two lookups: the
existing `getUsersByWallets` (DCW addresses) and a new
`getGrantsByDebtorAddresses` in `lib/agents-repo.ts` (linked EOAs). Everything
downstream in `settleOne` is already keyed on `(userId, debtor)` and does not
change.

## Client-side mandate signing

`SettlementAgentsPanel` already renders under `WagmiProviders`
(`app/layout.tsx:120`), so wagmi hooks work in it directly.

### Two selectors on section 01

**Which wallet am I arming?** Splitsy wallet (`user.wallet_address`) or the
connected browser wallet. One piece of state; every read and write below it
targets that address. Both can be armed at once with different ceilings.

**Who is my agent?** "Splitsy's agent (hosted)" or "My own agent wallet" with an
address field. That value is the first argument to `setMandate`, so it costs one
input and no server logic.

The copy must warn that naming an address you do not control silently disables
autopay: nothing can call `payFor`, so nothing happens and there is no error to
see. A silent failure needs a sentence in the UI, because it cannot produce a
log row.

### Signing splits by wallet type

The DCW path is untouched: `PUT /api/agents/grants` saves on blur and
`syncMandateOnchain` batches `approve` + `setMandate` server-side.

For an EOA, `PUT` gains an optional `debtorAddress`. When it matches the linked
browser wallet the route writes Postgres and returns `txHash: null` without
signing anything, because the server holds no key for that wallet.

The chain half then needs an explicit **"Arm on chain"** button. An EOA has no
`executeBatch`, so it is two transactions, and two wallet popups on every input
blur would be intolerable. The panel therefore carries two interaction models —
DCW auto-syncs on blur, EOA is explicit. Each is right for its wallet, and
leaving the working DCW path alone is cheaper than unifying them.

### Order: `setMandate`, then `approve`

The reverse of the DCW batch, deliberately. Without atomicity one transaction
can land alone, and this order makes every partial state safe:

- `setMandate` alone → `payFor` reverts inside `safeTransferFrom`. No money moves.
- Lowering caps → the tighter ceiling binds before the allowance is topped up.
- Raising caps → the old allowance still bounds total exposure until the second lands.

Approve-first would open a window with a freshly topped-up allowance sitting
under the old, looser caps.

### Revoke

One transaction, `revokeMandate()`, matching the DCW path. The residual approval
is inert: `payFor` is the only function that can spend it and it reverts with
`NoMandate`. The panel says so rather than spending a second popup zeroing it.

### GET

The `onchain` block currently describes `user.wallet_address` alone. It becomes
keyed by address so the panel can render both wallets' mandates side by side.

## Model-judged bill review

`lib/autopay-review.ts`, called from `settleOne` **only after** `decideAutopay`
returns `pay`. Rules are free and the model is not, so a bill already rejected by
a cap never costs a call.

Inputs are all in hand at that point: the preimage's merchant and line items, the
debtor's share, the participant count, the creator's score. Output is
`{ approve: boolean, reason: string }` — Gemini, JSON mode, `temperature: 0`,
raw `fetch`, `RECEIPT_SCANNER_API_KEY`, exactly as `lib/ocr-core.ts` does it.

It answers the one question no rule can: **is this bill coherent, and is my share
proportionate to what is attributed to me?** `require_verified_hash` proves only
that the preimage recomputes to the on-chain `metadataHash`. It says nothing
about whether the contents are reasonable.

### Fail closed

A timeout, a quota error, or unparseable output skips with reason
`review_unavailable`. This matches the stance `schema-agents.sql` already states
for `require_verified_hash`, and it is the right direction for money leaving a
wallet.

### The model's sentence is the log entry

It goes straight into `autopay_log.reason`. No new slug and no schema change:
`app/SettlementAgentsPanel.tsx:60` already falls back to rendering an unmapped
reason verbatim. `review_unavailable` is added to the `REASONS` map as a real
slug; the model's prose is not, by design.

This is also what makes the decision log worth reading. `over_bill_cap` is a
number comparison anyone can dismiss. *"The receipt lists two mains but you are
charged for four, and this creator has no history with you"* is not.

### Toggle

`require_bill_review boolean not null default true` on `autopay_grants`, and one
checkbox beside `require_verified_hash`. Default on, for the same reason that one
is.

### Cost ceiling

One call per debtor per bill, for participants who have a live mandate and passed
every deterministic rule — few in practice. A ten-person bill with ten live
mandates is ten calls. Mark it with a `ponytail:` comment naming one-call-per-bill
batching as the upgrade path if it ever matters.

## Discovery for a self-run agent

### `GET /api/agents/queue?debtor=0x…`

Public, read-only, unauthenticated. Returns the mandate state plus, per payable
bill: amount, creator, creator score, verified flag, and the preimage.

Built from `getBillIdsForParticipantOnchain` and `getMandateSpendableOnchain`,
filtered to `spendable > 0`, enriched with `getReputationSummaryForWallets` and
`getOnchainBillPreimage`.

**On the lack of auth:** every field is already public. The registry is readable
on chain by anyone and `/api/onchain-bills/preimage` already serves preimages.
This adds no exposure — but an unauthenticated endpoint keyed by an address in a
query string invites the question, so the answer belongs in the route's header
comment rather than in a reviewer's imagination.

Auth would also defeat the purpose: the endpoint exists so an agent the user runs
on their own machine, holding no Splitsy session, can find work.

### `GET /api/agents/skill`

`text/markdown`, templated with the live `MANDATE_ADDRESS` and queue URL, in the
shape Circle's own skills use (`https://agents.circle.com/skills/*.md`). It
teaches an agent to read the queue, apply its own judgment over score, verified
flag and line items, and then:

```
circle wallet execute "payFor(uint256,address)" <billId> <debtor> \
  --contract <MANDATE_ADDRESS> --chain ARC-TESTNET --address <yourAgentWallet>
```

Templating rather than a static file in `public/` because the mandate address is
environment-dependent, and a skill file naming a stale contract is worse than no
skill file.

## To verify, not assume

In the style of the Gas Station note in the previous design — each of these is
expected to hold, and none is confirmed:

1. `circle wallet execute` accepts a `uint256` and an `address` argument for a
   `--type agent` wallet on `ARC-TESTNET`.
2. Agent-wallet gas sponsorship covers a contract write on Arc Testnet. Fallback:
   `circle wallet fund --address <addr> --chain ARC-TESTNET`, which draws 20 USDC
   from the Circle faucet.
3. `circle wallet limit` is **mainnet-only**. If so, Circle-side spend policy does
   nothing on Arc Testnet and `AutopayMandate` is the only thing enforcing. This
   goes in the docs plainly. Glossing it is precisely what a reviewer would catch,
   and the on-chain mandate is a stronger claim than the Circle policy anyway.

Record the outcome of each in the relevant file rather than leaving the
assumption in place.

## Off-chain changes

| File | Change |
|---|---|
| `schema-agents.sql` | `debtor_address` column + partial unique index; `require_bill_review` column; comment covering both |
| `lib/agents-repo.ts` | `getGrantsByDebtorAddresses`, `setGrantDebtorAddress`, `require_bill_review` through the existing upsert |
| `app/api/agents/link/route.ts` | New. `POST` verifies a `personal_sign` and links; `DELETE` unlinks |
| `app/api/agents/grants/route.ts` | `PUT` accepts `debtorAddress` and skips server signing for it; `GET` returns `onchain` keyed by address |
| `app/api/agents/autopay/route.ts` | Debtor→user lookup becomes a union; `settleOne` returns null for a foreign agent instead of logging `disabled`; the model review runs after `decideAutopay` returns `pay` |
| `lib/autopay-review.ts` | New. Gemini review, fails closed |
| `lib/autopay-review.test.ts` | New |
| `lib/autopay.ts` | **Unchanged.** The deterministic core and `lib/autopay.test.ts` stand as they are |
| `app/api/agents/queue/route.ts` | New. Public payable-bill feed |
| `app/api/agents/skill/route.ts` | New. Templated markdown |
| `app/SettlementAgentsPanel.tsx` | Wallet selector, agent selector, link button, "Arm on chain", `require_bill_review` checkbox, per-wallet on-chain facts |
| `docs/` | The BYO walkthrough, and the mainnet-only policy caveat |

No contract change. No registry redeploy. No SCP monitor re-run.

## Testing

New:

- `lib/autopay-review.test.ts` — malformed JSON fails closed; `approve: false`
  skips carrying the model's sentence; `approve: true` passes through.
- Link route — a signature from the wrong signer is rejected; a timestamp older
  than 5 minutes is rejected; a valid pair writes the column.
- Queue route — only bills with `spendable > 0` are returned.
- Autopay route — a mandate naming a foreign agent writes no `autopay_log` row,
  while an absent mandate still writes `disabled`.

Unchanged and still required: `npm run test:agents`, `npm run test:contracts`.
The contract does not change, so `AutopayMandate.t.sol` needs no additions.

End-to-end, both operators against the same contract:

1. Link a browser wallet, arm a mandate naming Splitsy's agent, have a second
   account bill it. The hosted agent pays. Confirm `MandateSpent` and a `pay` row.
2. Re-arm naming a Circle Agent Wallet. Bill it again. The hosted agent writes no
   row at all — it stood down at `route.ts:136`, and specifically did *not* log a
   misleading `disabled`. Run the CLI agent against `/api/agents/queue` and watch
   it pay.
3. Bill it with a receipt whose line items do not support the share. Confirm the
   skip row carries the model's sentence.

## Demo narrative

1. The mandate on a block explorer: caps, agent address, allowance.
2. A bill arrives. The hosted agent pays it unattended.
3. A bill arrives whose receipt does not support the share. The agent declines,
   in a sentence, in the log.
4. Change the mandate's agent to a Circle Agent Wallet. Splitsy's agent goes
   quiet. The user's own agent — an LLM with the Circle skills installed — reads
   the queue, decides, and calls `circle wallet execute`.
5. Call `payFor` from any other wallet. It reverts. The caps were never the
   server's.

## Out of scope

- Batching the model review to one call per bill.
- More than one linked EOA per account.
- Mainnet, and therefore `circle wallet limit` policies.
- Moving the creator-score floor on chain.
- Any change to `collectMandate` / `collectDebt`.
