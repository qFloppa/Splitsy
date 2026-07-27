# Splitsy

Splitsy is a Next.js prototype for scanning receipts, splitting shared costs, and collecting payments on Arc Testnet. It combines:

- Receipt scanning via an autonomous OCR agent ("Scout") that pays for AI tooling in USDC fractions using Circle Nanopayments (x402).
- Social sign-in via X, Discord, Google, or a one-time email code — each provisions a Circle test-USDC wallet.
- FX conversion into USD.
- Equal or manual bill splitting.
- Onchain bill submission and wallet-based debt discovery.
- Arc transaction memos for bill payment reconciliation.
- Circle AppKit bridging from supported CCTP source chains into Arc Testnet.
- Recurring USDC tabs with cycle settings and allowance-based collection.
- Net-settlement treasury: every open position collapsed to one net figure per counterparty, settled atomically on Circle SCA wallets.

## Stack

- Next.js `16.2.9` with the App Router.
- React `19.2.4`.
- Circle AppKit and Viem for wallet, bridge, and chain interactions.
- `@circle-fin/x402-batching` for Scout's x402 buyer client and the seller facilitator.
- Hardhat 3 for contract tests and Arc Testnet deployment.
- Server-side receipt scanning API.

## Setup

Install dependencies:

```bash
npm install
```

Create `.env.local` from `.env.example` and fill in the keys you need:

```bash
cp .env.example .env.local
```

Important variables:

```ini
RECEIPT_SCANNER_API_KEY=your_receipt_scanner_key
RECEIPT_SCANNER_MODEL=receipt-scanner-model

ARC_TESTNET_RPC_URL=https://rpc.testnet.arc.network
ARC_TESTNET_USDC_ADDRESS=0x3600000000000000000000000000000000000000
NEXT_PUBLIC_RECURRING_TAB_FACTORY_ADDRESS=0x6c4d980f7a9250e3892a3541b5a62420b628f3c1
NEXT_PUBLIC_BILL_SPLIT_REGISTRY_ADDRESS=0x0000000000000000000000000000000000000000

DEPLOYER_PRIVATE_KEY=0x... # only needed for factory deployment
RECURRING_SETTLER_PRIVATE_KEY=0x... # server wallet that pays gas for recurring settlement
RECURRING_SETTLER_SECRET=... # bearer token for /api/recurring/settle
CRON_SECRET=... # optional host-provided cron bearer token

SESSION_SECRET=...            # min 32 chars — signs the login session cookie
X_CLIENT_ID=... / X_CLIENT_SECRET=...             # Sign in with X
DISCORD_CLIENT_ID=... / DISCORD_CLIENT_SECRET=...  # Sign in with Discord
GOOGLE_CLIENT_ID=... / GOOGLE_CLIENT_SECRET=...    # Sign in with Google
RESEND_API_KEY=... / EMAIL_FROM=...                # Email-OTP delivery (Resend)

# Scout agent (x402 nanopayments)
SCOUT_PRIVATE_KEY=0x...           # server-held EOA; generate with scripts/scout-setup.ts
SELLER_ADDRESS=0x...              # Splitsy treasury DCW — receives x402 earnings
SCOUT_DAILY_CAP_USDC=1            # Scout's daily spend ceiling in USDC (default 1)
SCOUT_ERC8004_TOKEN_ID=...        # set after scout-setup.ts registers Scout on Arc
NEXT_PUBLIC_BASE_URL=https://your-deployment.vercel.app
```

### Sign-in providers

Splitsy identifies a person by one of four providers, each giving them a Circle
test-USDC wallet on first sign-in (no seed phrase, no browser wallet needed):

- **X**, **Discord**, **Google** — OAuth 2.0 (PKCE). Configure the matching
  `*_CLIENT_ID` / `*_CLIENT_SECRET` and register the callback
  `<origin>/api/auth/<provider>/callback`.
