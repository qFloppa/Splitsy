# Agent Economy — Per-User Agents, ERC-8004 Identity, ERC-8183 Jobs

**Status:** design, approved for planning
**Date:** 2026-08-01
**Supersedes nothing.** Extends `2026-07-30-onchain-autopay-mandate-design.md` and
`2026-07-31-browser-wallet-agents-design.md`; both stay true.

---

## 1. The problem

Autopay today is correct and boring. A user signs a mandate, `AutopayMandate.sol`
holds the ceilings, and a server route calls `payFor`. Nothing about that reads as
an *agent*: the thing that spends is an unnamed address with no on-chain identity,
no balance of its own, no income, and no visible decisions. It is verifiable direct
debit with a cron trigger, and it cannot be presented as an agentic economy because
it is not one.

The security model is not the problem and does not change. Every agent that spends
someone's money needs a spending permission first, including Circle's own Agent
Wallets. What is missing is that the agent is **invisible and has no economics**.

Compare the two agents already in the repo:

| | Scout | Autopay agent |
|---|---|---|
| ERC-8004 identity | yes, token id in `SCOUT_ERC8004_TOKEN_ID` | none |
| Own wallet with a balance | yes, Gateway deposit | none, holds no float |
| Pays other agents | yes, x402 | no |
| Earns | no | no |

## 2. What we are building

Three changes, in one coherent story.

1. **Every user owns an agent.** A Circle DCW, with an ERC-8004 identity NFT that is
   transferred to the user. The user funds it. It is theirs.
2. **Every settlement is an ERC-8183 job** on Arc's deployed reference contract:
   posted, escrowed, delivered, independently evaluated on chain, and paid.
3. **Agents pay agents.** The Settler buys each bill review from the Auditor over
   x402, out of the fee income it has accumulated from earlier jobs.

The resulting money flow:

```
  user
   │  USDC top-up (manual, once)
   ▼
 user's agent  ──── ERC-8183 escrow, $0.01 / settlement ────▶  Splitsy Settler
   │                                                              │
   │  (Funded mode) bill share                                    │ x402
   │                                                              │  $0.002 / review
   ▼                                                              ▼
 BillSplitRegistry ◀── (Mandate mode) bill share ── AutopayMandate   Splitsy Auditor
```

Three payment rails, all official Circle/Arc: ERC-8183 on-chain escrow, x402
nanopayments, direct USDC settlement.

### Why not Circle Agent Wallets

Circle Agent Wallets (`circle wallet --type agent`) are provisioned by **email-OTP
login in a CLI** and the session **expires after 7 days**. There is no server-side
path to create one per user, so they cannot back a hosted per-user agent. Circle
DCWs with `accountType: "SCA"` are real smart-contract accounts on Arc and are the
correct official primitive here.

The existing "bring your own Circle Agent Wallet" path in `docs/autopay-agent.md`
stays exactly as it is — a self-hosting user can still name their own agent in the
mandate, and Splitsy still writes no log row for them.

### What does not change

The trigger. A `BillCreated` event still reaches a per-registry-address Circle SCP
monitor, which still POSTs `/api/webhooks/circle`, which still calls
`/api/agents/autopay` behind the same `AGENT_SECRET`. None of that is rebuilt.

`decideAutopay` in `lib/autopay.ts` stays a pure function and keeps its current
signature. `reviewBill` in `lib/autopay-review.ts` keeps its current logic. The
public agent queue (`/api/agents/queue`) and skill file (`/api/agents/skill`) keep
serving self-hosting operators unchanged.

## 3. The agents

