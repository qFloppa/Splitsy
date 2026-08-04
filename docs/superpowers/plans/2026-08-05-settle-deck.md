# Settle Deck Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Bills tab's two inbox panels with a new Settle tab that presents every pending debt and claim as a full-viewport scroll-snap deck in the `/pay/[token]` poster style.

**Architecture:** A pure ordering function (`lib/settle-items.ts`) merges three existing data sources into one `SettleItem[]`. A new client component (`app/SettleDeck.tsx`) renders that array as CSS scroll-snap sections, receiving the existing payment handlers from `HomeClient` as props. No route, contract call, or signing path changes. `BillVerification` moves out of `HomeClient` into its own file because both the deck and History need it.

**Tech Stack:** Next.js 16.2.9, React 19, TypeScript, Tailwind v4 + `app/globals.css` custom properties, framer-motion (already present), `node:test` for unit tests.

**Spec:** `docs/superpowers/specs/2026-08-05-settle-deck-design.md`

## Global Constraints

- **`AGENTS.md` rule — this is not the Next.js you know.** Read the relevant guide in `node_modules/next/dist/docs/` before writing framework-level code. Heed deprecation notices.
- **No new dependencies.** `framer-motion`, `gsap`, `lenis`, `split-type`, `canvas-confetti` are already installed. Of these the deck uses only `canvas-confetti`. Lenis and split-type are deliberately NOT used — see spec.
- **No new design tokens.** Reuse `--pay-poster-bg`, `--pay-poster-fg`, `--pay-poster-dim`, `--pay-poster-rule`, `--pay-poster-fill`, `--pay-poster-settled` (`app/globals.css:42–48`, `:131–136`), and `--dur-1: 150ms`, `--dur-2: 260ms`, `--dur-3: 420ms`, `--dur-4: 700ms`, `--ease-out: cubic-bezier(0.22, 1, 0.36, 1)`, `--ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1)` (`app/globals.css:97–102`). The single exception is `--app-header-h`, introduced in Task 5.
- **Font:** Clash Display weight **300** across the whole surface, via `var(--font-clash)`. The face is a 200–700 variable font (`app/layout.tsx:18`), so 300 is available. `var(--font-geist-mono)` is permitted only for hashes and addresses.
- **Contrast floor:** the borderless Pay control must clear 4.5:1 against `--pay-poster-bg` at rest. Never render an interactive control below that.
- **Every animation block needs a `prefers-reduced-motion: reduce` counterpart**, matching the seven existing blocks in `app/globals.css`.
- **No route, contract, or signing changes.** `app/api/**` and `contracts/**` are untouched by every task in this plan.
- **Commit after every task.** Message style: lowercase `type(scope): imperative`, matching `git log`.

---

### Task 1: `lib/settle-items.ts` — the ordering function

Pure, no React, no DOM. This is the only piece with non-trivial logic, so it carries the plan's real test coverage.

**Files:**
- Create: `lib/settle-items.ts`
- Create: `lib/settle-items.test.ts`
- Modify: `package.json` (add `test:settle` script)

**Interfaces:**
- Consumes: `BillSplitDebt` from `lib/bill-split-contracts.ts:279`, `refundableNow` from `lib/treasury.ts:174`.
- Produces: `type SettleItem`, `type SocialDebt`, `type OwnedDebt`, `function settleItemId(billId, account)`, `function buildSettleItems(input)`. Tasks 2, 6, 7, 9, 10 all import from here.

- [ ] **Step 1: Write the failing test**

Create `lib/settle-items.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSettleItems, settleItemId, type OwnedDebt, type SocialDebt } from "./settle-items.ts";

const ACCOUNT_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const ACCOUNT_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;
const SPLITTER = "0xcccccccccccccccccccccccccccccccccccccccc" as const;

// A debt the signed-in user owes. Defaults describe a plain, open, non-escrow
// bill; each test overrides only the field it is about.
function debt(over: Partial<OwnedDebt> = {}): OwnedDebt {
  return {
    billId: 1n,
    account: ACCOUNT_A,
    via: "wallet",
    splitter: SPLITTER,
    metadataHash: "0x00",
    totalOwed: 100_000_000n,
    totalPaid: 0n,
    claimed: 0n,
    dueDate: 0n,
    escrowUntilFull: false,
    participantList: [],
    owed: 10_000_000n,
    paid: 0n,
    remaining: 10_000_000n,
    claimable: 0n,
    ...over,
  } as OwnedDebt;
}

function social(over: Partial<SocialDebt> = {}): SocialDebt {
  return { id: "s1", amountUsd: 5, merchant: "Tesco", creator: null, ...over };
}

test("section id combines bill and account, so one bill on two wallets is two sections", () => {
  assert.equal(settleItemId(1n, ACCOUNT_A), `1:${ACCOUNT_A.toLowerCase()}`);
  assert.notEqual(settleItemId(1n, ACCOUNT_A), settleItemId(1n, ACCOUNT_B));

  const items = buildSettleItems({
    socialDebts: [],
    walletDebts: [debt({ account: ACCOUNT_A }), debt({ account: ACCOUNT_B })],
    splitterBills: [],
    nowSeconds: 0n,
  });
  const debts = items.filter((i) => i.kind === "debt-wallet");
  assert.equal(debts.length, 2);
  assert.equal(new Set(debts.map((d) => d.id)).size, 2);
});

test("social debts are never editable, wallet debts are", () => {
  const items = buildSettleItems({
    socialDebts: [social()],
    walletDebts: [debt({ via: "social" }), debt({ billId: 2n, via: "wallet" })],
    splitterBills: [],
    nowSeconds: 0n,
  });
  const byKind = (k: string) => items.filter((i) => i.kind === k);
  assert.equal(byKind("debt-social")[0].editable, false);
  const wallets = byKind("debt-wallet");
  assert.equal(wallets.find((d) => d.debt.via === "social")?.editable, false);
  assert.equal(wallets.find((d) => d.debt.via === "wallet")?.editable, true);
});

test("dated debts sort before undated, earliest first, then by amount descending", () => {
  const items = buildSettleItems({
    socialDebts: [],
    walletDebts: [
      debt({ billId: 1n, dueDate: 0n, remaining: 30_000_000n }),
      debt({ billId: 2n, dueDate: 500n }),
      debt({ billId: 3n, dueDate: 100n }),
      debt({ billId: 4n, dueDate: 0n, remaining: 90_000_000n }),
    ],
    splitterBills: [],
    nowSeconds: 0n,
  });
  const ids = items.filter((i) => i.kind === "debt-wallet").map((i) => i.debt.billId);
  assert.deepEqual(ids, [3n, 2n, 4n, 1n]);
});

test("a refund-only row survives and sorts to the end of the debt run", () => {
  // escrowed, past due, still short, and this payer has money in — refundable
  // with nothing remaining. Filtering on `remaining > 0n` would drop it.
  const refundOnly = debt({
    billId: 9n,
    remaining: 0n,
    paid: 10_000_000n,
    totalPaid: 10_000_000n,
    escrowUntilFull: true,
    dueDate: 100n,
  });
  const items = buildSettleItems({
    socialDebts: [],
    walletDebts: [refundOnly, debt({ billId: 1n, dueDate: 50n })],
    splitterBills: [],
    nowSeconds: 999n,
  });
  const debts = items.filter((i) => i.kind === "debt-wallet");
  assert.equal(debts.length, 2);
  assert.equal(debts.at(-1)?.debt.billId, 9n);
  assert.equal(debts.at(-1)?.action, "refund");
  assert.equal(debts[0].action, "pay");
});

test("the divider appears only when both sides have rows", () => {
  const claim = debt({ billId: 7n, claimable: 60_000_000n });

  const both = buildSettleItems({ socialDebts: [social()], walletDebts: [], splitterBills: [claim], nowSeconds: 0n });
  assert.equal(both.filter((i) => i.kind === "divider").length, 1);

  const debtsOnly = buildSettleItems({ socialDebts: [social()], walletDebts: [], splitterBills: [], nowSeconds: 0n });
  assert.equal(debtsOnly.filter((i) => i.kind === "divider").length, 0);

  const claimsOnly = buildSettleItems({ socialDebts: [], walletDebts: [], splitterBills: [claim], nowSeconds: 0n });
  assert.equal(claimsOnly.filter((i) => i.kind === "divider").length, 0);
});

test("the divider carries the claim count and total", () => {
  const items = buildSettleItems({
    socialDebts: [social()],
    walletDebts: [],
    splitterBills: [debt({ billId: 7n, claimable: 60_000_000n }), debt({ billId: 8n, claimable: 18_000_000n })],
    nowSeconds: 0n,
  });
  const divider = items.find((i) => i.kind === "divider");
  assert.equal(divider?.claimCount, 2);
  assert.equal(divider?.totalUsd, 78);
});

test("only claimable bills become claim sections", () => {
  const items = buildSettleItems({
    socialDebts: [],
    walletDebts: [],
    splitterBills: [debt({ billId: 7n, claimable: 60_000_000n }), debt({ billId: 8n, claimable: 0n })],
    nowSeconds: 0n,
  });
  const claims = items.filter((i) => i.kind === "claim");
  assert.equal(claims.length, 1);
  assert.equal(claims[0].debt.billId, 7n);
});

test("an escrowed bill past its due date and still short becomes a failed claim section", () => {
  const items = buildSettleItems({
    socialDebts: [],
    walletDebts: [],
    splitterBills: [debt({ billId: 8n, claimable: 0n, escrowUntilFull: true, dueDate: 100n, totalPaid: 1n })],
    nowSeconds: 999n,
  });
  const failed = items.filter((i) => i.kind === "claim-failed");
  assert.equal(failed.length, 1);
  assert.equal(failed[0].debt.billId, 8n);
});

test("the end card is always last, even when nothing is pending", () => {
  const empty = buildSettleItems({ socialDebts: [], walletDebts: [], splitterBills: [], nowSeconds: 0n });
  assert.equal(empty.length, 1);
  assert.equal(empty[0].kind, "end");

  const full = buildSettleItems({
    socialDebts: [social()],
    walletDebts: [debt()],
    splitterBills: [debt({ billId: 7n, claimable: 60_000_000n })],
    nowSeconds: 0n,
  });
  assert.equal(full.at(-1)?.kind, "end");
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
node --test --experimental-strip-types lib/settle-items.test.ts
```

