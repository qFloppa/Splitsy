# Net-Settlement Treasury

The treasury view aggregates every open on-chain bill position into one net
figure per counterparty and lets a user discharge all of them in a single
action.

---

## The Escrow Constraint

`BillSplitRegistry.payDebt` credits `msg.sender` on one specific `billId`.
`claim` pays only the splitter of that bill. Debts are therefore **escrow-bound
to their bill** — they cannot be routed through third parties or cancelled
against each other on-chain.

Netting is a **view-level truth**: it tells you your true net exposure per
counterparty. The execution win is **transaction batching** — one atomic
`executeBatch` on a Circle SCA wallet instead of an approve + payDebt per bill.
No copy in the UI, landing page, or docs should claim that fewer USDC move.

---

## Read Model (`lib/treasury.ts`)

`buildTreasury(input: TreasuryInput): TreasuryPlan` is a pure function (no I/O,
no clock). It takes:

```ts
type TreasuryInput = {
  myWallets: string[];          // every wallet the viewer controls
  created: TreasuryCreatedBill[];
  owed: TreasuryOwedBill[];
  identities: Record<string, CounterpartyIdentity>;
};
```

And returns `TreasuryPlan` (all money as decimal strings — `bigint` cannot cross
`Response.json`):

```ts
type TreasuryPlan = {
  positions: TreasuryPosition[];   // sorted by |net| descending
  claimBillIds: string[];
  totalTheyOweMeUsdc: string;
  totalIOweThemUsdc: string;
  netUsdc: string;
  claimableUsdc: string;
  payLegCount: number;
  claimLegCount: number;
  grossTxCount: number;            // 2 * payLegCount + claimLegCount
};
```

Each `TreasuryPosition` carries both directions for one counterparty:

```ts
type TreasuryPosition = {
  counterparty: string;   // lowercase 0x address
  label: string;          // handle if known, else address
  bucket: IdentityBucket;
  theyOweMeUsdc: string;
  iOweThemUsdc: string;
  netUsdc: string;        // positive = they owe me, negative = I owe them
  payBillIds: string[];   // bills I must pay to discharge my side
};
```

All money arithmetic inside `buildTreasury` is base-unit `bigint`. Only
`unitsToUsdc` from `lib/dashboard-aggregate.ts` crosses the wire boundary.
`buildTreasury` is unit-tested in `lib/treasury.test.ts` (seven cases).

---

## Transaction Count Formula

`grossTxCount = 2 × payLegCount + claimLegCount`

This is the bill-by-bill baseline: each debt requires one `approve` + one
`payDebt` (2 transactions), and each claim requires one `claim` (1 transaction).
What replaces it depends on the wallet type:

| Wallet type | Settlement cost |
|---|---|
| Circle DCW (social login, SCA) | **1 atomic `executeBatch`** — all-or-nothing |
| Privy embedded wallet (social login, EOA) | 1 `approve` + 1 `settle` |
| Browser EOA | 1 `approve` + 1 `settle` |

Every EOA costs two transactions whatever the leg count, because `settle` carries
every claim and every pay leg in one call. A selection with nothing to pay costs
one — there is no approval to send.

The UI derives the per-scope comparison from `payLegCount` and `claimLegCount`
rather than storing a pre-computed netted count, because the scope selector
(All / Custodial / Non-custodial) changes which legs are in scope.

---

## Settlement: Social Wallet Path (`app/api/treasury/settle`)

The route is the same on both wallet stacks up to the moment it sends. It:

1. Verifies the PIN unlock cookie (`verifyWalletUnlock` + `WALLET_UNLOCK_COOKIE`).
2. Re-reads every outstanding amount from chain (never trusts client-supplied
   amounts).
3. Encodes one `approve` for the summed debt amount and one
   `settle(claimIds, payIds, amounts)` carrying every leg, via
   `lib/registry-calldata.ts`.
4. Refuses with 402 if the wallet cannot cover the total, counting claim
   proceeds toward the budget because `settle` runs the claims first.

Step 5 is the fork, and it is the only one:

**Circle DCW.** Social-login wallets on this stack are Circle **SCA** accounts
(`accountType: "SCA"` in `lib/circle-dcw.ts`). SCA wallets support
`executeBatch((address,uint256,bytes)[])` called **on the wallet's own address**
— each tuple is `(target, nativeValue, calldata)`. Both calls go out as one
`executeBatch`. Atomic means all-or-nothing: one reverting leg reverts the whole
batch, so no partial-failure reporting is needed.

**Privy embedded wallet.** These are plain EOAs and cannot do that — an EOA does
not revert on calldata it cannot run, it *succeeds and does nothing* (see
`docs/deployments.md`). So the two calls go out as two transactions. Which one
this request sends is read from chain, the same way
`app/api/onchain-bills/[billId]/pay` picks its leg: an allowance already covering
the total means the `approve` has mined and `settle` is next. The `approve` leg
answers `{ok: true, more: true}` and `app/signed-send.ts` comes back for the
second — the browser tracks no sequence, so a reload resumes wherever the chain
actually is.

Splitting the `approve` off does **not** split the settlement. `settle` is still
one call carrying every claim and pay leg, claims first, so it reverts whole. An
`approve` that lands without its `settle` leaves an unspent allowance, not a
half-paid bill.

---

## Settlement: Browser EOA Path (`app/HomeClient.tsx`)

Non-custodial wallets are plain EOAs. The `settleNetWithWallet` function:

1. Re-reads every outstanding amount from chain.
2. Sends one `approveBillRegistry` for the summed debt amount.
3. Sends one `payBillDebtWithMemo` per owed bill.
4. Sends one `claimBillFunds` per created bill with unclaimed funds.

Each step advances the existing `ProgressModal` (switch → approve → pay →
claim → success). Reuses `lib/bill-split-contracts.ts` helpers throughout.

---

## Dashboard Integration

The treasury view is a tab inside `app/DashboardPanel.tsx` alongside the
existing Analytics tab. It inherits the panel's scope selector (All / Custodial
/ Non-custodial) and the sessionStorage stale-while-revalidate cache — switching
tabs does not refetch.

`/api/dashboard` builds the `TreasuryPlan` server-side and returns it as
`DashboardData.treasury`. The dashboard route performs one extra multicall
(`getBillsOnchain` over the owed bill IDs) to learn each bill's splitter, then
calls `buildTreasury` with the aggregated data and an identity map from
`getUsersByWallets`.

---

## Demo Fixture

`lib/dashboard-fixture.ts` includes a `treasury` block in `DEMO_DASHBOARD` so
`?demo=1` keeps working. The fixture satisfies the `TreasuryPlan` type exactly
and uses the same `grossTxCount` identity (`2 × payLegCount + claimLegCount`).

---

## Wire Types (`lib/dashboard-types.ts`)

`TreasuryPosition` and `TreasuryPlan` are declared once in
`lib/dashboard-types.ts` and imported by `lib/treasury.ts`, the dashboard
route, the fixture, and `DashboardPanel`. There are no duplicate definitions
and no module cycle.

---

## Known Limitations

- A counterparty with no `users` row and no preimage label renders as a
  shortened address. Fixing it requires a creator label in the preimage table
  (a schema change with first-write-wins semantics) — deferred.
- `executeBatch` on Arc Testnet is confirmed by inference (SCA account type +
  Circle batch-operations docs + `ARC-TESTNET` in the `contractExecution` enum).
  Verify empirically before shipping the "one transaction" copy.