| Agent | Wallet | Identity | Role |
|---|---|---|---|
| **User's agent** | Circle DCW, `refId: "agent:<userId>"` | ERC-8004 NFT, **transferred to the user** | holds the operating balance; client on every job; in Funded mode it also pays the bill share |
| **Splitsy Settler** | **raw EOA**, `SETTLER_PRIVATE_KEY` | ERC-8004 NFT | provider on every job; makes the decision in both modes and signs the settlement in Mandate mode; earns the fee; buys reviews over x402 |
| **Splitsy Auditor** | Circle DCW, `refId: "splitsy:auditor"` | ERC-8004 NFT | sells bill review over x402; evaluator on every job |
| Scout | EOA, unchanged | already registered | unchanged |
| reputation-validator, reputation-registrar | DCW, unchanged | n/a | unchanged |

Three distinct wallets on every job — client, provider, evaluator — so nobody
grades their own work. This mirrors the existing ERC-8004 rule that the validator
and registrar must be distinct from the payer.

**The Settler must be an EOA**, not a DCW, because x402 requires a raw key to sign
EIP-3009/EIP-712 authorizations (`GatewayClient` from `@circle-fin/x402-batching`).
One key signs both its ERC-8183 contract writes (via viem) and its x402 payments.
This follows the Scout precedent in `lib/scout/wallet.ts`.

> **Migration cost, stated plainly:** the Settler's address replaces today's
> `splitsy:autopay-agent` DCW as the address named in mandates. **Every existing
> user must re-arm their mandate**, exactly as they must after a mandate-contract
> redeploy. On testnet this is acceptable; it must be in the release notes.

Registration reuses `ensureAgent()` and `uploadMetadataToIPFS()` in `lib/erc8004.ts`
without change. The user's agent is minted by the existing registrar wallet and
transferred to the user's main wallet — the `minterAddress` branch of `ensureAgent`
already does exactly this for browser payers.

Metadata `agent_type` values: `splitsy-settler`, `splitsy-auditor`,
`splitsy-user-agent`. Existing payer agents keep `splitsy-payer`.

## 4. Funding: one wallet, one screen

**Every user must fund their agent before autopay can run, in both money modes.**
This is a real product change — today Mandate mode needs no funding — and it is
accepted deliberately. The agent needs USDC for its own gas (Arc charges gas in
USDC) and for the job fee it escrows.

The agent's USDC approval to the job contract is sent **lazily, immediately before
the first `fund()`, and only when `allowance(agent, AGENTIC_COMMERCE) == 0`.** Not
on top-up: a top-up is an inbound transfer the agent cannot hook. Not at wallet
creation either: `approve` costs gas, and a wallet with no balance cannot pay it.
Checking the allowance rather than a database flag makes it self-healing — if the
approval is ever spent down or the row is lost, the next settlement re-sends it.

An agent whose balance cannot cover the fee plus gas skips with the reason
**`agent_unfunded`** and creates no job. This is the most likely real-world failure
and it gets its own slug so the user is told what to fix, rather than seeing
`tx_failed`.

The agent's balance **is** the cap in Funded mode. An agent holding 5 USDC can never
spend 6. That is a simpler and more honest ceiling than a mandate, and it needs no
contract.

Recommended starting balance shown in the UI: **2 USDC** for Mandate mode (gas +
fees only), **20 USDC** for Funded mode (gas + fees + bill money).

## 5. Two money modes

The user picks where **bill money** comes from. Both modes need the funded agent
above; they differ only in who pays the share.

| Mode | Bill money from | Settlement call | Signer | New Solidity |
|---|---|---|---|---|
| **Mandate** (existing) | the user's own wallet | `AutopayMandate.payFor(billId, debtor)` | Settler | none |
| **Funded** (new) | the agent's own balance | `BillSplitRegistry.payDebtFor(billId, debtor, amount)` | user's agent | none |

`payDebtFor` already pulls from `msg.sender` and credits `debtor`, and already emits
`DebtPaid` with the **debtor** as payer — verified in `contracts/AuditProbe.t.sol`
and relied on by `lib/erc8004.ts`. So reputation keeps flowing to the user, not the
agent, with no change to the scoring path.

