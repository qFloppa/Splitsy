# Public pay link — cover anyone's share from one page

**Date:** 2026-08-04
**Status:** approved design, not yet implemented

## Problem

A bill's payers can each settle their own share, and an autopay agent can settle
one on their behalf. Nobody else can. The common real case — one person picks up
several people's shares, or a parent covers two of four roommates — has no path
through the product at all.

The registry already permits it. `payDebtFor(billId, debtor, amount)` is
deliberately permissionless: it moves only the caller's USDC and only ever
reduces the named debtor's remaining balance. What's missing is a way to reach a
bill without being on it, and a surface for choosing whose shares to cover.

## What we're building

A switch in the "Who owes what" panel. On, and creating the bill also mints an
unguessable link. Anyone holding that link gets a page dedicated entirely to that
one bill, picks the rows they want to cover, and pays them from a browser wallet
or a Splitsy (Circle) wallet.

**No contract work.** `payDebtFor` is deployed and permissionless.

## Decisions

| Question | Decision | Why |
|---|---|---|
| Link secrecy | Unguessable token, `/pay/<token>` | Toggle off mints no token, so the switch gates something real rather than revealing a URL that always worked |
| Per-row control | On/off only | Paying covers that person's full remaining share, read from chain. No partial-payment UI, no amount validation, and no rows left half-owing |
| Toggle availability | Bill creation only | Matches the panel it lives in. Bills already on Arc get no link |
| Layout | Editorial split (fixed poster + scrolling roster) | Chosen from three mockups; holds up at any payer count and keeps the headline amount on screen while selecting |

## Architecture

### The token

One new nullable column on `onchain_bill_preimages`, with a partial unique index.
The preimage table is already the only off-chain record of a bill's human-readable
details and is already keyed by `(registry_address, bill_id)` — the token is one
more way to look up the same row, not a new entity.

```sql
alter table onchain_bill_preimages add column if not exists share_token text;
create unique index if not exists onchain_bill_preimages_share_token_idx
  on onchain_bill_preimages (share_token) where share_token is not null;
```

The token is 22 base62 characters (~131 bits) from `crypto.getRandomValues`,
generated in the browser at submit time and passed down whichever creation path
runs. Client generation is safe here and buys something real: the browser-wallet
path publishes its preimage fire-and-forget, so a server-minted token would mean
either awaiting that POST or a second round trip before the link could be shown.

Publishing a preimage already requires knowing details that hash to the
commitment on-chain — a check `publishOnchainBillPreimage` enforces as a hard
gate — so in practice only the creator can set a token. The existing upsert is
`ignoreDuplicates`, so a token is written once at creation and cannot be
overwritten later. Servers validate the shape (`/^[A-Za-z0-9_-]{16,64}$/`) and
reject anything else, so a short or malformed token can't be smuggled in.

### Reading a bill by token

`GET /api/pay/[token]` — public, unauthenticated, no caching.

1. Look up the preimage row by `share_token`. 404 if absent.
2. **Reject any row whose `registry_address` isn't the current `REGISTRY_ADDRESS`.**
   Bill ids restart per registry deployment, so a token minted against the legacy
   v1 registry would otherwise route a payer to a different bill wearing the same
   number — the same hazard the preimage POST route already guards against before
   waking the autopay agent.
3. Read live state from Arc: `getBillOnchain` (totals, due date, escrow flag,
   `participantList`) and `getParticipantsOnchain` (owed/paid per address).
4. Pair `participantList[k]` with `participantLabels[k]` / `participantProviders[k]`.
   This index alignment is already load-bearing — `app/api/dashboard/route.ts`
   builds its counterparty identities the same way — including its tolerance for
   pre-migration rows whose label array is shorter than the participant list.
5. Overlay live handles from `getUsersByWallets`, which win over the creation-time
   label snapshot. Same precedence rule the dashboard applies.

Response shape:

```ts
{
  billId, registryAddress, merchant, currency, total, dueDate, escrowUntilFull,
  receiptUrl, creator: { address, label, provider },
  totalOwed, totalPaid, settled,
  rows: [{ address, label, provider, owed, paid, remaining }]
}
```

Amounts are decimal strings, not numbers — the rest of the codebase moves USDC as
`bigint` base units and formats through `billUnitsToUsdc`, and a float round-trip
through JSON is exactly how a cent goes missing.

### Paying

**Browser wallet** (client-side, on the page): `connectBrowserWallet()` →
`ensureBillSplitWalletOnArc` → `approveBillRegistry({ amount: sum })` → one
`payBillDebtFor` per selected row.

One new helper in `lib/bill-split-contracts.ts`, mirroring the existing
`payBillDebt` against the `payDebtFor` entry already present in the ABI:

```ts
export async function payBillDebtFor({ walletClient, account, billId, debtor, amount })
```

This is N+1 transactions and the UI says so. There is no batch-pay-for-others on
the registry: `settle()` batches, but its pay loop is hardcoded to `msg.sender`'s
own debts, so it cannot serve this. Adding one would mean redeploying the
registry and migrating every live bill — far past the cost of showing an honest
per-row progression.

**Splitsy wallet** — `POST /api/pay/[token]/social`, body `{ debtors: string[] }`:

- Requires a session and a valid PIN unlock (`verifyWalletUnlock`), matching
  `app/api/onchain-bills/[billId]/pay/route.ts`.
- Resolves the token server-side; the client never names a bill id.
- Reads each debtor's `owed - paid` **from chain** and pays exactly that. No
  client-supplied amount is trusted, mirroring the existing pay route.
- Approves the sum once, then one `executeContractOnArc` per debtor.
- Returns per-debtor `{ address, ok, txHash?, error? }` so a partial failure is
  reported as a partial failure.

### Reputation is deliberately untouched

`recordPaidFeedbackSafely` fires when a wallet settles *its own* share — the
payment is the debtor's consent to being scored. Covering someone else's share is
not their consent and is not their creditworthiness, so neither route records
ERC-8004 feedback for the debtor. The person paying doesn't earn a score either;
they were never on the bill.

## The page

`/pay/[token]` — a server component for metadata (**`robots: noindex, nofollow`**;
a share link must not land in a search index) wrapping a client component that
owns all state.

Two zones, per the approved mockup:

- **Poster** (left, `--ink-950`, fixed): merchant in Clash Display, amount still
  owed as the largest element on the page, progress bar in `--arc-cyan`,
  verification line, creator, due date.
- **Roster** (right, scrolling): one large row per participant — switch, name,
  `owes $X of $Y` in mono, remaining amount.
- **Pay bar** (bottom, ink): live "You pay" total and the action.

### States

1. **Not signed in** — rows are fully selectable before any wallet exists. You
   build the selection and authenticate at the moment of payment, not as a toll
   at the door. Pay bar offers both "Sign in to pay" and "Connect wallet".
2. **Paying** — the poster's owed figure ticks down and the progress bar advances
   as each transaction confirms; the settling row shows a spinner, then stamps
   PAID with its own tx hash. If row 3 fails, rows 1–2 stay paid and only row 3
   offers a retry.
3. **Settled** — the pay bar is removed rather than disabled, and the poster turns
   green. Nothing on screen implies an action that no longer exists.
4. **Already-paid rows** — no switch at all, rather than a disabled one.
5. **Mobile** — poster stacks full-bleed on top and condenses to a slim sticky
   strip (merchant + owed) once you scroll into the roster; pay bar fixed to the
   bottom edge.

Reuses `Switch` from `SettlementAgentsPanel`, `connectBrowserWallet` from
`appkit-bridge`, and the existing token/type system. Page-specific styles go in
`app/globals.css` alongside the other component classes, both themes.

The page renders `XAuthControl` so a social payer can unlock their wallet without
leaving — the PIN gate is a precondition of the social pay route, and every other
caller in the app already routes through this widget.

## Creator side

In the "Who owes what" panel, a card styled like the existing "All or nothing"
escrow card:

> **Anyone can pay** *(share link)* — Get a link that lets anyone open this bill
> and cover any payer's share. Without it, only the people you tagged can pay.

On success, both creation paths surface the link in the "Bill #N is live"
confirmation with a copy button. The social path currently returns early without
setting `submittedBillId`, so the link is held in its own state that both paths
set.

## Files

| File | Change |
|---|---|
| `schema-onchain-bill-preimages.sql` | `share_token` column + partial unique index |
| `lib/onchain-bill-preimage-repo.ts` | accept/return `shareToken`; add `getPreimageByShareToken` |
| `lib/bill-split-contracts.ts` | add `payBillDebtFor` |
| `lib/pay-link.ts` | token generation + validation + selection math (new, small) |
| `lib/pay-link.test.ts` | assert-based checks (new) |
| `app/api/onchain-bills/preimage/route.ts` | accept + validate `shareToken` |
| `app/api/onchain-bills/create/route.ts` | accept + validate `shareToken` |
| `app/api/pay/[token]/route.ts` | public bill read (new) |
| `app/api/pay/[token]/social/route.ts` | Circle-wallet pay-for (new) |
| `app/pay/[token]/page.tsx` | server component + noindex metadata (new) |
| `app/pay/[token]/PayClient.tsx` | the page (new) |
| `app/HomeClient.tsx` | toggle + link display |
| `app/globals.css` | pay page styles |

Next 16 conventions: `params` is a promise in both pages and route handlers
(`await props.params`), and the globally generated `PageProps<'/pay/[token]'>` /
`RouteContext<'/api/pay/[token]'>` helpers type them.

## Testing

`lib/pay-link.test.ts` — `node --test --experimental-strip-types`, matching the
repo's existing test style, added to `package.json` as `test:pay-link`:

- Generated tokens match the accepted shape; the validator rejects short,
  empty, and punctuation-bearing tokens.
- Selection math: total of selected rows, already-paid rows excluded from both
  the selectable set and the total, empty selection yields a disabled action.
- Amounts stay in base units through the round trip — no float drift on a
  three-row selection of odd cents.

Contract behaviour is already covered by `BillSplitRegistry.t.sol`; this adds no
Solidity.

## Out of scope

- Minting a link for a bill already written on Arc.
- Revoking a link once minted.
- Partial amounts per row.
- Off-chain (`bills` table) debts — this is on-chain registry bills only.
