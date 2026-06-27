# Splitsy

Splitsy is a Next.js prototype for scanning receipts, splitting shared costs, and collecting payments on Arc Testnet. It combines:

- Receipt scanning for structured bill extraction.
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
```

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
