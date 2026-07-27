# Net-Settlement Treasury Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Treasury" view to the dashboard that collapses every open on-chain bill position into one net position per counterparty, plus a "Settle net" action that discharges all of them — in a **single atomic transaction** for Circle SCA wallets.

**Architecture:** A pure aggregation core (`lib/treasury.ts`) folds the registry reads the dashboard route already performs — bills I created (participants who owe me) and bills where I owe (the splitter I owe) — into `TreasuryPlan`: one position per counterparty with both directions netted, plus the per-bill legs needed to execute. `/api/dashboard` gains one extra multicall (getBill over the *owed* ids, to learn each bill's splitter) and returns `treasury` inside `DashboardData`, so the new view inherits the panel's existing scope selector and stale-while-revalidate cache. Execution has two paths. Splitsy's social wallets are Circle **SCA** accounts, so `/api/treasury/settle` encodes one `executeBatch((address,uint256,bytes)[])` call against the wallet's own address — approve + every payDebt + every claim in one atomic on-chain transaction. The browser-wallet path is a plain EOA, so it keeps a sequential loop (one approve, then one tx per leg) reusing `approveBillRegistry`/`payBillDebtWithMemo`/`claimBillFunds` and the existing `ProgressModal`.

**Tech Stack:** Next.js 16 (App Router), React 19, viem 2.52 (Multicall3 reads), Supabase (`@supabase/supabase-js`), recharts (already present), `node --test --experimental-strip-types` for tests.

## Global Constraints

- **This is NOT the Next.js you know.** Before writing any route/handler code, read the relevant guide under `node_modules/next/dist/docs/` and heed deprecation notices (per `AGENTS.md`).
- ESM (`"type": "module"`). Imports inside `lib/` use explicit `./x.ts` specifiers (see `lib/dashboard-aggregate.ts`); imports from `app/` use the `@/` alias without extensions (see `app/api/dashboard/route.ts`). Match the file you are editing.
- Tests: `node --test --experimental-strip-types <file>`; colocate as `*.test.ts`. No framework beyond `node:test` + `node:assert/strict`.
- USDC is 6 decimals. **All money math happens in base-unit `bigint`.** Decimal strings are produced only at the wire boundary via `unitsToUsdc` from `lib/dashboard-aggregate.ts` — never a second formatter, never floats.
- **`bigint` must never cross `Response.json`** — it throws. `buildTreasury` returns strings/numbers only, exactly like `buildDashboard`.
- **Escrow constraint (do not paper over this).** `BillSplitRegistry.payDebt` credits `msg.sender` on one `billId`; `claim` pays only the splitter. Debts therefore CANNOT be routed through third parties or cancelled against each other on-chain. Netting is a **view-level** truth (one net figure per counterparty); the **execution** win is bundling, not fewer transfers. Never write UI copy or comments claiming less USDC moves, or that min-transfer routing is executed.
- **Circle SCA wallets batch atomically.** `lib/circle-dcw.ts:180` provisions social wallets with `accountType: "SCA"`, and Circle's batch-operations doc (https://developers.circle.com/wallets/batch-operations.md) says developer-controlled + MSCA wallets bundle user-ops into one atomic transaction via the `contractExecution` endpoint: call `executeBatch((address,uint256,bytes)[])` **on the wallet's own address**, each tuple being `(target, nativeValue, calldata)`. `ARC-TESTNET` is a supported `blockchain` enum for that endpoint (Circle release notes 2025.10.27). Atomic means **all-or-nothing**: one reverting leg reverts the batch. So the DCW settle is a single transaction, and it needs no partial-failure reporting.
- **Encode `executeBatch` locally, do not switch to `abiFunctionSignature`.** Circle's API treats `callData` as mutually exclusive with `abiFunctionSignature` + `abiParameters`. `executeContractOnArc` already sends `callData`, so encoding the batch with viem's `encodeFunctionData` reuses that helper untouched — no SDK-shape risk, no second code path.
- `lib/netting.ts` (`computeMinimumTransfers`, `previewSettlement`) is **not** used here. It types over the `Member`/`Charge` tab model, which no live code path populates, and its greedy third-party routing is exactly what escrow forbids. Leave it untouched.
- Never trust a client-supplied amount. Both settle paths re-read every outstanding amount from chain before signing.
- Spending from the Circle DCW requires an active PIN unlock (`verifyWalletUnlock` + `WALLET_UNLOCK_COOKIE`), matching `app/api/onchain-bills/[billId]/pay/route.ts`.
- Reuse: `lib/arc-read.ts` (batched multicall reads), `lib/registry-calldata.ts` (`encodeApprove`, `encodePayDebt`, `encodeClaim`), `lib/circle-dcw.ts` (`executeContractOnArc`), `lib/erc8004.ts` (`recordPaidFeedbackSafely`), `lib/bill-split-contracts.ts` (browser writes), `app/DashboardPanel.tsx` (cache + scope + styling), `ProgressModal` in `app/HomeClient.tsx`.

---

## File Structure

- `lib/dashboard-types.ts` — MODIFY: add the `TreasuryPosition` / `TreasuryPlan` wire types and `treasury` on `DashboardData`. Wire types live here (not in `treasury.ts`) so `treasury.ts` can import `IdentityBucket` without a module cycle.
- `lib/treasury.ts` + `lib/treasury.test.ts` — NEW: pure aggregation core. One responsibility: bills in → net positions + settle legs out.
- `lib/users-repo.ts` — MODIFY: add `getUsersByWallets` so counterparties display as handles, not raw addresses.
- `lib/registry-calldata.ts` + `lib/registry-calldata.test.ts` — MODIFY: add `encodeExecuteBatch` (Circle SCA atomic batching) and two round-trip cases.
- `app/api/dashboard/route.ts` — MODIFY: one extra `getBillsOnchain` over the owed ids (for `splitter`), build the identity map, attach `treasury`.
- `lib/dashboard-fixture.ts` — MODIFY: add a `treasury` block to `DEMO_DASHBOARD` (the type is required, and `?demo=1` must keep working).
- `app/api/treasury/settle/route.ts` — NEW: Circle SCA settle. Chain-verified legs, one atomic `executeBatch`.
- `app/DashboardPanel.tsx` — MODIFY: Analytics/Treasury view toggle + `TreasurySection` + settle wiring.
- `app/HomeClient.tsx` — MODIFY: `settleNetWithWallet` (browser-wallet path) passed down as `onSettleNet`.

---

## Task 1: Treasury wire types

**Files:**
- Modify: `lib/dashboard-types.ts:32-43`

**Interfaces:**
- Produces: `TreasuryPosition`, `TreasuryPlan`; `DashboardData.treasury: TreasuryPlan`.

- [x] **Step 1: Add the types**

Append to `lib/dashboard-types.ts`, above `DashboardData`:

```ts
// One counterparty, both directions netted. `payBillIds` are the bills *I* must
// pay to discharge my side — per-bill because payDebt is escrow-bound to a
// billId; there is no on-chain way to net them away (see the plan's escrow note).
export type TreasuryPosition = {
  counterparty: string;      // lowercase 0x address
  label: string;             // handle if known, else the preimage label, else the address
  bucket: IdentityBucket;
  theyOweMeUsdc: string;
  iOweThemUsdc: string;
  netUsdc: string;           // positive = they owe me, negative = I owe them
  payBillIds: string[];
};

export type TreasuryPlan = {
  positions: TreasuryPosition[]; // sorted by |net| descending
  claimBillIds: string[];        // bills I created with unclaimed funds
  totalTheyOweMeUsdc: string;
  totalIOweThemUsdc: string;
  netUsdc: string;
  claimableUsdc: string;
  // Leg counts drive the transaction comparison. Settling bill-by-bill costs
  // approve + payDebt per debt (2 each) plus one claim each — that is
  // grossTxCount. What replaces it depends on who signs: a Circle SCA wallet
  // does the whole thing in ONE atomic executeBatch; a browser EOA still needs
  // one approve + one tx per leg. The UI computes that per scope from these.
  payLegCount: number;
  claimLegCount: number;
  grossTxCount: number;
};
```

Then add the field to `DashboardData`:

```ts
export type DashboardData = {
  generatedAtSeconds: number;
  isDemo: boolean;
  kpis: Kpis;
  activity: TimePoint[];
  byIdentity: IdentitySlice[];
  status: StatusFunnel[];
  topCounterparties: Counterparty[];
  aging: AgingBuckets;
  reputation: ReputationTrend;
  recurring: RecurringHealth[];
  treasury: TreasuryPlan;
};
```

- [x] **Step 2: Verify it compiles in isolation**

Run: `npx tsc --noEmit lib/dashboard-types.ts`
Expected: exits 0 (this file has no imports beyond its own types).

- [x] **Step 3: Commit**

```bash
git add lib/dashboard-types.ts
git commit -m "feat(treasury): net-position wire types"
```

---

## Task 2: Treasury aggregation core

**Files:**
- Create: `lib/treasury.ts`, `lib/treasury.test.ts`

**Interfaces:**
- Consumes: `unitsToUsdc`, `bucketForProvider` from `lib/dashboard-aggregate.ts`; `TreasuryPlan`, `TreasuryPosition`, `IdentityBucket` from `lib/dashboard-types.ts` (Task 1).
- Produces:
  - `type TreasuryCreatedBill = { billId: string; totalPaid: bigint; claimed: bigint; participants: { addr: string; owed: bigint; paid: bigint }[] }`
  - `type TreasuryOwedBill = { billId: string; splitter: string; myOwed: bigint; myPaid: bigint }`
  - `type CounterpartyIdentity = { label: string; provider: string | null }`
  - `type TreasuryInput = { myWallets: string[]; created: TreasuryCreatedBill[]; owed: TreasuryOwedBill[]; identities: Record<string, CounterpartyIdentity> }`
  - `buildTreasury(input: TreasuryInput): TreasuryPlan`

- [x] **Step 1: Write the failing test**

```ts
// lib/treasury.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTreasury, type TreasuryInput } from "./treasury.ts";

const USDC = 1_000_000n;

function input(over: Partial<TreasuryInput> = {}): TreasuryInput {
  return { myWallets: ["0xme"], created: [], owed: [], identities: {}, ...over };
}

test("nets both directions with one counterparty into a single position", () => {
  const plan = buildTreasury(
    input({
      created: [
        {
          billId: "1",
          totalPaid: 0n,
          claimed: 0n,
          participants: [{ addr: "0xALICE", owed: 12n * USDC, paid: 0n }],
        },
      ],
      owed: [{ billId: "2", splitter: "0xalice", myOwed: 9n * USDC, myPaid: 0n }],
    }),
  );

  assert.equal(plan.positions.length, 1);
  const alice = plan.positions[0];
  assert.equal(alice.counterparty, "0xalice"); // addresses normalised to lowercase
  assert.equal(alice.theyOweMeUsdc, "12");
  assert.equal(alice.iOweThemUsdc, "9");
  assert.equal(alice.netUsdc, "3");
  assert.deepEqual(alice.payBillIds, ["2"]);
  assert.equal(plan.totalTheyOweMeUsdc, "12");
  assert.equal(plan.totalIOweThemUsdc, "9");
  assert.equal(plan.netUsdc, "3");
});

test("my own wallets are never counterparties to myself", () => {
  const plan = buildTreasury(
    input({
      myWallets: ["0xme", "0xMyOther"],
      created: [
        {
          billId: "1",
          totalPaid: 0n,
          claimed: 0n,
          participants: [
            { addr: "0xme", owed: 5n * USDC, paid: 0n },
            { addr: "0xmyother", owed: 5n * USDC, paid: 0n },
            { addr: "0xbob", owed: 5n * USDC, paid: 0n },
          ],
        },
      ],
      // Same bill seen from the participant side: I owe my own bill. Not a debt.
      owed: [{ billId: "1", splitter: "0xme", myOwed: 5n * USDC, myPaid: 0n }],
    }),
  );

  assert.deepEqual(
    plan.positions.map((p) => p.counterparty),
    ["0xbob"],
  );
  assert.equal(plan.totalIOweThemUsdc, "0");
  assert.deepEqual(plan.positions[0].payBillIds, []);
});

test("fully paid legs drop out entirely", () => {
  const plan = buildTreasury(
    input({
      created: [
        {
          billId: "1",
          totalPaid: 5n * USDC,
          claimed: 5n * USDC,
          participants: [{ addr: "0xbob", owed: 5n * USDC, paid: 5n * USDC }],
        },
      ],
      owed: [{ billId: "2", splitter: "0xcarla", myOwed: 4n * USDC, myPaid: 4n * USDC }],
    }),
  );

  assert.deepEqual(plan.positions, []);
  assert.deepEqual(plan.claimBillIds, []);
  assert.equal(plan.claimableUsdc, "0");
});

test("collects unclaimed funds on bills I created", () => {
  const plan = buildTreasury(
    input({
      created: [
        {
          billId: "7",
          totalPaid: 7n * USDC,
          claimed: 2n * USDC,
          participants: [{ addr: "0xbob", owed: 10n * USDC, paid: 7n * USDC }],
        },
      ],
    }),
  );

  assert.deepEqual(plan.claimBillIds, ["7"]);
  assert.equal(plan.claimableUsdc, "5");
  assert.equal(plan.positions[0].theyOweMeUsdc, "3"); // 10 owed - 7 paid
});

test("counts the legs a settle must execute", () => {
  const plan = buildTreasury(
    input({
      created: [
        {
          billId: "9",
          totalPaid: 4n * USDC,
          claimed: 0n,
          participants: [{ addr: "0xz", owed: 4n * USDC, paid: 4n * USDC }],
        },
      ],
      owed: [
        { billId: "1", splitter: "0xa", myOwed: 1n * USDC, myPaid: 0n },
        { billId: "2", splitter: "0xa", myOwed: 2n * USDC, myPaid: 0n },
        { billId: "3", splitter: "0xb", myOwed: 3n * USDC, myPaid: 0n },
      ],
    }),
  );

  assert.equal(plan.payLegCount, 3);
  assert.equal(plan.claimLegCount, 1);
  // Bill-by-bill: 3 debts x (approve + payDebt) + 1 claim.
  assert.equal(plan.grossTxCount, 7);
});

test("positions sort by absolute net, largest exposure first", () => {
  const plan = buildTreasury(
    input({
      created: [
        {
          billId: "1",
          totalPaid: 0n,
          claimed: 0n,
          participants: [{ addr: "0xalice", owed: 3n * USDC, paid: 0n }],
        },
      ],
      owed: [{ billId: "2", splitter: "0xbob", myOwed: 10n * USDC, myPaid: 0n }],
    }),
  );

  assert.deepEqual(
    plan.positions.map((p) => `${p.counterparty}:${p.netUsdc}`),
    ["0xbob:-10", "0xalice:3"],
  );
});

test("labels and identity buckets come from the identity map, else the address", () => {
  const plan = buildTreasury(
    input({
      created: [
        {
          billId: "1",
          totalPaid: 0n,
          claimed: 0n,
          participants: [
            { addr: "0xalice", owed: 2n * USDC, paid: 0n },
            { addr: "0xstranger", owed: 1n * USDC, paid: 0n },
          ],
        },
      ],
      identities: { "0xalice": { label: "@alice", provider: "x" } },
    }),
  );

  const byAddr = new Map(plan.positions.map((p) => [p.counterparty, p]));
  assert.equal(byAddr.get("0xalice")!.label, "@alice");
  assert.equal(byAddr.get("0xalice")!.bucket, "x");
  assert.equal(byAddr.get("0xstranger")!.label, "0xstranger");
  assert.equal(byAddr.get("0xstranger")!.bucket, "unknown");
});
```

- [x] **Step 2: Run the test, expect FAIL**

Run: `node --test --experimental-strip-types lib/treasury.test.ts`
Expected: FAIL — `Cannot find module` for `./treasury.ts`.

- [x] **Step 3: Implement the core**

```ts
// lib/treasury.ts
// Pure treasury aggregation: registry reads in, one net position per
// counterparty out. No I/O, no clock. Money math is base-unit bigint; only
// unitsToUsdc crosses the wire boundary (bigint would throw in Response.json).
//
// IMPORTANT — what "net" means here. BillSplitRegistry.payDebt credits
// msg.sender on ONE billId and claim pays only the splitter, so debts can
// neither be routed through a third party nor cancelled against each other
// on-chain. The netting below is therefore a VIEW: it tells you your true
// exposure per counterparty. The executable saving is transaction batching
// (one approve for the summed amount instead of one per bill) — which is what
// grossTxCount/nettedTxCount report. Do not restate it as fewer USDC moved.
import { bucketForProvider, unitsToUsdc } from "./dashboard-aggregate.ts";
import type { TreasuryPlan, TreasuryPosition } from "./dashboard-types.ts";

export type TreasuryCreatedBill = {
  billId: string;
  totalPaid: bigint;
  claimed: bigint;
  participants: { addr: string; owed: bigint; paid: bigint }[];
};

export type TreasuryOwedBill = {
  billId: string;
  splitter: string;
  myOwed: bigint;
  myPaid: bigint;
};

export type CounterpartyIdentity = { label: string; provider: string | null };

export type TreasuryInput = {
  myWallets: string[]; // every wallet the viewer controls; case-insensitive
  created: TreasuryCreatedBill[];
  owed: TreasuryOwedBill[];
  identities: Record<string, CounterpartyIdentity>; // keyed by lowercase address
};

const max0 = (v: bigint) => (v < 0n ? 0n : v);
const absBig = (v: bigint) => (v < 0n ? -v : v);

export function buildTreasury(input: TreasuryInput): TreasuryPlan {
  const mine = new Set(input.myWallets.map((w) => w.toLowerCase()));

  type Acc = { theyOweMe: bigint; iOweThem: bigint; payBillIds: string[] };
  const acc = new Map<string, Acc>();
  const slot = (addr: string): Acc => {
    const existing = acc.get(addr);
    if (existing) return existing;
    const fresh: Acc = { theyOweMe: 0n, iOweThem: 0n, payBillIds: [] };
    acc.set(addr, fresh);
    return fresh;
  };

  // Bills I created: every participant with an unpaid remainder owes me. Skip my
  // own wallets — a bill where I'm both splitter and participant is legal, and
  // "I owe myself" is not a position.
  for (const bill of input.created) {
    for (const p of bill.participants) {
      const addr = p.addr.toLowerCase();
      if (mine.has(addr)) continue;
      const outstanding = max0(p.owed - p.paid);
      if (outstanding === 0n) continue;
      slot(addr).theyOweMe += outstanding;
    }
  }

  // Bills where I'm a participant: I owe the splitter. Same self-skip.
  for (const bill of input.owed) {
    const addr = bill.splitter.toLowerCase();
    if (mine.has(addr)) continue;
    const outstanding = max0(bill.myOwed - bill.myPaid);
    if (outstanding === 0n) continue;
    const s = slot(addr);
    s.iOweThem += outstanding;
    s.payBillIds.push(bill.billId);
  }

  const positions: TreasuryPosition[] = [...acc.entries()].map(([counterparty, v]) => {
    const identity = input.identities[counterparty];
    return {
      counterparty,
      label: identity?.label ?? counterparty,
      bucket: bucketForProvider(identity?.provider),
      theyOweMeUsdc: unitsToUsdc(v.theyOweMe),
      iOweThemUsdc: unitsToUsdc(v.iOweThem),
      netUsdc: unitsToUsdc(v.theyOweMe - v.iOweThem),
      payBillIds: v.payBillIds,
    };
  });

  // Sort by |net| descending, comparing the accumulator's bigints rather than
  // the formatted strings — "1000" < "9" lexicographically. Address breaks ties
  // so the order is stable across reloads.
  positions.sort((a, b) => {
    const an = absBig(netMicros(acc.get(a.counterparty)!));
    const bn = absBig(netMicros(acc.get(b.counterparty)!));
    if (an === bn) return a.counterparty < b.counterparty ? -1 : 1;
    return bn > an ? 1 : -1;
  });

  const claimBills = input.created.filter((b) => b.totalPaid - b.claimed > 0n);
  const claimable = claimBills.reduce((s, b) => s + (b.totalPaid - b.claimed), 0n);

  const totalTheyOweMe = [...acc.values()].reduce((s, v) => s + v.theyOweMe, 0n);
  const totalIOweThem = [...acc.values()].reduce((s, v) => s + v.iOweThem, 0n);
  const payLegCount = [...acc.values()].reduce((s, v) => s + v.payBillIds.length, 0);

  return {
    positions,
    claimBillIds: claimBills.map((b) => b.billId),
    totalTheyOweMeUsdc: unitsToUsdc(totalTheyOweMe),
    totalIOweThemUsdc: unitsToUsdc(totalIOweThem),
    netUsdc: unitsToUsdc(totalTheyOweMe - totalIOweThem),
    claimableUsdc: unitsToUsdc(claimable),
    payLegCount,
    claimLegCount: claimBills.length,
    // Bill-by-bill today: approve + payDebt per debt, one claim per funded bill.
    grossTxCount: 2 * payLegCount + claimBills.length,
  };
}

function netMicros(v: { theyOweMe: bigint; iOweThem: bigint }): bigint {
  return v.theyOweMe - v.iOweThem;
}
```

- [x] **Step 4: Run the test, expect PASS**

Run: `node --test --experimental-strip-types lib/treasury.test.ts`
Expected: `# pass 7`, `# fail 0`.

- [x] **Step 5: Add the npm script**

In `package.json` `scripts`, after `"test:dashboard"`:

```json
"test:treasury": "node --test --experimental-strip-types lib/treasury.test.ts",
```

- [x] **Step 6: Commit**

```bash
git add lib/treasury.ts lib/treasury.test.ts package.json
git commit -m "feat(treasury): net-position aggregation core + tests"
```

---

## Task 3: Counterparty identity lookup

**Files:**
- Modify: `lib/users-repo.ts` (append)

**Interfaces:**
- Produces: `getUsersByWallets(addresses: string[]): Promise<Map<string, { handle: string; provider: IdentityProvider }>>` — keyed by **lowercase** wallet address; absent for unknown wallets.

Without this, every counterparty in the treasury view renders as a raw hex address. The registry only knows addresses; the `users` table is where a handle lives.

- [x] **Step 1: Implement**

Append to `lib/users-repo.ts`:

```ts
// Reverse lookup: wallet address -> the social identity that owns it. The
// registry only records addresses, so the treasury view needs this to show
// "@alice" instead of 0xab…12. One query, Map keyed lowercase. Wallets with no
// row (non-custodial users) are simply absent — callers fall back to the address.
export async function getUsersByWallets(
  addresses: string[],
): Promise<Map<string, { handle: string; provider: IdentityProvider }>> {
  const result = new Map<string, { handle: string; provider: IdentityProvider }>();
  const wanted = [...new Set(addresses.map((a) => a.toLowerCase()))].filter(Boolean);
  if (wanted.length === 0) return result;

  const client = createSupabaseServerClient();
  if (!client) return result;

  const { data, error } = await client
    .from("users")
    .select("wallet_address, handle, provider")
    .in("wallet_address", wanted);
  // Display-only enrichment: a failure degrades to addresses, never breaks the view.
  if (error || !data) return result;

  for (const row of data) {
    if (!row.wallet_address) continue;
    result.set(String(row.wallet_address).toLowerCase(), {
      handle: row.handle,
      provider: row.provider as IdentityProvider,
    });
  }
  return result;
}
```

Check the top of the file: it must already import `createSupabaseServerClient` and `IdentityProvider`. If `IdentityProvider` is not in the existing `import type { AppUser } from "@/lib/types"` line, add it there.

- [x] **Step 2: Verify wallet addresses are stored lowercase**

Run:

```bash
grep -rn "wallet_address" lib/users-repo.ts
```

Confirm `setUserWallet` writes the address. If it does **not** lowercase before insert, the `.in()` filter above will miss rows. In that case make the query case-insensitive by fetching with `.or()` on both cases, or normalise in `setUserWallet` — pick whichever leaves existing rows matching, and note the choice in a comment.

- [x] **Step 3: Commit**

```bash
git add lib/users-repo.ts
git commit -m "feat(treasury): wallet-address -> handle reverse lookup"
```

---

## Task 4: Feed `treasury` from the dashboard route

**Files:**
- Modify: `app/api/dashboard/route.ts:98-157`
- Modify: `lib/dashboard-fixture.ts` (append `treasury` to `DEMO_DASHBOARD`)

**Interfaces:**
- Consumes: `buildTreasury`, `TreasuryCreatedBill`, `TreasuryOwedBill`, `CounterpartyIdentity` (Task 2); `getUsersByWallets` (Task 3); `getBillsOnchain` (existing).
- Produces: `GET /api/dashboard` response gains `treasury: TreasuryPlan`.

The route already reads bills I created (with participants) and my owed participant rows. It does **not** know the splitter of an owed bill — that is the counterparty I owe. One extra `getBillsOnchain` over the owed ids supplies it.

- [x] **Step 1: Add the imports**

At the top of `app/api/dashboard/route.ts`, extend the existing `@/lib/arc-read` import to include `getBillsOnchain` (already imported — verify), and add:

```ts
import { buildTreasury, type TreasuryCreatedBill, type TreasuryOwedBill, type CounterpartyIdentity } from "@/lib/treasury";
import { getUsersByWallets } from "@/lib/users-repo";
```

- [x] **Step 2: Read the owed bills' splitters**

The route currently derives `owed` from `owedParts` alone. Replace the block that starts at `const owedParts = await getParticipantsOnchain(` (around line 125) with a version that also multicalls `getBill` for those ids:

```ts
  // Owed bills need their splitter (the counterparty I owe) for the treasury
  // view, which getParticipant does not return — one more multicall, not a
  // per-bill fan-out (see getBillsOnchain on why per-call reads break the RPC).
  const [owedParts, owedBills] = await Promise.all([
    getParticipantsOnchain(owedEntries.map(([idStr, wallet]) => ({ billId: BigInt(idStr), addr: wallet }))),
    getBillsOnchain(owedEntries.map(([idStr]) => BigInt(idStr))),
  ]);
  const owed: OwedBill[] = owedEntries.map(([idStr], i) => {
    const p = owedParts[i];
    // ponytail: no preimage → createdAtSeconds 0 bins into 30d+ aging. Fine for v1.
    return {
      billId: BigInt(idStr),
      myOwed: p?.owed ?? 0n,
      myPaid: p?.paid ?? 0n,
      createdAtSeconds: preimageMap.get(idStr)?.createdAtSeconds ?? 0,
    };
  });
```

- [x] **Step 3: Build the treasury plan**

Insert this immediately before the existing `const data = buildDashboard({` call:

```ts
  // ── treasury: net position per counterparty ────────────────────────────────
  // Reuses the reads above; the only new I/O is the handle lookup below.
  const treasuryCreated: TreasuryCreatedBill[] = created.map((b) => ({
    billId: b.billId.toString(),
    totalPaid: b.totalPaid,
    claimed: b.claimed,
    participants: b.participants,
  }));
  const treasuryOwed: TreasuryOwedBill[] = owedEntries.flatMap(([idStr], i) => {
    const bill = owedBills[i];
    if (!bill) return []; // unreadable bill — can't name the counterparty, so skip it
    return [{
      billId: idStr,
      splitter: bill.splitter.toLowerCase(),
      myOwed: owed[i].myOwed,
      myPaid: owed[i].myPaid,
    }];
  });

  // Labels: a preimage names the participants of a bill I created (index-aligned
  // with participantList), the users table names anyone with a social wallet.
  // The users row wins — it is the live handle; a preimage label is a snapshot.
  const identities: Record<string, CounterpartyIdentity> = {};
  bills.forEach((bill, bi) => {
    if (!bill) return;
    const preimage = preimageMap.get(createdIds[bi]);
    bill.participantList.forEach((addr, k) => {
      const label = preimage?.participantLabels?.[k];
      if (!label) return;
      const key = addr.toLowerCase();
      if (!identities[key]) identities[key] = { label, provider: preimage?.participantProviders?.[k] ?? null };
    });
  });
  const counterpartyAddresses = [
    ...treasuryCreated.flatMap((b) => b.participants.map((p) => p.addr)),
    ...treasuryOwed.map((b) => b.splitter),
  ];
  for (const [addr, user] of await getUsersByWallets(counterpartyAddresses)) {
    identities[addr] = { label: `@${user.handle}`, provider: user.provider };
  }

  const treasury = buildTreasury({
    myWallets: wallets,
    created: treasuryCreated,
    owed: treasuryOwed,
    identities,
  });
```

- [x] **Step 4: Attach it to the response**

The route ends with `return Response.json(data);`. Change the final two statements to:

```ts
  return Response.json({ ...data, treasury });
```

- [x] **Step 5: Add the demo fixture block**

`DEMO_DASHBOARD` is typed `DashboardData`, so it must now carry `treasury` or the file will not compile. Append inside the object in `lib/dashboard-fixture.ts`, after `recurring`:

```ts
  // Nets to -18.35: two counterparties owe me, one I owe more than they owe me.
  treasury: {
    positions: [
      {
        counterparty: "0x9f3c2b1a7d6e5048392a1b0c4d5e6f7089abcdef",
        label: "@dev",
        bucket: "x",
        theyOweMeUsdc: "0",
        iOweThemUsdc: "43.75",
        netUsdc: "-43.75",
        payBillIds: ["41", "44"],
      },
      {
        counterparty: "0x2e4f6a8c0b1d3f5709a8b7c6d5e4f3a2b1c0d9e8",
        label: "@carla",
        bucket: "discord",
        theyOweMeUsdc: "18.4",
        iOweThemUsdc: "0",
        netUsdc: "18.4",
        payBillIds: [],
      },
      {
        counterparty: "0x7a1b2c3d4e5f60718293a4b5c6d7e8f901234567",
        label: "sam@example.com",
        bucket: "email",
        theyOweMeUsdc: "7",
        iOweThemUsdc: "0",
        netUsdc: "7",
        payBillIds: [],
      },
    ],
    claimBillIds: ["38", "40"],
    totalTheyOweMeUsdc: "25.4",
    totalIOweThemUsdc: "43.75",
    netUsdc: "-18.35",
    claimableUsdc: "72.25",
    payLegCount: 2,
    claimLegCount: 2,
    grossTxCount: 6, // 2 debts x (approve + payDebt) + 2 claims
  },
```

- [x] **Step 6: Verify**

Run: `npx next build`
Expected: compiles with no type error on `app/api/dashboard/route.ts` or `lib/dashboard-fixture.ts`.

Then run the dev server and check the payload includes the new block:

```bash
npm run dev
# in another shell:
curl -s "http://localhost:3000/api/dashboard?demo=1" | grep -o '"treasury"'
```

Expected: prints `"treasury"`.

- [x] **Step 7: Commit**

```bash
git add app/api/dashboard/route.ts lib/dashboard-fixture.ts
git commit -m "feat(treasury): serve net positions from the dashboard route"
```

---

## Task 5: Atomic batched settle for the Circle SCA wallet

**Files:**
- Modify: `lib/registry-calldata.ts` (append the `executeBatch` encoder)
- Modify: `lib/registry-calldata.test.ts` (append two cases — the file exists, do not overwrite it)
- Create: `app/api/treasury/settle/route.ts`

**Interfaces:**
- Consumes: `getSessionUser`; `verifyWalletUnlock`, `WALLET_UNLOCK_COOKIE`; `getBillIdsForParticipantOnchain`, `getBillIdsForSplitterOnchain`, `getParticipantsOnchain`, `getBillsOnchain`, `REGISTRY_ADDRESS`; `encodeApprove`, `encodePayDebt`, `encodeClaim`; `executeContractOnArc`, `InsufficientFundsError`; `recordPaidFeedbackSafely`.
- Produces:
  - `encodeExecuteBatch(calls: { to: string; value?: bigint; data: \`0x${string}\` }[]): \`0x${string}\`` in `lib/registry-calldata.ts`
  - `POST /api/treasury/settle` → `{ ok: true; txHash: string | null; paid: { billId: string; amountUsdc: string }[]; claimed: { billId: string; amountUsdc: string }[] }`

**Why one transaction.** Splitsy provisions social wallets as Circle SCA accounts (`lib/circle-dcw.ts:180`), and Circle's batch-operations doc bundles user-ops by calling `executeBatch((address,uint256,bytes)[])` **on the wallet's own address**. So approve + every payDebt + every claim go on chain as one atomic transaction. Because it is atomic, there is no partial-failure state to report: it all lands or none of it does.

**Takes no request body on purpose.** Every amount is re-read from chain, so there is nothing a client could usefully (or maliciously) supply.

- [x] **Step 1: Add the `executeBatch` encoder**

Append to `lib/registry-calldata.ts`:

```ts
// Circle SCA wallets expose executeBatch on the wallet address itself: each
// tuple is (target contract, native value, calldata) and the whole batch lands
// as ONE atomic transaction — any reverting leg reverts all of it.
// See https://developers.circle.com/wallets/batch-operations.md
// Encoded here rather than passed as abiFunctionSignature/abiParameters because
// Circle treats those as mutually exclusive with callData, and
// executeContractOnArc already sends callData.
export const SCA_BATCH_ABI = [
  {
    type: "function",
    name: "executeBatch",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "calls",
        type: "tuple[]",
        components: [
          { name: "target", type: "address" },
          { name: "value", type: "uint256" },
          { name: "data", type: "bytes" },
        ],
      },
    ],
    outputs: [],
  },
] as const;

export function encodeExecuteBatch(
  calls: { to: string; value?: bigint; data: `0x${string}` }[],
): `0x${string}` {
  if (calls.length === 0) throw new Error("encodeExecuteBatch: no calls");
  return encodeFunctionData({
    abi: SCA_BATCH_ABI,
    functionName: "executeBatch",
    args: [calls.map((c) => ({ target: c.to as `0x${string}`, value: c.value ?? 0n, data: c.data }))],
  });
}
```

- [x] **Step 2: Write the encoder test**

`lib/registry-calldata.test.ts` already exists. Append (do not overwrite):

```ts
test("encodeExecuteBatch round-trips every leg in order", () => {
  const approve = encodeApprove("0x1111111111111111111111111111111111111111", 3_000000n);
  const pay = encodePayDebt(7n, 1_000000n);
  const batch = encodeExecuteBatch([
    { to: "0x2222222222222222222222222222222222222222", data: approve },
    { to: "0x3333333333333333333333333333333333333333", data: pay },
  ]);

  const decoded = decodeFunctionData({ abi: SCA_BATCH_ABI, data: batch });
  assert.equal(decoded.functionName, "executeBatch");
  const calls = decoded.args[0] as readonly { target: string; value: bigint; data: string }[];
  assert.equal(calls.length, 2);
  assert.equal(calls[0].target.toLowerCase(), "0x2222222222222222222222222222222222222222");
  assert.equal(calls[0].value, 0n);
  assert.equal(calls[0].data, approve);
  assert.equal(calls[1].data, pay); // order preserved: approve must precede the pays
});

test("encodeExecuteBatch refuses an empty batch", () => {
  assert.throws(() => encodeExecuteBatch([]), /no calls/);
});
```

Extend that file's existing import from `./registry-calldata.ts` with `encodeExecuteBatch` and `SCA_BATCH_ABI`. It already imports `decodeFunctionData` from `viem`, `encodeApprove` and `encodePayDebt` — leave those alone.

- [x] **Step 3: Run the encoder test, expect PASS**

Run: `node --test --experimental-strip-types lib/registry-calldata.test.ts`
Expected: all tests pass, including the two new ones.

- [x] **Step 4: Read the Next.js route-handler guide**

Run:

```bash
ls node_modules/next/dist/docs/
```

Read the route-handler / `after()` guide before writing the file. `app/api/onchain-bills/[billId]/pay/route.ts` is the in-repo reference for the exact shape (`runtime`, `dynamic`, `after` from `next/server`).

- [x] **Step 5: Implement the route**

```ts
// app/api/treasury/settle/route.ts
// "Settle net" for the Circle wallet identity: approve, pay every outstanding
// debt, and claim every funded bill — as ONE atomic on-chain transaction.
//
// Splitsy's social wallets are Circle SCA accounts (lib/circle-dcw.ts), which
// expose executeBatch on the wallet's own address. Atomicity is the point: one
// reverting leg reverts everything, so there is no half-settled state to report
// or unwind. See https://developers.circle.com/wallets/batch-operations.md
//
// Note this does NOT move less USDC — registry escrow binds each debt to its
// billId, so every debt still gets its own payDebt leg. What collapses is the
// transaction count: 2N+M calls become 1.
//
// Every amount is read from chain, never from the client (hence no request body).
import { cookies } from "next/headers";
import { after } from "next/server";
import { getSessionUser } from "@/lib/session";
import { verifyWalletUnlock, WALLET_UNLOCK_COOKIE } from "@/lib/session-core";
import { encodeApprove, encodeClaim, encodeExecuteBatch, encodePayDebt } from "@/lib/registry-calldata";
import { executeContractOnArc, InsufficientFundsError } from "@/lib/circle-dcw";
import {
  REGISTRY_ADDRESS,
  getBillIdsForParticipantOnchain,
  getBillIdsForSplitterOnchain,
  getBillsOnchain,
  getParticipantsOnchain,
} from "@/lib/arc-read";
import { recordPaidFeedbackSafely } from "@/lib/erc8004";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ARC_USDC_ADDRESS = process.env.ARC_TESTNET_USDC_ADDRESS ?? "0x3600000000000000000000000000000000000000";

const usdc = (v: bigint) => (Number(v) / 1e6).toString();

export async function POST() {
  const user = await getSessionUser();
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });

  const secret = process.env.SESSION_SECRET ?? "";
  const unlockToken = (await cookies()).get(WALLET_UNLOCK_COOKIE)?.value ?? "";
  if (verifyWalletUnlock(unlockToken, secret, Date.now()) !== user.id) {
    return Response.json({ error: "locked" }, { status: 403 });
  }
  if (!user.circle_wallet_id || !user.wallet_address) {
    return Response.json({ error: "Your wallet isn't provisioned yet. Log in again." }, { status: 409 });
  }
  const wallet = user.wallet_address as `0x${string}`;
  const walletId = user.circle_wallet_id;

  // 1. Derive every leg from chain.
  const [owedIds, createdIds] = await Promise.all([
    getBillIdsForParticipantOnchain(wallet),
    getBillIdsForSplitterOnchain(wallet),
  ]);
  const [parts, createdBills] = await Promise.all([
    getParticipantsOnchain(owedIds.map((billId) => ({ billId, addr: wallet }))),
    getBillsOnchain([...createdIds]),
  ]);

  const payLegs = owedIds.flatMap((billId, i) => {
    const p = parts[i];
    if (!p) return [];
    const remaining = p.owed - p.paid;
    return remaining > 0n ? [{ billId, amount: remaining }] : [];
  });
  const claimLegs = createdBills.flatMap((b) => {
    if (!b) return [];
    const claimable = b.totalPaid - b.claimed;
    return claimable > 0n ? [{ billId: b.billId, amount: claimable }] : [];
  });

  if (payLegs.length === 0 && claimLegs.length === 0) {
    return Response.json({ error: "Nothing to settle." }, { status: 409 });
  }

  // 2. Build the batch. Order matters: the approval must precede the payDebts
  //    that spend it. Claims are independent and go last.
  const total = payLegs.reduce((s, l) => s + l.amount, 0n);
  const calls: { to: string; data: `0x${string}` }[] = [];
  if (total > 0n) {
    calls.push({ to: ARC_USDC_ADDRESS, data: encodeApprove(REGISTRY_ADDRESS, total) });
  }
  for (const leg of payLegs) {
    calls.push({ to: REGISTRY_ADDRESS, data: encodePayDebt(leg.billId, leg.amount) });
  }
  for (const leg of claimLegs) {
    calls.push({ to: REGISTRY_ADDRESS, data: encodeClaim(leg.billId, leg.amount) });
  }

  // 3. One atomic transaction, sent to the wallet's OWN address (that is where
  //    executeBatch lives on an SCA account).
  let tx: { txHash: string | null };
  try {
    tx = await executeContractOnArc(walletId, wallet, encodeExecuteBatch(calls));
  } catch (err) {
    if (err instanceof InsufficientFundsError) {
      return Response.json({ error: "insufficient_funds" }, { status: 402 });
    }
    // Atomic: nothing settled, so report the whole thing as failed.
    return Response.json(
      { error: err instanceof Error ? err.message : "Settlement failed" },
      { status: 502 },
    );
  }

  // Same consent rule as the per-bill pay route: paying a full remaining share
  // is what permits ERC-8004 scoring. Deferred so the extra txs never delay this
  // response, and never turn a settled batch into an error.
  if (tx.txHash) {
    const paymentTxHash = tx.txHash;
    for (const leg of payLegs) {
      const billId = leg.billId.toString();
      after(() => recordPaidFeedbackSafely({ payerAddress: wallet, payerWalletId: walletId, billId, paymentTxHash }));
    }
  }

  return Response.json({
    ok: true,
    txHash: tx.txHash,
    paid: payLegs.map((l) => ({ billId: l.billId.toString(), amountUsdc: usdc(l.amount) })),
    claimed: claimLegs.map((l) => ({ billId: l.billId.toString(), amountUsdc: usdc(l.amount) })),
  });
}
```

- [x] **Step 6: Verify the guards, before any happy path**

Run: `npm run dev`, then with **no** session cookie:

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3000/api/treasury/settle
```

Expected: `401`.

Then signed in but with the wallet locked (do not enter the PIN): expected `403` with `{"error":"locked"}`. Then, signed in and unlocked with no open debts: expected `409` `"Nothing to settle."`.

- [x] **Step 7: Verify a real atomic settle**

With the social identity signed in, unlocked, and owing at least two bills:

```bash
curl -s -X POST http://localhost:3000/api/treasury/settle | head -c 600
```

Expected: `"ok":true` with a **single** `txHash`, and `paid` listing every open debt.

**This is the step that validates the whole approach — check the transaction on chain.** Open `https://testnet.arcscan.app/tx/<txHash>` and confirm one transaction contains the approve, every `payDebt`, and every `claim`. If Circle rejects `executeBatch` on Arc (a 400 naming the function or the account type), the SCA batch path is unavailable on this chain: fall back to the sequential loop — `executeContractOnArc` once per leg, in the same order, with a `errors[]` array for partial failure — and update `TreasurySection`'s copy in Task 6 to the "one approval instead of N" claim rather than "one transaction". Record whichever happened in the commit message.

- [x] **Step 8: Commit**

```bash
git add lib/registry-calldata.ts lib/registry-calldata.test.ts app/api/treasury/settle/route.ts
git commit -m "feat(treasury): atomic batched settle via Circle SCA executeBatch"
```

---

## Task 6: Treasury view in the dashboard panel

**Files:**
- Modify: `app/DashboardPanel.tsx` (props, view toggle, new section)

**Interfaces:**
- Consumes: `DashboardData.treasury` (Task 1/4); `POST /api/treasury/settle` (Task 5); `GET /api/wallet/pin` (existing unlock check).
- Produces: `DashboardPanel` accepts `onSettleNet?: () => Promise<void>` (browser-wallet settle, implemented in Task 7).

- [x] **Step 1: Extend the props and add view state**

At `app/DashboardPanel.tsx:151`, change the component signature to:

```tsx
export default function DashboardPanel({
  socialWallet = null,
  browserWallet = null,
  onSettleNet,
}: {
  socialWallet?: string | null;
  browserWallet?: string | null;
  // Settle from the connected browser wallet. Owned by HomeClient, which holds
  // the wallet client and the progress modal; undefined when none is connected.
  onSettleNet?: () => Promise<void>;
}) {
```

Add next to the other `useState` calls (after the `buckets` state at line 168):

```tsx
  const [view, setView] = useState<"analytics" | "treasury">("analytics");
```

Also extend the imports at line 26 to bring in the treasury type and two icons:

```tsx
import { IDENTITY_BUCKETS, type DashboardData, type IdentityBucket, type TreasuryPlan } from "@/lib/dashboard-types";
```

and add `Landmark` and `ArrowRightLeft` to the existing `lucide-react` import at line 17.

- [x] **Step 2: Render the toggle and switch views**

In the returned JSX (line 281 onward), insert the toggle right after `<DashboardHeader … />` and wrap the existing sections:

```tsx
      <ViewToggle view={view} onView={setView} />

      {view === "treasury" ? (
        <TreasurySection
          treasury={data.treasury}
          isDemo={data.isDemo}
          scope={effectiveScope}
          bothIdentities={bothIdentities}
          onSettleNet={onSettleNet}
          onSettled={reload}
        />
      ) : showEmpty ? (
        <EmptyState onDemo={toggleDemo} />
      ) : (
        <>
          <KpiRow data={data} filtered={filtered} />
          {/* …existing sections unchanged… */}
        </>
      )}
```

Keep every existing child of that fragment exactly as it is — only the surrounding condition changes.

- [x] **Step 3: Add the toggle component**

Append near the other shells (below `DashboardHeader`):

```tsx
function ViewToggle({ view, onView }: { view: "analytics" | "treasury"; onView: (v: "analytics" | "treasury") => void }) {
  return (
    <div className="flex gap-1 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-muted)] p-1 text-sm w-fit">
      {(["analytics", "treasury"] as const).map((v) => (
        <button
          key={v}
          type="button"
          onClick={() => onView(v)}
          className={`rounded-[calc(var(--radius)-4px)] px-3 py-1.5 capitalize ${
            view === v ? "bg-[var(--surface)] font-semibold" : "text-[var(--text-muted)]"
          }`}
        >
          {v}
        </button>
      ))}
    </div>
  );
}
```

- [x] **Step 4: Add the treasury section**

Append at the end of the file:

```tsx
// One net position per counterparty, plus the single batched settle action.
// The netting here is a VIEW of exposure: registry escrow means each debt is
// still discharged by its own payDebt leg (see lib/treasury.ts). What batching
// removes is transactions, not transfers — and how many depends on who signs:
// a Circle SCA wallet does the whole batch atomically in ONE tx, a browser EOA
// still needs one approve plus one tx per leg.
function TreasurySection({
  treasury,
  isDemo,
  scope,
  bothIdentities,
  onSettleNet,
  onSettled,
}: {
  treasury: TreasuryPlan;
  isDemo: boolean;
  scope: Scope;
  bothIdentities: boolean;
  onSettleNet?: () => Promise<void>;
  onSettled: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const { payLegCount, claimLegCount, grossTxCount } = treasury;
  const hasWork = payLegCount > 0 || claimLegCount > 0;
  // "all" spans both identities and each signs differently (Circle SCA batch vs.
  // browser EOA), so settling needs an explicit choice of which one pays.
  const needsScopeChoice = bothIdentities && scope === "all";
  const canSettle = hasWork && !isDemo && !needsScopeChoice && (scope === "social" || Boolean(onSettleNet));
  // Social = Circle SCA → one atomic executeBatch. Wallet = EOA → 1 approve + N.
  const atomic = scope === "social";
  const settledTxCount = atomic ? 1 : (payLegCount > 0 ? 1 : 0) + payLegCount + claimLegCount;

  async function settle() {
    setBusy(true);
    setNote(null);
    try {
      if (scope === "wallet") {
        await onSettleNet!();
      } else {
        const pin = await fetch("/api/wallet/pin").then((r) => r.json()).catch(() => ({}));
        if (!pin.unlocked) {
          setNote("Unlock your wallet (the wallet button in the bottom-right corner), then tap Settle net again.");
          return;
        }
        const res = await fetch("/api/treasury/settle", { method: "POST" });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setNote(data.error === "insufficient_funds" ? "Your wallet needs more test USDC." : data.error ?? "Settlement failed.");
          return;
        }
        const legs = (data.paid?.length ?? 0) + (data.claimed?.length ?? 0);
        setNote(`Settled ${legs} position${legs === 1 ? "" : "s"} in one transaction on Arc.`);
      }
      onSettled();
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Settlement failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <TreasuryTile label="Owed to me" value={usd(treasury.totalTheyOweMeUsdc)} />
        <TreasuryTile label="I owe" value={usd(treasury.totalIOweThemUsdc)} />
        <TreasuryTile label="Net position" value={usd(treasury.netUsdc)} emphasis />
        <TreasuryTile label="Claimable now" value={usd(treasury.claimableUsdc)} />
      </div>

      <div className="panel space-y-3">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <Landmark size={16} className="text-[var(--accent)]" /> Net position by counterparty
        </h3>
        {treasury.positions.length === 0 ? (
          <p className="text-sm text-[var(--text-muted)]">Nothing outstanding — every bill is settled.</p>
        ) : (
          <ul className="space-y-2">
            {treasury.positions.map((p) => {
              const net = num(p.netUsdc);
              return (
                <li
                  key={p.counterparty}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-muted)] p-3 text-sm"
                >
                  <span className="flex items-center gap-2">
                    <strong>{p.label.startsWith("0x") ? shortAddr(p.label) : p.label}</strong>
                    <span className="text-xs text-[var(--text-muted)]">{BUCKET_LABEL[p.bucket]}</span>
                  </span>
                  <span className="flex items-center gap-3 text-xs text-[var(--text-muted)]">
                    <span>they owe {usd(p.theyOweMeUsdc)}</span>
                    <ArrowRightLeft size={13} />
                    <span>I owe {usd(p.iOweThemUsdc)}</span>
                    <strong className={`amount-text text-sm ${net < 0 ? "text-[var(--warning-text)]" : "text-[var(--text)]"}`}>
                      {net >= 0 ? "+" : ""}
                      {usd(p.netUsdc)}
                    </strong>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="panel space-y-3">
        <p className="text-sm">
          Settling each bill separately: <strong className="amount-text">{grossTxCount}</strong> transactions.{" "}
          {atomic ? (
            <>
              From your Splitsy wallet: <strong className="amount-text">1</strong> — every approval, payment and claim
              lands in a single atomic transaction.
            </>
          ) : (
            <>
              In one batch: <strong className="amount-text">{settledTxCount}</strong> — a single USDC approval covers
              every payment.
            </>
          )}
        </p>
        <p className="text-xs text-[var(--text-muted)]">
          Each bill is escrowed on Arc, so its debt is still paid to its own bill — batching removes transactions, not
          transfers.
        </p>
        {needsScopeChoice ? (
          <p className="text-xs text-[var(--text-muted)]">Pick Social or Non-custodial above to choose which wallet settles.</p>
        ) : null}
        <button type="button" className="primary-button" disabled={!canSettle || busy} onClick={settle}>
          {busy ? <Loader2 size={15} className="animate-spin" /> : <ArrowRightLeft size={15} />}
          {busy ? "Settling on Arc…" : "Settle net"}
        </button>
        {note ? <p className="text-xs text-[var(--text-muted)]">{note}</p> : null}
        {isDemo ? <p className="text-xs text-[var(--text-muted)]">Sample data — settling is disabled.</p> : null}
      </div>
    </div>
  );
}

function TreasuryTile({ label, value, emphasis }: { label: string; value: string; emphasis?: boolean }) {
  return (
    <div className="panel">
      <div className="text-xs text-[var(--text-muted)]">{label}</div>
      <div className={`amount-text ${emphasis ? "text-xl font-semibold" : "text-lg"}`}>{value}</div>
    </div>
  );
}
```

- [x] **Step 5: Verify**

Run: `npm run dev`, open the dashboard tab, switch to **Treasury**. Then:
- `?demo=1` (the "View sample data" toggle) shows three counterparties, a net of `-$18.35`, and a disabled Settle button.
- With a real signed-in wallet that owes bills, the positions list matches what the Bills tab shows.
- Scope **Social** reads "…6 transactions. From your Splitsy wallet: 1 — …atomic transaction."; scope **Non-custodial** reads "…In one batch: N — a single USDC approval…". Confirm both, since they are different claims.

Run: `npx next build` — expected: no type errors.

- [x] **Step 6: Commit**

```bash
git add app/DashboardPanel.tsx
git commit -m "feat(treasury): net-position view + batched settle action"
```

---

## Task 7: Browser-wallet settle path

**Files:**
- Modify: `app/HomeClient.tsx` (add `settleNetWithWallet`, pass `onSettleNet` at line ~2848)

**Interfaces:**
- Consumes: `connectBillWallet`, `ensureBillSplitWalletOnArc`, `approveBillRegistry`, `payBillDebtWithMemo`, `claimBillFunds`, `readDebtsForWallet`, `readBillsForSplitter` (all existing); `setProgressFlow`/`advanceFlow`/`completeFlow`/`failFlow`, `refreshBillRegistry`.
- Produces: `onSettleNet` prop value for `DashboardPanel` (Task 6).

**Why this one is not atomic.** A connected browser wallet is a plain EOA — `executeBatch` (Task 5) exists only on the Circle SCA account. So this path stays a sequential loop: one approval for the summed total, then one transaction per leg. That asymmetry is deliberate and is what the scope-dependent copy in Task 6 reports.

Amounts are read from chain here too — `readDebtsForWallet` / `readBillsForSplitter` already exist in `lib/bill-split-contracts.ts`, so the dashboard's plan is display-only and a stale plan can never sign a wrong amount.

- [x] **Step 1: Check what the existing readers return**

Run:

```bash
grep -n "async function readDebt\b" -A 25 lib/bill-split-contracts.ts
```

Note the exact field names for the per-bill remaining/claimable values, and use those below in place of `remaining` / `claimable` if they differ.

- [x] **Step 2: Add the settle function**

Insert after `payDebtOnArc` (which ends at `app/HomeClient.tsx:1388`):

```tsx
  // "Settle net" from the connected browser wallet: ONE approval for the summed
  // outstanding debt, then one payDebt per bill (escrow binds each debt to its
  // billId — no on-chain netting exists), then claim every funded bill I created.
  // Sequential, not atomic: executeBatch is an SCA feature and this is an EOA —
  // the Circle-wallet path (/api/treasury/settle) is the one-transaction one.
  // Legs are re-read from chain, never taken from the dashboard payload.
  async function settleNetWithWallet() {
    const wallet = billWallet ?? (await connectBillWallet());
    if (!wallet) return;

    const [myDebts, myBills] = await Promise.all([
      readDebtsForWallet(wallet.account),
      readBillsForSplitter(wallet.account),
    ]);
    const payLegs = myDebts.filter((d) => d.remaining > 0n);
    const claimLegs = myBills.filter((b) => b.claimable > 0n);
    if (payLegs.length === 0 && claimLegs.length === 0) {
      setBillMessage("Nothing to settle — every bill is already square.");
      return;
    }

    const total = payLegs.reduce((sum, d) => sum + d.remaining, 0n);
    setProgressFlow({
      kind: "pay",
      open: true,
      amountLabel: billUnitsToUsdc(total),
      contextLabel: `${payLegs.length + claimLegs.length} positions`,
      status: "running",
      errorMessage: "",
      steps: [
        { key: "switch", icon: "switch", label: "Connect to Arc Testnet", hint: "Approve the network switch in your wallet", state: "active" },
        { key: "approve", icon: "approve", label: "Approve USDC once", hint: "One approval covers every payment below", state: "pending" },
        { key: "pay", icon: "pay", label: `Settle ${payLegs.length} debt${payLegs.length === 1 ? "" : "s"}`, hint: "One payment per escrowed bill", state: "pending" },
        { key: "claim", icon: "claim", label: `Collect ${claimLegs.length} bill${claimLegs.length === 1 ? "" : "s"}`, hint: "Pull paid USDC to your wallet", state: "pending" },
      ],
    });

    try {
      setBillState("working");
      await ensureBillSplitWalletOnArc(wallet);
      advanceFlow("switch", "approve");

      if (total > 0n) {
        await approveBillRegistry({ ...wallet, amount: total });
      }
      advanceFlow("approve", "pay");

      for (const debt of payLegs) {
        await payBillDebtWithMemo({ ...wallet, billId: debt.billId, amount: debt.remaining });
      }
      advanceFlow("pay", "claim");

      for (const bill of claimLegs) {
        await claimBillFunds({ ...wallet, billId: bill.billId, amount: bill.claimable });
      }
      completeFlow();

      setBillState("success");
      setBillMessage(
        `Settled ${payLegs.length + claimLegs.length} positions on Arc with ${total > 0n ? "one" : "no"} USDC approval.`,
      );
      await refreshBillRegistry(wallet.account);
    } catch (caught) {
      setBillState("error");
      failFlow(errorMessage(caught));
      throw caught; // the panel surfaces it too
    }
  }
```

Verify `claimBillFunds` and `readBillsForSplitter` are in the `@/lib/bill-split-contracts` import block at the top of the file; add whichever are missing.

- [x] **Step 3: Pass it down**

At `app/HomeClient.tsx:2848`, change:

```tsx
            <DashboardPanel
              socialWallet={socialWalletAddress}
              browserWallet={connectedWalletAccount}
              onSettleNet={connectedWalletAccount ? settleNetWithWallet : undefined}
            />
```

- [x] **Step 4: Verify end to end**

Run `npm run dev` with a connected browser wallet that owes at least two bills:
1. Dashboard → Treasury → scope **Non-custodial** → **Settle net**.
2. The wallet must prompt for exactly **one** `approve`, then one `payDebt` per bill.
3. The progress modal advances switch → approve → pay → claim and lands on success.
4. Return to the Bills tab: the settled debts read as paid.

Run: `npx next build` — expected: no type errors.

- [x] **Step 5: Commit**

```bash
git add app/HomeClient.tsx
git commit -m "feat(treasury): batched settle from the connected browser wallet"
```

---

## Task 8: Regression pass

**Files:** none (verification only)

- [ ] **Step 1: Run every test**

```bash
npm run test:treasury && npm run test:netting && npm run test:dashboard && npm run test:dashboard-create
node --test --experimental-strip-types lib/registry-calldata.test.ts
```

Expected: all pass. `test:netting` must still pass untouched — `lib/netting.ts` was deliberately not modified.

- [ ] **Step 2: Lint + build**

```bash
npm run lint && npx next build
```

Expected: both exit 0.

- [ ] **Step 3: Confirm the analytics view is unchanged**

Open the dashboard with a real wallet, stay on **Analytics**, and confirm the KPI row, activity chart, identity buckets, counterparties, aging, reputation and recurring sections all render exactly as before, and that switching Analytics ↔ Treasury does not refetch (the sessionStorage cache still serves the panel).

- [ ] **Step 4: Commit if anything needed fixing**

```bash
git commit -am "fix(treasury): regression fixes from the verification pass"
```

(Skip if the working tree is clean.)

---

## Self-Review

**Spec coverage** (`docs/superpowers/specs/2026-07-24-agentic-nanopayments-treasury-design.md` § "Feature 3 — Net-settlement treasury"):

| Spec requirement | Task |
| --- | --- |
| Read model: aggregate every open debt and credit into one net position per counterparty | Tasks 2, 4 |
| Reuse `lib/netting.ts` | **Deliberately not done** — see the Global Constraints note. Its `Member`/`Charge` model has no live producer and its third-party routing is unexecutable under registry escrow. Substituted with `lib/treasury.ts`, same shape of value, honest about what settles. Flagged here rather than silently dropped. |
| Action: "Settle net" fires transfers through the existing pay path | Tasks 5 (Circle SCA, one atomic `executeBatch`) + 7 (browser EOA, sequential), both reusing the existing encoders/helpers |
| Framing as treasury infrastructure on the dashboard | Task 6 |
| New work = cross-bill aggregation read model, the view, wiring to existing per-transfer execution | Tasks 2/4, 6, 5/7 |
| Testing: "extends existing netting tests with a multi-bill fixture" | Task 2 — seven multi-bill cases against `buildTreasury` (not `netting.ts`, per the substitution above), plus two `encodeExecuteBatch` cases in Task 5 |
| Demo script step 4 ("many debts collapse to one net position; Settle net fires the transfers") | Tasks 4 (demo fixture), 6, 5/7. Copy states the escrow truth, so the demo claim is the one the code delivers — and on the social path "many debts → one transaction" is now literally true. |

**Placeholder scan:** No TBD/TODO. Every code step carries real code. Three steps deliberately ask the implementer to verify against live systems before proceeding (Task 3 Step 2 on address casing, Task 5 Step 7 on whether Arc accepts `executeBatch`, Task 7 Step 1 on `readDebt` field names) — each states its fallback action, so none is a deferred decision.

**Type consistency:**
- `TreasuryPosition` / `TreasuryPlan` are declared once (Task 1, `lib/dashboard-types.ts`) and imported by `lib/treasury.ts` (Task 2), the route (Task 4), the fixture (Task 4) and the panel (Task 6). No duplicate definitions, no module cycle.
- `buildTreasury(input: TreasuryInput)` field names — `myWallets`, `created`, `owed`, `identities` — match the call site in Task 4 exactly.
- `TreasuryCreatedBill.participants` is `{ addr; owed; paid }[]`, byte-identical to `CreatedBill.participants` in `lib/dashboard-aggregate.ts`, so Task 4's `.map` passes it through unchanged.
- `payLegCount` / `claimLegCount` / `grossTxCount` are produced in Task 2, asserted in its test, carried in the Task 4 fixture, and consumed by name in Task 6's `TreasurySection`. `nettedTxCount` was removed everywhere — the netted count is now scope-dependent and derived in the UI.
- `getUsersByWallets` returns `Map<string, { handle; provider }>` (Task 3) and Task 4 consumes exactly those two fields.
- `encodeExecuteBatch(calls: { to; value?; data }[])` (Task 5 Step 1) matches its call site in the same task's route, which passes `{ to, data }` and relies on the `value ?? 0n` default.
- `onSettleNet?: () => Promise<void>` is declared in Task 6 and supplied in Task 7 with a matching signature.
- Money: `bigint` inside `lib/treasury.ts`, decimal strings on the wire, `unitsToUsdc` as the single formatter. Neither settle path accepts a client amount.

**Two known rough edges, deliberately left:**
1. A counterparty I owe but who has no `users` row and no preimage label renders as a shortened address. Fixing it needs a creator label in the preimage table (a schema change on a table with `ignoreDuplicates` first-write-wins semantics) — out of proportion to a display fallback.
2. `executeBatch` on Arc Testnet is confirmed only by inference: the account type is SCA (`lib/circle-dcw.ts:180`), Circle documents batching for developer-controlled + MSCA wallets, and `ARC-TESTNET` is a supported `contractExecution` enum — but Circle's batch examples are all ETH-SEPOLIA. Task 5 Step 7 is the empirical check, with a documented sequential fallback. Do not ship the "one transaction" copy until that step passes on chain.
