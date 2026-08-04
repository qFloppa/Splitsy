# Public Pay Link Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A switch on bill creation that mints an unguessable link; anyone holding it opens a page dedicated to that one bill and pays any selection of participants' shares from a browser wallet or a Splitsy (Circle) wallet.

**Architecture:** No contract work — `BillSplitRegistry.payDebtFor(billId, debtor, amount)` is deployed and deliberately permissionless. A nullable `share_token` column on the existing `onchain_bill_preimages` table becomes a second lookup key for a row that already exists. One public read endpoint resolves the token to live on-chain state; one authenticated endpoint pays from a Circle wallet; the browser-wallet path signs directly from the page.

**Tech Stack:** Next.js 16.2.9 (App Router), React 19, TypeScript, viem + wagmi, Supabase (Postgres + Storage), Circle Developer-Controlled Wallets, Tailwind v4 + CSS custom properties, `node --test --experimental-strip-types`.

**Design doc:** `docs/superpowers/specs/2026-08-04-public-pay-link-design.md`

## Global Constraints

- **Read `node_modules/next/dist/docs/` before writing route or page code.** This Next.js has breaking changes from training data (`AGENTS.md`). `params` is a **Promise** in both pages and route handlers — `const { token } = await params`. `PageProps<'/pay/[token]'>` and `RouteContext<'/api/pay/[token]'>` are globally available generated helpers needing no import.
- **Never trust a client-supplied amount.** Every payment path reads `owed - paid` from chain and pays exactly that, mirroring `app/api/onchain-bills/[billId]/pay/route.ts`.
- **USDC amounts cross the API as base-unit integer strings** (`"42500000"`), never JSON numbers. Base units are 6 dp. Format for display with `billUnitsToUsdc` from `lib/bill-split-contracts.ts`.
- **A token is only valid against the current registry.** Bill ids restart per registry deployment; a row whose `registry_address` differs from `REGISTRY_ADDRESS` must 404.
- **No ERC-8004 reputation on this path.** `recordPaidFeedbackSafely` fires only when a wallet settles its *own* share. Covering someone else's share is not their consent to be scored.
- **Both themes.** Every colour is an existing custom property from `app/globals.css` (`--ink-950`, `--paper-50`, `--accent`, `--arc-cyan`, `--success`, `--text-muted`, `--border`, …). No hardcoded hex.
- **Existing components get reused, not re-created:** `Switch` from `app/SettlementAgentsPanel.tsx`, `XAuthControl` from `app/XAuthControl.tsx`, `SignInMenu` from `app/SignInMenu.tsx`, `ConnectButton` from `@rainbow-me/rainbowkit`.
- Run `npm run lint` before every commit.

---

### Task 1: Share-token and selection module

Pure, dependency-free logic so it is testable without a network, a database, or viem. This is the repo's established pattern — see `app/api/onchain-bills/create/participant-providers.ts` and its sibling test.

**Files:**
- Create: `lib/pay-link.ts`
- Test: `lib/pay-link.test.ts`
- Modify: `package.json` (add `test:pay-link` script)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `SHARE_TOKEN_LENGTH: number` (22)
  - `newShareToken(): string`
  - `isShareToken(value: unknown): value is string`
  - `selectionTotalUnits(rows: ReadonlyArray<{ address: string; remainingUnits: string }>, selected: Iterable<string>): bigint`
  - `payableRows<T extends { remainingUnits: string }>(rows: readonly T[]): T[]`

- [ ] **Step 1: Write the failing test**

Create `lib/pay-link.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SHARE_TOKEN_LENGTH,
  isShareToken,
  newShareToken,
  payableRows,
  selectionTotalUnits,
} from "./pay-link.ts";

test("generated tokens are base62 and the declared length", () => {
  for (let i = 0; i < 200; i += 1) {
    const token = newShareToken();
    assert.equal(token.length, SHARE_TOKEN_LENGTH);
    assert.match(token, /^[A-Za-z0-9]+$/);
    assert.equal(isShareToken(token), true);
  }
});

test("generated tokens do not repeat", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 500; i += 1) seen.add(newShareToken());
  assert.equal(seen.size, 500);
});

test("the validator rejects everything that is not a plausible token", () => {
  assert.equal(isShareToken("short"), false);              // under 16
  assert.equal(isShareToken(""), false);
  assert.equal(isShareToken("a".repeat(65)), false);       // over 64
  assert.equal(isShareToken("has-a-dash-in-it-here"), false);
  assert.equal(isShareToken("has a space in it xx"), false);
  assert.equal(isShareToken("../../etc/passwd/aaaa"), false);
  assert.equal(isShareToken(null), false);
  assert.equal(isShareToken(12345678901234567890), false);
  assert.equal(isShareToken("a".repeat(16)), true);        // boundary
  assert.equal(isShareToken("a".repeat(64)), true);        // boundary
});

test("selection total sums only the selected rows, in base units", () => {
  const rows = [
    { address: "0xAAA", remainingUnits: "42500000" },
    { address: "0xBBB", remainingUnits: "18000000" },
    { address: "0xCCC", remainingUnits: "36000000" },
  ];
  assert.equal(selectionTotalUnits(rows, ["0xAAA", "0xCCC"]), 78500000n);
  assert.equal(selectionTotalUnits(rows, []), 0n);
  assert.equal(selectionTotalUnits(rows, ["0xAAA", "0xBBB", "0xCCC"]), 96500000n);
});

test("selection matching is case-insensitive on both sides", () => {
  const rows = [{ address: "0xAbCdEf", remainingUnits: "1000000" }];
  assert.equal(selectionTotalUnits(rows, ["0xabcdef"]), 1000000n);
  assert.equal(selectionTotalUnits([{ address: "0xabcdef", remainingUnits: "1000000" }], ["0xABCDEF"]), 1000000n);
});

test("an address that is not a row contributes nothing", () => {
  const rows = [{ address: "0xAAA", remainingUnits: "5000000" }];
  assert.equal(selectionTotalUnits(rows, ["0xZZZ"]), 0n);
});

test("odd cents survive the round trip with no float drift", () => {
  const rows = [
    { address: "0x1", remainingUnits: "3333333" }, // $3.333333
    { address: "0x2", remainingUnits: "3333333" },
    { address: "0x3", remainingUnits: "3333334" },
  ];
  assert.equal(selectionTotalUnits(rows, ["0x1", "0x2", "0x3"]), 10000000n);
});

test("payable rows exclude anything already settled", () => {
  const rows = [
    { address: "0xAAA", remainingUnits: "42500000" },
    { address: "0xBBB", remainingUnits: "0" },
    { address: "0xCCC", remainingUnits: "36000000" },
  ];
  assert.deepEqual(payableRows(rows).map((r) => r.address), ["0xAAA", "0xCCC"]);
  assert.deepEqual(payableRows([{ address: "0xD", remainingUnits: "0" }]), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test --experimental-strip-types lib/pay-link.test.ts
```

Expected: FAIL — `Cannot find module './pay-link.ts'`.

- [ ] **Step 3: Write the implementation**

Create `lib/pay-link.ts`:

```ts
// A share token is a bill's only public handle: /pay/<token> is reachable by
// anyone, so the token itself is the access control. 22 base62 characters is
// ~131 bits — not guessable, and short enough to paste into a chat message.
//
// Deliberately NOT the bill id. Ids are sequential, so a link built from one
// would let anyone walk every bill on the registry by counting.
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

export const SHARE_TOKEN_LENGTH = 22;

export function newShareToken(): string {
  // 256 is not a multiple of 62, so `byte % 62` would make the first 8 letters
  // slightly likelier than the rest. 248 is (62 * 4), so rejecting the 248–255
  // tail and redrawing keeps every character uniform.
  const bytes = new Uint8Array(SHARE_TOKEN_LENGTH * 2);
  crypto.getRandomValues(bytes);
  let out = "";
  let i = 0;
  while (out.length < SHARE_TOKEN_LENGTH) {
    if (i >= bytes.length) {
      crypto.getRandomValues(bytes);
      i = 0;
    }
    const byte = bytes[i];
    i += 1;
    if (byte < 248) out += ALPHABET[byte % 62];
  }
  return out;
}

// Base62 only, matching the generator. Narrow on purpose: this value reaches a
// database lookup and a URL segment, so anything that isn't a token we could
// have minted is rejected before it gets near either.
export function isShareToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9]{16,64}$/.test(value);
}

// Base units (6 dp), summed as bigint. Every amount stays an integer from the
// chain read to the transaction — a float round trip is exactly how a cent goes
// missing on a three-row selection.
export function selectionTotalUnits(
  rows: ReadonlyArray<{ address: string; remainingUnits: string }>,
  selected: Iterable<string>,
): bigint {
  const want = new Set([...selected].map((address) => address.toLowerCase()));
  return rows.reduce(
    (sum, row) => (want.has(row.address.toLowerCase()) ? sum + BigInt(row.remainingUnits) : sum),
    0n,
  );
}

// A settled participant is not selectable: payDebtFor caps at their remaining
// debt and reverts on a zero amount, so offering the row at all would be a
// button that can only fail.
export function payableRows<T extends { remainingUnits: string }>(rows: readonly T[]): T[] {
  return rows.filter((row) => BigInt(row.remainingUnits) > 0n);
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --test --experimental-strip-types lib/pay-link.test.ts
```