**Zero contract changes in this design.** No redeploy of `BillSplitRegistry`, no
redeploy of `AutopayMandate`, no new Solidity file.

Mode is stored per user in `autopay_grants.money_mode text not null default
'mandate' check (money_mode in ('mandate','funded'))`.

In Funded mode the on-chain caps in `AutopayMandate` do not bind, because the
mandate is not in the path. The off-chain rules still do: per-bill cap, daily cap,
creator allowlist, score floor and verified hash are all evaluated by
`decideAutopay` against the Postgres mirror instead of against the chain.

`decideAutopay` itself does **not** learn about modes. It stays pure and keeps its
signature — only its *input* changes. A new pure helper alongside it decides where
that input comes from:

```ts
buildGrant(mode, mandateFromChain, rulesFromPostgres): AutopayGrant | null
```

`'mandate'` sources the caps from the chain exactly as today; `'funded'` sources
them from the mirror. This is the one piece of new branching logic in the design and
it is a pure function, so it is unit-testable without a network.

The weakening is genuine and must be said in the UI in one sentence: *"In this mode
your limits are enforced by Splitsy, not by the chain. Your agent's balance is the
only limit the chain enforces."*

## 6. The ERC-8183 job

Contract: `0x0747EEf0706327138c69792bF28Cd525089e4583` (AgenticCommerce reference
implementation, Arc Testnet). Statuses: `Open(0) Funded(1) Submitted(2)
Completed(3) Rejected(4) Expired(5)`.

| Role | Who |
|---|---|
| client | the user's agent |
| provider | Splitsy Settler |
| evaluator | Splitsy Auditor |
| budget | `SETTLEMENT_FEE_USDC`, default `0.01` |
| description | `Splitsy: settle bill <billId> share for <debtor>` |
| deliverable | `keccak256(settlementTxHash)` |
| expiredAt | `block.timestamp + 3600` |
| hook | `address(0)` |

### Order of operations

```
0. decide            lib/autopay.ts rules, then the paid Auditor review (§7)
                     any 'skip' → STOP. No job is created. 0 transactions.
1. createJob         user's agent
2. setBudget         Settler                     ← provider sets the price
3. fund              user's agent                → 0.01 USDC into escrow
4. settle            payFor (Settler) | payDebtFor (user's agent)
5. submit            Settler                     → keccak256(settlement tx)
6. complete          Auditor, after reading getParticipant(billId, debtor)
                     on chain and confirming paid >= owed
                     → escrow releases 0.01 to the Settler
```

Six transactions, **all signed by wallets the server controls**. The user gets no
prompt at settlement time. The user signs only at setup: two signatures for a
browser-wallet mandate (`setMandate`, `approve`), or one USDC transfer to fund the
agent.

**Idempotency does not change.** `claimAutopayDecision` still writes its row on the
unique `(registry, bill, debtor)` key *before* anything moves, so a redelivered
`BillCreated` webhook loses the race and creates no second job. The claim is taken
at step 0, before `createJob`, so a duplicate delivery cannot even open a job — the
existing lock covers the new ceremony without being widened.

### Why the job is created before the work

Escrow is locked before the Settler does anything, which is the honest lifecycle
order. The risk this creates is bounded: **escrow only ever holds the fee, never the
bill money.** If step 4 fails, the job sits `Funded`, expires an hour later, and at
worst 0.01 USDC of the user's agent balance is stranded. The bill money is never at
risk in either ordering, which is what makes job-first affordable.

See §12 Q3 — whether `Expired` refunds the client is unverified.

### Step 6 is not a rubber stamp

The Auditor calls `complete` only after an `eth_call` to
`BillSplitRegistry.getParticipant(billId, debtor)` returns `paid >= owed`. If the
debt is not really settled it does not complete, the job expires, and the Settler is
not paid. This is what separates a job market from theatre, and it is the single
most important line in this design.

### Cost

6 transactions **per settled share**, not per bill. A bill with 4 autopaying
participants costs 4 jobs, 24 transactions.

