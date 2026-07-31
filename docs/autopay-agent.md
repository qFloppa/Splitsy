# Autopay — Debtor-Side Settlement Agent

Autopay settles *your* share of a bill someone else raised, without you opening
the app. The permission it runs under is an on-chain mandate you sign yourself:
`AutopayMandate.sol` holds the ceilings, names the one agent allowed to spend,
and reverts anything outside them. Splitsy's servers are not in that path.

Two things on this page are worth reading even if you only ever use the hosted
agent: you can arm autopay from **your own browser wallet** (not just the
Splitsy-managed Circle wallet), and you can name **your own Circle Agent Wallet**
as the spender instead of Splitsy's.

---

## Architecture

```
Bill created on chain
  │  BillCreated event → Circle SCP monitor → POST /api/agents/autopay
  │
  ├─ per participant: resolve the debtor to a Splitsy account
  │     users.wallet_address (Circle DCW)  OR
  │     autopay_grants.debtor_address      (linked browser wallet)
  │
  ├─ mandate names someone else's agent?  → return, write NO log row
  │     (you run your own agent; this one has nothing to say about it)
  │
  ├─ lib/autopay.ts    decideAutopay()   caps, score floor, verified hash
  ├─ lib/autopay-review.ts  reviewBill() the one judgment a rule cannot make
  │
  └─ AutopayMandate.payFor(billId, debtor)   ← the only call that moves money
```

The layering is deliberate:

| Layer | Holds | Fails |
|---|---|---|
| `AutopayMandate.sol` | agent identity, per-bill cap, per-day bucket, creator allowlist | reverts |
| `lib/autopay.ts` | score floor, verified-hash check | closed (`skip`) |
| `lib/autopay-review.ts` | is this bill coherent at all | closed (`skip`) |

Only the first can actually stop money. The other two run before it and can only
ever be *more* restrictive.

---

## The Mandate Contract

`contracts/AutopayMandate.sol`, deployed in front of the existing
`BillSplitRegistry` — no registry redeploy, no SCP monitor re-run.

| Function | Who calls it | Effect |
|---|---|---|
| `setMandate(agent, maxPerBill, maxPerDay, creators)` | the debtor | arms autopay, `msg.sender`-keyed |
| `revokeMandate()` | the debtor | `agent = address(0)`, which is "off" |
| `payFor(uint256 billId, address debtor)` | the named agent only | pulls the debtor's full remaining share |
| `spendable(billId, debtor)` | anyone (view) | what `payFor` would move right now, `0` if any rule blocks |

`payFor` takes **no amount**. The contract reads the remaining share off the
registry itself, so an agent cannot pick a figure, cannot split one share into
several sub-cap pulls, and cannot aim the call at another bill's money.

Events: `MandateSet`, `MandateRevoked`, `MandateSpent(billId, debtor, agent, amount)`.
Reverts: `NoMandate`, `NotAgent`, `NotParticipant`, `NothingOwed`,
`CreatorNotAllowed`, `OverBillCap`, `OverDailyCap`, `TooManyCreators`.

`MAX_ALLOWED_CREATORS` is **10**. An empty allowlist means *any* creator, within
the ceilings.

Deploy with:

```bash
node --env-file=.env.local --experimental-strip-types scripts/deploy-autopay-mandate.ts
```

then set `NEXT_PUBLIC_AUTOPAY_MANDATE_ADDRESS` from its output. Every user must
re-arm after a redeploy — mandates live on the old contract and the app no
longer reads it.

---

## Arming From a Browser Wallet

The Splitsy-managed Circle DCW is signed for you on save. A browser wallet is
not — Splitsy holds no key for it — so you sign its mandate yourself.