Expected: FAIL — `Cannot find module './settle-items.ts'`.

- [ ] **Step 3: Write the implementation**

Create `lib/settle-items.ts`:

```ts
import type { BillSplitDebt } from "./bill-split-contracts";
import { refundableNow } from "./treasury";

// A registry debt tagged with the wallet it belongs to. Mirrors HomeClient's
// OwnedBillSplitDebt — declared here too so this module stays importable by
// node:test without pulling a "use client" component into scope.
export type OwnedDebt = BillSplitDebt & { account: `0x${string}`; via: "wallet" | "social" };

// An off-chain debt tagged to a handle, as /api/bills returns it under `iOwe`.
export type SocialDebt = {
  id: string;
  amountUsd: number;
  merchant: string;
  creator: { provider?: string; handle: string; avatar_url: string | null } | null;
};

export type SettleItem =
  | { kind: "debt-social"; id: string; sortKey: SortKey; debt: SocialDebt; editable: false }
  | { kind: "debt-wallet"; id: string; sortKey: SortKey; debt: OwnedDebt; editable: boolean; action: "pay" | "refund"; refundable: bigint }
  | { kind: "divider"; id: "divider"; claimCount: number; totalUsd: number }
  | { kind: "claim"; id: string; debt: OwnedDebt; editable: boolean }
  | { kind: "claim-failed"; id: string; debt: OwnedDebt }
  | { kind: "end"; id: "end" };

// Two sections can exist for one bill: a dual-identity user may owe the same
// bill from their browser wallet and from their Circle DCW. Keying on billId
// alone collapses them into one, which is why every per-debt map in HomeClient
// is keyed by this too.
export function settleItemId(billId: bigint, account: string): string {
  return `${billId.toString()}:${account.toLowerCase()}`;
}

// Sort: refund-only rows last, then dated before undated, earliest date first,
// then larger amounts first. Tuple compare keeps it readable and stable.
type SortKey = [refundLast: 0 | 1, undated: 0 | 1, due: bigint, negAmount: bigint];

function compare(a: SortKey, b: SortKey): number {
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
}

const UNITS = 1_000_000; // USDC has 6 decimals
const toUsd = (units: bigint) => Number(units) / UNITS;

export function buildSettleItems(input: {
  socialDebts: SocialDebt[];
  walletDebts: OwnedDebt[];
  splitterBills: OwnedDebt[];
  nowSeconds: bigint;
}): SettleItem[] {
  const { socialDebts, walletDebts, splitterBills, nowSeconds } = input;

  // Social debts carry no due date on the wire, so they sort as undated.
  const socialItems: SettleItem[] = socialDebts.map((debt) => ({
    kind: "debt-social",
    id: `social:${debt.id}`,
    sortKey: [0, 1, 0n, -BigInt(Math.round(debt.amountUsd * UNITS))],
    debt,
    editable: false,
  }));

  const walletItems: SettleItem[] = walletDebts.map((debt) => {
    const refundable = refundableNow(debt, debt.paid, nowSeconds);
    // Nothing left to pay: the row is only still here because a failed
    // all-or-nothing bill owes this payer their money back.
    const action = debt.remaining === 0n && refundable > 0n ? "refund" : "pay";
    return {
      kind: "debt-wallet",
      id: settleItemId(debt.billId, debt.account),
      sortKey: [
        action === "refund" ? 1 : 0,
        debt.dueDate === 0n ? 1 : 0,
        debt.dueDate,
        -(action === "refund" ? refundable : debt.remaining),
      ],
      debt,
      // The server-signed routes read the debt from chain and ignore any client
      // amount, so only a browser-wallet row can be partially paid.
      editable: debt.via === "wallet",
      action,
      refundable,
    };
  });

  const debtItems = [...socialItems, ...walletItems].sort((a, b) =>
    compare((a as { sortKey: SortKey }).sortKey, (b as { sortKey: SortKey }).sortKey),
  );

  const claimItems: SettleItem[] = splitterBills
    .filter((debt) => debt.claimable > 0n)
    .map((debt) => ({
      kind: "claim",
      id: settleItemId(debt.billId, debt.account),
      debt,
      editable: debt.via === "wallet",
    }));

  // All-or-nothing bills that missed the deadline. `claimable` is 0n on these
  // forever, so without a section the creator watches them vanish with no word.
  const failedItems: SettleItem[] = splitterBills
    .filter(
      (debt) =>
        debt.escrowUntilFull && debt.totalPaid < debt.totalOwed && debt.dueDate !== 0n && nowSeconds >= debt.dueDate,
    )
    .map((debt) => ({ kind: "claim-failed", id: settleItemId(debt.billId, debt.account), debt }));

  const rightSide = [...claimItems, ...failedItems];
  const divider: SettleItem[] =
    debtItems.length > 0 && rightSide.length > 0
      ? [
          {
            kind: "divider",
            id: "divider",
            claimCount: rightSide.length,
            totalUsd: claimItems.reduce((sum, item) => sum + toUsd((item as { debt: OwnedDebt }).debt.claimable), 0),
          },
        ]
      : [];

  return [...debtItems, ...divider, ...rightSide, { kind: "end", id: "end" }];
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
node --test --experimental-strip-types lib/settle-items.test.ts
```

Expected: PASS, 9 tests.

- [ ] **Step 5: Add the test script**

In `package.json`, after the `"test:pay-link"` line:

```json
    "test:settle": "node --test --experimental-strip-types lib/settle-items.test.ts",
```

- [ ] **Step 6: Verify the script runs**

```bash
npm run test:settle
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/settle-items.ts lib/settle-items.test.ts package.json
git commit -m "feat(settle): order debts and claims into one deck sequence"
```

---

### Task 2: Re-key per-debt state by bill *and* account