- **Email-OTP** — a 6-digit code emailed via [Resend](https://resend.com). Set
  `RESEND_API_KEY` and `EMAIL_FROM` (a verified sender), and create the
  `email_otps` table by running `schema-otp.sql` once in the Supabase SQL editor.

Google and Email-OTP both resolve to the **same** email-keyed identity, so a
person who signs in either way shares one account and one wallet. X and Discord
are separate namespaces (an X `@alice` and a Discord `alice` are different
people). Each provider is independent — enable only the ones you configure.

Supabase and Circle API keys are included in `.env.example` for future persistence and server-side Circle flows. The current browser demo primarily uses receipt scanning, public FX data, browser wallets, and Arc Testnet contract calls.

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
npm run test:netting
npm run test:treasury
npm run test:dashboard
npm run test:landing
npm run test:contracts
npm run deploy:arc:bill-registry
npm run deploy:arc:factory
node --env-file=.env.local --experimental-strip-types scripts/scout-setup.ts
```

## Demo Flow

1. Upload a receipt image. Scout assesses image quality (size + dimensions) and pays Splitsy's own `/api/ocr` endpoint in USDC via x402 ($0.005/call). If parse confidence is below 0.8 and budget remains, Scout pays for a second-opinion pass and takes the better result.
2. Review the parsed merchant, totals, tax, tip, line items, and confidence. A Scout identity card shows the agent's on-chain ERC-8004 address and the nanopayments it made.
3. Convert non-USD bills into USD (Scout pays `/api/fx` at $0.001/call if needed).
4. Split equally or enter manual payer amounts.
5. Submit the split bill.
6. Debtors connect the matching wallet and see unpaid debt in the app.
7. Debtors pay fully or partially on Arc with a transaction memo, or bridge USDC from a supported CCTP source chain first.
8. The splitter claims paid funds from the registry.
9. Open the Treasury view on the dashboard: every open debt and credit collapses to one net figure per counterparty. Hit "Settle net" — Circle SCA wallets execute one atomic `executeBatch` transaction; browser wallets run a sequential approve + pay + claim loop.
10. Create weekly, monthly, or custom recurring tabs on Arc Testnet.
11. Payers approve the recurring tab as a constrained USDC spender. Funds stay in their wallets until the backend settler runs and pulls due recurring shares.

The repository includes a small sample image at `.tmp/test-receipt.png` for local receipt-scan testing.

## Scout Agent (x402 Nanopayments)

Scout is a server-side autonomous agent that pays for Splitsy's own OCR and FX
endpoints in USDC fractions via Circle Nanopayments (x402) on Arc Testnet.

### How it works

Every receipt upload routes through `POST /api/scout/scan`. Scout runs a
decision loop driven by three signals:

1. **Image quality** (`lib/scout/decide.ts:assessImage`) — rejects images under 8 KB or 200 px on either edge before spending anything.
2. **Parse confidence** — if the OCR result's `confidence` is below 0.8 and daily budget remains, Scout pays for a second-opinion pass with a stricter prompt and takes the better result.
3. **Remaining budget** (`lib/x402/spend.ts:canSpend`) — enforces the `SCOUT_DAILY_CAP_USDC` ceiling. When exhausted, Scout returns the best-effort parse with a `lowConfidence` flag.

If the paid path fails at any point, the route falls back to a direct internal
call to `lib/ocr-core.ts` so the human upload UX never breaks.

### Prices

Defined once in `lib/x402/pricing.ts`:

| Endpoint   | Price per call |
|------------|---------------|
| `/api/ocr` | $0.005 USDC   |
| `/api/fx`  | $0.001 USDC   |

### Scout's wallet

Scout is a **server-held EOA** (`SCOUT_PRIVATE_KEY`), not a Circle DCW.
`lib/scout/wallet.ts` constructs a `GatewayClient` from
`@circle-fin/x402-batching` with `chain: "arcTestnet"`. The rest of Splitsy
continues to use DCWs; Scout's EOA is only its x402 payment signer.

### x402 seller endpoints

`/api/ocr` and `/api/fx` are wrapped by `lib/x402/seller.ts`'s `withGateway`
HOF. Unauthenticated requests receive HTTP 402 with a `PAYMENT-REQUIRED`
challenge. The facilitator is Circle's `BatchFacilitatorClient`
(`@circle-fin/x402-batching`). `maxTimeoutSeconds` is set to `345600` (7 days)
because Circle's SDK default of 4 days is shorter than the Gateway's auth
validity window on Arc.

### ERC-8004 identity

Scout is registered on Arc's canonical IdentityRegistry
(`0x8004A818BFB912233c491871b3d84c89A494BD9e`). The upload UI shows a Scout
identity card linking to Arcscan.

### Payments ledger

Every earned and spent payment is recorded in the `x402_payments` Supabase
table (schema: `schema-x402-payments.sql`). The "Agent economy" panel in the
dashboard shows earnings, spend, calls served, and remaining daily budget,
fetched from `GET /api/scout/stats`.

### Scout setup (one-time per environment)

```bash
# 1. Generate Scout's EOA, register ERC-8004, make initial Gateway deposit
node --env-file=.env.local --experimental-strip-types scripts/scout-setup.ts

# 2. Apply the payments table
# Run schema-x402-payments.sql in the Supabase SQL editor

# 3. Add SCOUT_PRIVATE_KEY, SELLER_ADDRESS, SCOUT_ERC8004_TOKEN_ID to .env.local
```

Fund Scout's EOA with test USDC from the [Circle faucet](https://faucet.circle.com) before running.

See `docs/scout-agent.md` for full technical details.

## Net-Settlement Treasury

The Treasury view (dashboard → Treasury tab) aggregates every open on-chain
bill position into one net figure per counterparty.

### The escrow constraint

`BillSplitRegistry.payDebt` is escrow-bound to a specific `billId` — debts
cannot be routed through third parties or cancelled against each other on-chain.
Netting is a **view-level truth** (your true net exposure per counterparty). The
execution win is **transaction batching**, not fewer USDC moved.

### Settlement paths

| Wallet type | What happens |
|---|---|
| Circle SCA (social login) | One atomic `executeBatch` — all-or-nothing |
| Browser EOA | Sequential: one `approve`, one `payDebt` per bill, one `claim` per bill |

The transaction count formula is `grossTxCount = 2 × payLegCount + claimLegCount`
(the bill-by-bill baseline). A Circle SCA wallet replaces all of that with one
transaction.

### Read model

`lib/treasury.ts:buildTreasury` is a pure function that folds registry reads
into `TreasuryPlan`: one `TreasuryPosition` per counterparty (both directions
netted), sorted by absolute net descending. All money arithmetic is base-unit
`bigint`; only `unitsToUsdc` crosses the wire boundary.

See `docs/treasury.md` for full technical details.

## Contracts

Bill splits are stored in `BillSplitRegistry`. It records each submitted bill, participant debts, partial payments, and claimable splitter funds.

Recurring tabs are implemented with a factory:

- `contracts/BillSplitRegistry.sol`
- `contracts/RecurringTabFactory.sol`
- `contracts/RecurringTab.sol`
- `contracts/RecurringTab.t.sol`

Both flows build on a set of shared, audited security primitives instead of external dependencies:

- `contracts/security/ReentrancyGuard.sol` — `nonReentrant` modifier inherited by every fund-moving entrypoint.
- `contracts/libraries/SafeERC20.sol` — reverting wrappers around `transfer`/`transferFrom` for non-standard ERC-20 tokens.
- `contracts/interfaces/IERC20.sol` — minimal ERC-20 interface used to read approvals/balances and move USDC.

The current Arc Testnet deployment is:

```text
RecurringTabFactory: 0x6c4d980f7a9250e3892a3541b5a62420b628f3c1
Arcscan: https://testnet.arcscan.app/address/0x6c4d980f7a9250e3892a3541b5a62420b628f3c1
USDC: 0x3600000000000000000000000000000000000000
ERC-8004 IdentityRegistry: 0x8004A818BFB912233c491871b3d84c89A494BD9e
Gateway Wallet: 0x0077777d7EBA4688BDeF3E311b846F25870A19B9
```

More details are in `docs/snapsplit-contract.md`.

## Payment Reputation (ERC-8004)

Payers earn verifiable on-chain reputation using Arc's pre-deployed [ERC-8004](https://eips.ethereum.org/EIPS/eip-8004) registries (no Splitsy contract changes). After a wallet pays its full share of an on-chain bill:

1. The payer's wallet gets an identity NFT on the IdentityRegistry (lazily, first payment only).
2. A dedicated Splitsy validator DCW records scored feedback on the ReputationRegistry, with `feedbackHash = keccak256("splitsy:bill:<billId>:<payTx>")` so any score can be re-verified against the `DebtPaid` event it claims to describe.
3. The bill-creation UI shows a badge ("Paid N bills in full on Arc · 97/100 timeliness") for tagged payers, via `GET /api/reputation`.

**Timing scores.** Bill creators can set an optional "Pay by" date, committed into the bill's on-chain `metadataHash` so it can't be moved later. Each payment is graded against it using the `payDebt` **block timestamp** (never a server clock): no due date or paid within the due date + a 2-day grace window scores 100 (`paid_in_full` / `paid_on_time`); later loses 5 points per whole day down to a floor of 50 (`paid_late`). Paying is always positive — a payment never made records nothing. The badge average is **amount-weighted** by each payment's USDC share, so a large late bill drags more than a small one; per-payment on-chain scores stay simple and independently verifiable. The pure scoring curve lives in `lib/reputation-score.ts` (unit-tested in `lib/reputation-score.test.ts`).

All three payment shapes earn reputation:

- **Circle DCW payments** go through the server pay route, which records feedback in an `after()` hook once `payDebt` settles. The payer's own DCW signs the identity registration (it just paid, so it holds gas).
- **Browser / non-custodial payments** settle on-chain directly and never touch the server, so a Circle Smart Contract Platform event monitor on `BillSplitRegistry.DebtPaid` POSTs to the webhook (`app/api/webhooks/circle`). Splitsy can't sign as the payer's wallet, so a dedicated **registrar** DCW mints their identity NFT and then transfers it to the payer, who ends up owning it — a third wallet, distinct from the validator, so ERC-8004's no-self-scoring rule still holds. Registration and scoring are each serialized by a DB claim, because DCW payments fire both the pay route's hook and this webhook. Only paid-in-full settlements (`paidTotal >= owedTotal`) are scored.
- **Recurring tab cycles** are scored by the settle route after each confirmed `settleTab`: every member the settlement collected from earns one independent score per cycle (keyed `tab:<id>:cycle:<n>`), graded against that cycle's boundary. Consent is the member's standing USDC approval to the tab.

**Consent policy:** feedback is positive-only and recorded only for payments the wallet itself made — a debt someone merely tags you into can never touch your score, so fake bills can't grief anyone. "No history" always displays as neutral.

**Verify a score yourself:** open the `giveFeedback` tx on [Arcscan](https://testnet.arcscan.app) (mirrored as `feedback_tx` in `reputation_feedback`), recompute `keccak256("splitsy:bill:<billId>:<payTx>")` from its tag + `fileuri` fields and compare to the committed `feedbackHash`, confirm the payment tx emitted a matching paid-in-full `DebtPaid`, then pull the bill's preimage, recompute the metadata hash, and apply the scoring curve to the committed due date vs. the payment's block timestamp — you reproduce the exact score. The `/docs` page walks through this step by step.

**Regenerate from chain data:** the Supabase mirror (`reputation_feedback`) exists only for fast display — the chain is the audit trail. If the mirror is lost or the webhook missed events, replay history through the same scoring path:

```bash
node --env-file=.env.local --experimental-strip-types scripts/circle-scp-replay.ts
```

It pulls the `DebtPaid` events Circle stored under the monitor and re-runs scoring; idempotent per (payer, bill), so re-running never double-counts.

Setup:

1. Run `schema-reputation.sql` in the Supabase SQL editor (additive — also adds the `share_units` / `due_date` / `paid_at` columns to existing deployments). Run `schema-onchain-bill-preimages.sql` too if upgrading: it adds the `due_date` column that timing scores read.
2. Fund two auto-created Circle wallets with a little Arc Testnet USDC for gas (https://faucet.circle.com): the validator (refId `splitsy:reputation-validator`) and the registrar (refId `splitsy:reputation-registrar`). Both are created on first use; until funded, payments still succeed and only the reputation side effect is skipped (logged server-side).
3. To score browser payments, register the `DebtPaid` event monitor once: `node --env-file=.env.local --experimental-strip-types scripts/circle-scp-monitor-setup.ts`. This imports the registry into Circle's Contracts platform and creates the monitor. Make sure your webhook is subscribed to Smart Contract Platform (`contracts.eventLog`) notifications in the Circle console.

**Optional IPFS metadata:** For full ERC-8004 compliance with discoverable agent profiles, set `PINATA_JWT` in `.env.local` with a Pinata API key that has **pinFileToIPFS** permission (create at https://app.pinata.cloud). Without it, registration falls back to `data:` URIs — reputation still works, just without off-chain metadata discovery.

## Recurring Collection

The recurring tab is designed for subscriptions such as weekly shared bills or monthly services.

- The splitter creates a tab with a recipient, cycle length, member wallets, and fixed USDC shares.
- Each payer connects once and approves the tab contract for a chosen USDC limit.
- Funds remain in payer wallets until the cycle is due.
- The backend calls `settleTab()` on a schedule. The contract pulls the fixed share from each payer with enough balance and allowance, skips the others, and makes collected USDC claimable to the recipient.
- Payers can revoke by setting the tab allowance back to `0`.

### Backend recurring settlement

Recurring settlement is not a user wallet action. The app exposes a protected server route:

```bash
curl -X POST "$APP_URL/api/recurring/settle" \
  -H "Authorization: Bearer $RECURRING_SETTLER_SECRET"
```

The route scans every tab in `NEXT_PUBLIC_RECURRING_TAB_FACTORY_ADDRESS` and submits settlement transactions from `RECURRING_SETTLER_PRIVATE_KEY`. It skips tabs that are not due, have no collectible members, or are already complete.

`vercel.json` schedules this route every hour, every day:

```json
{
  "path": "/api/recurring/settle",
  "schedule": "0 * * * *"
}
```

Set `CRON_SECRET` or `RECURRING_SETTLER_SECRET` in the hosting environment so cron requests include the matching bearer token.

The allowance-based recurring contract differs from the older prepaid tab deployment. Redeploy `RecurringTabFactory` and update `NEXT_PUBLIC_RECURRING_TAB_FACTORY_ADDRESS` before testing recurring collection on Arc Testnet.

## Arc Testnet Constants

| Name | Value |
|---|---|
| Network CAIP-2 | `eip155:5042002` |
| USDC | `0x3600000000000000000000000000000000000000` |
| Gateway Wallet | `0x0077777d7EBA4688BDeF3E311b846F25870A19B9` |
| RPC | `https://rpc.testnet.arc.network` |
| ERC-8004 IdentityRegistry | `0x8004A818BFB912233c491871b3d84c89A494BD9e` |

All constants live in `lib/x402/constants.ts`.

## Current Verification

These checks pass locally:

```bash
npm run lint
npm run test:netting
npm run test:treasury
npm run test:landing
npm run build
```

`npm run test:contracts` requires the local Hardhat/Solidity test environment to be available.
