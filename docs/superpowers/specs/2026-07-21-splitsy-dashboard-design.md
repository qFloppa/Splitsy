# Splitsy Analytics Dashboard — Design

Date: 2026-07-21
Status: Draft for review

## Goal

A professional analytics dashboard, added as a 4th tab in the Splitsy app shell,
that lets the signed-in user see and analyze their bill activity: bills created,
paid, and pending (both one-time and recurring), broken down and filterable by
identity type (X / Discord / email / non-custodial wallet). Beyond the core
counters, it surfaces activity-over-time, counterparty and debt-aging insight,
reputation trend, and recurring-tab health — the gaps identified as missing from
a product that today only has list views.

## Non-goals

- Platform-wide / multi-user stats (this is personal analytics for the signed-in user only).
- Any write path. The dashboard is read-only.
- Editing or paying bills from the dashboard (that stays in the Bills/Recurring tabs).

## Data model reality (important)

`bill_debts` is **retired**. All bills — social AND non-custodial-wallet — now
live on-chain in `BillSplitRegistry`. `onchain_bill_preimages` (Supabase) holds
the human-readable details keyed by `(registry_address, bill_id)`.

Consequence: the on-chain registry is the source of truth for money and payment
status; the preimage table is the source for merchant/labels/provider/due-date.

### Schema migration (part of this work)

`onchain_bill_preimages` has `participant_labels text[]` but **no provider
information** — that used to live in the now-dead `bill_debts.debtor_provider`.
The "sort by identity type" requirement has no data source without it.

Add, additively:

```sql
alter table onchain_bill_preimages
  add column if not exists participant_providers text[];
```

- Same index order as `participant_labels`.
- Values: `'wallet'` for raw-address slots; the actual provider
  (`'x'` | `'discord'` | `'email'`) for social slots.
- The create route (`app/api/onchain-bills/create/route.ts`) already knows each
  slot's kind/provider at build time — write the array alongside `participant_labels`.
- Old rows have `null` → bucketed as `'unknown'` in the dashboard.

`participant_providers` is NOT part of the on-chain metadata hash. It is display/
analytics metadata only, so adding it does not change any commitment or break
verification of existing bills.

## Architecture

### Server: `/api/dashboard` (new, `app/api/dashboard/route.ts`)

One aggregated endpoint. Node runtime, `force-dynamic`, session-gated like
`/api/bills`. Runs three on-chain read groups plus a Supabase fetch and returns
one pre-shaped JSON blob so the client does zero aggregation math on raw lists.

`GET /api/dashboard?demo=1` short-circuits every read and returns a static,
realistic fixture of the same shape (for the demo toggle and empty-state preview).

Reads:

1. **On-chain — bills I created**: `billIdsForSplitter(myWallet)` → per id
   `getBillOnchain` (totalOwed, totalPaid, claimed, participantList) and
   `getParticipantOnchain(id, payer)` per participant for per-payer paid/owed.
2. **On-chain — bills I owe**: `billIdsForParticipant(myWallet)` → per id
   `getBillOnchain` + my own `getParticipantOnchain` for what I owe/paid.
   - `billIdsForParticipant` already exists on the contract and is used
     client-side (`readDebtsForWallet` in `lib/bill-split-contracts.ts`). Mirror
     the read into the server-side `lib/arc-read.ts` (currently only has
     `billIdsForSplitter`).
3. **On-chain — recurring tabs where I'm recipient**: existing `lib/recurring-read.ts`
   reads — `claimable`, `settlementCount`, `maxSettlements`, and MemberSettled /
   SettlementShortfall for shortfall counts. Scoped to the user's known tab ids.
4. **Supabase**: batch-fetch `onchain_bill_preimages` for all `(registry, billId)`
   pairs seen above (merchant, `participant_labels`, `participant_providers`,
   `due_date`); `reputation_feedback` for the signed-in user's payer wallet
   (score history + weighted average).

**De-dup:** a bill where I am both splitter and a participant appears in BOTH id
lists (1 and 2). Union the ids and read each bill once; a bill's `role` is
`"creator"` if my wallet is its splitter, else `"payer"`. Never sum a bill into
both "created" and "I owe" totals — this is the money-math trap.

Chain reads dominate latency: fetch id lists first, then batch the per-bill
`getBill`/preimage lookups with `Promise.all`. `ponytail:` no caching layer in v1
— add one only if the batched reads measurably lag.

### Client: `DashboardPanel.tsx` (new)

- Added as `activeTab === "dashboard"` in `app/HomeClient.tsx` (4th `TabButton`,
  extend the `AppTab` union). Panel body lives in its own file to keep
  `HomeClient.tsx` from growing (it is already ~4900 lines).
- Fetches `/api/dashboard` once on mount into a single `useState`. Filters
  (identity-type, time-range) are applied client-side to the returned blob — the
  blob carries enough per-bill granularity (timestamps, provider, amounts,
  status) to re-derive every chart without refetching.
- Demo toggle flips the fetch to `?demo=1`.

### Charts: Recharts via shadcn chart components

- Install `recharts` + shadcn `chart` component (`components/ui/chart.tsx`). No
  chart lib exists today.
- Charts themed through CSS custom properties (see Palette) so light/dark and the
  existing theme toggle (`data-theme`) drive chart color with no JS branching.

### `/api/dashboard` response shape