Goes in `app/api/agents/autopay/route.ts`:

```
// ponytail: 6 tx per settled share, 24 for a 4-person bill. Accepted while Arc
// gas is sub-cent USDC. If it hurts: investigate Circle SCA batch execution to
// fold createJob+fund and setBudget+submit into single user-ops.
```

Nothing else changes cost:

| Event | Extra transactions |
|---|---|
| bill created | 0 |
| paid manually in the app | 0 |
| autopay off | 0 |
| autopay on, agent **skips** | 0 |
| autopay on, agent **pays** | 6 |

## 7. The paid bill review (x402)

`lib/autopay-review.ts` is today a free internal function call. It becomes a paid
endpoint the Auditor sells and the Settler buys.

- **New route** `POST /api/agents/review`, wrapped in the existing `withGateway()`.
- **Price** `$0.002`, added to `PRICES` in `lib/x402/pricing.ts`.
- **Body** the same input `reviewBill()` takes today: preimage, share, participant
  count, creator score.
- **Response** the same verdict shape: `{ approve: boolean, reason: string }`.
- **Buyer** the Settler, via a `GatewayClient` built from `SETTLER_PRIVATE_KEY`,
  mirroring `lib/scout/wallet.ts` including its re-deposit helper.
- **Ledger** both sides land in `x402_payments` automatically — `earned` by the
  seller wrapper, `spent` recorded by the Settler.

**One change to `withGateway`:** it currently always pays `SELLER_ADDRESS`. It gains
an optional fourth parameter `payTo` defaulting to `SELLER_ADDRESS`, so the Auditor
receives its own earnings at its own address. `/api/ocr` and `/api/fx` pass nothing
and keep paying the treasury exactly as now. The Auditor's address is resolved once
per process from `getOrCreateArcWallet("splitsy", "auditor")`, the same lazy pattern
the validator and registrar already use.

**Both sides run in the same Next.js process, and that is fine.** The Settler calls
`/api/agents/review` over HTTP with an x402 payment header, exactly as Scout already
calls `/api/ocr`. The payment is real — Circle Gateway verifies and settles it
between two distinct addresses — and the loopback is the existing, proven shape in
this repo, not a shortcut invented here. The URL comes from `NEXT_PUBLIC_BASE_URL`,
as Scout's does.

Failure behaviour is unchanged from today and still **fails closed**: any error —
402, timeout, unparseable verdict, missing key, *and now also an x402 settlement
failure* — is a refusal with slug `review_unavailable`, logged, and no job is
created. A Settler that cannot pay for a review does not settle anything.

`reviewBill()` itself is not rewritten. The route is a thin wrapper around it, and
the Settler calls the route instead of the function.

The route is **public to anyone who pays**, like `/api/ocr` and `/api/fx`, and that
is intended — it is a service the Auditor sells. It leaks nothing: every field it
judges arrives in the request body from the caller, so a stranger who pays $0.002
gets a verdict on their own data and learns nothing about Splitsy's.

## 8. Data model

No new table. Three additive columns on `autopay_log`, whose existing unique key
`(registry_address, bill_id, debtor_address)` already serves as the idempotency
lock:

```sql
alter table autopay_log add column if not exists job_id      text;
alter table autopay_log add column if not exists job_status  text;
alter table autopay_log add column if not exists fee_usdc    numeric(20,6) not null default 0;
```

`job_status` mirrors the chain for display only: `open | funded | submitted |
completed | expired | failed`. The chain is authoritative; `getJob(jobId)` is the
source of truth and the UI refetches it.

One additive column on `autopay_grants`:

```sql
alter table autopay_grants add column if not exists money_mode text not null default 'mandate'
  check (money_mode in ('mandate','funded'));
```

One additive column on `users`, so the agent wallet is not re-derived on every
request:

```sql
alter table users add column if not exists agent_wallet_address text;
alter table users add column if not exists agent_wallet_id      text;
```