A latent bug the deck would make visible. `debtMessages`, `partialPayments`, and `claimAmounts` are keyed by `debt.billId.toString()`, but rows render keyed by `${billId}:${account}` (`app/HomeClient.tsx:3508`). A dual-identity user owing the same bill from both wallets gets two rows sharing one amount input. In the deck, two sections would mirror each other's typed number.

Fix at the source, not in the deck.

**Files:**
- Modify: `app/HomeClient.tsx` (the four handlers and the maps they read)

**Interfaces:**
- Consumes: `settleItemId` from Task 1.
- Produces: nothing new; all per-debt maps are now keyed by `settleItemId(debt.billId, debt.account)`.

- [ ] **Step 1: Import the helper**

Add to the imports in `app/HomeClient.tsx`:

```ts
import { settleItemId } from "@/lib/settle-items";
```

- [ ] **Step 2: Change `debtKey` in all four handlers**

In `payDebtOnArc` (`:1434`), `refundOnArc` (`:1547`), `claimSplitterFunds` (`:1877`), and `bridgeForDebt` (`:1705`), replace:

```ts
    const debtKey = debt.billId.toString();
```

with:

```ts
    // Keyed by bill AND account: a dual-identity user can owe the same bill from
    // their browser wallet and their Circle DCW, and one key would let the two
    // rows share an amount input and overwrite each other's messages.
    const debtKey = settleItemId(debt.billId, debt.account);
```

`bridgeForDebt` takes a bare `BillSplitDebt` (`:1705`) with no `account`. Widen its parameter to `OwnedBillSplitDebt` — every call site already passes one.

- [ ] **Step 2b: Alias the duplicated debt type**

`HomeClient` declares `OwnedBillSplitDebt` (`:280`) and Task 1 declares an
identical `OwnedDebt`. They are structurally interchangeable today, which is
exactly how they drift apart later. Replace the local declaration with:

```ts
import type { OwnedDebt } from "@/lib/settle-items";

type OwnedBillSplitDebt = OwnedDebt;
```

- [ ] **Step 3: Fix the API paths that used `debtKey` as a bill id**

`debtKey` is interpolated into request URLs. Those must stay the bare bill id. Search `app/HomeClient.tsx` for `${debtKey}` inside a template literal starting `/api/` — there are three (`/api/onchain-bills/${debtKey}/pay`, `/claim`, `/refund`). Replace each with `${debt.billId}`:

```ts
        const res = await fetch(`/api/onchain-bills/${debt.billId}/pay`, { method: "POST" });
```

This is the step most likely to be missed. Grep afterwards to confirm none remain:

```bash
grep -n 'api/onchain-bills/\${debtKey}' app/HomeClient.tsx
```

Expected: no output.

- [ ] **Step 4: Update the render sites that read the maps**

In `WalletDebtRows` (`:3486`) and `ClaimFundsPanel` (`:3794`), the local `const key = debt.billId.toString();` feeds both the map lookups and the React key. Change it to:

```ts
              const key = settleItemId(debt.billId, debt.account);
```

and simplify the now-redundant React keys from `` key={`${key}:${debt.account}`} `` to `key={key}`. Where `key` was shown to the user as `Bill #{key}`, use `Bill #{debt.billId.toString()}` — the composite id is not for display.

- [ ] **Step 5: Add `subjectKey` to `ProgressFlow`**

In the `ProgressFlow` type (`:197`), add:

```ts
  // Which deck section owns this flow, as settleItemId(). Lets the Settle deck
  // render the step ticker inside the right section. Null for flows that aren't
  // about a single debt (the multi-position settle at :1635).
  subjectKey: string | null;
```

Then set it at all five `setProgressFlow({` sites (`:1317`, `:1336`, `:1352`, `:1367`, `:1635`). Give `beginPayFlow`, `beginSocialPayFlow`, and `beginClaimFlow` their existing first parameter (already the debt key) as `subjectKey`. `beginBridgeFlow` needs a new first parameter:

```ts
  function beginBridgeFlow(subjectKey: string, amountLabel: string, source: string) {
```

and both call sites (`:1732`, `:1841`) pass `debtKey`. The multi-position settle at `:1635` passes `subjectKey: null`.

- [ ] **Step 6: Verify it compiles and the app still pays**

```bash
npx tsc --noEmit && npm run lint
```

Expected: no errors. Then run `npm run dev` and confirm the existing Bills-tab inbox still pays one wallet debt end to end — this task changes money-path code and must be proven before the UI work builds on it.

- [ ] **Step 7: Commit**

```bash
git add app/HomeClient.tsx
git commit -m "fix(bills): key per-debt state by bill and account, not bill alone"
```

---

### Task 3: Extract `app/BillVerification.tsx`

`BillVerification` (`app/HomeClient.tsx:5408–5688`) has two consumers after this work: the deck's verified sheet and `BillActivityDetail` in History (`:3995`). Move it out and split the data fetch from the presentation so both can share it.

**Files:**
- Create: `app/BillVerification.tsx`
- Modify: `app/HomeClient.tsx` (delete `:5408–5688`, import instead)

**Interfaces:**
- Produces:
  - `useBillVerification(billId: bigint, metadataHash: \`0x${string}\`): VerificationResult`
  - `type VerificationResult = { status: "loading" | "verified" | "mismatch" | "unpublished" | "error"; merchant: string; receiptUrl: string | null; dueDate: number | undefined; audit: AuditState }`
  - `BillVerification({ billId, metadataHash })` — the existing inline panel, unchanged output, for History
- Task 8 consumes `useBillVerification` and `VerificationResult`.

- [ ] **Step 1: Create the file by moving the code verbatim**

Cut `app/HomeClient.tsx:5408–5688` into a new `app/BillVerification.tsx` with `"use client";` at the top. Move with it the two module-level helpers it owns, `readCachedScan` (`:293`) and `writeCachedScan` (`:303`), and add the imports it needs: `useEffect`, `useState` from `react`; `AlertTriangle`, `CalendarClock`, `CheckCircle2`, `Info`, `Loader2`, `ShieldCheck` from `lucide-react`; `BILL_SPLIT_REGISTRY_ADDRESS`, `hashReceiptBytes`, `verifyBillPreimage`, `type BillPreimage` from their current sources; `scanReceiptTotalUsd`.

Do not change behaviour in this step. A pure move keeps the diff reviewable.

- [ ] **Step 2: Split the hook out of the component**

Everything from `const [status, setStatus]` through the closing `}, [billId, metadataHash]);` becomes:

```tsx
export type AuditState =
  | { state: "idle" | "checking" | "unavailable" | "no-receipt" }
  | { state: "ok" | "altered"; scannedUsd: number; onchainUsd: number };

export type VerificationResult = {
  status: "loading" | "verified" | "mismatch" | "unpublished" | "error";
  merchant: string;
  receiptUrl: string | null;
  dueDate: number | undefined;
  audit: AuditState;
};

export function useBillVerification(billId: bigint, metadataHash: `0x${string}`): VerificationResult {
  // ...the five useState calls and the useEffect, moved unchanged...
  return { status, merchant, receiptUrl, dueDate, audit };
}
```

and `BillVerification` becomes:

```tsx
export default function BillVerification({ billId, metadataHash }: { billId: bigint; metadataHash: `0x${string}` }) {
  const { status, merchant, receiptUrl, dueDate, audit } = useBillVerification(billId, metadataHash);
  const [showDetail, setShowDetail] = useState(false);
  const [showReceipt, setShowReceipt] = useState<boolean | null>(null);
  // ...the existing render, unchanged...
}
```

- [ ] **Step 3: Import it back into HomeClient**

```ts
import BillVerification from "./BillVerification";
```

- [ ] **Step 4: Verify History still verifies**

```bash
npx tsc --noEmit && npm run lint
```

Then `npm run dev`, open the Bills tab, expand a paid bill in History, and confirm the green "Verified on Arc" panel still renders with its merchant name and receipt check.

- [ ] **Step 5: Commit**

```bash
git add app/BillVerification.tsx app/HomeClient.tsx
git commit -m "refactor(bills): lift BillVerification out of HomeClient into its own file"
```