```ts
type DashboardResponse = {
  // Row 1 — KPI tiles (USDC amounts as decimal strings, 6dp; counts as numbers)
  kpis: {
    createdCount: number;   createdTotal: string;
    claimable: string;      // owed to me, unclaimed
    outstandingOwedToMe: string;
    iOweOutstanding: string;
    // prior-period deltas for the tile sparkline/arrow
    deltas: { createdTotal: number; claimable: number; outstandingOwedToMe: number; iOweOutstanding: number };
  };
  // Row 2 — activity over time; one point per bill, aggregated client-side per range
  bills: Array<{
    billId: string;
    role: "creator" | "payer";
    createdAt: number;               // unix seconds
    kind: "one_time" | "recurring";
    totalOwed: string; totalPaid: string;
    status: "pending" | "partial" | "paid";
    dueDate: number | null;
    merchant: string | null;
    // per participant, for identity-type + counterparty + aging breakdowns
    participants: Array<{
      label: string;
      provider: "x" | "discord" | "email" | "wallet" | "unknown";
      owed: string; paid: string;
    }>;
  }>;
  // Row 5 — reputation
  reputation: {
    weightedAverage: number | null;   // 0..100
    history: Array<{ at: number; score: number; tag: string }>;
  };
  // Row 5 — recurring health
  recurring: Array<{
    tabId: string; name: string | null;
    settlementCount: number; maxSettlements: number;
    claimable: string; shortfallCount: number;
  }>;
};
```

Every chart is derived from `bills[]` + the small summary objects. The client
filters `bills[]` by provider and time-range and recomputes; no refetch.

## Sections & chart forms (dataviz-validated)

Responsive grid, top to bottom. Each number traces to a read above.

- **Row 1 — KPI stat tiles** (hero numbers, no plot each): Created (count + USDC),
  Claimable / paid to me, Outstanding owed to me, I owe. Each: value, prior-period
  delta arrow, small sparkline.
- **Row 2 — Activity over time**: stacked **area**, created vs settled USDC by week.
  Single y-axis (money). 7d / 30d / 90d / all range selector. Crosshair + tooltip.
  Created vs settled are two states of one measure, not identity types — use the
  reserved **status** palette (settled = good `#0ca30c`; created/outstanding =
  neutral or the blue sequential 450 step), NOT categorical identity hues.
- **Row 3a — By identity type**: horizontal **bars** (volume across X / Discord /
  email / wallet / unknown). Clicking a bar filters the whole dashboard. This is
  the core "sort by social type" requirement, visualized + interactive.
- **Row 3b — Bill status**: created → partial → paid, split one-time vs recurring
  (stacked bar / ordinal funnel).
- **Row 4a — Top counterparties**: ranked bars, who you split with / who owes most.
- **Row 4b — Debt aging**: buckets 0–7d / 8–30d / 30d+ of pending debts (bars).
- **Row 4c — Settlement rate**: meter, % of owed that's been paid.
- **Row 5a — Reputation trend**: **line** from `reputation.history` + weighted-avg badge.
- **Row 5b — Recurring health**: per-tab cycle progress (settled/max), claimable
  total, shortfall count.

Filters (identity-type multiselect + time-range) sit in one row above the charts
and re-filter every section.

## Palette (validated — do not eyeball)

Categorical, one slot per identity type. Validated with dataviz
`validate_palette.js` in both modes (all hard gates PASS; contrast WARN handled
by the relief rule below):

| Identity | Light | Dark |
|----------|-------|------|
| X        | `#2a78d6` | `#3987e5` |
| Discord  | `#008300` | `#008300` |
| email    | `#e87ba4` | `#d55181` |
| wallet   | `#eda100` | `#c98500` |
| unknown  | `#1baf7a` | `#199e70` |

- Color follows the **identity entity**, never rank — filtering out a type must
  not repaint the survivors.
- Contrast WARN → **relief rule**: legend always present for ≥2 series, ≤4 series
  also direct-labeled, and a table-view toggle exists. Identity is never
  color-alone.
- Sequential contexts (aging heat, magnitude) use the blue sequential ramp;
  status (good/warning/critical) uses the reserved status palette with icon+label,
  never a categorical hue.
- Money is one y-axis only — never a dual-axis chart.

## Empty states & demo toggle

- Real data when present. When a section is empty, a designed zero-state card
  ("Create your first bill", etc.) — never a flat zero chart.
- A "View sample data" toggle flips the fetch to `?demo=1`, filling every chart
  with a realistic fixture (also powers the marketing/demo story). Clearly labeled
  as sample data while active.

## Testing

- `lib/arc-read.ts` new `billIdsForParticipant` mirror: unit test the decode/shape
  against a fixture (pattern of existing `*.test.ts` in `lib/`).
- Dashboard aggregation (bills[] → per-provider totals, aging buckets,
  settlement rate): pure function extracted from the panel, one `*.test.ts` with
  asserts on a small fixture — the money/bucket math is the part that breaks.
- Palette: already validated via script; re-run if hues change.
- `ponytail:` no component/render tests in v1 — the risk is the aggregation math,
  not React wiring.

## Out of scope for v1 (add when needed)

- Server-side caching of chain reads (add if batched reads lag).
- CSV/PDF export of the dashboard.
- Configurable/custom date ranges beyond the 4 presets.