Expected: PASS, 8 tests.

- [ ] **Step 5: Add the npm script**

In `package.json`, after the `"test:landing"` line:

```json
    "test:pay-link": "node --test --experimental-strip-types lib/pay-link.test.ts app/api/pay/build-rows.test.ts",
```

The second file arrives in Task 5. Verify the script runs the first file now:

```bash
npm run test:pay-link
```

Expected: the `lib/pay-link.test.ts` tests pass; Node reports the missing `build-rows.test.ts` as a failure. That is expected until Task 5 — do not "fix" it by removing the path.

- [ ] **Step 6: Commit**

```bash
git add lib/pay-link.ts lib/pay-link.test.ts package.json
git commit -m "feat(pay-link): share-token generation, validation, and selection math"
```

---

### Task 2: Schema column and repository lookup

**Files:**
- Modify: `schema-onchain-bill-preimages.sql` (append)
- Modify: `lib/onchain-bill-preimage-repo.ts`

**Interfaces:**
- Consumes: `isShareToken` from `lib/pay-link.ts` (Task 1).
- Produces:
  - `OnchainBillPreimage` gains optional `shareToken?: string`
  - `getPreimageByShareToken(token: string): Promise<(PublishedBillPreimage & { registryAddress: string; billId: string }) | null>`

- [ ] **Step 1: Append the migration**

Append to `schema-onchain-bill-preimages.sql`:

```sql
-- Additive: the public share link's token. Null for every bill created without
-- the "Anyone can pay" switch, which is what makes that switch gate something
-- real rather than reveal a URL that always worked.
--
-- A second lookup key onto a row that already exists — not a new entity. The
-- index is partial so the many null rows don't collide with each other, and
-- unique so a token addresses exactly one bill.
alter table onchain_bill_preimages
  add column if not exists share_token text;

create unique index if not exists onchain_bill_preimages_share_token_idx
  on onchain_bill_preimages (share_token)
  where share_token is not null;
```

Run it in the Supabase SQL editor against the project before continuing — Task 5 cannot be tested without it.

- [ ] **Step 2: Add `shareToken` to the published type and the upsert**

In `lib/onchain-bill-preimage-repo.ts`, extend the input type:

```ts
export type OnchainBillPreimage = BillPreimage & {
  registryAddress: string;
  billId: string;
  // Per-participant identity provider, index-aligned with participantLabels.
  // Display/analytics only — NOT part of billMetadataHash.
  participantProviders?: string[];
  // Public share link token, or absent when the creator left the link off.
  // Written once with the row (the upsert is ignoreDuplicates), so a link can
  // never be added to — or swapped on — a bill after it was created.
  shareToken?: string;
};
```

In the `upsert` object inside `publishOnchainBillPreimage`, after the `due_date` line:

```ts
      // Null rather than undefined: an absent key would leave the column at its
      // default, which is the same thing here, but being explicit keeps the row
      // shape identical between a linked and an unlinked bill.
      share_token: input.shareToken ?? null,
```

- [ ] **Step 3: Add the token lookup**

Append to `lib/onchain-bill-preimage-repo.ts`:

```ts
// Resolve a public share link back to the bill it addresses. Returns the same
// shape as getOnchainBillPreimage plus the keys that locate the bill on Arc,
// because the caller has a token and nothing else — no registry, no bill id.
//
// The token is the whole access control on /pay/<token>, so the caller must have
// validated its shape (isShareToken) before this runs.
export async function getPreimageByShareToken(
  token: string,
): Promise<(PublishedBillPreimage & { registryAddress: string; billId: string }) | null> {
  const client = createSupabaseServerClient();
  if (!client) return null;

  const { data, error } = await client
    .from("onchain_bill_preimages")
    .select(
      "registry_address, bill_id, merchant, currency, total_usd, participant_labels, participant_providers, receipt_hash, due_date, created_at",
    )
    .eq("share_token", token)
    .maybeSingle();
  if (error) throw new Error(`Failed to read bill preimage: ${error.message}`);
  if (!data) return null;

  const registryAddress = String(data.registry_address);
  const billId = String(data.bill_id);
  const receiptHash = data.receipt_hash ?? "";
  const receiptUrl = receiptHash
    ? client.storage.from(RECEIPT_BUCKET).getPublicUrl(receiptPath(registryAddress, billId)).data.publicUrl
    : null;
  const dueDateRaw = Number(data.due_date ?? 0);
  const parsedAt = data.created_at ? Date.parse(data.created_at) : NaN;

  return {
    registryAddress,
    billId,
    merchant: data.merchant,
    currency: data.currency,
    total: Number(data.total_usd),
    participantLabels: data.participant_labels ?? [],
    participantProviders: data.participant_providers ?? [],
    receiptHash,
    receiptUrl,
    dueDate: dueDateRaw > 0 ? dueDateRaw : undefined,
    createdAtSeconds: Number.isNaN(parsedAt) ? 0 : Math.floor(parsedAt / 1000),
  };
}
```

- [ ] **Step 4: Verify nothing regressed**

```bash
npm run lint
npm run test:dashboard
```

Expected: lint clean; dashboard tests pass (they exercise `getOnchainBillPreimages`, which shares this module).

- [ ] **Step 5: Commit**

```bash
git add schema-onchain-bill-preimages.sql lib/onchain-bill-preimage-repo.ts
git commit -m "feat(pay-link): store and resolve a bill's public share token"
```

---

### Task 3: Both creation paths accept a share token

**Files:**
- Modify: `app/api/onchain-bills/preimage/route.ts` (browser-wallet creation path)
- Modify: `app/api/onchain-bills/create/route.ts` (Circle-wallet creation path)

**Interfaces:**
- Consumes: `isShareToken` (Task 1), `OnchainBillPreimage.shareToken` (Task 2).
- Produces: both routes accept an optional `shareToken` string in their JSON body and persist it with the preimage.

- [ ] **Step 1: Accept the token in the preimage publish route**

In `app/api/onchain-bills/preimage/route.ts`:

Add the import beside the existing ones:

```ts
import { isShareToken } from "@/lib/pay-link";
```

Add `shareToken?: unknown;` to the body type literal in `POST`, and add it to the destructuring alongside `dueDate`.

After the `normalizedDueDate` line, add:

```ts
  // Optional public share link. Rejected outright rather than silently dropped
  // when malformed: the creator's UI has already shown them the link, so a
  // quietly-discarded token would hand them a URL that 404s forever.
  if (shareToken !== undefined && !isShareToken(shareToken)) {
    return Response.json({ error: "Invalid share token" }, { status: 400 });
  }
```

Pass it through to the publish call:

```ts
    await publishOnchainBillPreimage(
      { registryAddress, billId, merchant, currency, total, participantLabels, participantProviders: providers, receiptHash, dueDate: normalizedDueDate, shareToken: shareToken as string | undefined },
      onchainHash,
      receiptBytes,
    );
```

- [ ] **Step 2: Accept the token in the Circle-wallet create route**

In `app/api/onchain-bills/create/route.ts`:

Add the import:

```ts
import { isShareToken } from "@/lib/pay-link";
```

Add `shareToken?: unknown;` to the body type literal.

After the `escrowUntilFull` line, add:

```ts
  // Same rejection rule as the browser-wallet path: a malformed token means the
  // creator is holding a link that would never resolve.
  const shareToken = body.shareToken === undefined ? undefined : body.shareToken;
  if (shareToken !== undefined && !isShareToken(shareToken)) {
    return Response.json({ error: "Invalid share token" }, { status: 400 });
  }
```

Pass it into the publish call inside the `try`:

```ts
    await publishOnchainBillPreimage(
      { registryAddress: REGISTRY_ADDRESS, billId: billId.toString(), merchant, currency, total, participantLabels: labels, participantProviders, receiptHash, dueDate, shareToken: shareToken as string | undefined },
      metadataHash,
      receiptBytes,
    );
```

- [ ] **Step 3: Verify**

```bash
npm run lint
npm run test:dashboard-create
```

Expected: lint clean; the existing create-route test passes untouched.

- [ ] **Step 4: Commit**

```bash
git add app/api/onchain-bills/preimage/route.ts app/api/onchain-bills/create/route.ts
git commit -m "feat(pay-link): both bill creation paths persist an optional share token"
```

---

### Task 4: `payBillDebtFor` contract helper

**Files:**
- Modify: `lib/bill-split-contracts.ts` (add after the existing `payBillDebtWithMemo`, around line 462)

**Interfaces:**
- Consumes: the `payDebtFor` entry already present in `billSplitRegistryAbi` (line ~139) and the existing `BillSplitWallet` type.
- Produces: `payBillDebtFor({ walletClient, account, billId, debtor, amount }): Promise<TransactionReceipt>`

- [ ] **Step 1: Add the helper**

In `lib/bill-split-contracts.ts`, directly after `payBillDebtWithMemo`:

```ts
// Cover somebody else's share. The registry makes this permissionless on
// purpose: it moves only the caller's USDC and only ever reduces `debtor`'s
// remaining balance, capped at what they still owe. Same approve-then-pay shape
// as payBillDebt — the caller must have approved the registry for `amount`.
//
// No memo wrapper. billPaymentMemoId keys a memo by (billId, payer), so N rows
// paid by one wallet in one sitting would collide on a single id; the registry's
// own DebtFunded event already records who funded whose share.
export async function payBillDebtFor({
  walletClient,
  account,
  billId,
  debtor,
  amount,
}: BillSplitWallet & {
  billId: bigint;
  debtor: `0x${string}`;
  amount: bigint;
}) {
  ensureRegistryConfigured();

  const hash = await walletClient.writeContract({
    address: BILL_SPLIT_REGISTRY_ADDRESS,
    abi: billSplitRegistryAbi,
    functionName: "payDebtFor",
    args: [billId, debtor, amount],
    account,
    chain: arcTestnet,
  });

  return assertReceiptSuccess(await publicClient.waitForTransactionReceipt({ hash }), "Payment");
}
```

- [ ] **Step 2: Verify the ABI entry matches the call**

```bash
grep -n -A 10 '"payDebtFor"' lib/bill-split-contracts.ts
```

Expected: an entry with `inputs` of `uint256 billId`, `address debtor`, `uint256 amount` and `stateMutability: "nonpayable"`. If the debtor parameter is missing, stop — the ABI is out of date with `contracts/BillSplitRegistry.sol:374` and must be corrected first.

- [ ] **Step 3: Verify it typechecks**

```bash
npx tsc --noEmit
```

Expected: no errors introduced by this file.

- [ ] **Step 4: Commit**

```bash
git add lib/bill-split-contracts.ts
git commit -m "feat(pay-link): payBillDebtFor helper for covering another payer's share"
```

---

### Task 5: Public bill read by token

**Files:**
- Create: `app/api/pay/build-rows.ts` (pure row assembly)
- Create: `app/api/pay/build-rows.test.ts`
- Create: `app/api/pay/[token]/route.ts`

The pure logic lives one directory up from the route so it is importable and testable without a route context — matching `app/api/onchain-bills/create/participant-providers.ts`.

**Interfaces:**
- Consumes: `getPreimageByShareToken` (Task 2), `isShareToken` (Task 1), `getBillOnchain` / `getParticipantsOnchain` / `REGISTRY_ADDRESS` from `lib/arc-read.ts`, `getUsersByWallets` from `lib/users-repo.ts`.
- Produces:
  - `type PayRow = { address: string; label: string; provider: string | null; owedUnits: string; paidUnits: string; remainingUnits: string }`
  - `buildPayRows(input): PayRow[]`
  - `GET /api/pay/[token]` returning `PayBillResponse` (shape below), consumed by Tasks 6 and 7.

- [ ] **Step 1: Write the failing test**

Create `app/api/pay/build-rows.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPayRows } from "./build-rows.ts";

const P = (owed: bigint, paid: bigint) => ({ owed, paid, exists: true });

test("labels and providers pair with participants by position", () => {
  const rows = buildPayRows({
    participantList: ["0xAaA", "0xBbB", "0xCcC"],
    participants: [P(1000000n, 0n), P(2000000n, 0n), P(3000000n, 0n)],
    labels: ["@mert", "@sarah", "Payer 3"],
    providers: ["x", "discord", "wallet"],
    liveHandles: new Map(),
  });
  assert.deepEqual(rows.map((r) => r.label), ["@mert", "@sarah", "Payer 3"]);
  assert.deepEqual(rows.map((r) => r.provider), ["x", "discord", "wallet"]);
  assert.deepEqual(rows.map((r) => r.remainingUnits), ["1000000", "2000000", "3000000"]);
});

test("a live handle beats the creation-time label snapshot", () => {
  const rows = buildPayRows({
    participantList: ["0xAaA", "0xBbB"],
    participants: [P(1000000n, 0n), P(1000000n, 0n)],
    labels: ["@old_handle", "@sarah"],
    providers: ["x", "x"],
    liveHandles: new Map([["0xaaa", { handle: "new_handle", provider: "discord" }]]),
  });
  assert.equal(rows[0].label, "@new_handle");
  assert.equal(rows[0].provider, "discord");
  assert.equal(rows[1].label, "@sarah");
});

test("a short label array (pre-migration row) falls back without shifting", () => {
  const rows = buildPayRows({
    participantList: ["0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa", "0xBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBb"],
    participants: [P(1000000n, 0n), P(2000000n, 0n)],
    labels: ["@mert"],
    providers: [],
    liveHandles: new Map(),
  });
  assert.equal(rows[0].label, "@mert");
  assert.equal(rows[1].label, "0xBbBb…BbBb");
  assert.equal(rows[1].provider, null);
  assert.equal(rows[1].remainingUnits, "2000000");
});

test("a settled participant reports zero remaining, not a negative", () => {
  const rows = buildPayRows({
    participantList: ["0xAaA", "0xBbB"],
    participants: [P(5000000n, 5000000n), P(5000000n, 7000000n)],
    labels: ["@a", "@b"],
    providers: ["x", "x"],
    liveHandles: new Map(),
  });
  assert.equal(rows[0].remainingUnits, "0");
  assert.equal(rows[1].remainingUnits, "0");
});

test("partial payment reports only what is left", () => {
  const rows = buildPayRows({
    participantList: ["0xAaA"],
    participants: [P(3000000n, 1200000n)],
    labels: ["@a"],
    providers: ["x"],
    liveHandles: new Map(),
  });
  assert.equal(rows[0].owedUnits, "3000000");
  assert.equal(rows[0].paidUnits, "1200000");
  assert.equal(rows[0].remainingUnits, "1800000");
});

test("an unreadable participant slot is omitted, not shown as a $0 phantom", () => {
  const rows = buildPayRows({
    participantList: ["0xAaA", "0xBbB", "0xCcC"],
    participants: [P(1000000n, 0n), null, { owed: 0n, paid: 0n, exists: false }],
    labels: ["@a", "@b", "@c"],
    providers: ["x", "x", "x"],
    liveHandles: new Map(),
  });
  assert.deepEqual(rows.map((r) => r.label), ["@a"]);
});

test("live handle lookup is case-insensitive against checksummed chain addresses", () => {
  const rows = buildPayRows({
    participantList: ["0xAbCdEf1234567890AbCdEf1234567890AbCdEf12"],
    participants: [P(1000000n, 0n)],
    labels: ["Payer 1"],
    providers: ["wallet"],
    liveHandles: new Map([["0xabcdef1234567890abcdef1234567890abcdef12", { handle: "lina", provider: "x" }]]),
  });
  assert.equal(rows[0].label, "@lina");
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test --experimental-strip-types app/api/pay/build-rows.test.ts
```

Expected: FAIL — `Cannot find module './build-rows.ts'`.

- [ ] **Step 3: Write the row builder**

Create `app/api/pay/build-rows.ts`:

```ts
export type PayRow = {
  address: string;
  label: string;
  provider: string | null;
  // Base units (6 dp) as decimal-integer strings. Never numbers: a bill split
  // three ways lands on thirds of a cent, and JSON floats lose them.
  owedUnits: string;
  paidUnits: string;
  remainingUnits: string;
};

type ParticipantRead = { owed: bigint; paid: bigint; exists: boolean };

function shorten(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

// Pair the chain's participant list with the off-chain preimage's labels.
//
// The pairing is POSITIONAL: participantLabels[k] describes participantList[k],
// because createBill received both arrays in the same order. app/api/dashboard
// builds its counterparty identities the same way, including the tolerance for
// pre-migration rows whose label array is shorter than the participant list —
// a missing label falls back to the shortened address rather than shifting
// every later label onto the wrong person.
//
// `liveHandles` (keyed lowercase) wins over the label: a preimage label is a
// snapshot taken at creation, while the users table holds the handle as it is
// now. Same precedence the dashboard applies.
export function buildPayRows({
  participantList,
  participants,
  labels,
  providers,
  liveHandles,
}: {
  participantList: readonly string[];
  participants: readonly (ParticipantRead | null)[];
  labels: readonly string[];
  providers: readonly string[];
  liveHandles: Map<string, { handle: string; provider: string }>;
}): PayRow[] {
  const rows: PayRow[] = [];

  participantList.forEach((address, k) => {
    const read = participants[k];
    // A null read is a failed multicall leg; !exists is a slot the registry
    // doesn't know. Either way we cannot state what this person owes, and a row
    // showing $0 would read as "already settled" — which is a different and
    // wrong claim. Drop it.
    if (!read || !read.exists) return;

    const live = liveHandles.get(address.toLowerCase());
    const snapshotLabel = labels[k];
    const remaining = read.owed > read.paid ? read.owed - read.paid : 0n;

    rows.push({
      address,
      label: live ? `@${live.handle}` : snapshotLabel || shorten(address),
      provider: live ? live.provider : (providers[k] ?? null),
      owedUnits: read.owed.toString(),
      paidUnits: read.paid.toString(),
      remainingUnits: remaining.toString(),
    });
  });

  return rows;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --test --experimental-strip-types app/api/pay/build-rows.test.ts
npm run test:pay-link
```

Expected: both PASS (7 tests here, 8 from Task 1). `test:pay-link` is now fully green.

- [ ] **Step 5: Write the route**

Read `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md` first — `params` is a Promise and `RouteContext` is the generated helper.

Create `app/api/pay/[token]/route.ts`:

```ts
import { isShareToken } from "@/lib/pay-link";
import { getPreimageByShareToken } from "@/lib/onchain-bill-preimage-repo";
import { REGISTRY_ADDRESS, getBillOnchain, getParticipantsOnchain } from "@/lib/arc-read";
import { getUsersByWallets } from "@/lib/users-repo";
import { buildPayRows } from "../build-rows";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/pay/<token> — the public read behind a share link. No session: the
// token IS the credential, and everything returned is already on a public chain.
export async function GET(_request: Request, ctx: RouteContext<"/api/pay/[token]">) {
  const { token } = await ctx.params;
  if (!isShareToken(token)) return Response.json({ error: "not_found" }, { status: 404 });

  const preimage = await getPreimageByShareToken(token);
  if (!preimage) return Response.json({ error: "not_found" }, { status: 404 });

  // Bill ids restart with each registry deployment, so a token minted against
  // the legacy v1 registry would otherwise open a DIFFERENT bill wearing the
  // same number — and invite a payment toward it. 404 rather than guess.
  if (preimage.registryAddress.toLowerCase() !== REGISTRY_ADDRESS.toLowerCase()) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  const billId = BigInt(preimage.billId);
  let bill;
  try {
    bill = await getBillOnchain(billId);
  } catch {
    return Response.json({ error: "Could not read this bill from Arc." }, { status: 502 });
  }

  const participants = await getParticipantsOnchain(
    bill.participantList.map((addr) => ({ billId, addr })),
  );

  // Display-only enrichment; getUsersByWallets already degrades to an empty map
  // rather than throwing, so a Supabase hiccup costs handles, not the page.
  const liveHandles = new Map(
    [...(await getUsersByWallets([...bill.participantList, bill.splitter]))].map(([addr, user]) => [
      addr,
      { handle: user.handle, provider: String(user.provider) },
    ]),
  );

  const rows = buildPayRows({
    participantList: bill.participantList,
    participants,
    labels: preimage.participantLabels,
    providers: preimage.participantProviders,
    liveHandles,
  });

  const creatorLive = liveHandles.get(bill.splitter.toLowerCase());

  return Response.json({
    billId: preimage.billId,
    registryAddress: preimage.registryAddress,
    merchant: preimage.merchant,
    currency: preimage.currency,
    total: preimage.total,
    dueDate: preimage.dueDate ?? 0,
    escrowUntilFull: bill.escrowUntilFull,
    receiptUrl: preimage.receiptUrl,
    creator: {
      address: bill.splitter,
      label: creatorLive ? `@${creatorLive.handle}` : null,
      provider: creatorLive ? creatorLive.provider : null,
    },
    totalOwedUnits: bill.totalOwed.toString(),
    totalPaidUnits: bill.totalPaid.toString(),
    settled: bill.totalPaid >= bill.totalOwed,
    rows,
  });
}
```

- [ ] **Step 6: Verify against a real bill**

Create a bill in the app with the switch on once Task 8 lands; until then, insert a token by hand on an existing preimage row in the Supabase SQL editor:

```sql
update onchain_bill_preimages
set share_token = 'aaaaaaaaaaaaaaaaaaaaaa'
where bill_id = '<an existing bill id>'
  and registry_address = lower('<the current registry address>');
```

Then, with `npm run dev` running:

```bash
curl -s localhost:3000/api/pay/aaaaaaaaaaaaaaaaaaaaaa | head -c 2000
curl -s -o /dev/null -w "%{http_code}\n" localhost:3000/api/pay/nope
curl -s -o /dev/null -w "%{http_code}\n" localhost:3000/api/pay/zzzzzzzzzzzzzzzzzzzzzz
```

Expected: the first prints JSON whose `rows` length matches the bill's participants and whose `remainingUnits` match what the app shows; the second and third both print `404`.

- [ ] **Step 7: Commit**

```bash
git add app/api/pay/build-rows.ts app/api/pay/build-rows.test.ts app/api/pay/[token]/route.ts
git commit -m "feat(pay-link): public bill read resolved by share token"
```

---

### Task 6: Pay-for from a Splitsy (Circle) wallet

**Files:**
- Create: `app/api/pay/[token]/social/route.ts`

**Interfaces:**
- Consumes: `getPreimageByShareToken` (Task 2), `isShareToken` (Task 1), `encodeApprove` / `encodePayDebtFor` from `lib/registry-calldata.ts`, `executeContractOnArc` / `InsufficientFundsError` from `lib/circle-dcw.ts`, `getParticipantsOnchain` / `REGISTRY_ADDRESS` from `lib/arc-read.ts`, `getSessionUser` from `lib/session.ts`, `verifyWalletUnlock` / `WALLET_UNLOCK_COOKIE` from `lib/session-core.ts`.
- Produces: `POST /api/pay/[token]/social` with body `{ debtors: string[] }` returning `{ results: { address, ok, txHash?, error? }[] }`.

- [ ] **Step 1: Write the route**

Create `app/api/pay/[token]/social/route.ts`:

```ts
import { cookies } from "next/headers";
import { getSessionUser } from "@/lib/session";
import { verifyWalletUnlock, WALLET_UNLOCK_COOKIE } from "@/lib/session-core";
import { isShareToken } from "@/lib/pay-link";
import { getPreimageByShareToken } from "@/lib/onchain-bill-preimage-repo";
import { encodeApprove, encodePayDebtFor } from "@/lib/registry-calldata";
import { executeContractOnArc, InsufficientFundsError } from "@/lib/circle-dcw";
import { REGISTRY_ADDRESS, getParticipantsOnchain } from "@/lib/arc-read";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ARC_USDC_ADDRESS = process.env.ARC_TESTNET_USDC_ADDRESS ?? "0x3600000000000000000000000000000000000000";
const MAX_ROWS = 20;

// POST /api/pay/<token>/social — cover other people's shares from the caller's
// Circle wallet. The client names WHO to cover; the amounts come from chain.
//
// No ERC-8004 feedback here, unlike /api/onchain-bills/[billId]/pay. That route
// scores a wallet for settling its OWN share, where the payment is the debtor's
// consent to be scored. Paying on someone's behalf is not their consent and is
// not their creditworthiness.
export async function POST(request: Request, ctx: RouteContext<"/api/pay/[token]/social">) {
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

  const { token } = await ctx.params;
  if (!isShareToken(token)) return Response.json({ error: "not_found" }, { status: 404 });

  const body = (await request.json().catch(() => null)) as { debtors?: unknown } | null;
  const requested = Array.isArray(body?.debtors) ? body.debtors : null;
  if (!requested || requested.length === 0) {
    return Response.json({ error: "Pick at least one person to cover." }, { status: 400 });
  }
  if (requested.length > MAX_ROWS) {
    return Response.json({ error: `Cover at most ${MAX_ROWS} people at a time.` }, { status: 400 });
  }
  if (!requested.every((d): d is string => typeof d === "string" && /^0x[0-9a-fA-F]{40}$/.test(d))) {
    return Response.json({ error: "bad debtor address" }, { status: 400 });
  }
  // De-duplicate before reading: the same address twice would pay the first
  // leg, then revert the second on a now-zero remaining and report a failure
  // for a row that is actually settled.
  const debtors = [...new Map(requested.map((d) => [d.toLowerCase(), d])).values()] as `0x${string}`[];

  const preimage = await getPreimageByShareToken(token);
  if (!preimage) return Response.json({ error: "not_found" }, { status: 404 });
  // Same stale-registry guard as the read route: a v1 token must not be able to
  // aim a payment at a different bill that happens to share its id.
  if (preimage.registryAddress.toLowerCase() !== REGISTRY_ADDRESS.toLowerCase()) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  const billId = BigInt(preimage.billId);

  // Amounts come from chain, never from the client.
  const reads = await getParticipantsOnchain(debtors.map((addr) => ({ billId, addr })));
  const legs: { address: `0x${string}`; amount: bigint }[] = [];
  for (const [i, addr] of debtors.entries()) {
    const read = reads[i];
    if (!read || !read.exists) continue;
    const remaining = read.owed > read.paid ? read.owed - read.paid : 0n;
    if (remaining > 0n) legs.push({ address: addr, amount: remaining });
  }
  if (legs.length === 0) {
    return Response.json({ error: "Those shares are already settled." }, { status: 409 });
  }

  const total = legs.reduce((sum, leg) => sum + leg.amount, 0n);

  // One approval covering every leg, then one payDebtFor per person. The
  // registry has no batch pay-for-others: settle() batches, but its pay loop is
  // hardcoded to msg.sender's own debts (BillSplitRegistry.sol:589).
  try {
    await executeContractOnArc(user.circle_wallet_id, ARC_USDC_ADDRESS, encodeApprove(REGISTRY_ADDRESS, total));
  } catch (err) {
    if (err instanceof InsufficientFundsError) return Response.json({ error: "insufficient_funds" }, { status: 402 });
    return Response.json({ error: err instanceof Error ? err.message : "approval failed" }, { status: 502 });
  }

  // Sequential, and each leg reports its own outcome. A failure partway through
  // leaves the earlier legs paid — which is the truth, so it is what we return
  // rather than a single ok/failed for the whole batch.
  const results: { address: string; ok: boolean; txHash?: string; error?: string }[] = [];
  for (const leg of legs) {
    try {
      const tx = await executeContractOnArc(
        user.circle_wallet_id,
        REGISTRY_ADDRESS,
        encodePayDebtFor(billId, leg.address, leg.amount),
      );
      results.push({ address: leg.address, ok: true, txHash: tx.txHash ?? undefined });
    } catch (err) {
      results.push({
        address: leg.address,
        ok: false,
        error: err instanceof InsufficientFundsError ? "insufficient_funds" : err instanceof Error ? err.message : "payment failed",
      });
    }
  }

  return Response.json({ results });
}
```

- [ ] **Step 2: Verify the guards**

With `npm run dev` running and **signed out**:

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST localhost:3000/api/pay/aaaaaaaaaaaaaaaaaaaaaa/social \
  -H 'Content-Type: application/json' -d '{"debtors":["0x0000000000000000000000000000000000000001"]}'
```

Expected: `401`.

Then signed in but with the wallet locked (do not unlock the PIN), repeat the same call from the browser console:

```js
await fetch("/api/pay/aaaaaaaaaaaaaaaaaaaaaa/social", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ debtors: ["0x0000000000000000000000000000000000000001"] }),
}).then((r) => r.status)
```

Expected: `403`.

- [ ] **Step 3: Verify lint and types**

```bash
npm run lint
npx tsc --noEmit
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add "app/api/pay/[token]/social/route.ts"
git commit -m "feat(pay-link): cover other payers' shares from a Splitsy wallet"
```

---

### Task 7: The pay page

**Files:**
- Create: `app/pay/[token]/page.tsx`
- Create: `app/pay/[token]/PayClient.tsx`
- Modify: `app/globals.css` (append the pay-page block)

**Interfaces:**
- Consumes: `GET /api/pay/[token]` and `POST /api/pay/[token]/social` (Tasks 5, 6); `payBillDebtFor`, `approveBillRegistry`, `ensureBillSplitWalletOnArc`, `createBillSplitWallet`, `billUnitsToUsdc`, `isBillRegistryConfigured` from `lib/bill-split-contracts.ts` (Task 4); `selectionTotalUnits`, `payableRows` from `lib/pay-link.ts` (Task 1); `Switch` from `app/SettlementAgentsPanel.tsx`; `XAuthControl`, `SignInMenu`.
- Produces: the route `/pay/<token>`.

- [ ] **Step 1: Add the styles**

Append to `app/globals.css`:

```css
/* ── Public pay page (/pay/[token]) ───────────────────────────────────────────
   Two zones: a fixed ink poster carrying the headline amount, and a scrolling
   roster of payer rows. The poster never leaves the viewport on desktop so the
   figure you are working against stays visible while you pick rows. */

.pay-shell {
  display: grid;
  grid-template-columns: minmax(0, 0.85fr) minmax(0, 1.15fr);
  min-height: calc(100dvh - 4rem);
}

.pay-poster {
  position: sticky;
  top: 0;
  align-self: start;
  height: calc(100dvh - 4rem);
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  gap: 2rem;
  padding: clamp(2rem, 1rem + 3vw, 4rem);
  background: var(--ink-950);
  color: var(--paper-50);
}

