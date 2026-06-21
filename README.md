# SnapSplit on Arc

SnapSplit is a Next.js prototype for turning a receipt photo into USDC payment flows on Arc Testnet. It combines:

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
5. Submit the split bill onchain.
6. Debtors connect the matching wallet and see unpaid debt in the app.
7. Debtors pay fully or partially on Arc with a transaction memo, or bridge USDC from a supported CCTP source chain first.
8. The splitter claims paid funds from the registry.
9. Create weekly, monthly, or custom recurring tabs on Arc Testnet.
10. Payers approve the recurring tab as a constrained USDC spender. Funds stay in their wallets until a due settlement call pulls that cycle's share.

The repository includes a small sample image at `.tmp/test-receipt.png` for local receipt-scan testing.

## Contracts

Bill splits are stored in `BillSplitRegistry`. It records each submitted bill, participant debts, partial payments, and claimable splitter funds.

Recurring tabs are implemented with a factory:

- `contracts/BillSplitRegistry.sol`
- `contracts/RecurringTabFactory.sol`
- `contracts/RecurringTab.sol`
- `contracts/RecurringTab.t.sol`

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
- Anyone can call `settleTab()` after the interval. The contract pulls the fixed share from each payer with enough balance and allowance, skips the others, and sends collected USDC directly to the recipient.
- Payers can revoke by setting the tab allowance back to `0`.

The allowance-based recurring contract differs from the older prepaid tab deployment. Redeploy `RecurringTabFactory` and update `NEXT_PUBLIC_RECURRING_TAB_FACTORY_ADDRESS` before testing recurring collection on Arc Testnet.

## Current Verification

These checks pass locally:

```bash
npm run lint
npm run test:netting
npm run build
```

`npm run test:contracts` requires the local Hardhat/Solidity test environment to be available.
