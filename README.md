# Splitsy

Splitsy is a Next.js prototype for scanning receipts, splitting shared costs, and collecting payments on Arc Testnet. It combines:

- Receipt scanning for structured bill extraction.
- Social sign-in via X, Discord, Google, or a one-time email code — each provisions a Circle test-USDC wallet.
- FX conversion into USD.
- Equal or manual bill splitting.
- Onchain bill submission and wallet-based debt discovery.
- Arc transaction memos for bill payment reconciliation.
- Circle AppKit bridging from supported CCTP source chains into Arc Testnet.
- Recurring USDC tabs with cycle settings and allowance-based collection.
- Netting utilities for reducing repeated shared expenses into fewer transfers.

## Stack

- Next.js `16.2.9` with the App Router.
- React `19.2.4`.
- Circle AppKit and Viem for wallet, bridge, and chain interactions.
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
npm run test:contracts
npm run deploy:arc:bill-registry
npm run deploy:arc:factory
```

## Demo Flow

1. Upload a receipt image.
2. Review the parsed merchant, totals, tax, tip, line items, and confidence.
3. Convert non-USD bills into USD.
4. Split equally or enter manual payer amounts.
5. Submit the split bill.
6. Debtors connect the matching wallet and see unpaid debt in the app.
7. Debtors pay fully or partially on Arc with a transaction memo, or bridge USDC from a supported CCTP source chain first.
8. The splitter claims paid funds from the registry.
9. Create weekly, monthly, or custom recurring tabs on Arc Testnet.
10. Payers approve the recurring tab as a constrained USDC spender. Funds stay in their wallets until the backend settler runs and pulls due recurring shares.

The repository includes a small sample image at `.tmp/test-receipt.png` for local receipt-scan testing.

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

## Current Verification

These checks pass locally:

```bash
npm run lint
npm run test:netting
npm run build
```

`npm run test:contracts` requires the local Hardhat/Solidity test environment to be available.