.pay-poster[data-settled="true"] { background: #0d2a1f; }

.pay-merchant {
  font-family: var(--font-clash), system-ui, sans-serif;
  font-weight: 600;
  letter-spacing: -0.03em;
  line-height: 0.95;
  font-size: clamp(2.2rem, 1.2rem + 3.4vw, 4rem);
  margin: 0.6rem 0 1.4rem;
}

.pay-amount {
  font-family: var(--font-clash), system-ui, sans-serif;
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  letter-spacing: -0.03em;
  line-height: 1;
  font-size: clamp(3rem, 1.6rem + 5vw, 5.5rem);
}

.pay-amount[data-settled="true"] { color: var(--success); }

.pay-progress {
  height: 5px;
  border-radius: 999px;
  background: rgba(247, 243, 234, 0.18);
  overflow: hidden;
  margin-top: 1.1rem;
}

.pay-progress > span {
  display: block;
  height: 100%;
  background: var(--arc-cyan);
  transition: width var(--dur-3) var(--ease-out);
}

.pay-poster[data-settled="true"] .pay-progress > span { background: var(--success); }

.pay-roster {
  padding: clamp(1.25rem, 0.8rem + 1.6vw, 2.5rem);
  background: var(--surface-strong);
}

.pay-row {
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 1.1rem 0;
  border-bottom: 1px solid var(--border);
  transition: box-shadow var(--dur-1) var(--ease-out), background var(--dur-1) var(--ease-out);
}

.pay-row:last-child { border-bottom: 0; }

.pay-row[data-selected="true"] {
  box-shadow: inset 3px 0 0 var(--accent);
  background: linear-gradient(90deg, var(--accent-soft), transparent 65%);
  padding-left: 0.9rem;
  margin-left: -0.9rem;
}

.pay-row[data-state="paid"] { opacity: 0.45; }
.pay-row[data-state="paid"] .pay-row-name { text-decoration: line-through; }

.pay-row-name {
  font-family: var(--font-clash), system-ui, sans-serif;
  font-weight: 600;
  letter-spacing: -0.02em;
  font-size: clamp(1.05rem, 0.9rem + 0.6vw, 1.5rem);
}

.pay-row-meta {
  font-family: var(--font-geist-mono), ui-monospace, monospace;
  font-size: 0.7rem;
  color: var(--text-muted);
  margin-top: 0.15rem;
}

.pay-row-amount {
  font-family: var(--font-geist-mono), ui-monospace, monospace;
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  font-size: clamp(1.05rem, 0.9rem + 0.6vw, 1.4rem);
}

.pay-stamp {
  border: 1px solid var(--success);
  border-radius: 4px;
  color: var(--success);
  font-size: 0.62rem;
  font-weight: 700;
  letter-spacing: 0.1em;
  padding: 0.15rem 0.4rem;
}

.pay-bar {
  position: sticky;
  bottom: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
  padding: 0.9rem clamp(1.25rem, 0.8rem + 1.6vw, 2.5rem);
  background: var(--ink-950);
  color: var(--paper-50);
}

.pay-bar-total {
  font-family: var(--font-clash), system-ui, sans-serif;
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  font-size: clamp(1.3rem, 1.1rem + 0.8vw, 1.9rem);
}

@media (max-width: 860px) {
  .pay-shell { grid-template-columns: minmax(0, 1fr); }
  .pay-poster { position: static; height: auto; }
  .pay-bar { position: fixed; left: 0; right: 0; bottom: 0; }
  .pay-roster { padding-bottom: 6rem; }
}
```

- [ ] **Step 2: Write the server component**

Read `node_modules/next/dist/docs/01-app/01-getting-started/14-metadata-and-og-images.md` before writing metadata.

Create `app/pay/[token]/page.tsx`:

```tsx
import type { Metadata } from "next";
import PayClient from "./PayClient";

// A share link is handed to specific people. Keeping it out of search indexes is
// the difference between "unguessable" and "unguessable until Google finds it".
export const metadata: Metadata = {
  title: "Pay a bill",
  robots: { index: false, follow: false, googleBot: { index: false, follow: false } },
};

export default async function PayPage(props: PageProps<"/pay/[token]">) {
  const { token } = await props.params;
  return <PayClient token={token} />;
}
```

- [ ] **Step 3: Write the client component**

Create `app/pay/[token]/PayClient.tsx`:

```tsx
"use client";

import { ConnectButton } from "@rainbow-me/rainbowkit";
import { Loader2 } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { getWalletClient } from "wagmi/actions";
import { arcTestnet } from "viem/chains";
import SignInMenu from "@/app/SignInMenu";
import XAuthControl from "@/app/XAuthControl";
import { Switch } from "@/app/SettlementAgentsPanel";
import { wagmiConfig } from "@/lib/wagmi";
import { payableRows, selectionTotalUnits } from "@/lib/pay-link";
import {
  approveBillRegistry,
  billUnitsToUsdc,
  createBillSplitWallet,
  ensureBillSplitWalletOnArc,
  isBillRegistryConfigured,
  payBillDebtFor,
} from "@/lib/bill-split-contracts";

type Row = {
  address: string;
  label: string;
  provider: string | null;
  owedUnits: string;
  paidUnits: string;
  remainingUnits: string;
};

type Bill = {
  billId: string;
  merchant: string;
  currency: string;
  total: number;
  dueDate: number;
  escrowUntilFull: boolean;
  receiptUrl: string | null;
  creator: { address: string; label: string | null; provider: string | null };
  totalOwedUnits: string;
  totalPaidUnits: string;
  settled: boolean;
  rows: Row[];
};

// Per-row progress during a payment run. `pending` rows are queued behind the
// row currently signing — shown as queued rather than as failures.
type RowState = { status: "idle" | "pending" | "signing" | "paid" | "failed"; txHash?: string; error?: string };

const usd = (units: string) => `$${Number(billUnitsToUsdc(BigInt(units))).toFixed(2)}`;

export default function PayClient({ token }: { token: string }) {
  const [bill, setBill] = useState<Bill | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [rowStates, setRowStates] = useState<Record<string, RowState>>({});
  const [paying, setPaying] = useState(false);
  const [message, setMessage] = useState<string>("");

  const load = useCallback(async () => {
    const res = await fetch(`/api/pay/${token}`);
    if (!res.ok) {
      setLoadError(res.status === 404 ? "not_found" : "unavailable");
      return;
    }
    const data = (await res.json()) as Bill;
    setBill(data);
    // Preselect nothing. The payer chooses; a page that arrives with everyone
    // ticked invites an accidental payment of the entire bill.
    setLoadError(null);
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loadError === "not_found") {
    return (
      <main className="mx-auto flex min-h-[70dvh] max-w-lg flex-col items-center justify-center gap-3 px-6 text-center">
        <h1 className="text-2xl font-semibold text-[var(--text)]">This link doesn&apos;t open a bill</h1>
        <p className="text-[var(--text-muted)]">
          It may have been mistyped, or the bill was created without a share link.
        </p>
        <Link className="secondary-button mt-2" href="/">
          Go to Splitsy
        </Link>
      </main>
    );
  }

  if (loadError) {
    return (
      <main className="mx-auto flex min-h-[70dvh] max-w-lg flex-col items-center justify-center gap-3 px-6 text-center">
        <h1 className="text-2xl font-semibold text-[var(--text)]">Couldn&apos;t reach Arc</h1>
        <p className="text-[var(--text-muted)]">The bill exists, but its live balances couldn&apos;t be read just now.</p>
        <button className="secondary-button mt-2" onClick={() => void load()} type="button">
          Try again
        </button>
      </main>
    );
  }

  if (!bill) {
    return (
      <main className="flex min-h-[70dvh] items-center justify-center">
        <Loader2 className="animate-spin text-[var(--text-muted)]" size={22} />
      </main>
    );
  }

  const open = payableRows(bill.rows);
  const selectedTotal = selectionTotalUnits(bill.rows, selected);
  const owedUnits = BigInt(bill.totalOwedUnits);
  const paidUnits = BigInt(bill.totalPaidUnits);
  const remainingUnits = owedUnits > paidUnits ? owedUnits - paidUnits : 0n;
  const pct = owedUnits > 0n ? Number((paidUnits * 100n) / owedUnits) : 100;

  function toggle(address: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(address)) next.delete(address);
      else next.add(address);
      return next;
    });
  }

  // Browser wallet: one approval for the whole selection, then one payDebtFor
  // per row. The registry has no batch pay-for-others, so the honest thing is to
  // show each row settling on its own — and to leave the earlier rows paid when
  // a later one fails.
  async function payWithBrowserWallet() {
    if (!isBillRegistryConfigured()) {
      setMessage("Bill registry is not configured.");
      return;
    }
    const legs = bill!.rows.filter((r) => selected.has(r.address) && BigInt(r.remainingUnits) > 0n);
    if (legs.length === 0) return;

    setPaying(true);
    setMessage("");
    setRowStates(Object.fromEntries(legs.map((l) => [l.address, { status: "pending" } as RowState])));

    try {
      const walletClient = await getWalletClient(wagmiConfig, { chainId: arcTestnet.id });
      const wallet = await createBillSplitWallet(walletClient);
      await ensureBillSplitWalletOnArc(wallet);

      setMessage("Approving USDC…");
      await approveBillRegistry({ ...wallet, amount: selectedTotal });

      for (const leg of legs) {
        setRowStates((s) => ({ ...s, [leg.address]: { status: "signing" } }));
        try {
          const receipt = await payBillDebtFor({
            ...wallet,
            billId: BigInt(bill!.billId),
            debtor: leg.address as `0x${string}`,
            amount: BigInt(leg.remainingUnits),
          });
          setRowStates((s) => ({ ...s, [leg.address]: { status: "paid", txHash: receipt.transactionHash } }));
        } catch (err) {
          setRowStates((s) => ({
            ...s,
            [leg.address]: { status: "failed", error: err instanceof Error ? err.message : "Payment failed" },
          }));
        }
      }
      setMessage("");
      setSelected(new Set());
      await load();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Payment failed.");
    } finally {
      setPaying(false);
    }
  }

  // Splitsy wallet: the server signs. One request, per-row results back.
  async function payWithSplitsyWallet() {
    const legs = bill!.rows.filter((r) => selected.has(r.address) && BigInt(r.remainingUnits) > 0n);
    if (legs.length === 0) return;

    const pin = await fetch("/api/wallet/pin").then((r) => r.json()).catch(() => ({}));
    if (!pin.unlocked) {
      setMessage("Unlock your wallet (the wallet button in the bottom-right corner), then tap Pay again.");
      return;
    }

    setPaying(true);
    setMessage("");
    setRowStates(Object.fromEntries(legs.map((l) => [l.address, { status: "pending" } as RowState])));
    try {
      const res = await fetch(`/api/pay/${token}/social`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ debtors: legs.map((l) => l.address) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage(
          data.error === "insufficient_funds"
            ? "Your wallet needs more test USDC to cover this."
            : data.error === "locked"
              ? "Unlock your wallet (the wallet button in the bottom-right corner), then tap Pay again."
              : (data.error ?? "Payment failed."),
        );
        setRowStates({});
        return;
      }
      const results = (data.results ?? []) as { address: string; ok: boolean; txHash?: string; error?: string }[];
      setRowStates(
        Object.fromEntries(
          results.map((r) => [
            r.address,
            r.ok ? { status: "paid" as const, txHash: r.txHash } : { status: "failed" as const, error: r.error },
          ]),
        ),
      );
      setSelected(new Set());
      await load();
    } finally {
      setPaying(false);
    }
  }

  return (
    <>
      <header className="flex items-center justify-between border-b border-[var(--border)] bg-[color:var(--header-bg)] px-5 py-3 backdrop-blur-xl">
        <Link className="text-sm font-bold tracking-tight text-[var(--text)] no-underline" href="/">
          Splitsy
        </Link>
        <div className="flex items-center gap-2">
          <SignInMenu />
          <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false} />
        </div>
      </header>

      <main className="pay-shell">
        <aside className="pay-poster" data-settled={bill.settled}>
          <div>
            <p className="text-[0.62rem] font-semibold uppercase tracking-[0.14em] text-[rgba(247,243,234,0.55)]">
              Bill #{bill.billId} · Arc Testnet
            </p>
            <h1 className="pay-merchant">{bill.merchant || "Bill"}</h1>
            {bill.settled ? (
              <p className="pay-amount" data-settled="true">
                Settled
              </p>
            ) : (
              <p className="pay-amount">{usd(remainingUnits.toString())}</p>
            )}
            <p className="amount-text mt-1 text-xs text-[rgba(247,243,234,0.6)]">
              {bill.settled ? `${usd(bill.totalOwedUnits)} of ${usd(bill.totalOwedUnits)}` : `still owed of ${usd(bill.totalOwedUnits)}`}
            </p>
            <div className="pay-progress">
              <span style={{ width: `${Math.min(100, pct)}%` }} />
            </div>
          </div>
          <div className="text-[0.62rem] leading-relaxed text-[rgba(247,243,234,0.55)]">
            <p>✓ Details verified against Arc</p>
            <p>
              Created by {bill.creator.label ?? `${bill.creator.address.slice(0, 6)}…${bill.creator.address.slice(-4)}`}
              {bill.dueDate > 0 ? ` · due ${new Date(bill.dueDate * 1000).toLocaleDateString()}` : ""}
            </p>
            {bill.escrowUntilFull ? <p>Held in escrow until every share is paid</p> : null}
          </div>
        </aside>

        <section className="pay-roster">
          {bill.settled ? (
            <div className="flex min-h-[40dvh] flex-col items-center justify-center gap-2 text-center">
              <p className="pay-row-name text-2xl">Everyone&apos;s covered</p>
              <p className="max-w-xs text-sm text-[var(--text-muted)]">
                All {bill.rows.length} shares are paid. {bill.creator.label ?? "The creator"} can collect{" "}
                {usd(bill.totalOwedUnits)} from Arc.
              </p>
            </div>
          ) : (
            <>
              <p className="text-[0.62rem] font-semibold uppercase tracking-[0.14em] text-[var(--text-muted)]">
                {paying ? "Settling — don't close this tab" : "Choose who you're covering"}
              </p>
              {message ? <p className="mt-2 text-sm text-[var(--warning-text)]">{message}</p> : null}
              <div className="mt-2">
                {bill.rows.map((row) => {
                  const state = rowStates[row.address]?.status ?? "idle";
                  const done = BigInt(row.remainingUnits) === 0n || state === "paid";
                  return (
                    <div
                      className="pay-row"
                      data-selected={!done && selected.has(row.address)}
                      data-state={done ? "paid" : state}
                      key={row.address}
                    >
                      {done ? (
                        <span className="w-[34px] shrink-0" />
                      ) : state === "signing" ? (
                        <Loader2 className="shrink-0 animate-spin text-[var(--accent)]" size={18} />
                      ) : (
                        <Switch
                          checked={selected.has(row.address)}
                          disabled={paying}
                          onChange={() => toggle(row.address)}
                          srLabel={`Cover ${row.label}'s share`}
                        />
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="pay-row-name truncate">{row.label}</p>
                        <p className="pay-row-meta">
                          {state === "signing"
                            ? "waiting for confirmation…"
                            : state === "failed"
                              ? (rowStates[row.address]?.error ?? "failed — try again")
                              : done
                                ? "settled"
                                : `owes ${usd(row.remainingUnits)} of ${usd(row.owedUnits)}`}
                        </p>
                      </div>
                      {done ? (
                        <span className="pay-stamp">PAID</span>
                      ) : (
                        <span className="pay-row-amount">{usd(row.remainingUnits)}</span>
                      )}
                    </div>
                  );
                })}
              </div>
              {open.length === 0 ? (
                <p className="mt-4 text-sm text-[var(--text-muted)]">Every share on this bill is already settled.</p>
              ) : null}
            </>
          )}
        </section>
      </main>

      {bill.settled ? null : (
        <div className="pay-bar">
          <span className="flex items-baseline gap-2">
            <span className="text-[0.62rem] font-semibold uppercase tracking-[0.14em] text-[rgba(247,243,234,0.6)]">
              You pay
            </span>
            <span className="pay-bar-total">{usd(selectedTotal.toString())}</span>
            <span className="text-xs text-[rgba(247,243,234,0.6)]">
              · {selected.size} row{selected.size === 1 ? "" : "s"}
            </span>
          </span>
          <span className="flex gap-2">
            <button
              className="secondary-button"
              disabled={paying || selected.size === 0}
              onClick={() => void payWithSplitsyWallet()}
              type="button"
            >
              Pay with Splitsy wallet
            </button>
            <button
              className="primary-button"
              disabled={paying || selected.size === 0}
              onClick={() => void payWithBrowserWallet()}
              type="button"
            >
              {paying ? <Loader2 className="animate-spin" size={16} /> : null}
              Pay on Arc
            </button>
          </span>
        </div>
      )}

      <XAuthControl />
    </>
  );
}
```

- [ ] **Step 4: Verify it renders and behaves**

```bash
npm run dev
```

Open `http://localhost:3000/pay/aaaaaaaaaaaaaaaaaaaaaa` (the token inserted by hand in Task 5) and check each state from the design doc:

1. Signed out: rows toggle, "You pay" total updates, both pay buttons are present.
2. `http://localhost:3000/pay/zzzzzzzzzzzzzzzzzzzzzz` shows the "doesn't open a bill" screen, not a crash.
3. Already-paid rows show `PAID` with no switch.
4. Narrow the window under 860px: the poster stacks, the pay bar fixes to the bottom.
5. Toggle the theme: no hardcoded colour survives in either mode.
6. `curl -s localhost:3000/pay/aaaaaaaaaaaaaaaaaaaaaa | grep -i 'noindex'` → the robots meta tag is present.

Then actually pay one row with a browser wallet holding test USDC, and confirm the row stamps PAID, the poster's figure drops, and the progress bar advances.

- [ ] **Step 5: Lint and typecheck**

```bash
npm run lint
npx tsc --noEmit
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add "app/pay/[token]/page.tsx" "app/pay/[token]/PayClient.tsx" app/globals.css
git commit -m "feat(pay-link): dedicated page for covering any payer's share of one bill"
```

---

### Task 8: Creator toggle and the link

**Files:**
- Modify: `app/HomeClient.tsx`

**Interfaces:**
- Consumes: `newShareToken` from `lib/pay-link.ts` (Task 1); the `shareToken` body field on both creation routes (Task 3).
- Produces: nothing downstream.

- [ ] **Step 1: Add the import and state**

In `app/HomeClient.tsx`, add to the imports:

```ts
import { newShareToken } from "@/lib/pay-link";
```

Beside the existing `escrowUntilFull` state declaration, add:

