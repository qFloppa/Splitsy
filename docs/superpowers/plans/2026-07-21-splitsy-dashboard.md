# Splitsy Analytics Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a personal analytics dashboard tab to Splitsy showing created / paid / pending bills (one-time + recurring), broken down and filterable by identity type (X / Discord / email / wallet), plus counterparty, aging, reputation, and recurring-health insight.

**Architecture:** One session-gated `/api/dashboard` route fetches on-chain bill state (created + owed) and recurring-tab state, joins Supabase preimages (merchant/labels/**providers**) + reputation, and returns one pre-shaped JSON blob assembled by a pure, tested module (`lib/dashboard-aggregate.ts`). A new client `DashboardPanel.tsx` fetches once and derives every chart client-side with Recharts. Money math lives in pure functions with fixture tests; the route and UI are thin.

**Tech Stack:** Next.js (app router, `node_modules/next/dist/docs/` is authoritative — this is NOT stock Next), TypeScript, viem (Arc testnet reads), Supabase, Recharts + shadcn chart component, `node --test --experimental-strip-types` for unit tests.

## Global Constraints

- **Read the relevant guide in `node_modules/next/dist/docs/` before writing route/page code** — APIs differ from stock Next (per `AGENTS.md`).
- All new API routes: `export const runtime = "nodejs"` and `export const dynamic = "force-dynamic"`, session-gated via `getSessionUser()` returning 401 when absent (mirror `app/api/bills/route.ts`).
- USDC on-chain amounts are `bigint` in 6-decimal base units. Serialize to decimal strings at the API boundary; never send `bigint` over JSON.
- No `Date.now()` inside pure functions or tests — pass `nowSeconds: number` in (repo convention, see `lib/reputation-score.test.ts`). Route code may read the real clock and pass it down.
- `participant_providers` is display/analytics metadata only. It is NOT part of `billMetadataHash` — do not touch `lib/bill-metadata.ts` `BillPreimage` or the hash.
- Chart color comes from CSS custom properties (see Task 5), never hardcoded hex in components. Color follows identity entity, never rank.
- Test runner pattern: add each new `*.test.ts` as a `test:<name>` script in `package.json` mirroring `"test:netting"`.

---
## File Structure

**Create:**
- `lib/dashboard-types.ts` — `DashboardData` and sub-shapes (the API contract, shared by aggregate/route/panel/fixture). Pure types, no I/O.
- `lib/dashboard-aggregate.ts` — pure functions turning raw chain/db reads into `DashboardData`. No I/O, no clock. The tested core.
- `lib/dashboard-aggregate.test.ts` — fixture-driven unit tests for the aggregator.
- `lib/dashboard-fixture.ts` — one realistic `DashboardData` value; powers `?demo=1` and seeds panel dev.
- `app/api/dashboard/route.ts` — session-gated GET: orchestrates reads → aggregate → JSON. `?demo=1` returns the fixture.
- `app/DashboardPanel.tsx` — the client panel: fetch once, client-side filters, all charts.
- `components/ui/chart.tsx` — shadcn chart primitive (generated).

**Modify:**
- `schema-onchain-bill-preimages.sql` — add `participant_providers text[]`.
- `app/api/onchain-bills/create/route.ts` — derive + persist providers (pure helper `participantProvidersFromSlots`).
- `lib/onchain-bill-preimage-repo.ts` — write `participant_providers` in upsert; read it in `getOnchainBillPreimage`; extend types.
- `lib/arc-read.ts` — add `getBillIdsForParticipantOnchain`.
- `lib/recurring-read.ts` — add `listRecipientTabsOnchain`.
- `app/HomeClient.tsx` — add `"dashboard"` to `AppTab`, a 4th `TabButton`, and the panel branch.
- `app/globals.css` (or the file holding `:root`/`[data-theme]` tokens — confirm in Task 6) — identity chart color custom properties for light + dark.
- `package.json` — `recharts` dep; `test:dashboard` script.

**Boundaries:** the aggregator is the only place money math lives and is pure/tested; chain-read modules only fetch; the route only orchestrates + serializes; the panel only renders + filters an already-shaped blob. A bug in a chart can't corrupt a total; a bug in a total is caught by `dashboard-aggregate.test.ts`.

---

### Task 1: Migration + persist `participant_providers`

**Files:**
- Modify: `schema-onchain-bill-preimages.sql`
- Modify: `app/api/onchain-bills/create/route.ts:44-79,113-118`
- Modify: `lib/onchain-bill-preimage-repo.ts:7-14,64-71,101,121`
- Test: `app/api/onchain-bills/create/route.test.ts` (new — pure helper only)

**Interfaces:**
- Produces: `participantProvidersFromSlots(slots): ("x"|"discord"|"email"|"wallet")[]` (exported from the create route for test). `OnchainBillPreimage` and `PublishedBillPreimage` gain `participantProviders?: string[]`. `getOnchainBillPreimage` returns `participantProviders: string[]` (defaults `[]`).

- [ ] **Step 1: Add the column (additive migration).** Append to `schema-onchain-bill-preimages.sql`:

```sql
-- Additive: per-participant identity provider, index-aligned with
-- participant_labels. 'wallet' for address slots; 'x'|'discord'|'email' for
-- social slots. Existing rows are null -> bucketed 'unknown' in the dashboard.
-- Display/analytics only: NOT part of billMetadataHash, so this never affects
-- verification of existing or future bills.
alter table onchain_bill_preimages
  add column if not exists participant_providers text[];
```

Apply it in the Supabase SQL editor (these `schema-*.sql` files are applied by hand — there is no `supabase/` CLI dir).

- [ ] **Step 2: Write the failing test** for the pure provider-deriving helper. Create `app/api/onchain-bills/create/route.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { participantProvidersFromSlots } from "./route.ts";

test("wallet slots -> 'wallet', social slots -> their provider, index-aligned", () => {
  const socialRows = [{ provider: "x" }, { provider: "discord" }] as const;
  const slots = [
    { kind: "address" as const },
    { kind: "social" as const, idx: 0 },
    { kind: "social" as const, idx: 1 },
  ];
  assert.deepEqual(participantProvidersFromSlots(slots, socialRows), ["wallet", "x", "discord"]);
});
```

- [ ] **Step 3: Run it, verify it fails.**

Run: `node --test --experimental-strip-types app/api/onchain-bills/create/route.test.ts`
Expected: FAIL — `participantProvidersFromSlots` is not exported.

- [ ] **Step 4: Implement + wire the helper.** In `app/api/onchain-bills/create/route.ts`, add near the top-level (after imports):

```ts
export function participantProvidersFromSlots(
  slots: ReadonlyArray<{ kind: "social"; idx: number } | { kind: "address" }>,
  socialRows: ReadonlyArray<{ provider: IdentityProvider }>,
): string[] {
  return slots.map((s) => (s.kind === "address" ? "wallet" : socialRows[s.idx].provider));
}
```

Then, where the `labels`/`addresses` loop builds its arrays (around line 75-79), also build providers and pass them to publish. After the loop:

```ts
const participantProviders = participantProvidersFromSlots(slots, socialRows);
```

And extend the publish payload (line ~116) with `participantProviders`:

```ts
{ registryAddress: REGISTRY_ADDRESS, billId: billId.toString(), merchant, currency, total,
  participantLabels: labels, participantProviders, receiptHash, dueDate },
```

- [ ] **Step 5: Persist + read it in the repo.** In `lib/onchain-bill-preimage-repo.ts`:
  - Line 7-14: add `participantProviders?: string[]` to `OnchainBillPreimage` and `participantProviders: string[]` to `PublishedBillPreimage`.
  - In the `upsert` object (line ~64): add `participant_providers: input.participantProviders ?? null,`.
  - In the `select` (line ~101): add `participant_providers` to the column list.
  - In the returned object (line ~121): add `participantProviders: data.participant_providers ?? [],`.

- [ ] **Step 6: Run the test, verify it passes.**

Run: `node --test --experimental-strip-types app/api/onchain-bills/create/route.test.ts`
Expected: PASS.

- [ ] **Step 7: Add the test script + typecheck.** In `package.json` scripts add `"test:dashboard-create": "node --test --experimental-strip-types app/api/onchain-bills/create/route.test.ts"`. Run `npx tsc --noEmit` (whatever the repo's typecheck is — confirm via `package.json`) and fix type errors.

- [ ] **Step 8: Commit.**

```bash
git add schema-onchain-bill-preimages.sql app/api/onchain-bills/create/ lib/onchain-bill-preimage-repo.ts package.json
git commit -m "feat: persist per-participant identity provider on bill preimages"
```

---
### Task 2: Server-side reverse-lookup reads

**Files:**
- Modify: `lib/arc-read.ts` (add after `getBillIdsForSplitterOnchain`, ~line 105)
- Modify: `lib/recurring-read.ts` (add near `getNextTabIdOnchain`)

**Interfaces:**
- Produces:
  - `getBillIdsForParticipantOnchain(addr: "0x${string}"): Promise<readonly bigint[]>` — bills where `addr` owes.
  - `listRecipientTabsOnchain(recipient: "0x${string}"): Promise<Array<{ address: "0x${string}"; claimable: bigint; settlementCount: bigint; maxSettlements: bigint }>>` — recurring tabs where `addr` is recipient.

These are thin viem reads — no unit test (would only assert the mock). Task 3's aggregator, which consumes their output shape, is where the tested logic lives.

- [ ] **Step 1: Add `billIdsForParticipant` to the read ABI + a reader in `lib/arc-read.ts`.** The `READ_ABI` needs the entry (mirror the existing `billIdsForSplitter` entry, name `billIdsForParticipant`). Then:

```ts
export async function getBillIdsForParticipantOnchain(addr: `0x${string}`): Promise<readonly bigint[]> {
  return publicClient.readContract({
    address: REGISTRY_ADDRESS,
    abi: READ_ABI,
    functionName: "billIdsForParticipant",
    args: [addr],
  });
}
```

(Confirm the contract exposes `billIdsForParticipant` — it is used client-side by `readDebtsForWallet` in `lib/bill-split-contracts.ts`; copy that ABI fragment verbatim.)

- [ ] **Step 2: Add `listRecipientTabsOnchain` to `lib/recurring-read.ts`.** Reuse `FACTORY_READ_ABI` (`nextTabId`, `tabs`) and `TAB_READ_ABI` (`recipient`, `claimable`, `settlementCount`, `maxSettlements`), all already defined in the file:

```ts
export async function listRecipientTabsOnchain(
  recipient: `0x${string}`,
): Promise<Array<{ address: `0x${string}`; claimable: bigint; settlementCount: bigint; maxSettlements: bigint }>> {
  const nextId = await getNextTabIdOnchain();
  const ids = Array.from({ length: Math.max(0, Number(nextId - 1n)) }, (_, i) => BigInt(i + 1));
  if (ids.length === 0) return [];
  const addrs = await publicClient.multicall({
    allowFailure: true,
    contracts: ids.map((id) => ({
      address: RECURRING_TAB_FACTORY_ADDRESS, abi: FACTORY_READ_ABI, functionName: "tabs", args: [id],
    })),
  });
  const tabAddrs = addrs
    .map((r) => (r.status === "success" ? (r.result as `0x${string}`) : null))
    .filter((a): a is `0x${string}` => Boolean(a) && a !== "0x0000000000000000000000000000000000000000");
  const rows = await Promise.all(
    tabAddrs.map(async (address) => {
      try {
        const [recip, claimable, settlementCount, maxSettlements] = await publicClient.multicall({
          allowFailure: false,
          contracts: [
            { address, abi: TAB_READ_ABI, functionName: "recipient" },
            { address, abi: TAB_READ_ABI, functionName: "claimable" },
            { address, abi: TAB_READ_ABI, functionName: "settlementCount" },
            { address, abi: TAB_READ_ABI, functionName: "maxSettlements" },
          ],
        });
        return { address, recipient: recip as `0x${string}`, claimable, settlementCount, maxSettlements };
      } catch {
        return null;
      }
    }),
  );
  return rows
    .filter((r): r is NonNullable<typeof r> => r !== null && r.recipient.toLowerCase() === recipient.toLowerCase())
    .map(({ address, claimable, settlementCount, maxSettlements }) => ({ address, claimable, settlementCount, maxSettlements }));
}
```

`ponytail:` full-scan of tab ids, same as the client's `readRecurringTabsForWallet`. Add an id index only if tab count grows enough to matter.

- [ ] **Step 3: Typecheck.** Run `npx tsc --noEmit`; fix errors.

- [ ] **Step 4: Commit.**

```bash
git add lib/arc-read.ts lib/recurring-read.ts
git commit -m "feat: server reads for bills-owed and recipient recurring tabs"
```

---

### Task 3: Pure aggregator + API contract types

**Files:**
- Create: `lib/dashboard-types.ts`
- Create: `lib/dashboard-aggregate.ts`
- Create: `lib/dashboard-aggregate.test.ts`

**Interfaces:**
- Consumes: raw read shapes from Tasks 1-2 (`getBillOnchain`/`getParticipantOnchain` results, preimage `participantLabels`+`participantProviders`, `listRecipientTabsOnchain` rows, `getReputationSummary`).
- Produces: `DashboardData` (see Step 1) and `buildDashboard(input: DashboardInput): DashboardData`. `DashboardInput` groups the raw reads + `nowSeconds`. The route (Task 4) and fixture (Task 4) both target this shape; the panel (Task 6) consumes `DashboardData`.

- [ ] **Step 1: Define the contract in `lib/dashboard-types.ts`.** Amounts are decimal strings (USDC). One canonical identity bucket type reused everywhere:

```ts
export type IdentityBucket = "x" | "discord" | "email" | "wallet" | "unknown";
export const IDENTITY_BUCKETS: IdentityBucket[] = ["x", "discord", "email", "wallet", "unknown"];

export type Kpis = {
  createdCount: number;
  createdTotalUsdc: string;
  claimableUsdc: string;        // paid to me, not yet claimed
  owedToMeOutstandingUsdc: string;
  iOweOutstandingUsdc: string;
};

export type TimePoint = { weekStart: string; createdUsdc: string; settledUsdc: string };

export type IdentitySlice = { bucket: IdentityBucket; billCount: number; volumeUsdc: string };

export type StatusFunnel = {
  scope: "one_time" | "recurring";
  created: number; partiallyPaid: number; fullyPaid: number;
};

export type Counterparty = { label: string; bucket: IdentityBucket; volumeUsdc: string; billCount: number };

export type AgingBuckets = { d0_7Usdc: string; d8_30Usdc: string; d30plusUsdc: string };

export type ReputationTrend = { avgScore: number; count: number; lateCount: number; points: { at: string; score: number }[] };

export type RecurringHealth = {
  tabAddress: string; settlementCount: number; maxSettlements: number;
  claimableUsdc: string; shortfallCount: number;
};

export type DashboardData = {
  generatedAtSeconds: number;
  isDemo: boolean;
  kpis: Kpis;
  activity: TimePoint[];
  byIdentity: IdentitySlice[];         // always all 5 buckets, zero-filled
  status: StatusFunnel[];              // exactly 2 entries: one_time, recurring
  topCounterparties: Counterparty[];   // <= 8, rest folded into no entry (just truncated)
  aging: AgingBuckets;
  reputation: ReputationTrend;
  recurring: RecurringHealth[];
};
```

- [ ] **Step 2: Write failing tests in `lib/dashboard-aggregate.test.ts`.** Cover the money-critical paths:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDashboard, bucketForProvider } from "./dashboard-aggregate.ts";

test("bucketForProvider maps known providers, null/unknown -> 'unknown'", () => {
  assert.equal(bucketForProvider("x"), "x");
  assert.equal(bucketForProvider("wallet"), "wallet");
  assert.equal(bucketForProvider(null), "unknown");
  assert.equal(bucketForProvider("nonsense"), "unknown");
});

test("a bill I both created and owe is counted once in createdCount", () => {
  const both = 7n;
  const data = buildDashboard({
    nowSeconds: 1_700_000_000,
    myWallet: "0xme",
    created: [{ billId: both, totalOwed: 1_000000n, totalPaid: 0n, claimed: 0n,
      participants: [{ addr: "0xother", owed: 1_000000n, paid: 0n }],
      labels: ["@a"], providers: ["x"], createdAtSeconds: 1_699_000_000 }],
    owed: [{ billId: both, myOwed: 500000n, myPaid: 0n, createdAtSeconds: 1_699_000_000 }],
    recipientTabs: [],
    shortfallCountByTab: {},
    reputation: { avgScore: 0, count: 0, lateCount: 0, points: [] },
  });
  assert.equal(data.kpis.createdCount, 1);
});

test("KPI totals sum per-participant owed/paid as decimal USDC strings", () => {
  const data = buildDashboard({
    nowSeconds: 1_700_000_000,
    myWallet: "0xme",
    created: [{ billId: 1n, totalOwed: 3_000000n, totalPaid: 1_000000n, claimed: 0n,
      participants: [
        { addr: "0xa", owed: 2_000000n, paid: 1_000000n },
        { addr: "0xb", owed: 1_000000n, paid: 0n },
      ], labels: ["@a", "@b"], providers: ["x", "discord"], createdAtSeconds: 1_699_000_000 }],
    owed: [], recipientTabs: [], shortfallCountByTab: {},
    reputation: { avgScore: 0, count: 0, lateCount: 0, points: [] },
  });
  assert.equal(data.kpis.createdTotalUsdc, "3");
  assert.equal(data.kpis.owedToMeOutstandingUsdc, "2");  // 3 owed - 1 paid
  assert.equal(data.kpis.claimableUsdc, "1");            // totalPaid, unclaimed
});

test("byIdentity always returns all five buckets, zero-filled", () => {
  const data = buildDashboard({
    nowSeconds: 1_700_000_000, myWallet: "0xme",
    created: [], owed: [], recipientTabs: [], shortfallCountByTab: {},
    reputation: { avgScore: 0, count: 0, lateCount: 0, points: [] },
  });
  assert.equal(data.byIdentity.length, 5);
  assert.deepEqual(data.byIdentity.map((s) => s.bucket), ["x", "discord", "email", "wallet", "unknown"]);
});
```

- [ ] **Step 3: Run tests, verify they fail.**

Run: `node --test --experimental-strip-types lib/dashboard-aggregate.test.ts`
Expected: FAIL — module not found / not exported.

- [ ] **Step 4: Implement `lib/dashboard-aggregate.ts`.** Pure; base-unit `bigint` → decimal string only at the boundary. Key rules baked in from the spec self-review: dedupe created-vs-owed by bill id; per-participant sums for owed-to-me; provider index-aligned to labels; unknown fallback.

```ts
import { IDENTITY_BUCKETS, type DashboardData, type IdentityBucket } from "./dashboard-types.ts";

const USDC = 1_000_000n;
export function unitsToUsdc(v: bigint): string {
  const neg = v < 0n; const a = neg ? -v : v;
  const whole = a / USDC; const frac = a % USDC;
  const fracStr = frac === 0n ? "" : "." + frac.toString().padStart(6, "0").replace(/0+$/, "");
  return (neg ? "-" : "") + whole.toString() + fracStr;
}

export function bucketForProvider(p: string | null | undefined): IdentityBucket {
  return (IDENTITY_BUCKETS as string[]).includes(p ?? "") ? (p as IdentityBucket) : "unknown";
}

export type CreatedBill = {
  // `claimed` is a uint256 base-unit AMOUNT already withdrawn by the creator,
  // NOT a boolean. claimable = totalPaid - claimed.
  billId: bigint; totalOwed: bigint; totalPaid: bigint; claimed: bigint;
  participants: { addr: string; owed: bigint; paid: bigint }[];
  labels: string[]; providers: (string | null)[]; createdAtSeconds: number;
};
export type OwedBill = { billId: bigint; myOwed: bigint; myPaid: bigint; createdAtSeconds: number };
export type DashboardInput = {
  nowSeconds: number; myWallet: string;
  created: CreatedBill[]; owed: OwedBill[];
  recipientTabs: { address: string; claimable: bigint; settlementCount: bigint; maxSettlements: bigint }[];
  shortfallCountByTab: Record<string, number>;
  reputation: { avgScore: number; count: number; lateCount: number; points: { at: string; score: number }[] };
};

export function buildDashboard(input: DashboardInput): DashboardData {
  // ... full body specified in Step 4-detail below ...
  throw new Error("implement per Step 4-detail");
}
```

- [ ] **Step 4-detail: fill `buildDashboard`.** Implement in this order, each line traceable to a `DashboardData` field:
  1. `createdCount = input.created.length`.
  2. `createdTotalUsdc = unitsToUsdc(sum(created.totalOwed))`.
  3. `claimableUsdc = unitsToUsdc(sum over created of max(0, totalPaid - claimed))` — `claimed` is a base-unit amount, not a flag.
  4. `owedToMeOutstandingUsdc = unitsToUsdc(sum over created, over participants, of max(0, owed - paid)))`.
  5. `iOweOutstandingUsdc = unitsToUsdc(sum(owed.map(b => max(0, myOwed - myPaid))))`.
  6. `byIdentity`: seed a `Map` with all 5 buckets at `{billCount:0, volume:0n}`; for each created bill, for each participant index `i`, add `participants[i].owed` to `bucketForProvider(providers[i])`. Emit in `IDENTITY_BUCKETS` order.
  7. `activity`: group created (by `createdAtSeconds`) into ISO week buckets → `createdUsdc`; group `totalPaid` similarly → `settledUsdc`. Use `nowSeconds` only to bound the range; no `Date.now()`.
  8. `status`: one_time entry from `created` (created = count; fullyPaid = `totalPaid>=totalOwed`; partiallyPaid = `0<totalPaid<totalOwed`); recurring entry from `recipientTabs` (created = tab count; fullyPaid = `settlementCount>=maxSettlements`; partiallyPaid = `0<settlementCount<maxSettlements`).
  9. `topCounterparties`: aggregate created participants by `label`, sum owed, sort desc, take 8; `bucket` from that participant's provider.
  10. `aging`: for each created participant with `owed>paid`, age = `nowSeconds - bill.createdAtSeconds`; bin into 0-7d / 8-30d / 30d+ by outstanding `owed-paid`.
  11. `reputation`: pass through `input.reputation`.
  12. `recurring`: map `recipientTabs` → `{tabAddress, settlementCount:Number, maxSettlements:Number, claimableUsdc, shortfallCount: shortfallCountByTab[address] ?? 0}`.
  13. `generatedAtSeconds = input.nowSeconds`, `isDemo = false`.

  **Dedupe rule (self-review fix):** `created` and `owed` are independent id-lists; a bill where I'm both splitter and participant appears in both. `createdCount`/created-derived fields use ONLY `created`; `iOwe` fields use ONLY `owed`. They never cross-add, so the same bill is never double-counted in a single figure.

- [ ] **Step 5: Run tests, verify they pass.**

Run: `node --test --experimental-strip-types lib/dashboard-aggregate.test.ts`
Expected: PASS (all 4).

- [ ] **Step 6: Add `test:dashboard` script** (`"test:dashboard": "node --test --experimental-strip-types lib/dashboard-aggregate.test.ts"`) and run `npx tsc --noEmit`.

- [ ] **Step 7: Commit.**

```bash
git add lib/dashboard-types.ts lib/dashboard-aggregate.ts lib/dashboard-aggregate.test.ts package.json
git commit -m "feat: pure dashboard aggregator + API contract types"
```

---
### Task 4: `/api/dashboard` route + demo fixture

**Files:**
- Create: `lib/dashboard-fixture.ts`
- Create: `app/api/dashboard/route.ts`

**Interfaces:**
- Consumes: `buildDashboard` (Task 3), reads from Tasks 1-2, `getSessionUser` (`lib/session.ts`), `getReputationSummary` (`lib/reputation-repo.ts`), `getOnchainBillPreimage` (Task 1), `getBillOnchain`/`getParticipantOnchain` (`lib/arc-read.ts`).
- Produces: `DEMO_DASHBOARD: DashboardData` (fixture) and `GET /api/dashboard[?demo=1]` returning `DashboardData` JSON.

- [ ] **Step 1: Read the Next route-handler guide.** `node_modules/next/dist/docs/` — confirm the current signature for a `GET` handler reading query params (this is NOT stock Next; do not assume `NextRequest`).

- [ ] **Step 2: Build the fixture `lib/dashboard-fixture.ts`.** Export `DEMO_DASHBOARD: DashboardData` with `isDemo: true`, realistic non-zero values across all 5 identity buckets, ~10 weeks of activity, 2 status entries, 6 counterparties, non-empty aging, a rising reputation trend, and 2 recurring tabs. `generatedAtSeconds` is a hardcoded constant (no clock). This doubles as the empty-state preview and the demo toggle source.

- [ ] **Step 3: Implement the route `app/api/dashboard/route.ts`.**

```ts
import { getSessionUser } from "@/lib/session";
import { getBillIdsForSplitterOnchain, getBillIdsForParticipantOnchain, getBillOnchain, getParticipantOnchain } from "@/lib/arc-read";
import { listRecipientTabsOnchain } from "@/lib/recurring-read";
import { getOnchainBillPreimage } from "@/lib/onchain-bill-preimage-repo";
import { getReputationSummary } from "@/lib/reputation-repo";
import { buildDashboard, type CreatedBill, type OwedBill } from "@/lib/dashboard-aggregate";
import { DEMO_DASHBOARD } from "@/lib/dashboard-fixture";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const REGISTRY = (process.env.NEXT_PUBLIC_BILL_SPLIT_REGISTRY_ADDRESS ?? "") as `0x${string}`;

export async function GET(request: Request) {
  const user = await getSessionUser();
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });

  if (new URL(request.url).searchParams.get("demo") === "1") {
    return Response.json(DEMO_DASHBOARD);
  }
  const myWallet = (user.wallet_address ?? "").toLowerCase() as `0x${string}`;
  if (!myWallet) return Response.json({ error: "Wallet not provisioned" }, { status: 409 });

  // 1. id lists (cheap, parallel)
  const [createdIds, owedIds, recipientTabs] = await Promise.all([
    getBillIdsForSplitterOnchain(myWallet),
    getBillIdsForParticipantOnchain(myWallet),
    listRecipientTabsOnchain(myWallet),
  ]);

  // 2. per-bill detail (batched)
  const created: CreatedBill[] = await Promise.all(createdIds.map(async (billId) => {
    const [bill, preimage] = await Promise.all([
      getBillOnchain(billId),
      getOnchainBillPreimage(REGISTRY, billId.toString()),
    ]);
    const participants = await Promise.all(
      bill.participantList.map(async (addr) => {
        const p = await getParticipantOnchain(billId, addr as `0x${string}`);
        return { addr: addr.toLowerCase(), owed: p.owed, paid: p.paid };
      }),
    );
    return {
      billId, totalOwed: bill.totalOwed, totalPaid: bill.totalPaid, claimed: bill.claimed,
      participants, labels: preimage?.participantLabels ?? [],
      providers: preimage?.participantProviders ?? [],
      createdAtSeconds: 0, // ponytail: on-chain bills carry no createdAt; see Step 4
    };
  }));

  const owed: OwedBill[] = await Promise.all(owedIds.map(async (billId) => {
    const p = await getParticipantOnchain(billId, myWallet);
    return { billId, myOwed: p.owed, myPaid: p.paid, createdAtSeconds: 0 };
  }));

  // 3. reputation + shortfalls
  const reputationSummary = await getReputationSummary(myWallet);
  const shortfallCountByTab = {}; // ponytail: fill from SettlementShortfall logs in Task 7 if needed

  const data = buildDashboard({
    nowSeconds: Math.floor(Date.now() / 1000),
    myWallet, created, owed, recipientTabs, shortfallCountByTab,
    reputation: {
      avgScore: reputationSummary.avgScore, count: reputationSummary.count,
      lateCount: reputationSummary.lateCount, points: [], // ponytail: point series in Task 7
    },
  });
  return Response.json(data);
}
```

- [ ] **Step 4: Resolve `createdAtSeconds`.** On-chain bills expose no creation timestamp via `getBill`. Two lazy options — pick per what the schema already has:
  - **If** `onchain_bill_preimages.created_at` exists (it does — line 20 of the schema), read it in `getOnchainBillPreimage` (add `created_at` to the select, return `createdAtSeconds: Math.floor(Date.parse(created_at)/1000)`), and use it for both `created` and `owed`. This is the lazy win — no new column, no log scan.
  - Update the route to use `preimage?.createdAtSeconds ?? 0`. For `owed` bills lacking a preimage, `0` bins them into 30d+ (acceptable for v1; note it with a `ponytail:` comment).

  Implement the first option: extend `getOnchainBillPreimage`'s select + return with `created_at` → `createdAtSeconds`.

- [ ] **Step 5: Manual smoke test.** With the dev server running (`npm run dev` — confirm script), hit `/api/dashboard?demo=1` while signed in; expect the fixture JSON. Hit `/api/dashboard` (no demo) with a wallet that has bills; expect real aggregated JSON, no `bigint` serialization error. If not signed in, expect 401.

- [ ] **Step 6: Commit.**

```bash
git add lib/dashboard-fixture.ts app/api/dashboard/ lib/onchain-bill-preimage-repo.ts
git commit -m "feat: /api/dashboard aggregated endpoint + demo fixture"
```

---

### Task 5: Chart infrastructure — Recharts, shadcn chart, validated palette

**Files:**
- Modify: `package.json` (add `recharts`)
- Create: `components/ui/chart.tsx` (shadcn)
- Modify: the file holding `:root` / `[data-theme="dark"]` tokens (confirm: `app/globals.css` — grep in Step 2)

**Interfaces:**
- Produces: CSS custom properties `--chart-identity-x|discord|email|wallet|unknown` (light + dark) and `--chart-created`, `--chart-settled` for the activity series; the shadcn `ChartContainer`/`ChartTooltip` primitives.

- [ ] **Step 1: Install Recharts + shadcn chart.** `npm install recharts`. Then add the shadcn chart component (`npx shadcn@latest add chart` — confirm the project already uses shadcn via `components/ui/`; it does per the file structure). If the CLI isn't wired, copy `components/ui/chart.tsx` from shadcn docs manually.

- [ ] **Step 2: Locate the theme token block.** Run `grep -rn "data-theme\|:root" app/globals.css app/*.css` to find where light/dark tokens live (per memory `landing-page-architecture`, the app maps shadcn tokens + has a theme toggle via `data-theme`).

- [ ] **Step 3: Add the validated identity palette.** These 5 hues passed dataviz's `validate_palette.js` on both surfaces (lightness band, chroma floor, adjacent-pair CVD ΔE, normal-vision floor, contrast — all hard gates pass; the one contrast WARN is discharged by the legend + direct labels + table view in Task 6). Add to the token block:

```css
:root {
  --chart-identity-x: #2a78d6;
  --chart-identity-discord: #008300;
  --chart-identity-email: #e87ba4;
  --chart-identity-wallet: #eda100;
  --chart-identity-unknown: #1baf7a;
  --chart-created: #6366f1;   /* activity: created (indigo) */
  --chart-settled: #1baf7a;   /* activity: settled (green) */
}
[data-theme="dark"] {
  --chart-identity-x: #3987e5;
  --chart-identity-discord: #008300;
  --chart-identity-email: #d55181;
  --chart-identity-wallet: #c98500;
  --chart-identity-unknown: #199e70;
  --chart-created: #818cf8;
  --chart-settled: #199e70;
}
```

`ponytail:` created/settled are a 2-series activity chart, not identity buckets, so they get their own two tokens (indigo/green) — distinct from the 5 identity hues, re-run the validator if you change them.

- [ ] **Step 4: Verify install.** Run `npx tsc --noEmit` and `npm run build` (or `npm run lint` if build is heavy) to confirm recharts types resolve.

- [ ] **Step 5: Commit.**

```bash
git add package.json package-lock.json components/ui/chart.tsx app/globals.css
git commit -m "feat: recharts + shadcn chart primitive + validated identity palette"
```

---
### Task 6: `DashboardPanel` + wire into the app shell

**Files:**
- Create: `app/DashboardPanel.tsx`
- Modify: `app/HomeClient.tsx` (`AppTab` union ~line 142; `TabButton` row ~line 2320; panel branch after the `history` branch ~line 2762+)

**Interfaces:**
- Consumes: `DashboardData` (Task 3 types), the chart tokens (Task 5), shadcn `ChartContainer` (Task 5), `/api/dashboard` (Task 4).
- Produces: `<DashboardPanel />` (no props; self-fetches).

- [ ] **Step 1: Scaffold the panel with fetch + demo toggle.** `app/DashboardPanel.tsx`, `"use client"`:

```tsx
"use client";
import { useEffect, useMemo, useState } from "react";
import type { DashboardData, IdentityBucket } from "@/lib/dashboard-types";