---

### Task 4: `lib/use-social-debts.ts`

`XDebtsPanel` owns the `/api/bills` fetch and reports counts upward through callbacks. The deck needs the same list, and Task 10 deletes that file, so lift the fetch first.

**Files:**
- Create: `lib/use-social-debts.ts`
- Modify: `app/HomeClient.tsx` (call the hook)

**Interfaces:**
- Produces: `useSocialDebts(): { debts: SocialDebt[]; reload: () => Promise<void> }`, with `SocialDebt` imported from `lib/settle-items.ts` (Task 1).
- Tasks 6 and 10 consume it.

- [ ] **Step 1: Write the hook**

Create `lib/use-social-debts.ts`:

```ts
"use client";

import { useCallback, useEffect, useState } from "react";
import type { SocialDebt } from "./settle-items";

type Row = {
  id: string;
  amount_usdc: string;
  status: string;
  bill: { merchant: string | null; creator: SocialDebt["creator"] } | null;
};

// Unpaid off-chain debts tagged to the signed-in user's handle. Resolves to an
// empty list when signed out — /api/bills answers 401 there, which is ordinary,
// not an error worth surfacing.
export function useSocialDebts(): { debts: SocialDebt[]; reload: () => Promise<void> } {
  const [debts, setDebts] = useState<SocialDebt[]>([]);

  const reload = useCallback(async () => {
    const res = await fetch("/api/bills").catch(() => null);
    if (!res?.ok) return;
    const data = await res.json().catch(() => ({}));
    const rows = (data.iOwe ?? []) as Row[];
    setDebts(
      rows
        .filter((row) => row.status !== "paid")
        .map((row) => ({
          id: row.id,
          amountUsd: Number(row.amount_usdc) || 0,
          merchant: row.bill?.merchant ?? "Bill",
          creator: row.bill?.creator ?? null,
        })),
    );
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { debts, reload };
}
```

- [ ] **Step 2: Call it from HomeClient**

Alongside the other state near `app/HomeClient.tsx:405`:

```ts
  const { debts: socialDebts, reload: reloadSocialDebts } = useSocialDebts();
```

Leave `XDebtsPanel` mounted and untouched for now — Task 10 removes it. Two fetches of `/api/bills` briefly coexist; that is deliberate, so this task can be reviewed and reverted on its own.

- [ ] **Step 3: Verify**

```bash
npx tsc --noEmit && npm run lint
```

- [ ] **Step 4: Commit**

```bash
git add lib/use-social-debts.ts app/HomeClient.tsx
git commit -m "refactor(bills): lift the social debt fetch into a hook"
```

---

### Task 5: The `.settle-*` stylesheet and the sticky header

CSS and the one new token, before any component consumes them.

**Files:**
- Modify: `app/globals.css` (append after the `.pay-*` block, which ends at `:3213`)
- Modify: `app/HomeClient.tsx` (header `sticky` on this tab, `--app-header-h` observer)

**Interfaces:**
- Produces: CSS classes `.settle-deck`, `.settle-section`, `.settle-rail`, `.settle-merchant`, `.settle-label`, `.settle-amount`, `.settle-rule`, `.settle-meta`, `.settle-action`, `.settle-triggers`, `.settle-trigger`, `.settle-sheet`, `.settle-sheet-backdrop`, `.settle-divider`, `.settle-steps`. Tasks 6–9 use these names exactly.
- Produces: CSS custom property `--app-header-h`.

- [ ] **Step 1: Publish the header height**

The app header (`app/HomeClient.tsx:2613`) is `position: static` and stacks to a taller two-row layout below `md`, so its height cannot be hardcoded the way `.pay-shell` hardcodes `4rem` (`app/globals.css:3072`).

Add to `HomeClient`:

```ts
  const headerRef = useRef<HTMLElement | null>(null);

  // The deck sizes itself to the viewport minus the header, and the header is
  // responsive (it stacks below `md`), so its height is measured rather than
  // assumed.
  useEffect(() => {
    const node = headerRef.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => {
      document.documentElement.style.setProperty("--app-header-h", `${entry.contentRect.height}px`);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
```

Attach `ref={headerRef}` to the `<header>`, and make its position conditional:

```tsx
      <header
        ref={headerRef}
        className={`${activeTab === "settle" ? "sticky top-0" : "static"} z-30 border-b border-[var(--border)] bg-[color:var(--header-bg)] backdrop-blur-xl`}
      >
```

- [ ] **Step 2: Append the stylesheet**

Add to the end of `app/globals.css`:

```css
/* ── Settle deck (/app → Settle tab) ──────────────────────────────────────────
   The /pay poster treatment applied to every debt and claim the signed-in user
   has. One full-viewport section per item, snapped, over a single poster field.
   Deliberately native: CSS scroll-snap, no smooth-scroll library — Lenis owns
   the scroll position and fights snap. */

.settle-deck {
  height: calc(100dvh - var(--app-header-h, 0px));
  overflow-y: auto;
  scroll-snap-type: y mandatory;
  background: var(--pay-poster-bg);
  color: var(--pay-poster-fg);
  /* No overscroll-behavior: contain — default scroll-chaining is what lets the
     end card hand off to the document so the site footer stays reachable. */
}

.settle-section {
  height: 100%;
  scroll-snap-align: start;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 0.6rem;
  padding: clamp(1.5rem, 1rem + 4vw, 5rem);
  position: relative;
  opacity: 0.25;
  transform: scale(0.98);
  transition: opacity var(--dur-3) var(--ease-out), transform var(--dur-3) var(--ease-out);
}

.settle-section[data-active="true"] { opacity: 1; transform: none; }
.settle-section[data-state="settled"] { opacity: 0.5; }

.settle-rail {
  position: absolute;
  top: clamp(1.5rem, 1rem + 4vw, 5rem);
  left: clamp(1.5rem, 1rem + 4vw, 5rem);
  right: clamp(1.5rem, 1rem + 4vw, 5rem);
  display: flex;
  justify-content: space-between;
  font-family: var(--font-clash), system-ui, sans-serif;
  font-size: 0.69rem;
  font-weight: 300;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--pay-poster-dim);
}

/* Every reveal below runs off [data-active], so one IntersectionObserver drives
   the whole surface — no scroll listener, no animation loop. */
.settle-merchant,
.settle-label,
.settle-amount,
.settle-meta,
.settle-action {
  clip-path: inset(0 0 100% 0);
  transform: translateY(0.3em);
  transition:
    clip-path var(--dur-3) var(--ease-out),
    transform var(--dur-3) var(--ease-out),
    opacity var(--dur-2) var(--ease-out);
}

.settle-section[data-active="true"] :is(.settle-merchant, .settle-label, .settle-amount, .settle-meta, .settle-action) {
  clip-path: inset(0);
  transform: none;
}

.settle-section[data-active="true"] .settle-label { transition-delay: 80ms; }
.settle-section[data-active="true"] .settle-amount { transition-delay: 80ms; }
.settle-section[data-active="true"] .settle-meta { transition-delay: 140ms; }
.settle-section[data-active="true"] .settle-action { transition-delay: 260ms; }

.settle-merchant {
  font-family: var(--font-clash), system-ui, sans-serif;
  font-weight: 300;
  font-size: clamp(3.2rem, 1.4rem + 7vw, 9rem);
  line-height: 0.9;
  letter-spacing: -0.03em;
  /* Merchant names come from OCR — one long unbroken token would otherwise run
     off the section at this size. */
  overflow-wrap: anywhere;
  margin: 0.4rem 0 1.6rem;
}

.settle-label {
  font-family: var(--font-clash), system-ui, sans-serif;
  font-weight: 300;
  font-size: 0.69rem;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--pay-poster-dim);
}

.settle-amount {
  font-family: var(--font-clash), system-ui, sans-serif;
  font-weight: 300;
  font-size: clamp(3rem, 1.4rem + 6vw, 7rem);
  line-height: 1;
  letter-spacing: -0.03em;
  font-variant-numeric: tabular-nums;
  /* The editable case is a bare <input>: no chrome of its own, inheriting all
     of the above. */
  appearance: none;
  border: 0;
  background: none;
  color: inherit;
  padding: 0;
  width: 100%;
  max-width: 12ch;
  outline: none;
}

.settle-amount::-webkit-outer-spin-button,
.settle-amount::-webkit-inner-spin-button { appearance: none; margin: 0; }

.settle-rule {
  height: 1px;
  max-width: 12ch;
  background: var(--pay-poster-rule);
  transform: scaleX(0);
  transform-origin: left;
  transition: transform var(--dur-4) var(--ease-out), background var(--dur-1) var(--ease-out);
}

.settle-section[data-active="true"] .settle-rule { transform: scaleX(1); }
.settle-amount:focus + .settle-rule { background: var(--pay-poster-fg); height: 2px; }
.settle-rule[data-tone="warning"] { background: var(--warning-text); }

.settle-meta {
  font-size: 0.75rem;
  color: var(--pay-poster-dim);
  margin-top: 0.55rem;
}

/* The signature control: borderless, huge, receded into the poster — but it is
   the control that moves money, so its rest state sits at the lowest mix that
   still clears 4.5:1 on --pay-poster-bg. Faded, never invisible. */
.settle-action {
  font-family: var(--font-clash), system-ui, sans-serif;
  font-weight: 300;
  font-size: clamp(2.2rem, 1rem + 3.2vw, 4.4rem);
  letter-spacing: 0.14em;
  line-height: 1;
  border: 0;
  background: none;
  padding: 0;
  margin: clamp(2rem, 1rem + 3vw, 4rem) 0 0;
  cursor: pointer;
  color: color-mix(in srgb, var(--pay-poster-fg) 62%, var(--pay-poster-bg));
  transition: color var(--dur-2) var(--ease-out), letter-spacing var(--dur-2) var(--ease-out);
}

:root[data-theme="dark"] .settle-action {
  color: color-mix(in srgb, var(--pay-poster-fg) 58%, var(--pay-poster-bg));
}

.settle-action:hover:not(:disabled),
.settle-action:focus-visible {
  color: var(--pay-poster-fg);
  letter-spacing: 0.1em;
}

/* No border means nothing to indicate focus — this ring is not optional. */
.settle-action:focus-visible {
  outline: 1px solid currentColor;
  outline-offset: 0.6em;
}

.settle-action:disabled { opacity: 0.4; cursor: not-allowed; }

@media (prefers-contrast: more) {
  .settle-action { color: var(--pay-poster-fg); }
}

.settle-triggers {
  position: absolute;
  bottom: clamp(1.5rem, 1rem + 4vw, 5rem);
  left: clamp(1.5rem, 1rem + 4vw, 5rem);
  display: flex;
  gap: 2rem;
}

.settle-trigger {
  font-family: var(--font-clash), system-ui, sans-serif;
  font-weight: 300;
  font-size: 0.78rem;
  letter-spacing: 0.06em;
  border: 0;
  background: none;
  padding: 0.3rem 0;
  cursor: pointer;
  color: var(--pay-poster-dim);
  border-bottom: 1px solid var(--pay-poster-rule);
  transition: color var(--dur-1) var(--ease-out), border-color var(--dur-1) var(--ease-out);
}

.settle-trigger:hover, .settle-trigger:focus-visible { color: var(--pay-poster-fg); border-color: currentColor; }
.settle-trigger[data-tone="warning"] { color: var(--warning-text); border-color: currentColor; }

.settle-sheet-backdrop {
  position: fixed;
  inset: 0;
  z-index: 40;
  background: color-mix(in srgb, var(--pay-poster-bg) 55%, transparent);
  backdrop-filter: blur(20px);
}

.settle-sheet {
  position: fixed;
  z-index: 41;
  left: 0;
  right: 0;
  bottom: 0;
  max-height: 70dvh;
  overflow-y: auto;
  padding: clamp(1.5rem, 1rem + 2vw, 3rem);
  border-top: 1px solid var(--pay-poster-rule);
  border-radius: 1.4rem 1.4rem 0 0;
  background: var(--pay-poster-bg);
  color: var(--pay-poster-fg);
}

.settle-divider {
  height: 100%;
  scroll-snap-align: start;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.8rem;
  text-align: center;
}

.settle-divider > hr {
  width: 0;
  border: 0;
  border-top: 1px solid var(--pay-poster-rule);
  transition: width var(--dur-4) var(--ease-out);
}

.settle-divider[data-active="true"] > hr { width: min(28rem, 60vw); }

.settle-steps {
  font-family: var(--font-clash), system-ui, sans-serif;
  font-weight: 300;
  font-size: 1rem;
  color: var(--pay-poster-dim);
  display: grid;
  gap: 0.35rem;
}

.settle-steps > li[data-state="active"] { color: var(--pay-poster-fg); }
.settle-steps > li[data-state="done"] { opacity: 0.55; }
.settle-steps > li[data-state="error"] { color: var(--warning-text); }

@media (prefers-reduced-motion: reduce) {
  .settle-deck { scroll-behavior: auto; }
  .settle-section,
  .settle-merchant,
  .settle-label,
  .settle-amount,
  .settle-meta,
  .settle-action {
    transform: none;
    clip-path: none;
    transition: opacity var(--dur-1) linear;
  }
  .settle-rule { transform: scaleX(1); transition: none; }
  .settle-divider > hr { width: min(28rem, 60vw); transition: none; }
}
```

- [ ] **Step 3: Verify the token resolves**

```bash
npm run dev
```

In devtools, confirm `getComputedStyle(document.documentElement).getPropertyValue('--app-header-h')` returns a pixel value, and that resizing the window past the `md` breakpoint changes it.

- [ ] **Step 4: Commit**

```bash
git add app/globals.css app/HomeClient.tsx
git commit -m "feat(settle): stylesheet for the settle deck, measured header height"
```

---

### Task 6: `app/SettleDeck.tsx` — static sections

Render only. No interactions, no sheets, no motion wiring. Get the type and layout right first.

**Files:**
- Create: `app/SettleDeck.tsx`

**Interfaces:**
- Consumes: `SettleItem`, `buildSettleItems`, `settleItemId` (Task 1); `useBillVerification` (Task 3); the `.settle-*` classes (Task 5).
- Produces: `export default function SettleDeck(props: SettleDeckProps)`. The full prop type is defined in this step and consumed by Task 10.

- [ ] **Step 1: Write the component**