1. **Link the wallet.** Settlement agents panel → **Pay from** → **Link wallet**.
   Your wallet signs a message; nothing goes on chain.

   The signature is mandatory. `autopay_grants.debtor_address` decides whose
   rules bind a wallet and who reads its decision log, so a merely *claimed*
   address would let anyone attach their own score floor to someone else's money
   and watch what it does. The message names the address, your handle **and your
   identity provider** — a handle alone is not an account, since uniqueness in
   `users` is `(provider, provider_user_id)`. It expires after 5 minutes
   (`LINK_MAX_AGE_MS`), in both directions: a future timestamp is as suspect as
   a stale one.

   One wallet, one account. A partial unique index on `debtor_address` returns
   409 if the wallet is already linked elsewhere.

2. **Select it.** **Pay from** → **Browser wallet**. The ceilings on screen
   reseed from *that* wallet's mandate — they are keyed per debtor on chain, so
   your two wallets can carry different numbers and different agents.

3. **Set the ceilings**, then press **Arm on chain**.

   This is **two transactions**, in this order and not the other one:

   ```
   1. setMandate(agent, maxPerBill, maxPerDay, creators)   → the mandate contract
   2. approve(mandateAddress, maxPerDay * 7)               → USDC
   ```

   An EOA has no `executeBatch`, so they cannot be atomic — the ordering is the
   mitigation. `setMandate` alone cannot move money (`payFor` reverts inside
   `safeTransferFrom` with no allowance). Lowering caps binds the tighter ceiling
   *before* the allowance is topped up; raising them leaves the old allowance
   bounding exposure until `approve` lands. Approve-first would instead open a
   window with a fresh allowance under the old, looser caps.

   Reject the second prompt and the first still stands. The panel refetches in
   `finally`, so the screen shows the half that took.

4. **Revoking is one transaction** — `revokeMandate()`. The residual approval is
   inert: `payFor` is the only function that can spend it, and it now reverts
   with `NoMandate`. Revoke is never gated behind the wallet-unlock cookie;
   tightening must never be harder than loosening.

If your wallet switches accounts, the panel refuses to arm rather than writing a
mandate keyed to a wallet whose rules and log nothing reads.

---

## Running Your Own Agent Wallet

By default the spender is Splitsy's hosted agent. You can name your own Circle
Agent Wallet instead, and then no Splitsy process ever calls `payFor` for you.

### 1. Install the Circle CLI

```bash
npm install -g @circle-fin/cli
circle wallet login <your-email> --testnet
```

Login is an **email OTP** — the CLI prints a code prompt and you paste the code
from your inbox. **Sessions expire after 7 days**, so expect to log in again
roughly weekly if your agent runs unattended.

### 2. Get the agent wallet's address

```bash
circle wallet list --type agent --chain ARC-TESTNET
```

Copy the address of the agent wallet you want to spend under your mandate.

### 3. Name it in the mandate

Settlement agents panel → **Agent** → **My own agent wallet**, paste the address
into **Agent wallet address**, then **Arm on chain**.

That address goes straight into `setMandate`'s first argument. There is no
server-side validation of it beyond the `0x…` shape, and there cannot be — the
chain has no way to know whether you hold the key.

> **Naming an address you do not control switches autopay off silently.** Nothing
> can call `payFor`, so no payment happens *and nothing is logged*. Splitsy's
> agent deliberately writes **no** `autopay_log` row at all when the mandate
> names someone else — not even a `disabled` one, because telling a user who
> deliberately runs their own agent that their autopay is off would be the
> opposite of true. The cost of that correctness is that a typo looks exactly
> like a working self-run setup.

### 4. Install the instructions into your agent

```bash
curl -sL <origin>/api/agents/skill
```

Served as `text/markdown` in the same shape as Circle's own hosted skills
(`https://agents.circle.com/skills/*.md`). It is templated rather than a static
file because the mandate address is environment-dependent, and a skill file
naming a stale contract is worse than none. It returns **503** when
`NEXT_PUBLIC_AUTOPAY_MANDATE_ADDRESS` is unset.

### 5. The queue your agent reads

```bash
curl -s "<origin>/api/agents/queue?debtor=<yourWalletAddress>"
```

**Public and unauthenticated, on purpose.** Every field is already public —
`BillSplitRegistry` is readable on chain by anyone and
`/api/onchain-bills/preimage` already serves preimages with no session. Auth
would also defeat the point: this exists so an agent on your own machine,
holding no Splitsy session, can find work.

