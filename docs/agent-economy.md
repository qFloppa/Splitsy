# The Agent Economy — ERC-8004 Identity, ERC-8183 Jobs

Autopay used to be one hosted wallet quietly calling `payFor`. It is now three
agents that trade with each other: **your agent** posts the work and escrows a
fee, the **Splitsy Settler** does it, and the **Splitsy Auditor** is paid to
check it and decides whether the Settler gets paid at all.

This is the sibling of [`autopay-agent.md`](./autopay-agent.md), not its
replacement. The mandate contract, the caps, the decision log and the
bring-your-own-Circle-Agent-Wallet path all work exactly as documented there.
This page covers what sits *around* them.

---

## Migration — read this first

**The Settler's address replaces the `splitsy:autopay-agent` DCW as the address
named in mandates, so every existing user must re-arm their mandate.** Exactly
as after a mandate-contract redeploy.

A mandate still naming the old DCW is not an error and produces no log row at
all: `app/api/agents/autopay/route.ts` returns before claiming when the mandate
names an agent that is not the Settler, because telling a user who deliberately
runs their own agent that their autopay is off would be the opposite of true.
The cost of that correctness is that a stale mandate looks exactly like a
working self-run setup — which is why this is the first section on the page.

Second change, equally user-visible: **every user must now fund their own agent
before autopay can run, in both money modes.** See [Funding](#funding).

---

## What changed, and what it costs

Three agents, three distinct wallets, so nobody grades their own work:

| Role on the job | Who | Wallet kind | Why |
|---|---|---|---|
| client | the user's own agent | Circle DCW, `refId` `agent:<userId>` | it posts the work and escrows the fee |
| provider | the Splitsy Settler | raw EOA | x402 needs a raw key to sign EIP-3009; a DCW will not hand one over |
| evaluator | the Splitsy Auditor | Circle DCW, `refId` `splitsy:auditor` | it is paid to say no |

Three payment rails: the **ERC-8183 escrow** holds the job fee, **x402** buys
the bill review, and **direct USDC** moves the bill money.

### Cost

Six transactions **per settled share**, not per bill. A bill with four
autopaying participants costs four jobs and 24 transactions.

| Event | Extra transactions |
|---|---|
| bill created | 0 |
| paid manually in the app | 0 |
| autopay off | 0 |
| autopay on, agent **skips** | 0 |
| autopay on, agent **pays** | 6 |

A skip costs no transactions at all — every gate runs before `createJob`, so a
refused bill never opens a job. That is the whole reason the ordering is what it
is.

Only the last gate costs money: the $0.002 review. It is bought **after** the
idempotency claim and **after** the agent's funding check, so a redelivered
webhook cannot buy a second verdict the lock will discard, and an unfunded agent
cannot buy one it could never act on. Both used to happen, charged to the Settler
with no job to recover them from.

Two USDC `approve` transactions sit outside that six. They are lazy — sent only
when the current allowance is short, for 100× the amount being spent — so they
amortise across roughly a hundred settlements rather than landing on each one.

> `ponytail:` 6 tx per settled share is accepted while Arc gas is sub-cent USDC.
> If it starts to hurt, the upgrade path is Circle SCA batch execution, folding
> `createJob`+`fund` and `setBudget`+`submit` into single user-ops.

### The job ceremony

```
0. decide       the free rules in lib/autopay.ts, then the claim, then the
                agent's funding, and LAST the bill review BOUGHT from the
                Auditor over x402.  Any refusal stops here: no job, 0 tx.
1. createJob    the user's agent          ← client
2. setBudget    the Settler               ← the provider prices its own work
3. fund         the user's agent          → the fee into escrow
4. settle       payFor (Settler)  |  payDebtFor (the user's agent)
5. submit       the Settler               → keccak256(settlement tx hash)
6. complete     the Auditor, ONLY after reading getParticipant on chain and
                seeing paid >= owed
```

**Step 6 is not a rubber stamp**, and it is the reason any of this is worth
doing. The Auditor reads the registry itself. If the debt is not really settled
it does not complete, the job expires, and the Settler is not paid for work it
did not do.

The deliverable is `keccak256(settlementTxHash)`, so anyone holding the
settlement transaction can recompute it and check the job against it. That is
what makes the escrow release mean something.

**Job-first is affordable because the escrow only ever holds the fee.** If the
settlement fails, the job sits `Funded`, expires an hour later
(`JOB_TTL_SECONDS = 3600`), and at worst 0.01 USDC is stranded. The bill money
is never in the escrow in either ordering. (Whether an `Expired` job returns the
escrow is [Q3](#q3--does-an-expired-job-return-the-escrow-to-the-client) —
unverified.)

**Idempotency did not change.** `autopay_log`'s unique key
`(registry_address, bill_id, debtor_address)` is still the lock, unwidened, and
the claim is taken *before* `createJob` — so a redelivered webhook cannot even
open a second job.

### One caveat on timing

The ceremony runs once per participant, serially, inside a route capped at
`maxDuration = 300` (Vercel Hobby's hard ceiling, and a build-time limit — a
larger number fails the deployment rather than being clamped). One participant's
worst case is ~205s.

A bill with more autopaying participants than fit in 300s is cut off
mid-ceremony, which strands that participant's row as a `pay` with a null
`tx_hash`. `reclaimUndecided` cannot overturn it. There is a `ponytail:` note on
`app/api/agents/autopay/route.ts` naming the durable fix — a reconciliation
sweep over rows older than N minutes in that state — and **no cron owns it
yet**. Worth knowing before pointing this at a bill with many participants.

---

## Setup, in order

1. **Apply the schema.** Run `schema-agent-economy.sql` in the Supabase SQL
   editor. It is additive (`add column if not exists`) and adds no table:
   `autopay_log.job_id`, `.job_status`, `.fee_usdc`; `autopay_grants.money_mode`;
   `users.agent_wallet_address`, `.agent_wallet_id`.

2. **Create the Settler.**

   ```bash
   npm run settler:setup
   ```

   It prints a fresh `SETTLER_PRIVATE_KEY` and the matching
   `NEXT_PUBLIC_AUTOPAY_AGENT_ADDRESS`. Copy both into `.env.local`.

3. **Fund the Settler** from the Circle faucet (<https://faucet.circle.com/>),
   then re-run `npm run settler:setup`. The second run registers its ERC-8004
   identity and deposits into Circle Gateway, printing
   `SETTLER_ERC8004_TOKEN_ID` for `.env.local`. Re-running with the key and the
   token id already set skips straight to topping up Gateway.

4. **Set `NEXT_PUBLIC_AGENTIC_COMMERCE_ADDRESS`** to
   `0x0747EEf0706327138c69792bF28Cd525089e4583`.

5. **Tell your users to re-arm their mandates**, per the migration note above.

6. **Register the service agents' identities:**

   ```bash
   npm run agents:setup
   ```

   The Auditor and the Validator act in their own name on chain — the Auditor is
   the named evaluator on every job and an x402 seller, the Validator signs every
   `giveFeedback` — so both carry an ERC-8004 identity. The script prints each
   wallet's address; fund them from the faucet and re-run. It is **idempotent and
   safe to re-run**: it keys on `reputation_agents` and is additionally guarded
   on chain by `balanceOf`, so it cannot mint a second identity for a wallet that
   already has one.

   The **registrar is deliberately excluded.** It is plumbing, not an actor: it
   exists only because `register()` mints to `msg.sender` and browser payers
   cannot sign, so it holds their tokens transiently and transfers them on. A
   wallet whose job is holding other agents' NFTs must not also hold one of its
   own.

The Auditor's wallet itself needs no setup step to *function* — it is created
lazily under `refId` `splitsy:auditor` the first time `/api/agents/review` is
called or a job needs an evaluator. Only its identity needs the script above.

---

## Environment

```ini
SETTLER_PRIVATE_KEY=0x…              # required. the Settler EOA; x402 + ERC-8183 signer
NEXT_PUBLIC_AGENTIC_COMMERCE_ADDRESS=0x0747EEf0706327138c69792bF28Cd525089e4583
NEXT_PUBLIC_AUTOPAY_AGENT_ADDRESS=0x…  # the Settler's address, named in new mandates
SETTLEMENT_FEE_USDC=0.01             # optional, default 0.01
SETTLER_ERC8004_TOKEN_ID=…           # optional, DISPLAY ONLY (see below)
```

Also read, all optional, all by `scripts/settler-setup.ts` unless noted:

```ini
SETTLER_DEPOSIT_AMOUNT=0.5           # Gateway deposit size; also read by lib/settler.ts
SETTLER_METADATA_URI=ipfs://…        # the Settler's ERC-8004 metadata
SETTLER_FORCE=1                      # proceed past the "not funded yet" check
NEXT_PUBLIC_USER_AGENT_TOKEN_ID=…    # DISPLAY ONLY, /api/agents/wallet fallback
```

**Unset `NEXT_PUBLIC_AGENTIC_COMMERCE_ADDRESS` or `SETTLER_PRIVATE_KEY` reads as
autopay OFF**, matching how an unset mandate address already behaves. It is
never "run the settlement without the job".

`SETTLEMENT_FEE_USDC` is validated: a non-finite or negative value falls back to
`0.01` rather than being trusted into the escrow.

The token-id variables are a **UI convenience only**, matching how
`SCOUT_ERC8004_TOKEN_ID` is used today. Nothing in the settlement path reads
them — `SETTLER_ERC8004_TOKEN_ID` is read only by the setup script, to know it
can skip registration. Identity is resolved from `reputation_agents` via
`getAgentByWallet`, which is authoritative and survives a redeploy; unset, the
links simply come from the database.

> The design spec also lists `AUDITOR_ERC8004_TOKEN_ID`. **No code reads it**,
> and nothing needs it to: the Auditor now has a real identity (`npm run
> agents:setup`), resolved from `reputation_agents` like every other agent's.
> It is named here only so nobody wastes time wondering why setting it has no
> effect.

`SETTLER_ERC8004_TOKEN_ID` is a hint, not the authority. `settler-setup.ts` also
asks the chain before minting, so losing the var from `.env.local` no longer
mints the Settler a second identity — the failure mode that gave one user agent
four NFTs.

---

## Funding

**Every user must fund their agent before autopay can run, in both money
modes.** Today's Mandate mode needs no funding at all, so this is a real product
change and it is deliberate: the agent needs USDC for its own gas (Arc charges
gas in USDC) and for the job fee it escrows.

The agent signs five of the up-to-eight transactions a settlement involves —
`createJob`, `fund`, up to two lazy `approve`s, and `payDebtFor` in Funded
mode — while the Settler and the Auditor pay for their own out of their own
balances.

| Mode | Suggested starting balance | Covers |
|---|---|---|
| Mandate | **2 USDC** | gas + job fees |
| Funded | **20 USDC** | gas + job fees + bill money |

The panel shows the agent's address, its balance, and a **Fund** button beside
it; while the balance is still zero it says plainly that nothing settles until it
is funded. The dialog's placeholder is `DEFAULT_FUND_USDC` = **2 USDC** — the
smallest amount that leaves the agent actually able to settle something, not a
figure that covers the table above. Someone expecting larger shares should raise
it.

Three routes, and the dialog offers only the ones the account has:

| Route | What happens | Needs |
|---|---|---|
| connected browser wallet | the wallet signs a USDC `transfer` to the agent; the receipt is checked with `assertReceiptSuccess`, because viem *resolves* on a reverted transaction | a wallet connected on Arc |
| the user's Splitsy wallet | the same transfer, sent server-side via `POST /api/wallet/send` | the wallet PIN unlocked |
| anywhere else | an ordinary inbound transfer to the address, which the card links to Arcscan | nothing |

It is deliberately a plain transfer either way, never an approval: the agent's
balance **is** its spending ceiling, so funding has to mean handing over custody
rather than permission. The Splitsy-wallet route is not offered to a
wallet-signin account — that DCW exists but has never been funded, and it sits
behind a PIN that account never set.

An agent whose balance cannot cover the fee plus a 0.20 USDC gas headroom
(plus the share itself, in Funded mode) **skips with `agent_unfunded` and
creates no job.** This is the most likely real-world failure, which is why it
has its own slug instead of surfacing as `tx_failed`.

**One agent per account, never per wallet.** The `refId` is `agent:<userId>`, so
someone who signs in socially *and* links a browser wallet has one agent, one
balance and one identity NFT covering both. They fund it once. The panel says so
in as many words, because the alternative is someone funding twice looking for a
second agent that does not exist.

**One per account is not one per person, though.** A browser-wallet sign-in mints
a whole account (`/api/auth/wallet`), so a person who used this tab before adding
a social login has *two* accounts and therefore two agents, each with its own
balance and neither able to spend the other's. The card shows **both** — hiding
one is how USDC ends up in an agent nobody can find — and **Link wallet** is what
collapses them: it frees the wallet account's `debtor_address`, claims it for the
session account, and then adopts that account's agent (`agentToAdopt`), because
the earlier login slot is the one that has been funded. The one exception is a
session agent that already holds a balance: adoption overwrites the only columns
that lead back to an agent wallet, so it is refused rather than allowed to strand
money, and the second agent stays on screen until one of them is empty.

**Unlink is the exact inverse.** `DELETE /api/agents/link` hands the agent back
when `wasAgentAdoptedFrom` says the link is why this account holds it — the donor
row still names what it donated, so an address match is the record and no column
remembers it. Handing back is just clearing the two columns: the next read
re-derives this account's own agent from its unchanged `refId`, so both accounts
end up on the agent they had before the merge, balances included. Anything less
would be a half-undo, leaving the wallet's account locked out of the agent it
funded while this one kept spending it.

**Two agents mean two sets of rules,** and the card says so rather than implying
one form binds both. `autopay_grants` is one row per `user_id`, so the ceilings,
the checks and the `enabled` switch on this page bind the session's agent only;
the other account keeps its own copy, editable only by signing in with that
wallet. The second row therefore carries that account's own Armed/Idle chip —
an agent that can spend while its rules are invisible from here is precisely
what this panel exists to surface — and points at **Link wallet** as the way out.

**The second row follows the extension.** It is keyed on the address wagmi
reports, so switching accounts in Rabby or MetaMask re-queries and swaps which
agent is shown. A wallet this browser has not proved renders as a sentence plus a
**Sign to show 0x…'s agent** button rather than as an empty space — the agent that
was on screen a moment ago belongs to the account of the wallet that signed in
with it, not to the person looking at the page, and a card that just drops it
reads as a lost balance. That row deliberately does not say whether the wallet
*has* an account, because the server will not answer that without a signature.

**The second account is resolved from a signed proof, never from the address in
the query.** `getProvenWalletAccount` (lib/session.ts) reads
`splitsy_wallet_proof` — issued by `POST /api/auth/wallet`, where a signature has
just been verified — and only then, and only while the extension is still on that
same wallet. The address in the query narrows; the cookie authorises. This matters
because the same resolution gates the decision log, and a log row says which of a
person's private rules declined which bill: an address is a claim anyone can make,
and naming one must not be enough to read someone else's agent, balance, armed
state or trail. The token is domain-separated from both the session and the
wallet-unlock token despite sharing their shape — otherwise a proof cookie
replayed as `splitsy_session` would *be* that account, and replayed as the unlock
cookie would bypass the wallet PIN for a month. `lib/session.test.ts` pins both
directions. Logging out clears it: it is tied to a wallet rather than to the
session holding it, so leaving it behind would hand the next person on this
browser the previous one's agent and trail.

**That button does not sign you out.** `POST /api/auth/wallet` passes
`setSession: false` to `finishProviderLogin` whenever a non-wallet session is
already live: there is one session cookie, so setting it would evict the social
login the caller is still using, and proving control of a browser wallet is not a
request to be signed out of anything. The account is created either way — only
the cookie differs — and on that path the route also creates the account's agent
up front, because the read side never provisions one for an account it is not
signed in as, so the card would otherwise still say *no agent* right after a
successful signature. A **wallet** session is still replaced as before: there is
no second identity to preserve.

**The decision log spans both accounts.** `listAutopayLog` takes one user id or
several and applies the limit to the merged result — 50 from each, sliced here,
would drop recent rows from a busy account to keep old ones from a quiet one. The
trail is the one part of this page that must not be scoped to whichever login you
happen to be in: each agent writes its own rows, and the decisions missing from a
session-scoped view are exactly the ones the reader has no other way to see, since
the other account's rules are unreachable from here. Rows carry `otherAccount` so
the panel can mark which agent decided — the ceilings above bind only the
session's. `GET /api/agents/job` widens by the same proof and no further, because
that endpoint authorises off the log itself; anything looser would make it the way
to read another account's jobs by naming its wallet. After a link the historical
rows stay under the account that wrote them, which is why the merged trail
survives the merge — and why the panel derives "is this trail merged?" from the
rows rather than from whether a second agent currently exists.

The agent's ERC-8004 identity is minted from the agent's own wallet — keying it
on the user's main wallet would collide with the `splitsy-payer` identity they
already earned by paying bills — and then transferred to the user with a
best-effort `transferFrom`. A failed transfer leaves the NFT with the agent,
which is cosmetic, and never blocks a settlement.

---

## The two money modes

Where **bill money** comes from. Both modes need the funded agent above; they
differ only in who pays the share. The **fee is always the user's agent's**, in
both.

| Mode | Bill money from | Settlement call | Signer | New Solidity |
|---|---|---|---|---|
| **Mandate** | the user's own wallet | `AutopayMandate.payFor(billId, debtor)` | Settler | none |
| **Funded** (the only one on offer) | the agent's own balance | `BillSplitRegistry.payDebtFor(billId, debtor, amount)` | user's agent | none |

> **The mode is no longer a user choice.** The picker is gone from
> `app/SettlementAgentsPanel.tsx`, which now describes Funded mode alone and
> sends `moneyMode: 'funded'` on every save; the column default is `'funded'`
> and existing rows were flipped (`schema-agent-economy.sql`). Everything below
> about Mandate mode is still true of the *backend* — the route, the contract
> and `buildGrant` are untouched and a `'mandate'` row still settles that way —
> but nothing puts a user there any more. A save also **revokes** a mandate left
> on the user's Splitsy wallet by the old flow, and the browser-wallet revoke
> survives in the unlink warning. Re-plugging it means restoring the picker and
> dropping two lines of SQL.

`payDebtFor` pulls from `msg.sender`, credits the `debtor`, and emits `DebtPaid`
naming the **debtor** as payer — so reputation keeps flowing to the user rather
than to their agent, and the existing scoring path is untouched. There is no
second scoring call.

In Funded mode the on-chain caps in `AutopayMandate` **do not bind**, because
the mandate is not in the path. The off-chain rules still do: per-bill cap,
daily cap, creator allowlist, score floor and verified hash are all evaluated by
`decideAutopay` against the Postgres mirror instead of against the chain.

The weakening is genuine, and the panel says so in its own row rather than
leaving it implied:

> *Splitsy does. They are checked before your agent spends, not enforced by a
> contract — so the hard limit is the balance above: it can never pay out more
> than you have sent it.*

That last clause is the honest consolation: an agent holding 5 USDC can never
spend 6. It is a simpler ceiling than a mandate and it needs no contract.

`decideAutopay` itself does **not** learn about modes — it keeps its exact
signature and stays pure. Only its *input* changes, and a new pure helper picks
where that input comes from:

```ts
buildGrant(mode, mandateFromChain, rulesFromPostgres): AutopayGrant | null
```

`'mandate'` sources the caps from the chain exactly as before; `'funded'`
sources them from the mirror. It is the one piece of new branching in the whole
design, and being pure it is unit-tested without a network
(`lib/autopay.test.ts`).

The daily-spend figure has exactly one source per mode: the contract's own token
bucket in Mandate mode, and `sumAutopaySpentTodayUsdc` over `autopay_log` in
Funded mode, where no bucket exists. Two modes, two sources, never two answers
for the same mode.

Mode is stored per user in `autopay_grants.money_mode`. The column now defaults
to `'funded'`, because that is the only mode the UI can describe; the *code*
still reads anything that is not exactly `'funded'` as `'mandate'`, so a typo
lands in the stricter mode rather than the looser one.

---

## The paid bill review

`lib/autopay-review.ts` used to be a free internal function call. It is now a
paid endpoint the Auditor sells and the Settler buys, at **$0.002** per review
(`lib/x402/pricing.ts`), out of the fee income the Settler accumulates — priced
well under the 0.01 USDC job fee so the Settler is still ahead on a job it
completes.

Both sides land in `x402_payments`: `earned` by the seller wrapper,
`spent` by the Settler. The `spent` row is recorded *before* the response body
is inspected, because by then the money is already gone — Gateway settled the
payment to return a response at all, and an unreadable verdict still costs the
fee.

`POST /api/agents/review` is **public to anyone who pays**, like `/api/ocr` and
`/api/fx`, and that is the point: it is a service the Auditor sells. It leaks
nothing, because every field it judges arrives in the request body. A stranger
who pays $0.002 gets a verdict on their own data.

Every failure direction is a refusal — a 402, a timeout, an unparseable verdict,
a missing key, or an x402 settlement failure. **A Settler that cannot buy a
review settles nothing.**

---

## Unlinking

`DELETE /api/agents/link` always existed; nothing in the client called it. With
money now sitting in an agent, a user has to be able to walk a link back, so the
panel has the button — with a warning, because unlinking does less than people
expect.

| On unlink | Effect |
|---|---|
| autopay for that browser wallet | **stops** — no `userId`, so the route skips the participant |
| the on-chain mandate on that wallet | **survives** — `revokeMandate()` is a separate transaction the user must send |
| the USDC approval to the mandate contract | **survives**, and is inert only while the mandate is revoked |
| the agent, its balance, its identity NFT | **untouched** — they belong to the account |

The surviving mandate is not new behaviour; it was simply unreachable before.
The UI offers **Revoke first, then unlink** as an ordered pair and never
presents unlink alone as "turning it off". Revoke is offered only while the
linked wallet is the connected account — revoking from another account would
report success while leaving the mandate that actually binds this user alive.

Unlink is never gated behind the wallet-unlock cookie: tightening must never be
harder than loosening.

---

## Reading the decision log

Two new skip reasons, both rendered in the panel:

| Slug | Means |
|---|---|
| `agent_unfunded` | the agent cannot cover the fee plus gas (plus the share, in Funded mode). No job was created. |
| `job_failed` | a job transaction reverted after the claim was taken. |

`job_status` on a row is a **display mirror** — `getJob(jobId)` on chain is the
source of truth. Its values:

| `job_status` | Means |
|---|---|
| `completed` | the full ceremony ran; the Auditor verified and released the escrow |
| `settled_incomplete` | **the debt is paid**; only `submit` or `complete` broke afterwards |
| `settlement_unconfirmed` | the settlement was broadcast but never confirmed; it may still mine |
| `failed` | the ceremony broke before step 4. No money moved and none can. |

The last three carry a failure slug in `reason` and are logged **`pay` for the
full amount** whenever the money might have moved. That direction is deliberate
and fail-closed: in Funded mode the log is the only record of the day's spend, so
a settlement that succeeded on chain but broke afterwards, written as a
zero-amount `skip`, would silently hand the user their whole daily cap back. Two
8 USDC bills against a 10 USDC cap would both pay and 16 USDC would be gone.
Costing a user headroom they were entitled to is recoverable; spending money they
had already capped is not.

---

## UNVERIFIED — run these by hand

**None of the following has been executed.** They are expected to hold; none is
confirmed. **Q2 and Q4 could each force a design change** — read those two
first.

Prerequisites: the setup steps above completed, funded Arc-testnet wallets, and
a deployed `AutopayMandate` per `docs/autopay-agent.md`.

### Q1 — Does `setBudget` accept a call from the provider while the job is `Open`?

The Arc quickstart's order is `createJob` → `setBudget` → `approve` → `fund`,
which is what step 2 of the ceremony implements. Run it as written.

*If `setBudget` must precede something else,* reorder steps 2 and 3 in
`runJob` (`app/api/agents/autopay/route.ts`).

### Q2 — Can the evaluator `complete` a job it is not the client of?

The quickstart uses one wallet as both client and evaluator. This design uses
three distinct wallets, and the Auditor is never the client.

*If `complete` requires the evaluator to also be the client:* make the user's
agent the evaluator, and have the Settler `submit` only after the Auditor has
confirmed the debt on chain. The check still happens — one step earlier.

### Q3 — Does an `Expired` job return the escrow to the client?

Fund a job, let it pass `expiredAt` without submitting, then read the client's
balance.

*If the escrow is not returned:* say so in this document and shorten
`JOB_TTL_SECONDS` from `3600n` to 15 minutes, to bound how long a stranded fee
is invisible.

### Q4 — Does a raw EOA pay Arc gas in USDC with no native balance?

Send a contract write from the Settler holding only ERC-20 USDC.
`scripts/settler-setup.ts` prints both balances for exactly this reason.

*If it fails:* the Settler needs a native balance, and
`scripts/settler-setup.ts` must fund it.

**Partially observed, not yet answered.** Across two setup runs the two balances
this script prints were the same number:

| | Native (`getBalance`, 18dp) | USDC (`balanceOf`, 6dp) |
|---|---|---|
| after faucet funding | `20` | `20` |
| after the `register` tx | `19.9959468296` | `19.995946` |

Truncated to six places the native figure *is* the USDC figure, both times —
consistent with native and ERC-20 USDC being two views of one balance on Arc,
which is what "USDC is the gas token" would imply. If that holds, the state Q4
asks about (USDC held, native zero) is unreachable and the question is moot.

Two samples are not a proof, and neither run tested the interesting case: the
`register` transaction that succeeded had a non-zero native balance, so it says
nothing about paying gas without one. Answering Q4 properly still needs an
address where the two figures genuinely diverge — if one can exist.

### Q5 — End-to-end, Mandate mode

Re-arm a mandate naming the Settler, fund the agent with 2 USDC, have a second
account bill it.

*Expect:* a job reaching `Completed`, the Settler's USDC up by ~0.01 minus gas,
the Auditor's up by 0.002, and one `pay` row carrying a job id.

### Q6 — End-to-end, Funded mode

Switch to Funded, fund the agent with 20 USDC, bill it.

*Expect:* the share paid by `payDebtFor` from the agent, a `DebtPaid` naming the
**user** as payer, reputation scored to the user and not to the agent, and the
job completed.

### Q7 — The Auditor refuses

Create a bill whose headline figures do not support the debtor's share.

*Expect:* the model's own sentence (or `review_unavailable`) in the log,
**no job created at all**, and one `spent` row in `x402_payments` — the review
was bought and its answer was no.

### Q8 — One agent covers both wallets

Sign in socially, link a browser wallet, fund the agent once. Bill the **DCW**
address, then bill the **browser wallet** address.

*Expect:* both settled by the *same* agent address out of the *same* balance,
with two `pay` rows under one `user_id`.

*If a second agent appears,* the `refId` is being derived from a wallet
somewhere instead of from `userId`.

### Q9 — Unlink with a live mandate

With a live mandate on the linked wallet, press **Unlink**.

*Expect:* the wallet disappears from **Pay from**; a later bill to that address
produces **no log row at all** (the participant is no longer resolvable to an
account); the agent's balance is unchanged; and
`AutopayMandate.mandates(thatWallet).agent` is still the Settler — proving the
warning above is accurate and not hypothetical.

---

## Deliberately not doing

- **No new Solidity.** Everything runs on already-deployed contracts:
  `AgenticCommerce`, `BillSplitRegistry`, `AutopayMandate`, `IdentityRegistry`.
- **No batching.** 24 transactions for a four-person bill is accepted; see the
  `ponytail:` note under [Cost](#cost).
- **No per-user x402 keys.** Only the Settler buys reviews, so Splitsy never
  holds a raw private key per user.
- **No on-chain skip log.** Skips stay in Postgres. Paying gas to record a
  non-payment buys nothing.
- **No fee split, no dynamic pricing, no agent marketplace.** One fee, one
  price, two Splitsy agents.
- **Circle Agent Wallets stay out of the hosted path** — x402 needs a raw key —
  and stay fully supported for self-hosting users, exactly as documented in
  [`autopay-agent.md`](./autopay-agent.md).

---

## Arc Testnet Constants

| Name | Value |
|---|---|
| Network CAIP-2 | `eip155:5042002` |
| USDC | `0x3600000000000000000000000000000000000000` |
| AgenticCommerce (ERC-8183) | `0x0747EEf0706327138c69792bF28Cd525089e4583` |
| ERC-8004 IdentityRegistry | `0x8004A818BFB912233c491871b3d84c89A494BD9e` |
| RPC | `https://rpc.testnet.arc.network` |
| Explorer | `https://testnet.arcscan.app` |