```tsx
"use client";

import { useMemo } from "react";
import { billUnitsToUsdc } from "@/lib/bill-split-contracts";
import { buildSettleItems, type OwnedDebt, type SettleItem, type SocialDebt } from "@/lib/settle-items";

export type SettleDeckProps = {
  socialDebts: SocialDebt[];
  walletDebts: OwnedDebt[];
  splitterBills: OwnedDebt[];
  nowSeconds: bigint;
};

const usd = (units: bigint) => `$${billUnitsToUsdc(units)}`;

export default function SettleDeck({ socialDebts, walletDebts, splitterBills, nowSeconds }: SettleDeckProps) {
  const items = useMemo(
    () => buildSettleItems({ socialDebts, walletDebts, splitterBills, nowSeconds }),
    [socialDebts, walletDebts, splitterBills, nowSeconds],
  );
  // The rail counts payable items only — the divider and end card are chrome.
  const counted = items.filter((item) => item.kind !== "divider" && item.kind !== "end");

  return (
    <div className="settle-deck">
      {items.map((item) => (
        <Section key={item.id} item={item} index={counted.indexOf(item)} total={counted.length} />
      ))}
    </div>
  );
}

function Section({ item, index, total }: { item: SettleItem; index: number; total: number }) {
  if (item.kind === "divider") {
    return (
      <section className="settle-divider" data-active="true">
        <p className="settle-label">owed to you</p>
        <hr />
        <p className="settle-merchant" style={{ fontSize: "clamp(2rem, 1rem + 3vw, 4rem)", margin: 0 }}>
          {item.claimCount} bill{item.claimCount === 1 ? "" : "s"} · ${item.totalUsd.toFixed(2)}
        </p>
      </section>
    );
  }

  if (item.kind === "end") {
    return (
      <section className="settle-section" data-active="true">
        <h2 className="settle-merchant">nothing waiting on you</h2>
        <p className="settle-meta">Bills tagged to your handle or wallet will appear here.</p>
      </section>
    );
  }

  return (
    <section className="settle-section" data-active="true">
      {/* A lone item gets no counter — snap chrome on a single card is noise. */}
      <div className="settle-rail">
        <span>{total > 1 ? `${String(index + 1).padStart(2, "0")} / ${String(total).padStart(2, "0")}` : ""}</span>
        <span>arc testnet</span>
      </div>
      <SectionBody item={item} />
    </section>
  );
}

function SectionBody({ item }: { item: Exclude<SettleItem, { kind: "divider" } | { kind: "end" }> }) {
  if (item.kind === "debt-social") {
    return (
      <>
        <p className="settle-label">
          to {item.debt.creator?.handle ?? "the creator"}
          {item.debt.creator?.provider ? ` · ${item.debt.creator.provider}` : ""}
        </p>
        <h2 className="settle-merchant">{item.debt.merchant}</h2>
        <p className="settle-label">you pay</p>
        <p className="settle-amount">${item.debt.amountUsd.toFixed(2)}</p>
        <p className="settle-meta">settles in full from your splitsy wallet</p>
      </>
    );
  }

  if (item.kind === "claim-failed") {
    return (
      <>
        <p className="settle-label">bill #{item.debt.billId.toString()}</p>
        <h2 className="settle-merchant">this bill didn&apos;t come together</h2>
        <p className="settle-meta">
          It held the money until everyone paid, and the due date passed while still short. There is nothing to
          collect — each payer takes their own share back.
        </p>
      </>
    );
  }

  if (item.kind === "claim") {
    return (
      <>
        <p className="settle-label">bill #{item.debt.billId.toString()}</p>
        <h2 className="settle-merchant">ready to collect</h2>
        <p className="settle-label">you collect</p>
        <p className="settle-amount">{usd(item.debt.claimable)}</p>
        <span className="settle-rule" />
        <p className="settle-meta">
          paid {usd(item.debt.totalPaid)} · claimed {usd(item.debt.claimed)}
        </p>
      </>
    );
  }

  const { debt, action, refundable } = item;
  return (
    <>
      <p className="settle-label">bill #{debt.billId.toString()}</p>
      <h2 className="settle-merchant">Bill #{debt.billId.toString()}</h2>
      <p className="settle-label">{action === "refund" ? "you get back" : "you pay"}</p>
      <p className="settle-amount">{usd(action === "refund" ? refundable : debt.remaining)}</p>
      <span className="settle-rule" />
      <p className="settle-meta">
        {action === "refund"
          ? "this bill didn't come together — your share goes back to your wallet"
          : `of ${usd(debt.owed)} owed${debt.dueDate > 0n ? ` · due ${new Date(Number(debt.dueDate) * 1000).toLocaleDateString()}` : ""}`}
      </p>
    </>
  );
}
```

The wallet-debt heading is a placeholder bill number here only because the merchant name comes from `useBillVerification`, which Task 8 wires in. Task 8 replaces it.

- [ ] **Step 2: Verify it compiles**

```bash
npx tsc --noEmit && npm run lint
```

- [ ] **Step 3: Commit**

```bash
git add app/SettleDeck.tsx
git commit -m "feat(settle): render debts and claims as full-viewport sections"
```

---

### Task 7: Amount field and actions

**Files:**
- Modify: `app/SettleDeck.tsx`

**Interfaces:**
- Consumes: the handler props added here. Task 10 supplies them from `HomeClient`.
- Produces: `SettleDeckProps` extended with `billState`, `partialPayments`, `setPartialPayments`, `claimAmounts`, `setClaimAmounts`, `debtMessages`, `payDebtOnArc`, `claimSplitterFunds`, `refundOnArc`, `paySocialDebt`.

- [ ] **Step 1: Extend the props**

```tsx
export type SettleDeckProps = {
  socialDebts: SocialDebt[];
  walletDebts: OwnedDebt[];
  splitterBills: OwnedDebt[];
  nowSeconds: bigint;
  billState: BillRunState;
  partialPayments: Record<string, string>;
  setPartialPayments: (value: Record<string, string>) => void;
  claimAmounts: Record<string, string>;
  setClaimAmounts: (value: Record<string, string>) => void;
  debtMessages: Record<string, { message: string; tone: "error" | "neutral" | "success" }>;
  payDebtOnArc: (debt: OwnedDebt) => void;
  claimSplitterFunds: (debt: OwnedDebt) => void;
  refundOnArc: (debt: OwnedDebt) => void;
  paySocialDebt: (debt: SocialDebt) => void;
  bridgeForDebt: (debt: OwnedDebt, source: BridgeSourceChain) => void;
  progressFlow: ProgressFlow | null;
};
```

`BillRunState` is `"idle" | "connecting" | "working" | "success" | "error"`
(`app/HomeClient.tsx:172`) — five members, not four. Export it from `HomeClient`
and import it here rather than restating it, so the two cannot drift.
`ProgressFlow` (`:197`) and `BridgeSourceChain` need exporting too; `ProgressFlow`
is used in Task 9 and `bridgeForDebt` in Task 8.

Thread them down to `SectionBody` through `Section`.

- [ ] **Step 2: Make the editable amount a real input**

Replace the wallet-debt amount paragraph with:

```tsx
      {item.editable && action === "pay" ? (
        <>
          <input
            aria-label={`Amount to pay on bill ${debt.billId.toString()}`}
            className="settle-amount"
            inputMode="decimal"
            onChange={(event) => setPartialPayments({ ...partialPayments, [item.id]: event.target.value })}
            type="number"
            value={partialPayments[item.id] ?? billUnitsToUsdc(debt.remaining)}
          />
          <span className="settle-rule" data-tone={overpaying ? "warning" : undefined} />
        </>
      ) : (
        <>
          <p className="settle-amount">{usd(action === "refund" ? refundable : debt.remaining)}</p>
          {item.editable ? <span className="settle-rule" /> : null}
        </>
      )}
```

with, above the return:

```tsx
  // Client-side guard only — the contract clamps regardless. Saying so before
  // the signature costs one comparison and saves a rejected transaction.
  const typed = Number(partialPayments[item.id] ?? billUnitsToUsdc(debt.remaining));
  const overpaying = Number.isFinite(typed) && typed > Number(billUnitsToUsdc(debt.remaining));
```

Non-editable rows keep the `settles in full from your splitsy wallet` note already in place for `debt-social`; add the same note for `debt-wallet` rows where `item.editable === false`.

- [ ] **Step 3: Add the action buttons**

For each item kind, one borderless control:

```tsx
      <button
        className="settle-action"
        disabled={billState === "working" || overpaying}
        onClick={() => (action === "refund" ? refundOnArc(debt) : payDebtOnArc(debt))}
        type="button"
      >
        {action === "refund" ? "Get it back" : "Pay"} →
      </button>
      {overpaying ? (
        <p className="settle-meta" style={{ color: "var(--warning-text)" }}>
          more than the {usd(debt.remaining)} remaining
        </p>
      ) : null}
      {debtMessages[item.id] ? <p className="settle-meta">{debtMessages[item.id].message}</p> : null}
```

Claim sections use `Collect →` calling `claimSplitterFunds(item.debt)`, with the same editable/non-editable amount treatment reading `claimAmounts` / `setClaimAmounts` and `item.debt.claimable`. Social debts use `Pay →` calling `paySocialDebt(item.debt)`. `claim-failed` has no button.

- [ ] **Step 4: Cover the escrow and signed-out states**

Two spec edge cases the sections above do not yet render.

**Escrow-held debt.** A partly-paid all-or-nothing bill before its deadline: the
money is committed but is not yet the creator's, and saying so is the whole point.
Mirrors the condition at `app/HomeClient.tsx:3500`. In the wallet-debt branch:

```tsx
  const heldInEscrow =
    debt.escrowUntilFull && debt.totalPaid < debt.totalOwed && refundable === 0n && debt.paid > 0n;
```

When true, replace the `.settle-meta` line with:

```tsx
        <p className="settle-meta">
          your {usd(debt.paid)} is in the bill, not with the creator — they can&apos;t collect until the group is
          paid up
          {debt.dueDate > 0n ? `, and you can take yours back after ${new Date(Number(debt.dueDate) * 1000).toLocaleDateString()}` : ""}
        </p>
```

Pay stays available — an escrowed bill is still payable.

**Signed out.** `socialDebts`, `walletDebts`, and `splitterBills` are all empty
with no account, so the deck falls through to the end card. An empty scroll
container with a triumphant message is the wrong read for someone who has not
signed in, so pass a `signedIn: boolean` prop (true when either `me?.walletAddress`
or `registryReadAddress` is set) and branch the end card:

```tsx
        <h2 className="settle-merchant">{signedIn ? "nothing waiting on you" : "sign in to settle"}</h2>
        <p className="settle-meta">
          {signedIn
            ? "Bills tagged to your handle or wallet will appear here."
            : "Sign in or connect a wallet to see the bills tagged to you."}
        </p>
```

- [ ] **Step 5: Verify**

```bash
npx tsc --noEmit && npm run lint
```

- [ ] **Step 6: Commit**

```bash
git add app/SettleDeck.tsx
git commit -m "feat(settle): wire the amount field and pay, collect, and refund actions"
```

---

### Task 8: The two sheets

**Files:**
- Modify: `app/SettleDeck.tsx`

**Interfaces:**
- Consumes: `useBillVerification`, `VerificationResult` (Task 3); `bridgeSourceChains` from `lib/appkit-bridge.ts:36` (six chains); `bridgeForDebt` prop.
- Produces: the merchant name on wallet-debt sections, replacing Task 6's placeholder heading.

- [ ] **Step 1: Hold sheet state at deck level**

One sheet exists at a time, and a viewport-fixed element avoids the stacking-context traps of `position: absolute` inside a scroll-snap container.

```tsx
  const [sheet, setSheet] = useState<{ id: string; kind: "verified" | "bridge" } | null>(null);
```

Render after the section list:

```tsx
      {sheet ? (
        <>
          <div className="settle-sheet-backdrop" onClick={() => setSheet(null)} />
          <motion.div
            animate={{ y: 0 }}
            className="settle-sheet"
            exit={{ y: "100%" }}
            initial={{ y: "100%" }}
            role="dialog"
            aria-modal="true"
            transition={{ duration: 0.34, ease: [0.22, 1, 0.36, 1] }}
          >
            {/* body per kind */}
          </motion.div>
        </>
      ) : null}
```

Wrap in `AnimatePresence`. Close on Escape via a `keydown` listener, and on deck scroll via the deck's `onScroll`. On open, move focus into the sheet; on close, return it to the trigger that opened it.

- [ ] **Step 2: Give wallet-debt sections their merchant name**

In the wallet-debt branch:

```tsx
  const verification = useBillVerification(debt.billId, debt.metadataHash);
  const merchant = verification.merchant || `Bill #${debt.billId.toString()}`;
```

and use `{merchant}` as the `.settle-merchant` heading.

- [ ] **Step 3: Render the triggers**

```tsx
      <div className="settle-triggers">
        <button
          className="settle-trigger"
          data-tone={unsafe ? "warning" : undefined}
          onClick={() => setSheet({ id: item.id, kind: "verified" })}
          type="button"
        >
          {verification.status === "loading"
            ? "checking…"
            : unsafe
              ? "⌃ doesn't match arc"
              : "⌃ verified on arc"}
        </button>
        {item.editable ? (
          <button className="settle-trigger" onClick={() => setSheet({ id: item.id, kind: "bridge" })} type="button">
            ⌃ bridge
          </button>
        ) : null}
      </div>
```

with:

```tsx
  // A mismatch or an altered total is a red warning, not a detail — it opens
  // itself rather than waiting behind a click, because Pay is right there.
  const unsafe = verification.status === "mismatch" || verification.audit.state === "altered";
```

and an effect that opens the verified sheet when a section becomes active and `unsafe` is true.

**Pay is not disabled while verification loads.** It is not disabled today, and blocking it here would be a new restriction introduced under cover of a redesign.

- [ ] **Step 4: Sheet bodies**

The verified sheet takes `merchant` as its heading — `Verified on Arc — {merchant}` — followed by the two checks, the due-date line, and the receipt image, reading the same `verification` fields the inline panel renders. The bridge sheet carries the existing CCTP explanation and one `.settle-action`-styled button per entry in `bridgeSourceChains`, each calling `bridgeForDebt(debt, chain.id)`.

- [ ] **Step 5: Verify**

```bash
npx tsc --noEmit && npm run lint
```

Then in the browser: open both sheets, close each with Escape, an outside click, and a scroll; confirm focus returns to the trigger each time.

- [ ] **Step 6: Commit**

```bash
git add app/SettleDeck.tsx
git commit -m "feat(settle): slide-up sheets for arc verification and bridging"
```

---

### Task 9: Motion — activation, in-section progress, advance

**Files:**
- Modify: `app/SettleDeck.tsx`

**Interfaces:**
- Consumes: `progressFlow` prop (`ProgressFlow | null`, with `subjectKey` from Task 2).

- [ ] **Step 1: One observer drives activation**

```tsx
  const [activeId, setActiveId] = useState<string | null>(null);
  const deckRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const deck = deckRef.current;
    if (!deck) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.find((entry) => entry.isIntersecting);
        if (visible) setActiveId(visible.target.getAttribute("data-id"));
      },
      { root: deck, threshold: 0.6 },
    );
    deck.querySelectorAll("[data-id]").forEach((node) => observer.observe(node));
    return () => observer.disconnect();
  }, [items]);
```

Each section gets `data-id={item.id}` and `data-active={item.id === activeId}`. Every reveal in the stylesheet keys off that attribute — no scroll listener, no rAF loop.

- [ ] **Step 2: Swap the field for the step ticker while a flow runs**

```tsx
  const running = progressFlow?.subjectKey === item.id && progressFlow.status === "running";
```

When `running`, render in place of the amount field and button:

```tsx
        <ol className="settle-steps">
          {progressFlow.steps.map((step) => (
            <li data-state={step.state} key={step.key}>
              {step.label}
            </li>
          ))}
        </ol>