All of this goes in a new standalone `schema-agent-economy.sql`, matching the
repo's existing additive-script convention.

## 9. New and changed files

**New**

| File | Purpose |
|---|---|
| `lib/erc8183.ts` | ABI, calldata encoders for the five calls, `JobCreated` parsing, `getJob` read, status enum |
| `lib/settler.ts` | the Settler EOA: viem wallet client for contract writes + `GatewayClient` for x402, mirroring `lib/scout/wallet.ts` |
| `lib/user-agent.ts` | get-or-create the per-user agent wallet, its ERC-8004 identity, its balance, and its one-time USDC approval |
| `app/api/agents/review/route.ts` | the Auditor's paid review endpoint |
| `app/api/agents/wallet/route.ts` | GET the user's agent (address, identity token id, balance); the UI card reads this |
| `scripts/settler-setup.ts` | generate the Settler key, register its ERC-8004 identity, make its first Gateway deposit — modelled on `scripts/scout-setup.ts` |
| `schema-agent-economy.sql` | the columns in §8 |
| `docs/agent-economy.md` | operator documentation, in the shape of `docs/autopay-agent.md` |

**Changed**

| File | Change |
|---|---|
| `app/api/agents/autopay/route.ts` | job lifecycle around the settlement; Funded-mode branch; Settler replaces the DCW agent; buys the review over HTTP instead of calling `reviewBill` directly |
| `lib/autopay.ts` | add the pure `buildGrant` helper from §5. `decideAutopay` untouched |
| `lib/x402/seller.ts` | optional `payTo` parameter |
| `lib/x402/pricing.ts` | add `/api/agents/review: "$0.002"` |
| `lib/agents-repo.ts` | write `job_id`, `job_status`, `fee_usdc`; read/write `money_mode` |
| `app/…` settlement-agents panel | mode picker, agent card, fund flow, job list |
| `docs/autopay-agent.md` | point at the new agent address and the new funding requirement |

## 10. UI

One new card in the existing settlement-agents panel: **Your agent**.

- address, with an Arcscan link
- its ERC-8004 identity NFT, with a link
- USDC balance, and a **Fund** button
- the money-mode picker (Mandate / Funded), with the one-sentence warning from §5
- its jobs: bill, fee, status chip, and every transaction hash

The existing decision log stays where it is. A `pay` row now also shows its job id
and status; a `skip` row is unchanged and still shows the model's own sentence
verbatim.

## 11. Testing

Pure logic gets unit tests, matching the repo's existing pattern (`lib/autopay.test.ts`,
`lib/scout/decide.test.ts`):

- `lib/erc8183.test.ts` — calldata encoding for all five calls, `JobCreated` topic
  decoding, status-enum mapping, and one assertion that
  `deliverableHash === keccak256(settlementTxHash)`, because that binding is what
  the Auditor's evaluation rests on.
- `lib/autopay.test.ts` — extend for `buildGrant`: `'mandate'` takes the chain's
  caps and ignores the mirror; `'funded'` takes the mirror's and still refuses when
  they are exceeded; both return `null` when autopay is off.

Everything else is network-bound and is covered by the manual checks in §12 rather
than by mocks.

## 12. Open questions — UNVERIFIED

None of these has been executed. Each is written as a command a human can run.

**Q1 — Does `setBudget` accept a call from the provider while the job is `Open`?**
The tutorial's order is createJob → setBudget → approve → fund. Run it as written.
*If setBudget must precede something else,* reorder §6 steps 2 and 3.

**Q2 — Can the evaluator `complete` a job it is not the client of?**
The tutorial uses one wallet as both client and evaluator. This design uses three
distinct wallets. *If `complete` requires the evaluator to also be the client,* make
the user's agent the evaluator and have the Settler submit only after the Auditor
has confirmed on chain — the check still happens, just one step earlier.