```ts
  // "Anyone can pay": mints a share link at creation. Off by default — a bill
  // that anyone holding a URL can pay into is a choice, not a default.
  const [publicPayLink, setPublicPayLink] = useState(false);
  // Set on success by BOTH creation paths, so the confirmation can offer the
  // link regardless of which wallet wrote the bill.
  const [shareLinkUrl, setShareLinkUrl] = useState<string>("");
```

- [ ] **Step 2: Reset it with the rest of the form**

Find `resetSplitForm` and add, alongside the other resets:

```ts
    setPublicPayLink(false);
```

Do **not** reset `shareLinkUrl` there — `resetSplitForm()` runs immediately after a successful create, and clearing the URL would wipe the link before the creator ever saw it.

- [ ] **Step 3: Add the toggle card**

In the "Who owes what" panel, immediately after the closing `</div>` of the "All or nothing" escrow card and before the `canChooseCreator` block:

```tsx
                <div
                  className={`mt-4 flex flex-col gap-3 rounded-[var(--radius)] border p-3 text-sm sm:flex-row sm:items-start sm:justify-between ${
                    publicPayLink
                      ? "border-[var(--accent)] bg-[var(--accent-soft)]"
                      : "border-[var(--border)] bg-[var(--surface-muted)]"
                  }`}
                >
                  <div>
                    <p className="flex items-center gap-1.5 font-semibold text-[var(--text)]">
                      <Link2 size={14} />
                      Anyone can pay
                      <span className="font-normal text-[var(--text-muted)]">(share link)</span>
                    </p>
                    <p className="mt-1 max-w-xl leading-6 text-[var(--text-muted)]">
                      Get a link that opens this bill on its own page, where anyone holding it can cover any payer&apos;s
                      share — useful when one person picks up several shares. Without it, only the people you tagged can
                      pay. The link is minted when the bill is written and can&apos;t be added or removed afterwards.
                    </p>
                  </div>
                  <Switch
                    checked={publicPayLink}
                    onChange={setPublicPayLink}
                    srLabel="Anyone can pay — get a shareable link for this bill"
                  />
                </div>
```

Add `Link2` to the existing `lucide-react` import list.

- [ ] **Step 4: Mint the token and send it down both paths**

In `submitBillOnchainMixed`, immediately after the `const dueDate = dueDateToUnix(dueDateInput);` line:

```ts
      // Minted in the browser, not the server: the browser-wallet path publishes
      // its preimage fire-and-forget, so a server-minted token would mean either
      // awaiting that POST or a second round trip before the link could be
      // shown. Publishing a preimage already requires details that hash to the
      // on-chain commitment, so in practice only the creator can set one.
      const shareToken = publicPayLink ? newShareToken() : undefined;
```

In the **social path**'s `fetch("/api/onchain-bills/create", …)` body, add `shareToken,` alongside `dueDate`. Then replace the success block's message line with:

```ts
        setBillState("success");
        setBillMessage(`Bill #${data.billId} is live on Arc from your Splitsy wallet. Tagged people will see it after signing in.`);
        setShareLinkUrl(shareToken ? `${window.location.origin}/pay/${shareToken}` : "");
        resetSplitForm();
```

In the **browser-wallet path**'s `fetch("/api/onchain-bills/preimage", …)` body, add `shareToken,` alongside `dueDate`. Then after `setSubmittedBillId(result.billId);`, add:

```ts
      setShareLinkUrl(shareToken ? `${window.location.origin}/pay/${shareToken}` : "");
```

- [ ] **Step 5: Show the link in the confirmation**

**Not** in the `submittedBillId` block at `app/HomeClient.tsx:3187`. That block lives inside the split panel, and `resetSplitForm()` — which runs immediately after a successful create — both nulls `submittedBillId` and unmounts the panel. It is unreachable after creation, which is exactly why the real confirmation was moved out to the top of the page.

The live confirmation is at `app/HomeClient.tsx:2688`, directly under the hero. Replace it with:

```tsx
            {billState === "success" && billMessage && !billReadyForSplit ? (
              <div className="flex flex-col gap-3">
                <Message tone="success">{billMessage}</Message>
                {shareLinkUrl ? (
                  <div className="flex flex-col gap-2 rounded-[var(--radius)] border border-[var(--accent)] bg-[var(--accent-soft)] p-3 text-sm">
                    <span className="font-semibold text-[var(--text)]">Anyone with this link can pay</span>
                    <div className="flex flex-wrap items-center gap-2">
                      <code className="amount-text min-w-0 flex-1 truncate rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-strong)] px-2 py-1.5 text-xs text-[var(--text)]">
                        {shareLinkUrl}
                      </code>
                      <button
                        className="secondary-button"
                        onClick={() => void navigator.clipboard.writeText(shareLinkUrl)}
                        type="button"
                      >
                        <Link2 size={15} />
                        Copy link
                      </button>
                    </div>
                    <span className="text-xs text-[var(--text-muted)]">
                      Save it now — it isn&apos;t shown again anywhere.
                    </span>
                  </div>
                ) : null}
              </div>
            ) : null}
```

This is why `shareLinkUrl` is deliberately **not** cleared in `resetSplitForm()` (Step 2): the reset is what reveals this confirmation, so clearing the URL there would wipe the link in the same tick it was meant to appear.

Clear it instead when a new bill starts. In `resetSplitForm`'s only other caller path — the effect or handler that begins a fresh upload — is not reliable, so clear it at the top of `submitBillOnchainMixed` instead, right after the manual-share validation:

```ts
    setShareLinkUrl("");
```

- [ ] **Step 6: Verify end to end**

With `npm run dev`, create a bill with the switch **on**, using a browser wallet:

1. The confirmation shows the link and Copy works.
2. Opening the link in a private window shows the bill with the right payers and amounts.
3. Cover one row from a different wallet; the row stamps PAID and the creator's app shows the payment.

Then create a bill with the switch **off** and confirm no link appears, and that guessing `/pay/<any-22-chars>` 404s.

- [ ] **Step 7: Lint, typecheck, full test sweep**

```bash
npm run lint
npx tsc --noEmit
npm run test:pay-link
npm run test:dashboard
npm run test:dashboard-create
```

Expected: all clean and passing.

- [ ] **Step 8: Commit**

```bash
git add app/HomeClient.tsx
git commit -m "feat(pay-link): 'Anyone can pay' switch mints a share link at bill creation"
```

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
|---|---|
| Unguessable token, toggle-off mints none | 1, 2, 8 |
| `share_token` column + partial unique index | 2 |
| Client-generated token, both creation paths | 3, 8 |
| Token shape validated server-side | 1, 3, 5, 6 |
| Stale-registry rejection | 5, 6 |
| Public read by token, live chain state | 5 |
| Positional label pairing + live-handle override | 5 |
| Browser-wallet N+1 payment | 4, 7 |
| Circle-wallet pay-for behind PIN unlock | 6 |
| Amounts read from chain, never client | 5, 6 |
| No ERC-8004 feedback on this path | 6 |
| Editorial split layout, all four states | 7 |
| Mobile stacking | 7 |
| `noindex` on the page | 7 |
| Toggle + link in the creation panel | 8 |
| Test file + npm script | 1, 5 |

**Deviations from the spec, deliberate:**
- Token charset is base62 in both generator and validator; the spec wrote `[A-Za-z0-9_-]`. Narrower is better for a value that reaches a URL segment and a database lookup, and nothing mints `-` or `_`.
- Amounts cross the API as **base-unit integer strings**, which the spec called "decimal strings". Base units keep the selection math in `bigint` with no parsing step and no rounding surface.
- Row assembly was extracted to `app/api/pay/build-rows.ts` so the subtle index-alignment logic is unit-tested, adding a second test file to the spec's one.

**Type consistency:** `PayRow` in `app/api/pay/build-rows.ts` is the source of the `Row` type in `PayClient.tsx`; both use `owedUnits` / `paidUnits` / `remainingUnits`. `selectionTotalUnits` and `payableRows` take `{ address, remainingUnits }`, which `PayRow` satisfies. `payBillDebtFor` takes `debtor`, matching the ABI's parameter name and the contract at `BillSplitRegistry.sol:374`.

**Trap found while writing this plan, encoded in Task 8 Step 5:** the obvious home for the link — the `submittedBillId` block at `app/HomeClient.tsx:3187` — is dead code after a create. `resetSplitForm()` nulls `submittedBillId` and unmounts the panel containing it, in the same tick it is set. The reachable confirmation is the one at `app/HomeClient.tsx:2688`. An implementer following instinct rather than the plan would ship a link nobody ever sees.
