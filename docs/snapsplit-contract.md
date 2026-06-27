# Splitsy Recurring Tabs Contract

The recurring-tab build uses a factory pattern for per-tab isolation:

- `RecurringTabFactory` deploys one `RecurringTab` contract per recurring tab and indexes it by id. It holds no funds and has no privileges over the tabs it creates.
- Each `RecurringTab` fixes its members, each member's per-cycle USDC `fixedShare`, the `recipient`, the `settlementInterval`, and `maxSettlements` at construction. All of these are immutable.
- Collection is **allowance/pull-based, not deposit-based**. Members opt in by approving this tab contract as a USDC spender (`usdc.approve(tab, amount)`). Funds stay in member wallets until a cycle is settled.
- Anyone can call `RecurringTab.settleTab()` (or `RecurringTabFactory.settleTab(tabId)`). It settles every cycle that has accrued since the last settlement, pulling each member's outstanding schedule-derived due — capped to that member's current allowance and balance — into the tab.
- Underfunded or unapproved members are skipped, not batch-reverting. They emit `SettlementShortfall` and `MemberSettled(..., success=false)`; the rest are still collected. A skipped cycle can be collected on a later settlement once the member funds or re-approves.
- Collected funds accumulate in the tab's `claimable` balance. The immutable `recipient` calls `claim()` to withdraw the full balance.
- There is no deposit, admin withdrawal, recipient-change, member self-withdrawal, pause, sweep, or `selfdestruct` path. Funds can leave a tab only via `claim()` to the immutable recipient.

## Settlement model

- Time is measured in whole `settlementInterval` cycles counted from `createdAt`. The interval is configurable per tab (the app offers weekly, monthly, or custom); there is no hardcoded 30-day or calendar-month logic.
- A member can never be charged more than `fixedShare * maxSettlements` in total. Each settlement caps the pull to the member's outstanding accrued due (`fixedShare * accruedCycles - totalSettledByMember`) and to their own allowance and balance.
- `settleTab()` reverts with `AlreadySettledForPeriod` before a new cycle accrues, `TabComplete` once the schedule is exhausted, or `NoCollectibleMembers` when members are due but nothing could be collected.

## Security properties (audited)

- `settleTab()` and `claim()` are `ReentrancyGuard`-protected and follow checks-effects-interactions; all token movement uses `SafeERC20`.
- The pull's `from` address and amount are predetermined by the immutable member set and shares, so even though anyone may trigger settlement, the source and size of every transfer are not attacker-controlled.
- Members bound their own exposure with their approval and can revoke at any time by setting the tab allowance back to `0`.

## Events

| Contract | Event | Meaning |
| --- | --- | --- |
| `RecurringTabFactory` | `TabCreated` | A new tab was deployed (`tabId`, `tab`, `recipient`, `settlementInterval`, `maxSettlements`). |
| `RecurringTab` | `MemberSettled` | Per-member result of a settlement (`amount`, `success`). |
| `RecurringTab` | `SettlementShortfall` | A member could not fully cover their due for a settlement. |
| `RecurringTab` | `TabSettled` | One settlement completed (`totalAmount`, `timestamp`). |
| `RecurringTab` | `FundsClaimed` | The recipient withdrew collected funds. |

## Arc Testnet details

Checked from Arc docs:

- Chain ID: `5042002`
- RPC: `https://rpc.testnet.arc.network`
- Explorer: `https://testnet.arcscan.app`
- USDC ERC-20 interface: `0x3600000000000000000000000000000000000000`
- USDC ERC-20 decimals: `6`

## Current deployment

- `RecurringTabFactory`: `0x6c4d980f7a9250e3892a3541b5a62420b628f3c1`
- Arcscan: `https://testnet.arcscan.app/address/0x6c4d980f7a9250e3892a3541b5a62420b628f3c1`
- Constructor USDC address: `0x3600000000000000000000000000000000000000`

> The audited contract is allowance/pull-based and differs from the older prepaid (deposit-based) tab deployment. Redeploy `RecurringTabFactory` and update `NEXT_PUBLIC_RECURRING_TAB_FACTORY_ADDRESS` before testing recurring collection against the new behavior.

## Run tests

```bash
npm run test:contracts
```

## Deploy

Deploy the factory to Arc Testnet after `.env.local` contains a funded deployer:

```bash
npm run deploy:arc:factory
```

Required `.env.local` keys:

```ini
ARC_TESTNET_RPC_URL=https://rpc.testnet.arc.network
DEPLOYER_PRIVATE_KEY=0x...
ARC_TESTNET_USDC_ADDRESS=0x3600000000000000000000000000000000000000
```