Returns `mandate` plus a `bills` array. Entries are filtered on
`spendable > 0`, so every bill listed is one the contract would pay *right now*
— caps, daily budget, USDC approval and balance all already accounted for. An
empty array means there is nothing to do.

| Field | Meaning |
|---|---|
| `billId` | pass to `payFor` |
| `amountUsdc` | display only — you never pass an amount |
| `creator` | who raised the bill |
| `creatorScore` | ERC-8004 average, or `null` for no history |
| `verified` | published details recompute to the on-chain `metadataHash` |
| `preimage` | merchant, currency, total, participant labels |

A reputation-DB failure makes this route **error**, not report a null score.
`creatorScore: null` already means "genuinely unrated", so any agent policy that
accepts an unrated creator would then also accept a creator whose real score is
20. Fail closed: your agent finds no work rather than unverified work.

### 6. Pay

```bash
circle wallet execute "payFor(uint256,address)" <billId> <yourWalletAddress> \
  --contract <MANDATE_ADDRESS> \
  --chain ARC-TESTNET \
  --address <yourAgentWalletAddress>
```

---

## Spend Policy Is Not In Play On Testnet

**`circle wallet limit` policies are mainnet-only.** On Arc Testnet there is no
Circle-side spend policy on your agent wallet at all, so `AutopayMandate` is the
**sole** enforcement of what your agent may spend.

That is the stronger claim anyway — the caps are on chain, public, and revocable
by you at any moment with `revokeMandate()`, whether or not Splitsy's servers
are reachable — but it should be stated rather than glossed. If you were
expecting a second, Circle-side belt on testnet, there isn't one.