**Q3 — Does an `Expired` job return the escrow to the client?**
Fund a job, let it pass `expiredAt` without submitting, then read the client's
balance. *If escrow is not returned,* say so in `docs/agent-economy.md` and shorten
`expiredAt` to 15 minutes to bound how long a stranded fee is invisible.

**Q4 — Does a raw EOA pay gas in USDC on Arc without a native balance?**
Send a contract write from the Settler holding only USDC.
*If it fails,* the Settler needs a native balance and `scripts/settler-setup.ts`
must fund it.

**Q5 — End-to-end, Mandate mode.**
Re-arm a mandate naming the Settler, fund the agent with 2 USDC, have a second
account bill it. Expect: a job reaching `Completed`, the Settler's USDC up by
~0.01 minus gas, the Auditor's up by 0.002, one `pay` row carrying a job id.

**Q6 — End-to-end, Funded mode.**
Switch to Funded, fund the agent with 20 USDC, bill it. Expect: the share paid by
`payDebtFor` from the agent, a `DebtPaid` naming the **user** as payer, reputation
scored to the user and not to the agent, and the job completed.

**Q7 — The Auditor refuses.**
Create an incoherent bill. Expect: `review_unavailable` or the model's sentence in
the log, **no job created at all**, and one `spent` row in `x402_payments` — the
review was bought and its answer was no.

## 13. Deliberately not doing

- **No new Solidity.** Everything runs on already-deployed contracts.
- **No batching.** 24 transactions for a 4-person bill is accepted; see the
  `ponytail:` note in §6.
- **No per-user x402 keys.** Only the Settler buys reviews, so Splitsy never holds a
  raw key per user.
- **No on-chain skip log.** Skips stay in Postgres. Paying gas to record a
  non-payment buys nothing.
- **No fee split, no dynamic pricing, no agent marketplace.** One fee, one price,
  two Splitsy agents.
- **Circle Agent Wallets stay out of the hosted path** for the reason in §2, and stay
  supported for self-hosting users exactly as documented today.

## 14. Arc Testnet constants

| Name | Value |
|---|---|
| Network CAIP-2 | `eip155:5042002` |
| USDC | `0x3600000000000000000000000000000000000000` |
| AgenticCommerce (ERC-8183) | `0x0747EEf0706327138c69792bF28Cd525089e4583` |
| ERC-8004 IdentityRegistry | `0x8004A818BFB912233c491871b3d84c89A494BD9e` |
| ERC-8004 ReputationRegistry | `0x8004B663056A597Dffe9eCcC1965A193B7388713` |
| Gateway Wallet | `0x0077777d7EBA4688BDeF3E311b846F25870A19B9` |
| RPC | `https://rpc.testnet.arc.network` |
| Explorer | `https://testnet.arcscan.app` |

## 15. Environment

```ini
SETTLER_PRIVATE_KEY=0x…              # required. the Settler EOA; x402 + ERC-8183 signer
NEXT_PUBLIC_AGENTIC_COMMERCE_ADDRESS=0x0747EEf0706327138c69792bF28Cd525089e4583
SETTLEMENT_FEE_USDC=0.01             # optional, default 0.01
SETTLER_ERC8004_TOKEN_ID=…           # optional, DISPLAY ONLY (see below)
AUDITOR_ERC8004_TOKEN_ID=…           # optional, DISPLAY ONLY (see below)
```

The two token-id variables are a convenience for the UI only, matching how
`SCOUT_ERC8004_TOKEN_ID` is used today. Nothing in the settlement path reads them:
identity is resolved from `reputation_agents` via `getAgentByWallet`, which is
already the authoritative mapping and already survives a redeploy. If they are unset
the identity links simply come from the database instead.

Unset `NEXT_PUBLIC_AGENTIC_COMMERCE_ADDRESS` or `SETTLER_PRIVATE_KEY` reads as
**autopay off**, matching how an unset mandate address already behaves. It is never
"run without the job".