type RangeKey = "7d" | "30d" | "90d" | "all";

export default function DashboardPanel() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [demo, setDemo] = useState(false);
  const [range, setRange] = useState<RangeKey>("30d");
  const [buckets, setBuckets] = useState<Set<IdentityBucket>>(new Set());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setData(null); setError(null);
    fetch(`/api/dashboard${demo ? "?demo=1" : ""}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: DashboardData) => { if (alive) setData(d); })
      .catch((e) => { if (alive) setError(String(e)); });
    return () => { alive = false; };
  }, [demo]);

  // client-side filter derives every chart from `data`; no refetch on range/bucket change
  const filtered = useMemo(() => (data ? applyFilters(data, range, buckets) : null), [data, range, buckets]);
  // ... render below ...
}
```

- [ ] **Step 2: Implement `applyFilters(data, range, buckets)`** as a small local pure function (bucket set empty = all): filters `byIdentity`/`topCounterparties`/`activity` window by range and selected buckets, recomputing KPI subtotals from the surviving slices. Keep it in the same file (it's panel-local presentation logic, not money-of-record math — that's Task 3).

- [ ] **Step 3: Build the sections** using shadcn `ChartContainer` + Recharts, colors via `var(--chart-*)`:
  - **Row 1 — KPI tiles**: 4-5 stat tiles (hero number + label). No plot.
  - **Row 2 — Activity**: stacked `AreaChart`, `--chart-created` / `--chart-settled`, single y-axis, `<ChartTooltip>` crosshair. Range selector (7d/30d/90d/all) above.
  - **Row 3a — By identity**: horizontal `BarChart`, one bar per bucket colored `var(--chart-identity-<bucket>)`, click toggles that bucket in the filter set. Legend always present; direct value labels on bars (discharges the palette contrast WARN).
  - **Row 3b — Status funnel**: stacked `BarChart`, one_time vs recurring, created/partial/paid.
  - **Row 4a — Top counterparties**: horizontal `BarChart` ranked by volume, bar colored by counterparty bucket.
  - **Row 4b — Aging**: 3-bar `BarChart` (0-7d / 8-30d / 30d+).
  - **Row 4c — Settlement rate**: a meter (paid / owed as a labeled progress bar; no chart lib needed — one `<div>` with width %).
  - **Row 5a — Reputation trend**: `LineChart` of `reputation.points` + the weighted-avg badge (reuse `ReputationBadge` component if it fits).
  - **Row 5b — Recurring health**: per-tab progress (settlementCount/maxSettlements bar) + claimable + shortfall count.

- [ ] **Step 4: Empty + demo states.** When `!demo` and every section is zero/empty, render designed zero-state cards ("Create your first bill to see analytics") instead of flat-zero charts. A "View sample data" toggle flips `demo` (clearly labeled "Sample data" while active). Loading = skeleton cards; `error` = a retry card.

- [ ] **Step 5: Accessibility pass (dataviz check 6).** For every ≥2-series chart: legend present; ≤4 series also direct-labeled; a "Table" toggle per chart renders the same numbers as an HTML `<table>` (identity never conveyed by color alone). Confirm dark mode renders from the `[data-theme="dark"]` tokens (toggle the app theme and eyeball).

- [ ] **Step 6: Wire into `app/HomeClient.tsx`.**
  - Line ~142: `type AppTab = "bills" | "recurring" | "history" | "dashboard";`
  - Import at top: `import DashboardPanel from "./DashboardPanel";`
  - After the `history` `TabButton` (~line 2320): add
    `<TabButton active={activeTab === "dashboard"} onClick={() => switchAppTab("dashboard")}>Dashboard</TabButton>`
  - After the `history` panel branch (~line 2762+, before the closing of the `AnimatePresence`): add a branch
    `) : activeTab === "dashboard" ? (` wrapping a `<motion.div key="dashboard" ...>` (copy the transition props from the `recurring` branch) containing `<DashboardPanel />`.

- [ ] **Step 7: Render + eyeball (dataviz check 7).** `npm run dev`, sign in, open the Dashboard tab. Toggle sample data on (charts fill from fixture), off (real or empty states). Toggle a couple identity bars (whole dashboard refilters, survivors keep their colors — no repaint-by-rank). Switch light/dark. Check for label collisions and overflow at narrow widths.

- [ ] **Step 8: Typecheck + build.** `npx tsc --noEmit` then `npm run build`. Fix errors.

- [ ] **Step 9: Commit.**

```bash
git add app/DashboardPanel.tsx app/HomeClient.tsx
git commit -m "feat: analytics dashboard panel with identity/aging/reputation charts"
```

---

### Task 7 (optional, defer): shortfall counts + reputation point series

Only if the fixture-vs-real gap matters after Task 6 ships. Fill `shortfallCountByTab` from `SettlementShortfall` logs (`lib/recurring-read.ts` `MEMBER_SETTLED_ABI` already has the event) and `reputation.points` from per-feedback `created_at`+`score` (extend `getReputationSummary` to return the raw rows). Each is one read + one aggregate mapping; add a test to `dashboard-aggregate.test.ts` if the mapping is non-trivial. `ponytail:` skipped in v1 — the KPIs and per-tab claimable already convey recurring health; add point-level detail when a user asks for the trend.

---

## Self-Review

**1. Spec coverage:**
- Created/paid/pending stats → Task 3 KPIs + status funnel ✓
- One-time + recurring → status funnel (both scopes) + recurring health (Task 3/6) ✓
- Sort by identity type (X/Discord/email/wallet) → Task 1 (data), Task 3 (`byIdentity`), Task 6 (filter) ✓
- Non-custodial wallet as a type → `"wallet"` bucket, Task 1 ✓
- Charts/infographics → Task 5 palette + Task 6 chart set ✓
- "What else is lacking" extras (activity-over-time, counterparty, aging, settlement rate, reputation, recurring health) → Task 3/6 rows ✓
- Professional/empty-state/demo → Task 6 Steps 4-5 ✓
- Schema gap (`participant_providers`) → Task 1 ✓
- Dedupe money-math trap → Task 3 Step 4-detail ✓
- Validated palette → Task 5 Step 3 ✓

**2. Placeholder scan:** `buildDashboard` body is specified as a numbered algorithm (Step 4-detail) rather than a placeholder; the fixture is described by its required contents; every code step shows code. `createdAtSeconds` resolved in Task 4 Step 4 (not left TODO). Task 7 is explicitly optional/deferred, not a gap.

**3. Type consistency:** `DashboardData`/`IdentityBucket`/`buildDashboard`/`DashboardInput`/`CreatedBill`/`OwedBill`/`unitsToUsdc`/`bucketForProvider` used identically across Tasks 3-4-6. `getBillIdsForParticipantOnchain` and `listRecipientTabsOnchain` signatures match between Task 2 (produce) and Task 4 (consume). `participantProviders` naming consistent across Task 1 repo + Task 4 route. `getReputationSummary` fields (`avgScore`/`count`/`lateCount`) match its real signature confirmed in `lib/reputation-repo.ts`.