See [Open questions](#open-questions--unverified) below: this specific claim has
not been executed against the CLI.

---

## The Model Review (`lib/autopay-review.ts`)

`decideAutopay` is caps, a score floor and a hash comparison — a policy engine.
A standing mandate plus if-statements is verifiable direct debit. What it never
asks is whether the bill is *reasonable*: `requireVerifiedHash` proves only that
the preimage recomputes to the on-chain `metadataHash`, which says nothing about
whether the merchant, total and share hang together.

So a model gets one question, and only after the rules already said `pay` —
rules are free and this is not.

- Toggle: **Check the bill's contents before paying**, default **on**.
- It sees merchant, currency, total, participant count, even split, your share,
  the creator's score, and participant labels. It does **not** see line items —
  they are in neither the commitment nor the published row — so it judges
  headline coherence only, never "did this person actually order the wine".
- Refusal is logged with the model's own sentence, rendered verbatim in the
  decision log.
- Every failure direction is a refusal: no API key, HTTP error, timeout (15s),
  unparseable JSON. The slug is `review_unavailable`. Because the toggle
  defaults on, a broken key halts *all* autopay — that is the intended
  direction, and it is logged server-side so it is diagnosable.

---

## What Binds Whom

| Setting | Scope | Stored |
|---|---|---|
| agent address, per-bill cap, per-day cap, allowed creators | **per wallet** | on chain |
| score floor | per account | Postgres |
| require verified hash | per account | Postgres |
| check bill contents before paying | per account | Postgres |

`autopay_grants` upserts on `user_id`, so the three checks live in one row and
bind *every* wallet you arm. The panel renders them under their own heading
saying so — putting them inside a per-wallet card would be a lie.

The Postgres copies of the caps are a **display mirror only**. `enabled` is
never mirrored: it answers "can software move my money right now?", and that
comes from the chain alone.

---

## Environment

```ini
NEXT_PUBLIC_AUTOPAY_MANDATE_ADDRESS=0x…   # unset ⇒ autopay reads as OFF everywhere
NEXT_PUBLIC_AUTOPAY_AGENT_ADDRESS=0x…     # optional; else resolved from the Circle DCW
AUTOPAY_REVIEW_MODEL=gemini-3.1-flash-lite
RECEIPT_SCANNER_API_KEY=…                 # shared with OCR; no key ⇒ every review refuses
AGENT_SECRET=…                            # or CRON_SECRET, to authorize /api/agents/autopay
```

An unset mandate address is never "unlimited". It reads as off in the panel, and
both `/api/agents/skill` and `/api/agents/queue` return 503.

---

## Open Questions — UNVERIFIED

**None of the following has been executed.** They are expected to hold; none is
confirmed. Each is written as a command a human can run against a configured
deployment, with what to change if the answer differs.

Prerequisites for all of them: `NEXT_PUBLIC_AUTOPAY_MANDATE_ADDRESS` set to a
deployed `AutopayMandate`, the Circle CLI installed and logged in, and funded
Arc-testnet wallets.

### Q1 — Does the CLI accept `uint256` and `address` args for an agent wallet?

```bash
circle wallet execute "payFor(uint256,address)" <billId> <debtorAddress> \
  --contract <MANDATE_ADDRESS> \
  --chain ARC-TESTNET \
  --address <yourAgentWalletAddress>
```

*Expected:* a transaction hash, and a `MandateSpent(billId, debtor, agent, amount)`
log on the mandate contract.

*If argument encoding differs* (positional args rejected, a `--args` flag
required, JSON-encoded parameters, checksummed-address requirement): correct the
command in **`app/api/agents/skill/route.ts`** — section "3. Pay" — and mirror
the correction in step 6 above.

### Q2 — Is gas sponsored for a contract write on Arc Testnet?

Run Q1 from an agent wallet holding **zero** native balance.

*Expected:* it succeeds; Arc sponsors gas and no funding step is needed.

*If it fails for gas:* promote funding from an aside to a **required** step in
`app/api/agents/skill/route.ts`, ahead of the `payFor` call:

```bash
circle wallet fund --address <yourAgentWalletAddress> --chain ARC-TESTNET
```

(20 USDC from the faucet.) The skill file currently presents this conditionally,
under "If the wallet has no gas".

### Q3 — Is `circle wallet limit` really mainnet-only?

```bash
circle wallet limit --chain ARC-TESTNET
```

*Expected:* rejected as mainnet-only, which is what "Spend policy is not in play
on testnet" above asserts.

*If policies DO work on testnet:* say so in the section above **and** in the
closing "What binds you" section of `app/api/agents/skill/route.ts`, which
currently states the mandate is the only thing enforcing the agent's limits.

### Q4 — End-to-end, hosted operator

1. Sign in, connect a browser wallet, **Link wallet**, sign.
2. **Pay from** → Browser wallet; **Agent** → Splitsy's agent; set caps; **Arm on chain**.
3. Confirm two wallet prompts, `setMandate` then `approve`, in that order.
4. From a **second account**, bill the linked wallet an amount under the per-bill cap.

*Expected:* a `pay` row in the panel's decision log, and a `MandateSpent` event
on the mandate contract.

### Q5 — End-to-end, the model review

1. Create a bill whose headline figures do not support the debtor's share.
2. *Expected:* a `skip` row whose reason is the model's own sentence, verbatim —
   not a slug.
3. Turn off **Check the bill's contents before paying** and re-run.
4. *Expected:* the bill now pays.

### Q6 — End-to-end, self-run operator

1. Re-arm with **Agent** = your Circle Agent Wallet address.
2. Bill the wallet again.
3. *Expected:* **no new `autopay_log` row appears at all** — not a `disabled`
   row. Anything else means the early return in `app/api/agents/autopay/route.ts`
   (the `mandate.agent !== input.agent.address` branch) is not firing.
4. `curl -s "<origin>/api/agents/queue?debtor=<wallet>"` — expect the bill listed
   with `amountUsdc`, `verified` and `creatorScore`.
5. Run Q1's `circle wallet execute` and confirm the debt settles.

---

## Arc Testnet Constants

| Name | Value |
|---|---|
| Network CAIP-2 | `eip155:5042002` |
| USDC | `0x3600000000000000000000000000000000000000` |
| RPC | `https://rpc.testnet.arc.network` |
| Explorer | `https://testnet.arcscan.app` |
