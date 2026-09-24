# Splitsy

Splitsy is a Next.js prototype for splitting shared costs and collecting them in
USDC on [Arc](https://docs.arc.io). You can state a debt in one sentence, scan a
receipt into a full split, or set up a tab that repeats — and settle any of it
from a wallet you get by signing in with X, Discord, Google, or an email code.

**It runs on Arc Testnet with test USDC.** One variable
(`NEXT_PUBLIC_ARC_NETWORK=mainnet`) moves a deployment to Arc mainnet; nothing in
this repo asserts that flip has happened, and it has not. See
[Networks](#networks).

What it does:

- **IOUs** — one sentence is the whole bill. "@dani owes me $42" files a
  one-participant on-chain bill; "I owe @dani $42" sends the USDC straight to
  them. The contract forces which rail is which, because `claim` only ever pays
  the wallet that created the bill.
- **Pay someone who has no wallet yet** — tag a handle nobody has signed in as
  and the money goes into `HandleEscrow` instead of nowhere. Their first sign-in
  releases it to the wallet they actually sign in with; until then the depositor
  can take it back with `reclaim`.
- **Receipt scanning** by an autonomous OCR agent ("Scout") that pays for its own
  AI tooling in USDC fractions over x402 (Circle Nanopayments).
- **Social sign-in** via X, Discord, Google, or a one-time email code — each one
  provisions a wallet, with no seed phrase and nothing to install.
- FX conversion into USD, then equal or manual splitting.
- Onchain bill submission, wallet-based debt discovery, and Arc transaction memos
  for reconciliation.
- **Circle Gateway** for cross-chain USDC payments from Avalanche, Base, or
  Ethereum directly to Arc.
- **Recurring USDC tabs** with cycle settings and allowance-based collection.
- **Net-settlement treasury** — every open position collapsed to one net figure
  per counterparty, then discharged through the registry's own `settle` call.
- **Debtor-side autopay** — each account gets its own **user-funded** agent that
  settles that account's shares as ERC-8183 jobs, audited by a second Splitsy
  agent that is paid over x402 to check the work.

## Networks

`NEXT_PUBLIC_ARC_NETWORK` is the only Arc switch, and the match is exact: only
the literal string `mainnet` selects mainnet, so a typo, a capitalised value or
an unset variable all land on testnet, where being wrong is free
(`resolveArcProfile`, `lib/arc-chain.ts`).

| | Arc Testnet (default) | Arc mainnet |
|---|---|---|
| `NEXT_PUBLIC_ARC_NETWORK` | unset, or anything but `mainnet` | `mainnet` |
| Chain id | `5042002` | `5042` |
| RPC | `https://rpc.testnet.arc.network` | `https://rpc.mainnet.arc.io` |
| Explorer | `https://testnet.arcscan.app` | `https://explorer.arc.io` |
| USDC | `0x3600…0000` | `0x3600…0000` (the same) |
| Money | test USDC, no value | real USDC |

Chain id, RPC, explorer, USDC and the two Gateway addresses all follow from that
one switch and are no longer settable one by one.

Deployment **addresses** are not properties of a chain, so they are not in
`lib/arc-chain.ts`. They follow the switch by a naming rule instead: the
**unsuffixed variable is the testnet slot**, and a **`_MAINNET` twin** is the
mainnet slot (`forArcNetwork()`). So a testnet deployment needs nothing renamed,
mainnet is configured by *adding* variables rather than editing them, and both
sets can sit there fully populated with one variable deciding which is live.

**Mainnet never falls back to the testnet slot.** A `_MAINNET` address left unset
resolves to the zero address, which every consumer already reads as "not
configured" and refuses on (`isBillRegistryConfigured()`,
`isHandleEscrowConfigured()`, `isMandateConfigured()`). Quietly using a testnet
address on chain 5042 is the exact failure that rule exists to stop.

Two things mainnet does not have, and neither is a bug:

- **ERC-8183 `AgenticCommerce` is absent**, so `NEXT_PUBLIC_AGENTIC_COMMERCE_ADDRESS`
  stays unset there, `isJobsConfigured()` is false, and the job-market half of
  autopay is off.
- **x402 batching cannot run on Arc mainnet at all**, and this one is not a
  variable: `@circle-fin/x402-batching` ships exactly one Arc entry, `arcTestnet`.
  So `getScoutGateway()` and `getSettlerGateway()` throw when the switch is
  `mainnet` rather than batching real-money nanopayments on a test chain. Scout is
  off on mainnet and the Settler cannot buy reviews; mandate-mode settlement,
  which signs through viem, is unaffected.

ERC-8004 **is** live on both networks, at different addresses, and is opt-in on
both (see [Payment Reputation](#payment-reputation-erc-8004)).

`docs/deployments.md` is the operational companion to this section: which host
runs which arrangement, and everything about it that is done by hand.

## Wallets

Two wallet stacks live in one repo, selected per deployment rather than per user.
`WALLET_PROVIDER` decides **who holds the wallet**; `WALLET_UI` decides **who
asks the user to approve a payment**. Both match exactly and both default to the
older stack, so a typo or an unset variable in a new environment can only ever
land on the Circle path.

| | `WALLET_PROVIDER=privy` + `WALLET_UI=privy` | unset (Circle) |
|---|---|---|
| Wallet | Privy **embedded** wallet, an EOA the user owns from creation | Circle developer-controlled wallet (SCA) |
| Login door | Privy's modal (X, Discord, Google, email) | Splitsy's own OAuth routes |
| Approving a payment | Privy's confirmation prompt, per transaction | a PIN that unlocks sends for five minutes |
| Settle net | 1 `approve` + 1 `settle` | 1 atomic `executeBatch` |
| Key export / claim ceremony | not applicable — it is already the user's | `WALLET_CLAIM_ENABLED`, off by default |

The Privy pair is what the deployed hosts run. Everything downstream of login is
untouched by the switch: `POST /api/auth/privy` verifies Privy's access token
server-side, maps the user onto the `users` row they already have, and sets the
ordinary Splitsy session cookie, so the ~40 route handlers calling
`getSessionUser()` never learn which stack they are on.

On the Privy path the **client** produces the signed transaction, so
`lib/privy-wallet.ts:matchesPrepared` compares it against the server's prepared
ticket before broadcasting. Without that, a user could sign anything at all from
their own wallet and have a route mark a debt paid.

## Setup

Install dependencies:

```bash
npm install
```

Create `.env.local` from `.env.example` and fill in the keys you need:

```bash
cp .env.example .env.local
```

`.env.example` is the authority on every variable and documents what each one
does and what its absence means. The ones worth naming here:

```ini
# ── which chain ─────────────────────────────────────────────────────────────
NEXT_PUBLIC_ARC_NETWORK=            # unset → testnet; `mainnet` → Arc mainnet
ARC_RPC_URL=https://rpc.testnet.arc.network   # optional keyed endpoint
ARC_RPC_URL_MAINNET=

# ── which wallet stack ──────────────────────────────────────────────────────
WALLET_PROVIDER=privy               # unset → circle
WALLET_UI=privy                     # unset → the app's own screens
PRIVY_APP_ID=... / PRIVY_APP_SECRET=...
PRIVY_KEY_QUORUM_ID=... / PRIVY_AUTHORIZATION_PRIVATE_KEY=wallet-auth:...
PRIVY_AGENT_POLICY_ID=...           # per-transaction cap, attached at wallet creation
CIRCLE_API_KEY=... / CIRCLE_ENTITY_SECRET=... / CIRCLE_WALLET_SET_ID=...

# ── Splitsy's own deployments (testnet slots; add _MAINNET twins for mainnet) ─
NEXT_PUBLIC_BILL_SPLIT_REGISTRY_ADDRESS=0x8e30ca7f7347854629619aec68bd29d7ebedbd48
NEXT_PUBLIC_HANDLE_ESCROW_ADDRESS=0xc29b959868828702c37811deba826da48f0e1a6d
NEXT_PUBLIC_RECURRING_TAB_FACTORY_ADDRESS=0x9Cc377C957255582BCa8084a950F52e59fB0a41E
BILL_SPLIT_REGISTRY_ADDRESS_V1=0x924Cf4331741401cBc720770937C132A974E1a3b

# ── the two attester keys (server-only, treat as money) ─────────────────────
ESCROW_ATTESTER_ADDRESS=0x... / ESCROW_ATTESTER_PRIVATE_KEY=0x...
REFUND_SLOT_ATTESTER_PRIVATE_KEY=0x...

# ── receipts and FX ─────────────────────────────────────────────────────────
RECEIPT_SCANNER_API_KEY=your_receipt_scanner_key
RECEIPT_SCANNER_MODEL=receipt-scanner-model
SCOUT_SECOND_OPINION_MODEL=...      # the stricter re-read
SCOUT_FALLBACK_MODEL=...            # used when the default model is in a 503 spike

# ── identity ────────────────────────────────────────────────────────────────
SESSION_SECRET=...                  # min 32 chars — signs the login session cookie
X_CLIENT_ID=... / X_CLIENT_SECRET=...              # Sign in with X
DISCORD_CLIENT_ID=... / DISCORD_CLIENT_SECRET=...  # Sign in with Discord
GOOGLE_CLIENT_ID=... / GOOGLE_CLIENT_SECRET=...    # Sign in with Google
RESEND_API_KEY=... / EMAIL_FROM=...                # Email-OTP delivery (Resend)

# ── deployment and automation ───────────────────────────────────────────────
DEPLOYER_PRIVATE_KEY=0x...          # only needed to deploy contracts
RECURRING_SETTLER_PRIVATE_KEY=0x... # server wallet that pays gas for recurring settlement
RECURRING_SETTLER_SECRET=...        # bearer token for /api/recurring/settle
AGENT_SECRET=...                    # bearer token for the autopay + dunning endpoints
CRON_SECRET=...                     # host-provided cron bearer token; both fall back to it

# ── Scout and the agent economy ─────────────────────────────────────────────
SCOUT_PRIVATE_KEY=0x...             # server-held EOA; generate with npm run scout:setup
SELLER_ADDRESS=0x...                # Splitsy treasury wallet — receives x402 earnings
SCOUT_DAILY_CAP_USDC=1              # Scout's daily spend ceiling in USDC (default 1)
SCOUT_ERC8004_TOKEN_ID=...          # set after scout:setup registers Scout on Arc
SETTLER_PRIVATE_KEY=0x...           # the Splitsy Settler EOA; x402 + ERC-8183 signer
NEXT_PUBLIC_AGENTIC_COMMERCE_ADDRESS=0x0747EEf0706327138c69792bF28Cd525089e4583
NEXT_PUBLIC_AUTOPAY_MANDATE_ADDRESS=0x...   # AutopayMandate deployment
NEXT_PUBLIC_AUTOPAY_AGENT_ADDRESS=0x...     # the Settler's address, named in new mandates
SETTLEMENT_FEE_USDC=0.01                    # optional, default 0.01
NEXT_PUBLIC_BASE_URL=https://your-deployment.vercel.app

# ── ERC-8004 (opt-in; unset means reputation is OFF, silently) ──────────────
ERC8004_IDENTITY_REGISTRY=0x8004A818BFB912233c491871b3d84c89A494BD9e
ERC8004_REPUTATION_REGISTRY=0x8004B663056A597Dffe9eCcC1965A193B7388713

# ── Circle Gateway (cross-chain payments — optional, raises rate limits) ────
NEXT_PUBLIC_CIRCLE_GATEWAY_API_KEY=...
```

Unsetting `SETTLER_PRIVATE_KEY` or `NEXT_PUBLIC_AGENTIC_COMMERCE_ADDRESS` reads
as **autopay off**, never as "run the settlement without the job". The same rule
holds throughout: unset means refuse, never "do it somewhere else".

Every `NEXT_PUBLIC_*` value is inlined at **build** time, so changing one needs a
redeploy rather than a saved variable — and an *unset* one leaves a live
per-request read behind, so the age of a build is no defence against a
mis-scoped value.

### Sign-in providers

Splitsy identifies a person by one of four providers, each giving them a wallet
on first sign-in (no seed phrase, no browser wallet needed):

- **X**, **Discord**, **Google** — OAuth 2.0 (PKCE). Configure the matching
  `*_CLIENT_ID` / `*_CLIENT_SECRET` and register the callback
  `<origin>/api/auth/<provider>/callback`. With `WALLET_UI=privy` these are
  registered in the Privy dashboard instead, and the four buttons collapse into
  one modal.
- **Email-OTP** — a 6-digit code emailed via [Resend](https://resend.com). Set
  `RESEND_API_KEY` and `EMAIL_FROM` (a verified sender), and create the
  `email_otps` table by running `schema-otp.sql` once in the Supabase SQL editor.

Google and Email-OTP both resolve to the **same** email-keyed identity, so a
person who signs in either way shares one account and one wallet. X and Discord
are separate namespaces (an X `@alice` and a Discord `alice` are different
people). Each provider is independent — enable only the ones you configure.

Supabase holds the off-chain half: users, bills, escrow deposit index, the x402
ledger, and the reputation mirror. The `schema-*.sql` files at the repo root are
each run once in the Supabase SQL editor; all of them are additive.

## Development

Run the app:

```bash
npm run dev
```

Open `http://localhost:3000`.

Useful scripts:

```bash
npm run lint
npm run build

# unit tests (node --test, no framework)
npm run test:arc-chain        # which network a deployment resolves to
npm run test:escrow           # handle escrow, release relay, slots
npm run test:settle           # settle-item planning and registry reads
npm run test:iou              # the two IOU rails
npm run test:netting
npm run test:treasury
npm run test:dashboard
npm run test:landing
npm run test:agents
npm run test:footer           # the addresses the footer prints
npm run test:wallet-provider  # both wallet stacks
npm run test:scout
npm run test:gateway
npm run test:contracts        # Hardhat / Solidity

# contract deployment — same scripts, two networks
npm run deploy:arc:bill-registry       npm run deploy:arc-mainnet:bill-registry
npm run deploy:arc:handle-escrow       npm run deploy:arc-mainnet:handle-escrow
npm run deploy:arc:factory             npm run deploy:arc-mainnet:factory
npm run deploy:arc:autopay-mandate     npm run deploy:arc-mainnet:autopay-mandate

# one-time per environment
npm run scout:setup      # Scout's EOA, ERC-8004 identity, Gateway deposit
npm run settler:setup    # the Settler EOA, its identity, its Gateway deposit
npm run agents:setup     # ERC-8004 identities for the Auditor and the Validator
npm run privy:setup      # the Privy key quorum this deployment signs with
npm run privy:policy     # a per-transaction agent cap; prints the policy id
npm run audit:contracts  # slither
```

## Demo Flow

1. **Say what is owed.** The IOU tab opens with one sentence: pick a direction,
   name a person by handle, email or address, and enter an amount. "They owe me"
   files a one-participant bill in the registry; "I owe them" sends the USDC.
2. **Or scan a receipt.** Scout assesses image quality (size + dimensions), then
   pays Splitsy's own `/api/ocr` endpoint in USDC via x402 ($0.005/call). Below
   0.8 parse confidence, and with budget left, it buys a second opinion and keeps
   the better result.
3. Review the parsed merchant, totals, tax, tip, line items and confidence. A
   Scout identity card shows the agent's on-chain ERC-8004 address and the
   nanopayments it made.
4. Convert non-USD bills into USD (Scout pays `/api/fx` at $0.001/call if needed).
5. Split equally or enter manual payer amounts. Tag payers by handle, email or
   address; a payer with no wallet yet gets a **derived slot** rather than a
   custodial wallet.
6. Submit the split bill. Optionally set a "pay by" date, which unlocks
   **all-or-nothing** bills (nothing is claimable until everyone has settled).
7. Debtors sign in — or connect the matching browser wallet — and see only their
   own unpaid shares.
8. Debtors pay fully or partially on Arc with a transaction memo, or use
   **Circle Gateway** to pay from Avalanche, Base or Ethereum in a two-step flow
   (sign a burn intent on the source chain, then mint on Arc).
9. The splitter claims paid funds from the registry.
10. **Money sent to someone with no wallet** waits in `HandleEscrow`. Their first
    sign-in as that handle releases it; the sender can `reclaim` any time before
    that.
11. Open the Treasury view on the dashboard: every open debt and credit collapses
    to one net figure per counterparty. Hit "Settle net" — one `settle` call
    carries every claim and pay leg (see
    [Net-Settlement Treasury](#net-settlement-treasury)).
12. Create weekly, monthly or custom recurring tabs. Payers approve the tab as a
    constrained USDC spender; funds stay in their wallets until the backend
    settler pulls a due cycle.
13. Fund your own agent from the settlement-agents panel and switch autopay on.
    The next bill raised against you is settled by that agent as an ERC-8183
    job — expand the log row for every ceremony transaction, the live job status,
    and the x402 payments that gated it.

The repository includes a small sample image at `.tmp/test-receipt.png` for local
receipt-scan testing.

## Paying Someone Who Has No Wallet

Two contracts-level mechanisms, for the two things that can happen when you name
a stranger. Both exist because `BillSplitRegistry` records debts by **address**
and needs every participant's address at creation.

### `HandleEscrow` — money waiting for a person

`contracts/HandleEscrow.sol` holds USDC against
`keccak256("<provider>:<handle>")`, and nothing else about the recipient. Both
settle rails deposit into it when the recipient has never signed in:

| Entry point | Who calls it | What it does |
|---|---|---|
| `deposit(handleHash, amount)` | the sender's wallet | moves USDC in and returns a deposit id |
| `release(id, to, deadline, signature)` | anyone | pays the deposit to `to`, authorised by the attester's EIP-712 signature |
| `reclaim(id)` | the depositor only | takes it back, unconditionally, any time before a release |

The first sign-in as that handle triggers the release inside the login
(`lib/escrow-release.ts`), relayed by a server wallet that pays the gas. Three
properties hold it together, and they hold each other up:

- **The attester is immutable.** There is no setter and no owner. Rotating the
  key means redeploying, and until then deposits are releasable only by the old
  key.
- **`reclaim` is unconditional.** That is what makes the immutable attester safe:
  if the key is ever compromised, depositors take their money back and the
  contract is redeployed under a new attester.
- **A release is relayed, not sent by the recipient.** So a person with no wallet
  and no gas can still be paid.

Releases fail *silently* if the relayer runs out of USDC (Arc charges gas in
USDC): deposits stay safe and reclaimable, the login still succeeds, and money
simply stops arriving. Keep the releaser funded — `docs/deployments.md` has the
addresses and the measured cost per release.

### Derived handle slots — an address with no key

`lib/handle-slot.ts` turns a handle into an address: the low 160 bits of
`keccak256("<provider>:<handle>")`. Tagging `@dani` on two bills therefore files
the same address both times, and **nobody holds a key to it** — which is the
point. It is a filing key, never a proof of identity, and it replaced the older
path that minted a custodial wallet for every tagged stranger.

Money can be *paid toward* a slot's share (a third party settling it, an autopay
agent) but can never rest at the slot itself. That leaves one hole a failed
all-or-nothing bill would otherwise open, since `refund` pays `msg.sender` and a
slot has no `msg.sender` to be. `BillSplitRegistry.refundSlot(billId, slot, to,
deadline, signature)` is the answer: permissionless to call, authorised by an
EIP-712 signature over all four arguments, and it pays `to` — the user's real
wallet — instead of the slot.

Both signatures come from the same key (`ESCROW_ATTESTER_PRIVATE_KEY` /
`REFUND_SLOT_ATTESTER_PRIVATE_KEY`), which is one key to guard rather than two.
What that concedes is bounded and stated: a stolen key can misdirect a refund or
a release, but the signature binds `to` at signing time, so it cannot pay a
non-participant and cannot invent an amount. The contract pays what is actually
held. The two EIP-712 domains are deliberately different, so a release signature
can never verify as a refund.

## Circle Gateway (Cross-Chain Payments)

Payers with USDC on Avalanche Fuji, Base Sepolia or Ethereum Sepolia can pay
bills on Arc Testnet directly from those chains using Circle's Gateway
contracts — no separate bridge UI, no wrapping.

### Two-step flow

1. **Sign burn intent** — the payer's wallet signs an EIP-712 `BurnIntent` on the
   source chain (gas-free, just a signature).
2. **Mint on Arc** — Splitsy calls the Gateway API, receives an attestation,
   prompts the wallet to switch to Arc, and executes `gatewayMint` on the
   `GatewayMinter` contract.

The settlement lands on Arc within seconds. The entire flow is client-side — no
server-side keys involved.

### Key files

| File | Purpose |
|---|---|
| `lib/gateway-contracts.ts` | Gateway contract addresses and chain configs for all supported chains |
| `lib/gateway-browser.ts` | EIP-712 signing, Gateway API attestation, mint transaction data |
| `app/pay/[token]/PayClient.tsx` | "Pay via Gateway" button, chain picker, two-step UI |

### Supported source chains (testnet)

| Chain | Source domain | USDC |
|---|---|---|
| Avalanche Fuji | 1 | `0x5425...Bc65` |
| Base Sepolia | 6 | `0x036C...CF7e` |
| Ethereum Sepolia | 0 | `0x1c7D...7238` |

The destination is always **Arc** (domain 26). Gateway is permissionless — no API
key is required for basic usage. Set `NEXT_PUBLIC_CIRCLE_GATEWAY_API_KEY` to
raise rate limits. Arc's own Gateway Wallet and Minter addresses differ between
the two networks and are resolved from `lib/arc-chain.ts`, never set by hand.

See `docs/gateway-browser-wallet-integration.md` for the full implementation
guide.

## Scout Agent (x402 Nanopayments)

Scout is a server-side autonomous agent that pays for Splitsy's own OCR and FX
endpoints in USDC fractions via Circle Nanopayments (x402) on Arc Testnet.

### How it works

Every receipt upload routes through `POST /api/scout/scan`. Scout runs a
decision loop driven by three signals:

1. **Image quality** (`lib/scout/decide.ts:assessImage`) — rejects images under
   8 KB or 200 px on either edge before spending anything.
2. **Parse confidence** — if the OCR result's `confidence` is below 0.8 and daily
   budget remains, Scout pays for a second-opinion pass with a stricter prompt
   and takes the better result. If the model itself is in a 503 spike, it buys one
   parse from `SCOUT_FALLBACK_MODEL` over the same paid path.
3. **Remaining budget** (`lib/x402/spend.ts:canSpend`) — enforces the
   `SCOUT_DAILY_CAP_USDC` ceiling. When exhausted, Scout returns the best-effort
   parse with a `lowConfidence` flag.

If the paid path fails at any point, the route falls back to a direct internal
call to `lib/ocr-core.ts` so the human upload UX never breaks.

### Prices

Defined once in `lib/x402/pricing.ts`:

| Endpoint              | Price per call | Seller             | Buyer                          |
|-----------------------|----------------|--------------------|--------------------------------|
| `/api/ocr`            | $0.005 USDC    | Splitsy            | Scout, per scan                |
| `/api/fx`             | $0.001 USDC    | Splitsy            | Scout, non-USD receipts only   |
| `/api/agents/review`  | $0.002 USDC    | the Splitsy Auditor | the Splitsy Settler, per settlement |

All three are public to anyone who pays — that is what makes them a market rather
than an internal call.

### Scout's wallet

Scout is a **server-held EOA** (`SCOUT_PRIVATE_KEY`), not a managed wallet.
`lib/scout/wallet.ts` constructs a `GatewayClient` from
`@circle-fin/x402-batching` with `chain: "arcTestnet"` — and **throws on
mainnet**, because that SDK has no mainnet Arc entry. The rest of Splitsy uses
whichever wallet stack is configured; Scout's EOA is only its x402 payment
signer.

### x402 seller endpoints

`/api/ocr` and `/api/fx` are wrapped by `lib/x402/seller.ts`'s `withGateway`
HOF. Unauthenticated requests receive HTTP 402 with a `PAYMENT-REQUIRED`
challenge. The facilitator is Circle's `BatchFacilitatorClient`
(`@circle-fin/x402-batching`), and a buyer always buys from **this network's**
facilitator.

`maxTimeoutSeconds` is **not** hardcoded. The seller calls `getSupported()` once
and reads Arc's `minValiditySeconds` from the facilitator itself, then adds a
one-hour margin (`VALIDITY_MARGIN_SECONDS`) because Gateway checks the validity
*remaining* at verification time, not at signing time. If `getSupported()` fails,
it falls back to `604800` (7 days) — Gateway's current minimum for Arc — and
retries on the next request.

That fallback is deliberately **not** the `345600` (4 days) that the SDK's own
middleware hardcodes: the buyer signs `validBefore = now + maxTimeoutSeconds`, so
anything under the facilitator's minimum is rejected as
`authorization_validity_too_short` and no payment can ever settle.

### ERC-8004 identity

Scout is registered on Arc's canonical IdentityRegistry for the network it runs
on. The upload UI shows a Scout identity card linking to the explorer.

### Payments ledger

Every earned and spent payment is recorded in the `x402_payments` Supabase
table (schema: `schema-x402-payments.sql`). The "Agent economy" panel in the
dashboard shows earnings, spend, calls served, and remaining daily budget,
fetched from `GET /api/scout/stats`.

### Scout setup (one-time per environment)

```bash
# 1. Generate Scout's EOA, register ERC-8004, make initial Gateway deposit
npm run scout:setup

# 2. Apply the payments table
#    Run schema-x402-payments.sql in the Supabase SQL editor

# 3. Add SCOUT_PRIVATE_KEY, SELLER_ADDRESS, SCOUT_ERC8004_TOKEN_ID to .env.local
```

Fund Scout's EOA with test USDC from the [Circle faucet](https://faucet.circle.com)
before running.

See `docs/scout-agent.md` for full technical details.

## Agent Economy (ERC-8183 settlement jobs)

Debtor-side autopay is not one hosted wallet calling `payFor`. Every settlement
runs as an [ERC-8183](https://eips.ethereum.org/EIPS/eip-8183) job on the
already-deployed `AgenticCommerce` contract at
`0x0747EEf0706327138c69792bF28Cd525089e4583` (Arc Testnet; absent on mainnet),
with three **distinct** wallets so no agent grades its own work:

| Job role | Who | Wallet kind | Why |
|---|---|---|---|
| client | the **user's own agent** | managed wallet, keyed `agent:<userId>` | posts the job and escrows the fee |
| provider | the **Splitsy Settler** | raw EOA (`SETTLER_PRIVATE_KEY`) | x402 needs a raw key to sign EIP-3009; a managed wallet will not hand one over |
| evaluator | the **Splitsy Auditor** | managed wallet, keyed `splitsy:auditor` | it is paid to say no |

### Users must fund their own agent

Autopay under a mandate alone used to need no user funding. Now every account has
one agent (`agent:<userId>` — one per *account*, so it covers the Splitsy wallet
and any linked browser wallet) that pays its own gas (Arc charges gas in USDC),
escrows the job fee, and in the mode the UI offers pays the bill share out of its
own balance.

Its balance is therefore the **hard ceiling**: funding is a plain USDC transfer,
custody rather than an allowance, so an agent holding 5 USDC can never spend 6.
Before starting, `settleOne` requires `fee + 0.20 USDC gas headroom + share`;
short of that it logs `agent_unfunded` and **creates no job**, so an underfunded
agent costs nothing.

On the Privy stack the per-transaction cap is enforced **inside Privy's enclave**,
attached to the signer at wallet creation (`PRIVY_AGENT_POLICY_ID`), so it applies
from the agent's first signature and cannot be argued with by a bug in
`decideAutopay`. The rolling daily cap stays off-chain in
`sumAutopaySpentTodayUsdc` on both stacks.

The dashboard's settlement-agents panel has a **Fund** dialog with three routes:
a USDC `transfer` signed by the connected browser wallet, a server send from the
user's Splitsy wallet (`POST /api/wallet/send`), or an ordinary inbound transfer
to the agent's address from anywhere. Suggested first top-up: 2 USDC.

### The ceremony — 6 transactions per settled share

```
0. decide       lib/autopay.ts rules, then a bill review BOUGHT from the
                Auditor over x402. Any refusal stops here: no job, 0 tx.
1. createJob    the user's agent   ← client
2. setBudget    the Settler        ← the provider prices its own work
3. fund         the user's agent   → the fee (SETTLEMENT_FEE_USDC) into escrow
4. settle       payDebtFor (user's agent)  |  payFor (Settler, mandate mode)
5. submit       the Settler        → keccak256(settlementTxHash)
6. complete     the Auditor, ONLY after reading getParticipant on chain and
                seeing paid >= owed
```

Six transactions per settled **share**, not per bill — a four-participant bill is
four independent jobs. A skip costs zero. Two USDC `approve`s sit outside the six
and are lazy (sent only when the allowance is short, for 100× the amount), so
they amortise across ~100 settlements. The escrow only ever holds the fee; the
bill money is never in it, so a failed settlement strands at most
`SETTLEMENT_FEE_USDC` until the job expires (`JOB_TTL_SECONDS = 3600`).

Step 6 is not a rubber stamp: the Auditor reads `BillSplitRegistry.getParticipant`
itself and completes only when `paid >= owed`. The deliverable is
`keccak256(settlementTxHash)`, so anyone holding the settlement transaction can
recompute it and check the job against it.

`payDebtFor` pulls from `msg.sender`, credits the `debtor`, and emits `DebtPaid`
naming the **debtor** as payer — so reputation flows to the user, not to their
agent, and the existing scoring path is untouched.

### The paid bill review

`lib/autopay-review.ts` used to be a free internal call. It is now
`POST /api/agents/review`, sold by the Auditor at $0.002 and bought by the
Settler over x402 out of its job-fee income. Both sides land in `x402_payments`
(`earned` by the seller wrapper, `spent` by the Settler — recorded *before* the
body is inspected, because by then Gateway has already settled the payment).
Every failure direction is a refusal: a 402, a timeout, an unparseable verdict, a
missing key, or a settlement failure. **A Settler that cannot buy a review
settles nothing.**

### Setup

```bash
# 1. Apply the schema (additive; adds no table)
#    Run schema-agent-economy.sql in the Supabase SQL editor:
#    autopay_log.job_id/.job_status/.fee_usdc, autopay_grants.money_mode,
#    users.agent_wallet_address/.agent_wallet_id

# 2. Generate the Settler EOA — prints SETTLER_PRIVATE_KEY and
#    NEXT_PUBLIC_AUTOPAY_AGENT_ADDRESS
npm run settler:setup

# 3. Fund it from https://faucet.circle.com, then re-run to register its
#    ERC-8004 identity and make its Gateway deposit
npm run settler:setup

# 4. Register ERC-8004 identities for the Auditor and the Validator.
#    Idempotent (keyed on reputation_agents, guarded on chain by balanceOf).
#    It prints each wallet's address — fund from the faucet and re-run.
npm run agents:setup

# 5. On the Privy stack, mint the agent policy BEFORE any user signs in — it
#    attaches at wallet creation and nowhere else, so a wallet minted without
#    one is uncapped in the enclave forever.
npm run privy:policy -- 5      # per-transaction cap in USDC; prints the id

# 6. Set NEXT_PUBLIC_AGENTIC_COMMERCE_ADDRESS, then tell existing users to
#    RE-ARM their mandates: the Settler's address replaces the old
#    splitsy:autopay-agent wallet named in them.
```

The registrar is deliberately excluded from `agents:setup` — a wallet whose job
is transiently holding other agents' NFTs must not also hold one of its own.

Dunning (`POST /api/agents/dunning`, Bearer `AGENT_SECRET` or `CRON_SECRET`) is
the creditor-side counterpart, and its ladder is exactly two rungs plus a pull:
nudge three days before the due date, escalate after it, and — only where the
debtor granted a per-bill collect mandate and the creditor's wallet can still be
signed for — `collectDebt`. Like recurring settlement it spends money, so Vercel
runs it on Production only.

See `docs/agent-economy.md` for the full design, the two money modes, the
decision-log semantics, and the manual verification checklist.
`docs/autopay-agent.md` covers the mandate contract, arming from a browser
wallet, and running your own agent wallet.

## Net-Settlement Treasury

The Treasury view (dashboard → Treasury tab) aggregates every open on-chain
bill position into one net figure per counterparty.

### The escrow constraint

`BillSplitRegistry.payDebt` is escrow-bound to a specific `billId` — debts
cannot be routed through third parties or cancelled against each other on-chain.
Netting is a **view-level truth** (your true net exposure per counterparty). The
execution win is **transaction batching**, not fewer USDC moved.

### Settlement paths

The registry carries the batch itself:
`settle(claimBillIds, payBillIds, payAmounts)` runs every claim first — so the
proceeds can fund the pay legs inside the same transaction — then every payment,
all-or-nothing. A `payAmount` of `0` means "my whole remaining share", resolved
at execution time so a concurrent payment cannot make the leg revert on a stale
figure. Both arrays are bounded by `MAX_BATCH` before either loop runs.

| Wallet type | What happens |
|---|---|
| Circle developer-controlled (SCA) | 1 atomic `executeBatch` carrying the `approve` and the `settle` |
| Privy embedded wallet (EOA) | 1 `approve` + 1 `settle` — two prompts |
| Browser EOA | 1 `approve` + 1 `settle` |

Every EOA costs two transactions whatever the leg count, and a selection with
nothing to pay costs one (there is no approval to send). An EOA cannot do the
batch: it does not revert on calldata it cannot run, it **succeeds and does
nothing** — measured, not reasoned, in `docs/deployments.md`. Which of the two
legs a request sends is read from the on-chain allowance rather than tracked in
the browser, so a reload resumes wherever the chain actually is. Splitting the
`approve` off does not split the settlement: an `approve` that lands without its
`settle` leaves an unspent allowance, never a half-paid bill.

The bill-by-bill baseline it replaces is `2 × payLegCount + claimLegCount`
transactions.

### Read model

`lib/treasury.ts:buildTreasury` is a pure function that folds registry reads
into `TreasuryPlan`: one `TreasuryPosition` per counterparty (both directions
netted), sorted by absolute net descending. All money arithmetic is base-unit
`bigint`; only `unitsToUsdc` crosses the wire boundary.

See `docs/treasury.md` for full technical details.

## Contracts

Splitsy deploys three contracts of its own. Everything else it touches — USDC,
the ERC-8004 registries, `AgenticCommerce`, Gateway — is already on Arc.

- `contracts/BillSplitRegistry.sol` — bills, participant debts, partial
  payments, claimable splitter funds, all-or-nothing escrow, refunds, the
  `settle` batch, and `refundSlot`.
- `contracts/HandleEscrow.sol` — USDC held for a handle that has no wallet yet.
- `contracts/RecurringTabFactory.sol` + `contracts/RecurringTab.sol` — one tab
  contract per recurring agreement.

Both flows build on shared, audited security primitives instead of external
dependencies:

- `contracts/security/ReentrancyGuard.sol` — `nonReentrant`, inherited by every
  fund-moving entrypoint.
- `contracts/libraries/SafeERC20.sol` — reverting wrappers around
  `transfer`/`transferFrom` for non-standard ERC-20 tokens.
- `contracts/interfaces/IERC20.sol` — minimal ERC-20 interface used to read
  approvals and balances and to move USDC.

No contract has an owner, an upgrade path, a pause, a sweep or a
`selfdestruct`. Funds can only ever leave to a bill's splitter, a refunded
payer, a tab's immutable recipient, or an escrow deposit's recipient or
depositor.

### Current Arc Testnet deployment

```text
BillSplitRegistry:   0x8e30ca7f7347854629619aec68bd29d7ebedbd48   (v3)
HandleEscrow:        0xc29b959868828702c37811deba826da48f0e1a6d
RecurringTabFactory: 0x9Cc377C957255582BCa8084a950F52e59fB0a41E
USDC:                0x3600000000000000000000000000000000000000
Gateway Wallet:      0x0077777d7EBA4688BDeF3E311b846F25870A19B9
```

`AutopayMandate` has a deployment at
`0xb5703Db1dc62DDf8CBd6cb39F9f93F03Ca1C8Aff`, but
`NEXT_PUBLIC_AUTOPAY_MANDATE_ADDRESS` is **unset in every current environment**,
so `isMandateConfigured()` is false and mandate-mode autopay is off. Autopay runs
in funded mode instead, out of the user's own agent balance.

Pre-deployed on Arc, not ours — see the full table under
[Arc Constants](#arc-constants):

```text
ERC-8004 IdentityRegistry:  0x8004A818BFB912233c491871b3d84c89A494BD9e
AgenticCommerce (ERC-8183): 0x0747EEf0706327138c69792bF28Cd525089e4583
```

Browse any of them at `https://testnet.arcscan.app/address/<address>`. The
registry and the escrow share one immutable attester,
`0xEE42a492B183CdFf04439F2Cb6A9c49F857F70AC`, readable from both with
`attester()`.

**Registry v3 is not a drop-in for its predecessors.** It adds `settle`,
`refundSlot` and the attester, and **bill ids restart at 1 per deployment**, so
an id only means something next to the registry it came from. The registry v3
replaced is kept readable through `BILL_SPLIT_REGISTRY_ADDRESS_V1`
(`0x924Cf4331741401cBc720770937C132A974E1a3b`) so history survives; an even
earlier one at `0x867051b5F840F045B3c72a091B1b6453c86E120B` predates
`payDebtFor`, `authorizeCollect`, `collectDebt` and `refund`, and this codebase
will not work against it at all.

**Nothing is deployed on Arc mainnet yet.** The `_MAINNET` address slots are
blank, and every consumer refuses on a zero address rather than falling back.

More details are in `docs/snapsplit-contract.md`.

## Payment Reputation (ERC-8004)

Payers earn verifiable on-chain reputation using Arc's pre-deployed
[ERC-8004](https://eips.ethereum.org/EIPS/eip-8004) registries (no Splitsy
contract changes). After a wallet pays its full share of an on-chain bill:

1. The payer's wallet gets an identity NFT on the IdentityRegistry (lazily,
   first payment only).
2. A dedicated Splitsy validator wallet records scored feedback on the
   ReputationRegistry, with
   `feedbackHash = keccak256("splitsy:bill:<billId>:<payTx>")` so any score can
   be re-verified against the `DebtPaid` event it claims to describe.
3. The bill-creation UI shows a badge ("Paid N bills in full on Arc · 97/100
   timeliness") for tagged payers, via `GET /api/reputation`.

**Timing scores.** Bill creators can set an optional "Pay by" date, committed
into the bill's on-chain `metadataHash` so it can't be moved later. Each payment
is graded against it using the `payDebt` **block timestamp** (never a server
clock): no due date, or paid within the due date + a 2-day grace window, scores
100 (`paid_in_full` / `paid_on_time`); later loses 5 points per whole day down to
a floor of 50 (`paid_late`). Paying is always positive — a payment never made
records nothing. The badge average is **amount-weighted** by each payment's USDC
share, so a large late bill drags more than a small one; per-payment on-chain
scores stay simple and independently verifiable. The pure scoring curve lives in
`lib/reputation-score.ts` (unit-tested in `lib/reputation-score.test.ts`).

All three payment shapes earn reputation:

- **Server-routed payments** go through the pay route, which records feedback in
  an `after()` hook once `payDebt` settles. A Circle wallet signs its own
  identity registration (it just paid, so it holds gas). A **Privy embedded**
  wallet cannot — it is the user's from creation and Splitsy holds no key for
  it — so those registrations take the registrar route below, exactly as a
  browser payer's does.
- **Browser / non-custodial payments** settle on-chain directly and never touch
  the server, so a Circle Smart Contract Platform event monitor on
  `BillSplitRegistry.DebtPaid` POSTs to the webhook
  (`app/api/webhooks/circle`). Splitsy can't sign as the payer's wallet, so a
  dedicated **registrar** wallet mints their identity NFT and then transfers it
  to the payer, who ends up owning it — a third wallet, distinct from the
  validator, so ERC-8004's no-self-scoring rule still holds. Registration and
  scoring are each serialized by a DB claim, because a managed-wallet payment
  fires both the pay route's hook and this webhook. Only paid-in-full
  settlements (`paidTotal >= owedTotal`) are scored.
- **Recurring tab cycles** are scored by the settle route after each confirmed
  `settleTab`: every member the settlement collected from earns one independent
  score per cycle (keyed `tab:<id>:cycle:<n>`), graded against that cycle's
  boundary. Consent is the member's standing USDC approval to the tab.

**Consent policy:** feedback is positive-only and recorded only for payments the
wallet itself made — a debt someone merely tags you into can never touch your
score, so fake bills can't grief anyone. "No history" always displays as
neutral.

**Verify a score yourself:** open the `giveFeedback` tx on the explorer
(mirrored as `feedback_tx` in `reputation_feedback`), recompute
`keccak256("splitsy:bill:<billId>:<payTx>")` from its tag + `fileuri` fields and
compare to the committed `feedbackHash`, confirm the payment tx emitted a
matching paid-in-full `DebtPaid`, then pull the bill's preimage, recompute the
metadata hash, and apply the scoring curve to the committed due date vs. the
payment's block timestamp — you reproduce the exact score. The `/docs` page walks
through this step by step.

**Regenerate from chain data:** the Supabase mirror (`reputation_feedback`)
exists only for fast display — the chain is the audit trail. If the mirror is
lost or the webhook missed events, replay history through the same scoring path:

```bash
node --env-file=.env.local --experimental-strip-types scripts/circle-scp-replay.ts
```

It pulls the `DebtPaid` events Circle stored under the monitor and re-runs
scoring; idempotent per (payer, bill), so re-running never double-counts.

Setup:

1. Run `schema-reputation.sql` in the Supabase SQL editor (additive — also adds
   the `share_units` / `due_date` / `paid_at` columns to existing deployments).
   Run `schema-onchain-bill-preimages.sql` too if upgrading: it adds the
   `due_date` column that timing scores read.
2. **Set the two registry addresses** (`ERC8004_IDENTITY_REGISTRY` /
   `ERC8004_REPUTATION_REGISTRY`, or their `_MAINNET` twins on mainnet — both
   pairs are in `.env.example`). Reputation is opt-in: unset means OFF, and off
   is **silent** — payments succeed, `ensureAgent` returns an empty id and
   nothing is minted or scored. On mainnet the registries are live but the
   variables stay blank until the registrar and validator wallets are funded
   there, because turning it on spends real gas on the first bill anybody pays.
3. Fund two auto-created wallets with a little Arc USDC for gas
   (https://faucet.circle.com on testnet): the validator (keyed
   `splitsy:reputation-validator`) and the registrar (keyed
   `splitsy:reputation-registrar`). Both are created on first use; until funded,
   payments still succeed and only the reputation side effect is skipped (logged
   server-side).
4. To score browser payments, register the `DebtPaid` event monitor once:
   `node --env-file=.env.local --experimental-strip-types scripts/circle-scp-monitor-setup.ts`.
   This imports the registry into Circle's Contracts platform and creates the
   monitor. Make sure your webhook is subscribed to Smart Contract Platform
   (`contracts.eventLog`) notifications in the Circle console.

**Optional IPFS metadata:** For full ERC-8004 compliance with discoverable agent
profiles, set `PINATA_JWT` in `.env.local` with a Pinata API key that has
**pinFileToIPFS** permission (create at https://app.pinata.cloud). Without it,
registration falls back to `data:` URIs — reputation still works, just without
off-chain metadata discovery.

Also set `PINATA_GATEWAY` to your dedicated gateway host (e.g.
`your-name.mypinata.cloud`, shown on Pinata's Gateways page). The agent artwork
is written into the NFT as an `https://` URL on that gateway rather than
`ipfs://`, because explorers resolve `ipfs://` through a public gateway and
public gateways cannot retrieve these pins — dweb.link and ipfs.io both time out
on a 324 KB image that Pinata's own gateway serves in under two seconds. Without
it the metadata is still correct and the image link still carries its CID, but
the picture won't render. Tokens minted before it was set can be re-pointed with
`scripts/reputation-backfill.ts`.

## Recurring Collection

The recurring tab is designed for subscriptions such as weekly shared bills or
monthly services.

- The splitter creates a tab with a recipient, cycle length, member wallets, and
  fixed USDC shares.
- Each payer connects once and approves the tab contract for a chosen USDC limit.
- Funds remain in payer wallets until the cycle is due.
- The backend calls `settleTab()` on a schedule. The contract pulls the fixed
  share from each payer with enough balance and allowance, skips the others, and
  makes collected USDC claimable to the recipient.
- Payers can revoke by setting the tab allowance back to `0`.

### Backend recurring settlement

Recurring settlement is not a user wallet action. The app exposes a protected
server route:

```bash
curl -X POST "$APP_URL/api/recurring/settle" \
  -H "Authorization: Bearer $RECURRING_SETTLER_SECRET"
```

The route scans every tab in `NEXT_PUBLIC_RECURRING_TAB_FACTORY_ADDRESS` and
submits settlement transactions from `RECURRING_SETTLER_PRIVATE_KEY`. It skips
tabs that are not due, have no collectible members, or are already complete.

`vercel.json` schedules this route every hour, every day:

```json
{
  "path": "/api/recurring/settle",
  "schedule": "0 * * * *"
}
```

Set `CRON_SECRET` or `RECURRING_SETTLER_SECRET` in the hosting environment so
cron requests include the matching bearer token. Vercel runs crons on Production
only, which is what keeps a preview deployment from spending money against the
same rows.

The allowance-based recurring contract differs from the older prepaid tab
deployment. Redeploy `RecurringTabFactory` and update
`NEXT_PUBLIC_RECURRING_TAB_FACTORY_ADDRESS` before testing recurring collection.

## Arc Constants

Everything in this table follows `NEXT_PUBLIC_ARC_NETWORK` and is resolved in
`lib/arc-chain.ts` — never set variable by variable.

| Name | Arc Testnet | Arc mainnet |
|---|---|---|
| Network CAIP-2 | `eip155:5042002` | `eip155:5042` |
| USDC | `0x3600000000000000000000000000000000000000` | same |
| Gateway Wallet | `0x0077777d7EBA4688BDeF3E311b846F25870A19B9` | `0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE` |
| Gateway Minter | `0x0022222ABE238Cc2C7Bb1f21003F0a260052475B` | `0x2222222d7164433c4C09B0b0D809a9b52C04C205` |
| Gateway API | `https://gateway-api-testnet.circle.com/v1` | `https://gateway-api.circle.com/v1` |
| RPC | `https://rpc.testnet.arc.network` | `https://rpc.mainnet.arc.io` |
| Explorer | `https://testnet.arcscan.app` | `https://explorer.arc.io` |
| ERC-8004 IdentityRegistry | `0x8004A818BFB912233c491871b3d84c89A494BD9e` | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` |
| ERC-8004 ReputationRegistry | `0x8004B663056A597Dffe9eCcC1965A193B7388713` | `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` |
| AgenticCommerce (ERC-8183) | `0x0747EEf0706327138c69792bF28Cd525089e4583` | not deployed |
| x402 batching | supported | **not supported by the SDK** |

Gas on both networks is paid in USDC, and the native unit reports 18 decimals of
precision while the ERC-20 interface at the same address reports 6. Read the
ERC-20 for balances, never the native unit.

## Stack

- Next.js `16.2.9` with the App Router, React `19.2.4`.
- Viem `2.52.2` for every chain read and write; wagmi + RainbowKit for browser
  wallets.
- `@privy-io/node` + `@privy-io/react-auth` for the embedded-wallet stack,
  `@circle-fin/developer-controlled-wallets` for the managed one.
- Circle Gateway (`@circle-fin/provider-gateway-v1`) and CCTP
  (`@circle-fin/provider-cctp-v2`) for cross-chain USDC.
- `@circle-fin/x402-batching` for the x402 buyer clients (Scout, the Settler) and
  the seller facilitator.
- ERC-8004 (identity + reputation) on Arc's pre-deployed registries, and
  ERC-8183 (job escrow) on the already-deployed `AgenticCommerce` contract — no
  Splitsy agent contracts.
- Hardhat `3.9.0` for contract tests and Arc deployment; slither for the audit
  pass.
- Supabase for the off-chain ledger, and a server-side receipt scanning API.

## Current Verification

These checks pass locally:

```bash
npm run lint
npm run test:arc-chain
npm run test:escrow
npm run test:settle
npm run test:iou
npm run test:netting
npm run test:treasury
npm run test:footer
npm run test:agents
npm run test:landing
npm run build
```

`npm run test:contracts` requires the local Hardhat/Solidity test environment to
be available.