```

- [ ] **Step 3: Hold, then advance**

```tsx
  // The settled section stays mounted through the advance. Unmounting it the
  // instant the payment lands would pull the snap point out from under the
  // user's thumb mid-scroll.
  useEffect(() => {
    if (progressFlow?.status !== "success" || !progressFlow.subjectKey) return;
    const settled = progressFlow.subjectKey;
    const timer = setTimeout(() => {
      const next = deckRef.current?.querySelector(`[data-id]:not([data-id="${settled}"])[data-settled="false"]`);
      next?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 1200);
    return () => clearTimeout(timer);
  }, [progressFlow?.status, progressFlow?.subjectKey]);
```

- [ ] **Step 4: Move the confetti to the end card**

`completeFlow` (`app/HomeClient.tsx:1407`) currently calls `fireSuccessConfetti()`
on every flow success, so leaving it alone means confetti under every card in the
deck. **Remove the `fireSuccessConfetti()` call from `completeFlow`** and fire it
here instead. `fireSuccessConfetti` (`:5020`) stays where it is — other tabs'
flows are unaffected because they render `ProgressModal`, which is where that
celebration belonged.

Track the count in the deck; the pure `buildSettleItems` has no session memory,
so this cannot live on the `end` item:

```tsx
  // Counts successful flows this session, so the end card knows whether the deck
  // was emptied by the user or simply arrived empty.
  const [settledThisSession, setSettledThisSession] = useState(0);

  useEffect(() => {
    if (progressFlow?.status === "success" && progressFlow.subjectKey) {
      setSettledThisSession((count) => count + 1);
    }
  }, [progressFlow?.status, progressFlow?.subjectKey]);

  // Fires once, when the deck empties — not per card. Under every section in a
  // deck it is noise rather than a reward.
  useEffect(() => {
    if (counted.length > 0 || settledThisSession === 0) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    void confetti({ particleCount: 110, spread: 68, startVelocity: 36, origin: { y: 0.5 }, colors: ["#2775ca", "#3ee6d6", "#17a56b"] });
  }, [counted.length, settledThisSession]);
```

Pass `settledThisSession` into the end card so it reads `all settled` with the
session total rather than `nothing waiting on you` when the user cleared it
themselves.

- [ ] **Step 5: Verify**

Run the app with two or more debts. Confirm: sections reveal as they enter, neighbours sit dimmed, a payment shows the ticker in place, the deck advances after the settled beat, and the whole thing degrades to opacity-only with `prefers-reduced-motion` forced on in devtools.

- [ ] **Step 6: Commit**

```bash
git add app/SettleDeck.tsx
git commit -m "feat(settle): activation reveals, in-section progress, advance on success"
```

---

### Task 10: Wire the tab and delete the old panels

The migration. Everything before this was additive.

**Files:**
- Modify: `app/HomeClient.tsx`
- Delete: `app/XDebtsPanel.tsx`

- [ ] **Step 1: Add the tab**

`AppTab` (`:174`) becomes:

```ts
type AppTab = "bills" | "settle" | "recurring" | "dashboard" | "agents";
```

Add the button after Bills (`:2633`), with a count badge from `buildSettleItems`:

```tsx
                <TabButton active={activeTab === "settle"} onClick={() => switchAppTab("settle")}>
                  Settle
                  {settleCount > 0 ? <span className="spec-chip spec-chip-attn">{settleCount}</span> : null}
                </TabButton>
```

- [ ] **Step 2: Add `paySocialDebt`**

`XDebtsPanel` owned this. Lift it, preserving the PIN gate and the reload:

```ts
  // Off-chain debt tagged to a handle: the server transfers the full amount from
  // the user's Circle wallet. The PIN gate is the same one every server-signed
  // path uses.
  async function paySocialDebt(debt: SocialDebt) {
    const key = `social:${debt.id}`;
    const pin = await fetch("/api/wallet/pin").then((r) => r.json()).catch(() => ({}));
    if (!pin.unlocked) {
      setDebtMessages((current) => ({
        ...current,
        [key]: { tone: "neutral", message: "Unlock your wallet (the wallet button in the bottom-right corner), then tap Pay again." },
      }));
      return;
    }
    beginSocialPayFlow(key, debt.amountUsd.toFixed(2));
    try {
      setBillState("working");
      const res = await fetch(`/api/debts/${debt.id}/pay`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setBillState("error");
        failFlow(
          data.error === "insufficient_funds"
            ? "Your wallet needs more test USDC to cover this."
            : (data.error ?? "Payment failed."),
        );
        return;
      }
      setBillState("success");
      completeFlow();
      await reloadSocialDebts();
    } catch {
      setBillState("error");
      failFlow("Network error — please try again.");
    }
  }
```

`completeFlow` (`:1407`) and `failFlow` (`:1417`) are the existing helpers — reuse
them, do not add new ones. Note that Task 9 Step 4 strips the
`fireSuccessConfetti()` call out of `completeFlow`; if Task 9 has not landed yet,
this path will briefly fire confetti per payment.

- [ ] **Step 3: Render the deck outside the padded wrapper**

The section at `:2663` is `mx-auto max-w-7xl px-4 py-6` — a full-bleed poster cannot live inside it. Render the Settle branch as a sibling:

```tsx
        {activeTab === "settle" ? (
          <SettleDeck
            billState={billState}
            bridgeForDebt={bridgeForDebt}
            claimAmounts={claimAmounts}
            claimSplitterFunds={claimSplitterFunds}
            debtMessages={debtMessages}
            nowSeconds={nowSeconds}
            partialPayments={partialPayments}
            payDebtOnArc={payDebtOnArc}
            paySocialDebt={paySocialDebt}
            progressFlow={progressFlow}
            refundOnArc={refundOnArc}
            setClaimAmounts={setClaimAmounts}
            setPartialPayments={setPartialPayments}
            socialDebts={socialDebts}
            splitterBills={splitterBills}
            walletDebts={activeWalletDebts}
          />
        ) : null}
```

and gate the existing `<section className="mx-auto max-w-7xl …">` on `activeTab !== "settle"`.

- [ ] **Step 4: Delete the old panels**

Remove, in this order:

1. the merged "You owe" `Panel` block, `:2738–2796`
2. the `<ClaimFundsPanel …/>` usage, `:2797–2807`
3. `function WalletDebtRows`, `:3445–3693`
4. `function ClaimFundsPanel`, `:3695–3842`
5. the orphaned state: `socialPendingCount` (`:405`), `socialPendingTotalUsd` (`:408`), `debtsExpanded` (`:413`), and the derived `pendingTotal` / `walletPendingUnits` / `pendingTotalUsd` / `debtsShown` (`:519–524`)
6. `app/XDebtsPanel.tsx` and its import (`:49`)

```bash
git rm app/XDebtsPanel.tsx
```

- [ ] **Step 5: Verify nothing dangles**

```bash
npx tsc --noEmit && npm run lint
grep -rn "XDebtsPanel\|WalletDebtRows\|ClaimFundsPanel\|pendingTotal\|socialPendingCount" app/
```

Expected: `tsc` and `lint` clean; the grep returns nothing.

- [ ] **Step 6: Commit**

```bash
git add -A app/
git commit -m "feat(settle): move paying and collecting into the settle deck"
```

---

### Task 11: Full verification pass

No new code. Prove the work.

- [ ] **Step 1: Static checks**

```bash
npm run lint && npx tsc --noEmit && npm run test:settle
```

All three must pass. Paste the actual output — do not summarise.

- [ ] **Step 2: Four data states**

With `npm run dev`, exercise the Settle tab under each, confirming the deck renders and the rail counts correctly:

- social debt only (sign in with a handle, no wallet connected)
- wallet debt only (connect a browser wallet, sign out of the handle)
- both, plus at least one claimable bill — confirm the divider appears exactly once between the runs
- nothing pending — confirm the end card, and that no divider or rail counter renders

- [ ] **Step 3: One payment end to end**

Pay one wallet debt. Confirm the ticker renders in-section, the section resolves to settled, the deck advances after the beat, and the tab badge decrements.

- [ ] **Step 4: Keyboard only**

Tab to the amount field, type an amount, Tab to Pay, activate with Enter. Confirm the focus ring is visible on the borderless button at every step, and that both sheets open, trap focus, and return it on Escape.

- [ ] **Step 5: Reduced motion and contrast**

With `prefers-reduced-motion: reduce` forced in devtools, confirm no transforms, no shimmer, no confetti, and that the deck still snaps. With `prefers-contrast: more`, confirm the Pay control is fully opaque.

- [ ] **Step 6: Theme parity**

Toggle light and dark. Confirm the poster field, the faded Pay control, and both sheets read correctly in each — and that the Pay control at rest still clears 4.5:1 in both, measured with devtools' contrast checker.

- [ ] **Step 7: Commit any fixes and report**

Report what passed and what did not, with the real output. Do not claim completion on an unrun check.

---

## Notes for the implementer

- **Task 2 touches money paths.** It is the one task in this plan that changes code which moves USDC. Do not batch it with another task, and do not skip its manual verification step.
- **`app/HomeClient.tsx` is 5,825 lines.** Tasks 2, 3, and 10 all edit it. Land them as separate commits so a bad edit is bisectable.
- **The riskiest interaction is snap plus a changing list length.** Sections unmounting while snapped is where jumpiness will come from. Task 9 Step 3's hold-then-advance is the mitigation; test it with three or more debts, not one.
- **Clash Display tabular figures are unconfirmed.** If digits jitter while typing in the amount field, fix it with a fixed `ch` width per digit — do not swap the typeface.
