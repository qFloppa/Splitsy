# SnapSplit Recurring Tabs Contract

The recurring-tab build uses a factory pattern for per-tab isolation:

- `RecurringTabFactory` deploys one `RecurringTab` contract per recurring tab.
- Each `RecurringTab` stores its members, each member's fixed USDC share, the fixed recipient, a fixed settlement interval, and per-member deposited balances.
- Members deposit by approving USDC and calling either `RecurringTab.deposit(amount)` or `RecurringTabFactory.deposit(tabId, amount)`.
- Anyone can call `settleTab`; the contract enforces the interval and recipient.
- Underfunded members are skipped, not batch-reverting, and emit `SettlementShortfall`.
- There is no admin withdrawal or recipient-change function. Funds can leave only by fixed-recipient settlement or member self-withdrawal.

For v1, settlement uses a fixed 30-day interval from tab creation. It does not implement literal calendar-month or "1st of the month" logic.

Arc Testnet details checked from Arc docs:

- Chain ID: `5042002`
- RPC: `https://rpc.testnet.arc.network`
- Explorer: `https://testnet.arcscan.app`
- USDC ERC-20 interface: `0x3600000000000000000000000000000000000000`
- USDC ERC-20 decimals: `6`

Current deployment:

- `RecurringTabFactory`: `0x6c4d980f7a9250e3892a3541b5a62420b628f3c1`
- Arcscan: `https://testnet.arcscan.app/address/0x6c4d980f7a9250e3892a3541b5a62420b628f3c1`
- Constructor USDC address: `0x3600000000000000000000000000000000000000`

Run tests:

```bash
npm run test:contracts
```

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
