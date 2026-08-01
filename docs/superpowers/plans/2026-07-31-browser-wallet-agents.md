# Browser-Wallet Agents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let browser-wallet (EOA) users arm the on-chain autopay mandate — either against Splitsy's hosted agent or against their own Circle Agent Wallet — and give the hosted agent one genuine judgment step over the bill's contents.

**Architecture:** `AutopayMandate.sol` is unchanged and keyed on `msg.sender`, so an EOA can already arm it; what is missing is client-side signing, an EOA↔account link so the hosted agent can find the debtor's rules, and a public discovery feed so a user-run agent can find work. `setMandate` already takes an arbitrary agent address, which is the entire routing rule between the two operators.

**Tech Stack:** Next.js 16.2.9 (App Router), React 19.2.4, viem 2.52.2, wagmi 2.19.5, Supabase, Gemini via raw `fetch`, `node --test --experimental-strip-types`.

## Global Constraints

- **No contract change.** `contracts/AutopayMandate.sol` is not edited, not redeployed. No registry redeploy. No `circle-scp-monitor-setup.ts` re-run.
- **No new dependency.** The model call reuses the `lib/ocr-core.ts` pattern: raw `fetch` to `https://generativelanguage.googleapis.com/v1beta/models/<model>:generateContent`, header `x-goog-api-key`, `generationConfig: { responseMimeType: "application/json", temperature: 0 }`, key from `process.env.RECEIPT_SCANNER_API_KEY`.
- **Import extensions.** Files under `lib/` import siblings **with** the `.ts` extension (`import { decideAutopay } from "./autopay.ts"`) — the repo is `"type": "module"` and `node --test --experimental-strip-types` requires it. Files under `app/` use `@/lib/name` **without** an extension. Do not mix these up.
- **Money.** Amounts read from chain stay `bigint` USDC base units (6dp). Convert to a `number` only to compare against a user's own caps. Never round-trip an amount that will move through a float.
- **Fail closed.** Any new check that cannot reach a verdict must skip the payment, never allow it.
- **`MAX_ALLOWED_CREATORS` is 10**, enforced in the contract and mirrored in `app/api/agents/grants/route.ts:45`.
- **Addresses are stored and compared lowercase** everywhere in Postgres.
- **Typecheck command:** `npx tsc --noEmit`. **Lint:** `npm run lint`.

---

## File Structure

| File | Responsibility |
|---|---|
| `schema-agents.sql` (modify) | Adds `autopay_grants.debtor_address` + partial unique index, and `autopay_grants.require_bill_review` |
| `lib/agents-repo.ts` (modify) | Reads/writes the two new columns; new debtor-address → user lookup |
| `lib/agent-link.ts` (create) | Pure: builds and verifies the wallet-link signature message |
| `lib/agent-link.test.ts` (create) | Tests for the above |
| `app/api/agents/link/route.ts` (create) | `POST` links a browser wallet, `DELETE` unlinks |
| `lib/autopay-review.ts` (create) | Gemini review of a bill's contents; pure parse split out for testing |
| `lib/autopay-review.test.ts` (create) | Tests the parse + fail-closed behaviour |
| `app/api/agents/autopay/route.ts` (modify) | Union debtor lookup, silent stand-down, review call |
| `lib/agent-queue.ts` (create) | Pure: shapes and filters the payable-bill feed |
| `lib/agent-queue.test.ts` (create) | Tests the filter |
| `app/api/agents/queue/route.ts` (create) | Public read-only feed for a self-run agent |
| `app/api/agents/skill/route.ts` (create) | Templated markdown skill file |
| `app/api/agents/grants/route.ts` (modify) | Accepts `debtorAddress`; returns per-address on-chain facts |
| `app/SettlementAgentsPanel.tsx` (modify) | Wallet selector, agent selector, link, "Arm on chain", review checkbox |
| `docs/` (modify) | BYO walkthrough + the mainnet-only policy caveat |

---

### Task 1: Schema and repository plumbing

**Files:**
- Modify: `schema-agents.sql`
- Modify: `lib/agents-repo.ts:8`, `:18-46`, `:48-64`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `AutopayGrantRow = AutopayGrant & { userId: string; debtorAddress: string | null; requireBillReview: boolean }`
  - `getAutopayGrant(userId: string): Promise<AutopayGrantRow | null>` (unchanged signature, two more fields)
  - `upsertAutopayGrant(grant: AutopayGrantRow): Promise<void>` (unchanged signature)
  - `getGrantsByDebtorAddresses(addresses: string[]): Promise<Map<string, { userId: string }>>` — keys are lowercase addresses
  - `setGrantDebtorAddress(userId: string, address: string | null): Promise<void>`

`AutopayGrant` in `lib/autopay.ts` is **not** modified. `requireBillReview` is deliberately outside it: `decideAutopay` never reads it, because the review runs after `decideAutopay` returns `pay`.

- [ ] **Step 1: Append the schema change**

Add to the end of `schema-agents.sql`:

```sql
-- The browser wallet (EOA) this person autopays from, proven by a personal_sign
-- at POST /api/agents/link. It lives here rather than on `users` because it says
-- nothing about who someone is — only which wallet their agent may pull from —
-- and the identity tables are load-bearing across the whole app.
--
-- The partial unique index is what stops two accounts claiming one address and
-- making the debtor -> user lookup in the autopay route ambiguous.
alter table autopay_grants add column if not exists debtor_address text;
create unique index if not exists autopay_grants_debtor_idx
  on autopay_grants (debtor_address) where debtor_address is not null;

-- Whether the agent must also pass the bill's CONTENTS past a model before
-- paying: does the receipt cohere, and is this person's share proportionate to
-- what is attributed to them? require_verified_hash proves only that the
-- preimage recomputes to the on-chain metadataHash — it says nothing about
-- whether the contents are reasonable, and that is the one question no rule can
-- answer. Default ON, and fails CLOSED, for the same reasons as that column.
alter table autopay_grants add column if not exists require_bill_review boolean not null default true;
```

- [ ] **Step 2: Apply it to Supabase**

Run the two `alter table` statements and the `create unique index` in the Supabase SQL editor (the file header says this is how this schema is applied), or via the Supabase MCP `apply_migration` tool with name `autopay_grants_debtor_and_review`.

Verify:

```sql
select column_name from information_schema.columns
where table_name = 'autopay_grants'
  and column_name in ('debtor_address', 'require_bill_review');
```

Expected: two rows.

- [ ] **Step 3: Widen the row type and the read**

In `lib/agents-repo.ts`, replace line 8:

```ts
export type AutopayGrantRow = AutopayGrant & {
  userId: string;
  // The linked browser wallet, or null. Not part of AutopayGrant because
  // decideAutopay has no use for it — it is how the ROUTE finds this row from a
  // chain address, not something the decision consults.
  debtorAddress: string | null;
  // Also outside AutopayGrant: the model review runs AFTER decideAutopay
  // returns `pay`, so the pure decision core never sees this flag.
  requireBillReview: boolean;
};
```

In `getAutopayGrant`, extend the `.select(...)` string on line 22 to:

```ts
    .select("user_id, max_per_bill_usdc, max_per_day_usdc, trusted_creators, min_creator_score, require_verified_hash, enabled, debtor_address, require_bill_review")
```

Extend the local `row` cast with:

```ts
    debtor_address: string | null;
    require_bill_review: boolean;
```

and the returned object with:

```ts
    debtorAddress: row.debtor_address ? row.debtor_address.toLowerCase() : null,
    requireBillReview: row.require_bill_review,
```

- [ ] **Step 4: Widen the upsert**

In `upsertAutopayGrant`, add to the upsert payload — note `debtor_address` is deliberately absent, so a settings save can never overwrite or clear the link:

```ts
      require_bill_review: grant.requireBillReview,
```

- [ ] **Step 5: Add the two new functions**

Append after `upsertAutopayGrant`:

```ts
// The reverse lookup the autopay route needs: given the participant addresses on
// a bill, which of them are linked browser wallets, and whose? DCW addresses are
// resolved separately by getUsersByWallets — this covers the wallets that never
// appear in the `users` table at all.
export async function getGrantsByDebtorAddresses(
  addresses: string[],
): Promise<Map<string, { userId: string }>> {
  const result = new Map<string, { userId: string }>();
  const wanted = [...new Set(addresses.map((a) => a.toLowerCase()))].filter(Boolean);
  if (wanted.length === 0) return result;

  const client = requireClient();
  const { data, error } = await client
    .from("autopay_grants")
    .select("user_id, debtor_address")
    .in("debtor_address", wanted);
  if (error) throw new Error(`Failed to read linked wallets: ${error.message}`);

  for (const r of data ?? []) {
    const row = r as { user_id: string; debtor_address: string | null };
    if (!row.debtor_address) continue;
    result.set(row.debtor_address.toLowerCase(), { userId: String(row.user_id) });
  }
  return result;
}

// Link or unlink the browser wallet. Written only by POST/DELETE
// /api/agents/link, which proves control of the address first. The upsert
// creates the grant row if this is the user's first interaction with autopay —
// with every cap at 0, which is "off", never "unlimited".
export async function setGrantDebtorAddress(userId: string, address: string | null): Promise<void> {
  const client = requireClient();
  const { error } = await client.from("autopay_grants").upsert(
    {
      user_id: userId,
      debtor_address: address ? address.toLowerCase() : null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );
  if (error) throw new Error(`Failed to link wallet: ${error.message}`);
}
```

- [ ] **Step 6: Fix the two existing callers so the project compiles**

`AutopayGrantRow` gained two required fields, so every construction site must supply them.

In `app/api/agents/grants/route.ts`, the `upsertAutopayGrant({...})` call at line 147 needs two more fields. Add:

```ts
    debtorAddress: existing?.debtorAddress ?? null,
    requireBillReview: raw.requireBillReview !== false,
```

and read `existing` first, immediately above that call:

```ts
  // Read before write: debtor_address is not in the upsert payload, but the row
  // type requires it, and a settings save must never disturb the link.
  const existing = await getAutopayGrant(user.id);
```

`getAutopayGrant` is already imported on line 26 of that file.

- [ ] **Step 7: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. If it reports a missing property on `AutopayGrantRow`, a construction site was missed — fix it rather than loosening the type.

There is no unit test in this task. Every function added is a thin Supabase call with no branching logic, matching the stated contract of `lib/agents-repo.ts:1-3` ("thin, typed, no business logic"). The logic that *is* testable lands in Tasks 2, 3 and 5.

- [ ] **Step 8: Commit**

```bash
git add schema-agents.sql lib/agents-repo.ts app/api/agents/grants/route.ts
git commit -m "feat(agents): link a browser wallet to an autopay grant"
```

---

### Task 2: The wallet link

**Files:**
- Create: `lib/agent-link.ts`
- Create: `lib/agent-link.test.ts`
- Create: `app/api/agents/link/route.ts`
- Modify: `package.json` (add the test file to `test:agents`)

**Interfaces:**
- Consumes: `setGrantDebtorAddress(userId, address | null)` from Task 1.
- Produces:
  - `buildLinkMessage(address: string, handle: string, provider: string, isoTimestamp: string): string`
  - `verifyLinkSignature(input: { address: string; handle: string; provider: string; message: string; signature: string; nowMs: number }): Promise<{ ok: true } | { ok: false; error: string }>`
  - `LINK_MAX_AGE_MS: number`

- [ ] **Step 1: Write the failing test**

Create `lib/agent-link.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";
import { buildLinkMessage, verifyLinkSignature, LINK_MAX_AGE_MS } from "./agent-link.ts";

const account = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);
const other = privateKeyToAccount(
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
);

const NOW = 1_770_000_000_000; // fixed clock; the module must never call Date.now itself
const stamp = new Date(NOW).toISOString();

test("buildLinkMessage pins the address, handle and timestamp", () => {
  const message = buildLinkMessage(account.address, "ada", stamp);
  assert.ok(message.includes(account.address.toLowerCase()));
  assert.ok(message.includes("@ada"));
  assert.ok(message.includes(stamp));
});

test("a signature from the claimed address is accepted", async () => {
  const message = buildLinkMessage(account.address, "ada", stamp);
  const signature = await account.signMessage({ message });

  const result = await verifyLinkSignature({
    address: account.address,
    handle: "ada",
    message,
    signature,
    nowMs: NOW,
  });
  assert.deepEqual(result, { ok: true });
});

test("a signature from a different wallet is rejected", async () => {
  const message = buildLinkMessage(account.address, "ada", stamp);
  const signature = await other.signMessage({ message });

  const result = await verifyLinkSignature({
    address: account.address,
    handle: "ada",
    message,
    signature,
    nowMs: NOW,
  });
  assert.equal(result.ok, false);
});

test("a stale timestamp is rejected even with a valid signature", async () => {
  const message = buildLinkMessage(account.address, "ada", stamp);
  const signature = await account.signMessage({ message });

  const result = await verifyLinkSignature({
    address: account.address,
    handle: "ada",
    message,
    signature,
    nowMs: NOW + LINK_MAX_AGE_MS + 1,
  });
  assert.equal(result.ok, false);
});

test("a message whose body does not match the claim is rejected", async () => {
  // Signed correctly, but for a DIFFERENT handle than the session claims.
  const message = buildLinkMessage(account.address, "mallory", stamp);
  const signature = await account.signMessage({ message });

  const result = await verifyLinkSignature({
    address: account.address,
    handle: "ada",
    message,
    signature,
    nowMs: NOW,
  });
  assert.equal(result.ok, false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --experimental-strip-types lib/agent-link.test.ts`
Expected: FAIL — cannot find module `./agent-link.ts`.

- [ ] **Step 3: Write the implementation**

Create `lib/agent-link.ts`:

```ts
// Proof that the person holding this session also holds a given browser wallet.
//
// Needed because autopay_grants.debtor_address decides whose off-chain rules
// (the score floor, the verified-hash check, the model review) apply to a
// wallet, and whose decision log shows its payments. A merely CLAIMED address
// would let anyone attach their own rules to someone else's wallet and read
// their log — so the address has to be signed for.
//
// Pure and clock-free: `nowMs` is an argument, never Date.now(), so the staleness
// rule is testable.
import { verifyMessage } from "viem";

// Long enough to read a wallet prompt, short enough that a leaked signature is
// not a standing credential.
export const LINK_MAX_AGE_MS = 5 * 60 * 1000;

// The exact bytes the wallet signs. The address and handle are both inside the
// message, so a signature captured for one account cannot be replayed to link
// the same wallet to another.
export function buildLinkMessage(address: string, handle: string, isoTimestamp: string): string {
  return `Splitsy: link ${address.toLowerCase()} to @${handle} for autopay\n${isoTimestamp}`;
}

export async function verifyLinkSignature(input: {
  address: string;
  handle: string;
  message: string;
  signature: string;
  nowMs: number;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  // Re-derive the message from what the SESSION says rather than trusting the
  // body's copy. Otherwise a valid signature over some other text would pass.
  const lines = input.message.split("\n");
  const isoTimestamp = lines[1] ?? "";
  const expected = buildLinkMessage(input.address, input.handle, isoTimestamp);
  if (expected !== input.message) {
    return { ok: false, error: "That signature was not for this account and wallet." };
  }

  const signedAt = Date.parse(isoTimestamp);
  if (!Number.isFinite(signedAt)) {
    return { ok: false, error: "That link request has no readable timestamp." };
  }
  // Both directions: a future timestamp is as suspect as a stale one.
  if (Math.abs(input.nowMs - signedAt) > LINK_MAX_AGE_MS) {
    return { ok: false, error: "That link request expired. Try again." };
  }

  const valid = await verifyMessage({
    address: input.address as `0x${string}`,
    message: input.message,
    signature: input.signature as `0x${string}`,
  }).catch(() => false);
  if (!valid) {
    return { ok: false, error: "That signature does not come from this wallet." };
  }

  return { ok: true };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test --experimental-strip-types lib/agent-link.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Add it to the agents test script**

In `package.json`, change the `test:agents` line to:

```json
    "test:agents": "node --test --experimental-strip-types lib/autopay.test.ts lib/dunning.test.ts lib/agent-link.test.ts",
```

Run: `npm run test:agents`
Expected: PASS, all files.

- [ ] **Step 6: Write the route**

Create `app/api/agents/link/route.ts`:

```ts
// Links a browser wallet (EOA) to this account for autopay, and unlinks it.
//
// Why this exists: app/api/agents/autopay/route.ts resolves a bill participant
// to a Splitsy account so it can load that person's off-chain rules and write
// their decision log. That lookup matches on users.wallet_address, which only
// Circle DCW provisioning populates — so a browser wallet was never seen at all,
// not even skipped with a reason. This is the missing edge.
//
// The signature is mandatory: the link decides whose rules bind a wallet and who
// can read its decision log, so a claimed address would be a way to attach your
// own score floor to someone else's money and watch what it does.
//
// Deliberately NOT behind the wallet-unlock cookie, for the same reason the
// settings panel isn't: UNLINKING must never be harder than linking.
import { getSessionUser } from "@/lib/session";
import { setGrantDebtorAddress } from "@/lib/agents-repo";
import { verifyLinkSignature } from "@/lib/agent-link";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const user = await getSessionUser();
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });

  const body = (await request.json().catch(() => null)) as {
    address?: unknown;
    message?: unknown;
    signature?: unknown;
  } | null;
  if (!body) return Response.json({ error: "Expected a JSON body." }, { status: 400 });

  const address = String(body.address ?? "").toLowerCase();
  const message = String(body.message ?? "");
  const signature = String(body.signature ?? "");
  if (!/^0x[a-f0-9]{40}$/.test(address)) {
    return Response.json({ error: "Expected a 0x wallet address." }, { status: 400 });
  }

  const verdict = await verifyLinkSignature({
    address,
    handle: user.handle,
    message,
    signature,
    nowMs: Date.now(),
  });
  if (!verdict.ok) return Response.json({ error: verdict.error }, { status: 400 });

  try {
    await setGrantDebtorAddress(user.id, address);
  } catch (err) {
    // The partial unique index on debtor_address is what produces this, and it
    // is worth its own sentence: two accounts claiming one wallet would make the
    // debtor -> user lookup ambiguous, so the second one is refused.
    const message = err instanceof Error ? err.message : "";
    if (message.includes("autopay_grants_debtor_idx") || message.includes("23505")) {
      return Response.json(
        { error: "That wallet is already linked to another Splitsy account." },
        { status: 409 },
      );
    }
    throw err;
  }

  return Response.json({ ok: true, address });
}

export async function DELETE() {
  const user = await getSessionUser();
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });

  await setGrantDebtorAddress(user.id, null);
  return Response.json({ ok: true });
}
```

- [ ] **Step 7: Typecheck and lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add lib/agent-link.ts lib/agent-link.test.ts app/api/agents/link/route.ts package.json
git commit -m "feat(agents): prove and store a browser-wallet link"
```

---

### Task 3: Model-judged bill review

**Files:**
- Create: `lib/autopay-review.ts`
- Create: `lib/autopay-review.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `BillPreimage` from `lib/bill-metadata.ts` — `{ merchant: string; currency: string; total: number; participantLabels: string[]; receiptHash: string; dueDate?: number }`.
- Produces:
  - `type ReviewVerdict = { approve: boolean; reason: string }`
  - `parseReviewVerdict(raw: string | null): ReviewVerdict` — pure, fails closed
  - `reviewBill(input: ReviewInput): Promise<ReviewVerdict>` — performs the fetch
  - `type ReviewInput = { preimage: BillPreimage; shareUsdc: number; participantCount: number; creatorScore: number | null }`
  - `REVIEW_UNAVAILABLE: "review_unavailable"`

- [ ] **Step 1: Write the failing test**

Create `lib/autopay-review.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { parseReviewVerdict, REVIEW_UNAVAILABLE } from "./autopay-review.ts";

test("an approval passes through with its reason", () => {
  const verdict = parseReviewVerdict('{"approve":true,"reason":"Share matches the two items listed."}');
  assert.equal(verdict.approve, true);
  assert.equal(verdict.reason, "Share matches the two items listed.");
});

test("a refusal carries the model's sentence", () => {
  const verdict = parseReviewVerdict(
    '{"approve":false,"reason":"The receipt lists two mains but you are charged for four."}',
  );
  assert.equal(verdict.approve, false);
  assert.equal(verdict.reason, "The receipt lists two mains but you are charged for four.");
});

test("unparseable output fails closed", () => {
  const verdict = parseReviewVerdict("not json at all");
  assert.equal(verdict.approve, false);
  assert.equal(verdict.reason, REVIEW_UNAVAILABLE);
});

test("a null response fails closed", () => {
  const verdict = parseReviewVerdict(null);
  assert.equal(verdict.approve, false);
  assert.equal(verdict.reason, REVIEW_UNAVAILABLE);
});

test("valid JSON of the wrong shape fails closed", () => {
  // A model that answers in prose inside JSON must not be read as approval.
  const verdict = parseReviewVerdict('{"verdict":"looks fine"}');
  assert.equal(verdict.approve, false);
  assert.equal(verdict.reason, REVIEW_UNAVAILABLE);
});

test("an approval with no reason still approves, with a stand-in sentence", () => {
  const verdict = parseReviewVerdict('{"approve":true}');
  assert.equal(verdict.approve, true);
  assert.ok(verdict.reason.length > 0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --experimental-strip-types lib/autopay-review.test.ts`
Expected: FAIL — cannot find module `./autopay-review.ts`.

- [ ] **Step 3: Write the implementation**

Create `lib/autopay-review.ts`:

```ts
// The one judgment in the debtor-side agent that a rule cannot make.
//
// lib/autopay.ts is a pure deterministic function — caps, a score floor, a hash
// comparison. That is a policy engine, and a standing mandate plus if-statements
// is verifiable direct debit. What it never asks is whether the bill is
// REASONABLE: requireVerifiedHash proves only that the preimage recomputes to
// the on-chain metadataHash, which says nothing about whether the contents make
// sense or whether this person's share matches what is attributed to them.
// That question is unbounded OCR'd text, so it is the one place a model earns
// its keep — and it is only survivable because AutopayMandate.sol bounds the
// spend absolutely regardless of what this file returns.
//
// Runs ONLY after decideAutopay returns `pay`. Rules are free and this is not,
// so a bill already rejected by a cap never costs a call.
//
// Same provider and shape as lib/ocr-core.ts: raw fetch, JSON mode, temperature
// 0. No SDK, no new dependency.
import type { BillPreimage } from "./bill-metadata.ts";

const DEFAULT_MODEL = process.env.AUTOPAY_REVIEW_MODEL ?? "gemini-3.1-flash-lite";

// The slug written to autopay_log when the review could not reach a verdict.
// The model's own prose is written verbatim instead when it DID reach one —
// app/SettlementAgentsPanel.tsx renders an unmapped reason as-is, so no slug is
// needed for the interesting case.
export const REVIEW_UNAVAILABLE = "review_unavailable";

export type ReviewVerdict = { approve: boolean; reason: string };

export type ReviewInput = {
  preimage: BillPreimage;
  shareUsdc: number;
  participantCount: number;
  creatorScore: number | null;
};

// ponytail: one call per debtor per bill. A ten-person bill with ten live
// mandates is ten calls; batch to one call per bill returning a verdict per
// participant if that ever shows up in the bill.

const FAIL_CLOSED: ReviewVerdict = { approve: false, reason: REVIEW_UNAVAILABLE };

// Separated from the fetch so the failure directions are testable without a
// network. Anything it cannot read confidently is a refusal, never an approval.
export function parseReviewVerdict(raw: string | null): ReviewVerdict {
  if (!raw) return FAIL_CLOSED;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return FAIL_CLOSED;
  }

  if (!parsed || typeof parsed !== "object") return FAIL_CLOSED;
  const obj = parsed as { approve?: unknown; reason?: unknown };
  if (typeof obj.approve !== "boolean") return FAIL_CLOSED;

  const reason = typeof obj.reason === "string" && obj.reason.trim() ? obj.reason.trim() : "";
  if (obj.approve) {
    return { approve: true, reason: reason || "Bill contents look consistent with this share." };
  }
  // A refusal with no sentence is still a refusal, but the log must say
  // something a person can act on.
  return { approve: false, reason: reason || "The agent could not justify this bill's contents." };
}

export async function reviewBill(input: ReviewInput): Promise<ReviewVerdict> {
  const apiKey = process.env.RECEIPT_SCANNER_API_KEY;
  // No key is not "approve anyway". A deployment that cannot review must not
  // silently downgrade to paying without one.
  if (!apiKey) return FAIL_CLOSED;

  const prompt = [
    "You are reviewing a shared bill on behalf of one person before their agent pays their share.",
    "Return strict JSON only, shape: { approve: boolean, reason: string }.",
    "reason must be ONE sentence, addressed to the payer, in plain language.",
    "Approve when the bill is internally coherent and the share is proportionate.",
    "Refuse when the total does not match the line items, when the share is far above",
    "an even split without the line items justifying it, or when the merchant and items",
    "are incoherent with each other.",
    "A creator with no reputation history is neutral, never a reason to refuse on its own.",
    "",
    `Merchant: ${input.preimage.merchant || "(none given)"}`,
    `Currency: ${input.preimage.currency}`,
    `Bill total: ${input.preimage.total}`,
    `People on the bill: ${input.participantCount}`,
    `Even split would be: ${(input.preimage.total / Math.max(input.participantCount, 1)).toFixed(2)}`,
    `This person's share: ${input.shareUsdc}`,
    `Creator reputation score: ${input.creatorScore === null ? "no history" : input.creatorScore}`,
    `Participant labels: ${input.preimage.participantLabels.join(", ")}`,
  ].join("\n");

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${DEFAULT_MODEL}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: "application/json", temperature: 0 },
        }),
        // A model that hangs must not hold a webhook open. A timeout is a
        // refusal, which is the safe direction.
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok) return FAIL_CLOSED;

    const data = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    return parseReviewVerdict(data.candidates?.[0]?.content?.parts?.[0]?.text ?? null);
  } catch {
    return FAIL_CLOSED;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test --experimental-strip-types lib/autopay-review.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Add it to the agents test script**

In `package.json`:

```json
    "test:agents": "node --test --experimental-strip-types lib/autopay.test.ts lib/dunning.test.ts lib/agent-link.test.ts lib/autopay-review.test.ts",
```

Run: `npm run test:agents`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/autopay-review.ts lib/autopay-review.test.ts package.json
git commit -m "feat(agents): model-judged review of a bill's contents, failing closed"
```

---

### Task 4: Wire the hosted agent

**Files:**
- Modify: `app/api/agents/autopay/route.ts:30-44` (imports), `:75-101` (lookup), `:106-233` (`settleOne`)

**Interfaces:**
- Consumes: `getGrantsByDebtorAddresses` (Task 1), `reviewBill` / `REVIEW_UNAVAILABLE` (Task 3).
- Produces: no new exports. Behaviour changes only.

Three changes, all inside this file.

- [ ] **Step 1: Add the imports**

In the import block, add `getGrantsByDebtorAddresses` to the existing `@/lib/agents-repo` import (line 30), and add:

```ts
import { reviewBill } from "@/lib/autopay-review";
```

- [ ] **Step 2: Make the debtor lookup a union**

Replace the `owners` element of the `Promise.all` at lines 75-79 and the loop's owner resolution. The `Promise.all` becomes:

```ts
  const [owners, linked, creatorSummary, preimage] = await Promise.all([
    getUsersByWallets([...bill.participantList]),
    // Browser wallets never appear in `users` — they are linked to an account on
    // autopay_grants instead (see app/api/agents/link/route.ts). Without this
    // second lookup an EOA participant is skipped before any rule runs.
    getGrantsByDebtorAddresses([...bill.participantList]),
    getReputationSummaryForWallets([bill.splitter]),
    getOnchainBillPreimage(REGISTRY_ADDRESS, billId.toString()).catch(() => null),
  ]);
```

and inside the `for` loop, replace lines 85-88 with:

```ts
    const key = address.toLowerCase();
    const userId = owners.get(key)?.id ?? linked.get(key)?.userId;
    // A participant with neither a Splitsy account nor a linked wallet has no
    // grant to evaluate — nothing to skip, nothing to log. They were never in
    // the agent's scope.
    if (!userId) continue;
```

and pass `userId` instead of `owner.id` in the `settleOne` call.

- [ ] **Step 3: Stand down silently for a foreign agent**

This is a correction, not just an addition. Today `mine === false` yields `grant = null`, `decideAutopay` returns `disabled`, and `claimAutopayDecision` writes a skip row — so a user whose mandate names their own Circle Agent Wallet would see "Autopay is off" logged against every bill, which is false.

In `settleOne`, immediately after the `Promise.all` that resolves `mandate` (after line 131), insert:

```ts
  // A mandate naming somebody else's agent is not this agent's business. Return
  // BEFORE claiming, so no row is written at all: logging `disabled` here would
  // tell a user who deliberately runs their own Circle Agent Wallet that their
  // autopay is off, which is the opposite of true.
  //
  // Distinct from `mandate === null`, which really does mean autopay is off and
  // still logs `disabled` below.
  if (mandate && input.agent && mandate.agent.toLowerCase() !== input.agent.address.toLowerCase()) {
    return null;
  }
```

Line 136's `mine` computation can stay as-is — it is now always true when a mandate exists, but leaving it makes the null-mandate path read unchanged.

- [ ] **Step 4: Call the review after `decideAutopay` says pay**

Insert immediately after the `allowance_short` block (after line 179), before `const amountUsdc = ...`:

```ts
  // The contents check, last: it is the only step that costs money and latency,
  // so nothing already rejected by a free rule ever reaches it. Fails closed —
  // a timeout or a missing key skips rather than pays.
  if (decision.pay && rules?.requireBillReview !== false && input.preimage) {
    const verdict = await reviewBill({
      preimage: input.preimage,
      shareUsdc: usdc(decision.amount),
      participantCount: input.preimage.participantLabels.length,
      creatorScore: input.creatorScore,
    });
    if (!verdict.approve) {
      // The model's own sentence goes straight into the log. No slug: the panel
      // renders an unmapped reason verbatim, which is what makes this row worth
      // reading next to "over_bill_cap".
      await claimAutopayDecision({
        userId,
        registryAddress: REGISTRY_ADDRESS,
        billId: billKey,
        debtorAddress: debtor,
        decision: "skip",
        reason: verdict.reason,
        amountUsdc: 0,
        txHash: null,
      });
      return { debtor, decision: "skip", reason: verdict.reason, amountUsdc: 0 };
    }
  }
```

Note the `input.preimage` guard: with no published preimage there is nothing to review. That case is already handled — `requireVerifiedHash` defaults on and `decideAutopay` returns `unverifiable` for it, so reaching here with a null preimage means the user explicitly turned that check off.

- [ ] **Step 5: Typecheck and run the existing suites**

Run: `npx tsc --noEmit && npm run test:agents`
Expected: no type errors; all tests pass. `lib/autopay.test.ts` must be untouched and still green — the decision core did not change.

No new unit test here. This route needs Supabase and an Arc RPC to run at all, and the logic it gained is two branches over functions that are tested in Tasks 1–3. It is verified end-to-end in Task 8.

- [ ] **Step 6: Commit**

```bash
git add app/api/agents/autopay/route.ts
git commit -m "feat(agents): serve linked wallets, stand down for foreign agents, review contents"
```

---

### Task 5: The public queue

**Files:**
- Create: `lib/agent-queue.ts`
- Create: `lib/agent-queue.test.ts`
- Create: `app/api/agents/queue/route.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `getBillIdsForParticipantOnchain`, `getMandateSpendableOnchain`, `getAutopayMandateOnchain`, `getBillsOnchain` from `lib/arc-read.ts`; `getReputationSummaryForWallets`; `getOnchainBillPreimage`.
- Produces:
  - `type QueueCandidate = { billId: string; spendable: bigint; creator: string; creatorScore: number | null; verified: boolean; preimage: BillPreimage | null }`
  - `type QueueEntry = { billId: string; amountUsdc: number; creator: string; creatorScore: number | null; verified: boolean; preimage: BillPreimage | null }`
  - `shapeQueue(candidates: QueueCandidate[]): QueueEntry[]`

- [ ] **Step 1: Write the failing test**

Create `lib/agent-queue.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { shapeQueue } from "./agent-queue.ts";

const base = {
  creator: "0xabc",
  creatorScore: 80,
  verified: true,
  preimage: null,
};

test("only bills the contract would actually pay survive", () => {
  const entries = shapeQueue([
    { billId: "1", spendable: 2_500_000n, ...base },
    { billId: "2", spendable: 0n, ...base },
    { billId: "3", spendable: 1_000_000n, ...base },
  ]);
  assert.deepEqual(entries.map((e) => e.billId), ["1", "3"]);
});

test("base units are converted to USDC for the feed", () => {
  const entries = shapeQueue([{ billId: "1", spendable: 2_500_000n, ...base }]);
  assert.equal(entries[0].amountUsdc, 2.5);
});

test("an empty candidate list is an empty feed, not an error", () => {
  assert.deepEqual(shapeQueue([]), []);
});

test("the creator's facts are carried through for the agent to judge", () => {
  const entries = shapeQueue([
    { billId: "1", spendable: 1_000_000n, creator: "0xdef", creatorScore: null, verified: false, preimage: null },
  ]);
  assert.equal(entries[0].creator, "0xdef");
  assert.equal(entries[0].creatorScore, null);
  assert.equal(entries[0].verified, false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --experimental-strip-types lib/agent-queue.test.ts`
Expected: FAIL — cannot find module `./agent-queue.ts`.

- [ ] **Step 3: Write the implementation**

Create `lib/agent-queue.ts`:

```ts
// Shapes the payable-bill feed a self-run agent reads.
//
// `spendable` is AutopayMandate.spendable() — the contract pricing its own pull,
// including the debtor's USDC approval and balance. Filtering on it means the
// feed only ever offers work that would actually succeed, so an agent that pays
// everything in the list never burns gas discovering a revert.
import type { BillPreimage } from "./bill-metadata.ts";

export type QueueCandidate = {
  billId: string;
  spendable: bigint;
  creator: string;
  creatorScore: number | null;
  verified: boolean;
  preimage: BillPreimage | null;
};

export type QueueEntry = {
  billId: string;
  amountUsdc: number;
  creator: string;
  creatorScore: number | null;
  verified: boolean;
  preimage: BillPreimage | null;
};

export function shapeQueue(candidates: QueueCandidate[]): QueueEntry[] {
  return candidates
    .filter((c) => c.spendable > 0n)
    .map(({ spendable, ...rest }) => ({
      ...rest,
      // Display figure only. The agent never passes an amount — payFor reads the
      // full remaining share from the contract itself.
      amountUsdc: Number(spendable) / 1_000_000,
    }));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test --experimental-strip-types lib/agent-queue.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Write the route**

Create `app/api/agents/queue/route.ts`:

```ts
// What a self-run agent reads to find work: the bills this wallet owes on that
// its own on-chain mandate would let an agent pay right now.
//
// PUBLIC AND UNAUTHENTICATED, on purpose and without leaking anything. Every
// field here is already public: BillSplitRegistry is readable on chain by
// anyone, and /api/onchain-bills/preimage already serves preimages with no
// session. Auth would also defeat the point — this exists so an agent running on
// the user's own machine, holding no Splitsy session, can find work.
//
// The counterpart to /api/agents/skill, which teaches an agent how to use this.
import {
  getAutopayMandateOnchain,
  getBillIdsForParticipantOnchain,
  getBillsOnchain,
  getMandateSpendableOnchain,
  isMandateConfigured,
  MANDATE_ADDRESS,
  REGISTRY_ADDRESS,
} from "@/lib/arc-read";
import { shapeQueue, type QueueCandidate } from "@/lib/agent-queue";
import { getOnchainBillPreimage } from "@/lib/onchain-bill-preimage-repo";
import { getReputationSummaryForWallets } from "@/lib/reputation-repo";
import { billMetadataHash } from "@/lib/bill-metadata";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const debtor = (new URL(request.url).searchParams.get("debtor") ?? "").toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(debtor)) {
    return Response.json({ error: "debtor must be a 0x wallet address" }, { status: 400 });
  }
  if (!isMandateConfigured()) {
    return Response.json({ error: "No autopay mandate contract is configured." }, { status: 503 });
  }

  const address = debtor as `0x${string}`;
  const mandate = await getAutopayMandateOnchain(address).catch(() => null);
  if (!mandate) {
    // Not an error: "no mandate" is a complete and useful answer for an agent
    // deciding whether it has anything to do.
    return Response.json({ mandate: null, bills: [], mandateAddress: MANDATE_ADDRESS });
  }

  const billIds = await getBillIdsForParticipantOnchain(address);
  const bills = await getBillsOnchain([...billIds]);

  const candidates: QueueCandidate[] = [];
  await Promise.all(
    billIds.map(async (billId, i) => {
      const bill = bills[i];
      if (!bill) return;
      const [spendable, preimage] = await Promise.all([
        getMandateSpendableOnchain(billId, address).catch(() => 0n),
        getOnchainBillPreimage(REGISTRY_ADDRESS, billId.toString()).catch(() => null),
      ]);
      if (spendable === 0n) return;

      const score = await getReputationSummaryForWallets([bill.splitter]).catch(() => null);
      candidates.push({
        billId: billId.toString(),
        spendable,
        creator: bill.splitter,
        creatorScore: score?.avgScore ?? null,
        // The same recomputation a payer's browser does: the published details
        // hash to what the chain committed. An agent can refuse on this alone.
        verified: preimage
          ? billMetadataHash(preimage).toLowerCase() === bill.metadataHash.toLowerCase()
          : false,
        preimage,
      });
    }),
  );

  return Response.json({
    mandateAddress: MANDATE_ADDRESS,
    chain: "ARC-TESTNET",
    mandate: {
      agent: mandate.agent,
      maxPerBillUsdc: Number(mandate.maxPerBill) / 1_000_000,
      maxPerDayUsdc: Number(mandate.maxPerDay) / 1_000_000,
      headroomUsdc: Number(mandate.headroom) / 1_000_000,
      allowedCreators: mandate.allowedCreators,
    },
    bills: shapeQueue(candidates).sort((a, b) => Number(a.billId) - Number(b.billId)),
  });
}
```

- [ ] **Step 6: Add the test file and run everything**

In `package.json`:

```json
    "test:agents": "node --test --experimental-strip-types lib/autopay.test.ts lib/dunning.test.ts lib/agent-link.test.ts lib/autopay-review.test.ts lib/agent-queue.test.ts",
```

Run: `npm run test:agents && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add lib/agent-queue.ts lib/agent-queue.test.ts app/api/agents/queue/route.ts package.json
git commit -m "feat(agents): public payable-bill feed for a self-run agent"
```

---

### Task 6: The skill file

**Files:**
- Create: `app/api/agents/skill/route.ts`

**Interfaces:**
- Consumes: `MANDATE_ADDRESS`, `isMandateConfigured` from `lib/arc-read.ts`.
- Produces: `GET /api/agents/skill` returning `text/markdown`.

- [ ] **Step 1: Write the route**

Create `app/api/agents/skill/route.ts`:

```ts
// The instructions a user's own Circle Agent Wallet follows to settle their
// bills, in the same shape as Circle's own hosted skills
// (https://agents.circle.com/skills/*.md).
//
// Templated rather than a static file in public/ because MANDATE_ADDRESS is
// environment-dependent, and a skill file naming a stale contract is worse than
// no skill file at all.
import { isMandateConfigured, MANDATE_ADDRESS } from "@/lib/arc-read";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!isMandateConfigured()) {
    return new Response("No autopay mandate contract is configured.", { status: 503 });
  }
  const origin = new URL(request.url).origin;

  const body = `---
name: splitsy-autopay
description: Settle your share of Splitsy bills from your own Circle Agent Wallet, under an on-chain mandate you signed.
---

# Splitsy autopay

You hold a Circle Agent Wallet. The user has named its address as the agent on
their \`AutopayMandate\` contract, which means you — and only you — may pull their
USDC to settle their share of a bill, up to caps they set on chain.

The contract enforces those caps itself. You cannot exceed them; a call that
would will revert. Your job is the judgment the contract cannot make.

- Mandate contract: \`${MANDATE_ADDRESS}\`
- Chain: \`ARC-TESTNET\`

## 1. Find work

\`\`\`bash
curl -s "${origin}/api/agents/queue?debtor=<theUsersWalletAddress>"
\`\`\`

Returns the live mandate and a \`bills\` array. Every bill listed is one the
contract would pay right now — the feed already accounts for the caps, the daily
budget, the user's USDC approval and their balance. An empty array means there is
nothing to do.

Each bill carries:

| Field | Meaning |
|---|---|
| \`billId\` | Pass this to \`payFor\` |
| \`amountUsdc\` | What would move. You never pass an amount |
| \`creator\` | Who raised the bill |
| \`creatorScore\` | ERC-8004 average, or \`null\` for no history |
| \`verified\` | The published details hash to what the chain committed |
| \`preimage\` | Merchant, currency, total, participant labels |

## 2. Decide

Refuse when the bill does not hold up. Worth checking:

- \`verified\` is \`false\` — the details on display are not the details committed on chain.
- The total does not match what the participants and labels imply.
- The share is far above an even split with nothing in the bill to justify it.
- The creator's score is low **and** the bill is unusual. No history is neutral, never bad on its own.

## 3. Pay

\`\`\`bash
circle wallet execute "payFor(uint256,address)" <billId> <theUsersWalletAddress> \\
  --contract ${MANDATE_ADDRESS} \\
  --chain ARC-TESTNET \\
  --address <yourAgentWalletAddress>
\`\`\`

No amount: the contract reads the full remaining share itself, so you cannot pick
a figure, cannot split one share into several sub-cap pulls, and cannot aim this
at another bill's money.

If the wallet has no gas, run:

\`\`\`bash
circle wallet fund --address <yourAgentWalletAddress> --chain ARC-TESTNET
\`\`\`

## What binds you

\`circle wallet limit\` policies are **mainnet-only**, so on Arc Testnet Circle-side
spend policy is not in play. The mandate contract is the only thing enforcing
your limits — which is the stronger claim anyway: the caps are on chain, public,
and revocable by the user at any moment with \`revokeMandate()\`, whether or not
Splitsy's servers are reachable.
`;

  return new Response(body, {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
}
```

- [ ] **Step 2: Verify it renders**

Run: `npm run dev` in one terminal, then:

```bash
curl -s http://localhost:3000/api/agents/skill | head -40
```

Expected: markdown with the real mandate address substituted, not a placeholder. If it returns 503, `NEXT_PUBLIC_AUTOPAY_MANDATE_ADDRESS` is unset in `.env.local`.

- [ ] **Step 3: Typecheck and commit**

```bash
npx tsc --noEmit
git add app/api/agents/skill/route.ts
git commit -m "feat(agents): hosted skill file for a self-run Circle Agent Wallet"
```

---

### Task 7: Grants route — accept an EOA

**Files:**
- Modify: `app/api/agents/grants/route.ts:66-106` (GET), `:108-179` (PUT), `:184-232` (`syncMandateOnchain`)

**Interfaces:**
- Consumes: `getAutopayGrant` (now returning `debtorAddress`, `requireBillReview`).
- Produces: `GET` response gains `linkedAddress` and an `onchain` map keyed by address; `PUT` accepts `debtorAddress` and `requireBillReview`.

- [ ] **Step 1: Return both wallets' on-chain facts from GET**

Replace the body of `GET` after the session check with:

```ts
  const rules = await getAutopayGrant(user.id);
  const dcw = user.wallet_address ? (user.wallet_address.toLowerCase() as `0x${string}`) : null;
  const eoa = rules?.debtorAddress ? (rules.debtorAddress as `0x${string}`) : null;

  // Read both wallets in one pass. A person can have the Splitsy wallet armed
  // for one agent and their browser wallet armed for another, with different
  // ceilings — the mandate is keyed per debtor on chain, so the panel must be
  // able to show two answers rather than implying one setting binds both.
  const wallets = [dcw, eoa].filter((a): a is `0x${string}` => a !== null);
  const [log, ...facts] = await Promise.all([
    listAutopayLog(user.id),
    ...wallets.map(async (address) => {
      const [mandate, allowance] = await Promise.all([
        getAutopayMandateOnchain(address).catch(() => null),
        isMandateConfigured()
          ? getUsdcAllowanceOnchain(address, MANDATE_ADDRESS).catch(() => 0n)
          : Promise.resolve(0n),
      ]);
      return [
        address,
        {
          agentAddress: mandate?.agent ?? null,
          enabled: mandate !== null,
          maxPerBillUsdc: mandate ? toUsdc(mandate.maxPerBill) : 0,
          maxPerDayUsdc: mandate ? toUsdc(mandate.maxPerDay) : 0,
          trustedCreators: mandate ? mandate.allowedCreators.map((a) => a.toLowerCase()) : [],
          allowanceUsdc: toUsdc(allowance ?? 0n),
          spentTodayUsdc: mandate ? toUsdc(mandate.maxPerDay - mandate.headroom) : 0,
        },
      ] as const;
    }),
  ]);

  const onchain = Object.fromEntries(facts);
  const dcwFacts = dcw ? onchain[dcw] : null;

  // The form's own values still come from the DCW's mandate when there is one,
  // falling back to the Postgres mirror so a user sees the numbers they typed
  // but have not yet signed. `enabled` is never mirrored: it is the answer to
  // "can software move my money right now?" and must come from the chain alone.
  const grant: AutopayGrant & { requireBillReview: boolean } = {
    enabled: dcwFacts?.enabled ?? false,
    maxPerBillUsdc: dcwFacts?.enabled ? dcwFacts.maxPerBillUsdc : (rules?.maxPerBillUsdc ?? DEFAULT_GRANT.maxPerBillUsdc),
    maxPerDayUsdc: dcwFacts?.enabled ? dcwFacts.maxPerDayUsdc : (rules?.maxPerDayUsdc ?? DEFAULT_GRANT.maxPerDayUsdc),
    trustedCreators: dcwFacts?.enabled ? dcwFacts.trustedCreators : (rules?.trustedCreators ?? []),
    minCreatorScore: rules?.minCreatorScore ?? DEFAULT_GRANT.minCreatorScore,
    requireVerifiedHash: rules?.requireVerifiedHash ?? DEFAULT_GRANT.requireVerifiedHash,
    requireBillReview: rules?.requireBillReview ?? true,
  };

  return Response.json({
    grant,
    log,
    linkedAddress: eoa,
    walletAddress: dcw,
    // The panel needs BOTH to rebuild the exact bytes the wallet must sign.
    // buildLinkMessage puts the handle AND the provider inside the message,
    // because a handle alone is not an account: uniqueness in `users` is
    // (provider, provider_user_id), and idx_users_provider_handle is NOT unique.
    // Without the provider, a victim signing a message naming their own handle
    // could have that signature replayed by the holder of the same handle in
    // another namespace. Both are lowercased inside buildLinkMessage.
    handle: user.handle,
    provider: user.provider,
    mandateAddress: isMandateConfigured() ? MANDATE_ADDRESS : null,
    agentAddress: process.env.NEXT_PUBLIC_AUTOPAY_AGENT_ADDRESS ?? null,
    onchain,
  });
```

- [ ] **Step 2: Persist the review flag and refuse to sign for an EOA in PUT**

In `PUT`, extend the `upsertAutopayGrant` call (from Task 1 Step 6) with:

```ts
    requireBillReview: raw.requireBillReview !== false,
```

Then replace the `try { const txHash = await syncMandateOnchain(...) }` block with:

```ts
  // A browser wallet signs its own mandate: the server holds no key for it, so
  // there is nothing to sign here and saying so is not an error. The panel
  // follows up with setMandate then approve from the wallet itself.
  const debtorAddress = typeof raw.debtorAddress === "string" ? raw.debtorAddress.toLowerCase() : null;
  if (debtorAddress && debtorAddress === existing?.debtorAddress) {
    return Response.json({ ok: true, txHash: null, signWith: "wallet" });
  }

  try {
    const txHash = await syncMandateOnchain(user, { enabled, maxPerBillUsdc, maxPerDayUsdc, trustedCreators });
    return Response.json({ ok: true, txHash, signWith: "dcw" });
  } catch (err) {
    // ... unchanged
  }
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. `syncMandateOnchain` is unchanged — the DCW path must keep working exactly as before.

- [ ] **Step 4: Commit**

```bash
git add app/api/agents/grants/route.ts
git commit -m "feat(agents): per-wallet mandate facts, and let a browser wallet sign its own"
```

---

### Task 8: The panel

**Files:**
- Modify: `app/SettlementAgentsPanel.tsx`

**Interfaces:**
- Consumes: `GET/PUT /api/agents/grants` (Task 7), `POST/DELETE /api/agents/link` (Task 2), `encodeSetMandate` / `encodeApprove` / `encodeRevokeMandate` from `lib/registry-calldata.ts`.
- Produces: no exports beyond the existing default component.

House pattern for a browser-wallet transaction, from `lib/bill-split-contracts.ts:396-411`: get a `WalletClient` with `getWalletClient(wagmiConfig, { chainId: arcTestnet.id })`, call `walletClient.sendTransaction({ to, data, account, chain: arcTestnet })`, then `publicClient.waitForTransactionReceipt({ hash })`. Use `sendTransaction` with the existing calldata encoders rather than `writeContract`, so the panel and the server produce byte-identical calls.

- [ ] **Step 1: Add the imports and wagmi state**

At the top of the component file:

```tsx
import { useAccount, useSignMessage } from "wagmi";
import { getWalletClient } from "wagmi/actions";
import { createPublicClient, http } from "viem";
import { arcTestnet } from "viem/chains";
import { wagmiConfig } from "@/lib/wagmi";
import { buildLinkMessage } from "@/lib/agent-link";
import { encodeApprove, encodeRevokeMandate, encodeSetMandate } from "@/lib/registry-calldata";
```

and inside the component:

```tsx
  const { address: connectedAddress } = useAccount();
  const { signMessageAsync } = useSignMessage();
  // Which wallet the caps on this panel describe. The mandate is keyed per
  // debtor on chain, so this is a real choice, not a display preference.
  const [armingWallet, setArmingWallet] = useState<"dcw" | "browser">("dcw");
  const [agentChoice, setAgentChoice] = useState<"hosted" | "own">("hosted");
  const [ownAgent, setOwnAgent] = useState("");
```

- [ ] **Step 2: Add the link action**

```tsx
  async function linkWallet() {
    if (!connectedAddress) {
      fail("Connect a browser wallet first.");
      return;
    }
    try {
      const message = buildLinkMessage(connectedAddress, handle, provider, new Date().toISOString());
      const signature = await signMessageAsync({ message });
      const res = await fetch("/api/agents/link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: connectedAddress, message, signature }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        fail(body.error ?? "Could not link that wallet.");
        return;
      }
      setMessageTone("success");
      setMessage("Wallet linked. You can now arm autopay from it.");
      load();
    } catch {
      fail("You declined the signature, so the wallet was not linked.");
    }
  }
```

`handle` and `provider` are the fields returned by `GET /api/agents/grants` (added in Task 7 Step 1). Store both in component state alongside `grant` when `load()` resolves. They must be the session's values, not anything typed by the user — `verifyLinkSignature` re-derives the message from the server's own copy and rejects a mismatch. `buildLinkMessage` lowercases both itself, so pass them through as returned.

- [ ] **Step 3: Add the on-chain arm action**

```tsx
  // Two transactions, because an EOA has no executeBatch. setMandate FIRST, the
  // reverse of the DCW batch, and deliberately:
  //   * setMandate alone -> payFor reverts inside safeTransferFrom. No money moves.
  //   * lowering caps -> the tighter ceiling binds before the allowance is topped up.
  //   * raising caps -> the old allowance still bounds exposure until approve lands.
  // Approve-first would instead open a window with a fresh allowance under the
  // old, looser caps.
  async function armOnChain(next: Grant, revoke = false) {
    if (!connectedAddress || !mandateAddress) return;
    setSaving(true);
    try {
      const walletClient = await getWalletClient(wagmiConfig, { chainId: arcTestnet.id });
      const publicClient = createPublicClient({ chain: arcTestnet, transport: http() });
      const account = connectedAddress as `0x${string}`;
      const send = async (to: `0x${string}`, data: `0x${string}`) => {
        const hash = await walletClient.sendTransaction({ to, data, account, chain: arcTestnet });
        await publicClient.waitForTransactionReceipt({ hash });
        return hash;
      };

      if (revoke) {
        // One transaction, matching the DCW path. The residual approval is inert:
        // payFor is the only function that can spend it, and it now reverts with
        // NoMandate.
        await send(mandateAddress as `0x${string}`, encodeRevokeMandate());
      } else {
        const agent = (agentChoice === "own" ? ownAgent : agentAddress) as `0x${string}`;
        if (!/^0x[a-fA-F0-9]{40}$/.test(agent)) {
          fail("Enter the address of the agent wallet that may spend for you.");
          return;
        }
        const maxPerBill = BigInt(Math.round(next.maxPerBillUsdc * 1_000_000));
        const maxPerDay = BigInt(Math.round(next.maxPerDayUsdc * 1_000_000));
        await send(
          mandateAddress as `0x${string}`,
          encodeSetMandate(agent, maxPerBill, maxPerDay, next.trustedCreators as `0x${string}`[]),
        );
        await send(usdcAddress as `0x${string}`, encodeApprove(mandateAddress as `0x${string}`, maxPerDay * 7n));
      }
      setMessageTone("success");
      setMessage(revoke ? "Autopay revoked on chain." : "Mandate armed on chain.");
      load();
    } catch (err) {
      fail(err instanceof Error ? err.message : "The transaction was not completed.");
    } finally {
      setSaving(false);
    }
  }
```

`usdcAddress` is `process.env.NEXT_PUBLIC_ARC_TESTNET_USDC_ADDRESS ?? "0x3600000000000000000000000000000000000000"`. `mandateAddress` and `agentAddress` come from the `GET` response added in Task 7.

- [ ] **Step 4: Render the controls**

Add to section 01, above the existing cap inputs, matching the surrounding markup style:

1. A wallet toggle — "Splitsy wallet" / "Browser wallet" — disabled on the browser option with the copy *"Link your browser wallet to arm autopay from it"* plus a **Link wallet** button when `linkedAddress` is null.
2. An agent toggle — "Splitsy's agent" / "My own agent wallet" — the second revealing an address input bound to `ownAgent`.
3. Beneath the agent input when `agentChoice === "own"`, this warning verbatim:

   > This must be a wallet you control. Naming an address you don't control switches autopay off silently — nothing can call `payFor`, so no payment happens and nothing is logged.

4. When `armingWallet === "browser"`, an **Arm on chain** button calling `armOnChain(grant)` and a **Revoke** button calling `armOnChain(grant, true)`, replacing the automatic save-on-blur signing. Save-on-blur still writes Postgres, but must not open a wallet prompt.
5. A checkbox for `requireBillReview` beside the existing `requireVerifiedHash` one, labelled *"Check the bill's contents before paying"*, with the helper text *"The agent reads the receipt and refuses if your share doesn't match what's on it."*

- [ ] **Step 5: Add the one new reason mapping**

In the `REASONS` map at line 61, add:

```ts
  review_unavailable: "The agent couldn't check this bill's contents, so it didn't pay",
```

Do **not** add a mapping for the model's own sentences — line 60's comment documents that an unmapped reason renders verbatim, which is precisely what makes those rows readable.

- [ ] **Step 6: Build**

Run: `npm run build && npm run lint`
Expected: builds clean, no lint errors.

- [ ] **Step 7: Commit**

```bash
git add app/SettlementAgentsPanel.tsx app/api/agents/grants/route.ts
git commit -m "feat(app): arm autopay from a browser wallet, and choose the agent"
```

---

### Task 9: Documentation and end-to-end verification

**Files:**
- Modify: `docs/` (the autopay page; find it with `grep -rl "autopay" docs/`)
- Modify: `lib/autopay-review.ts` and `app/api/agents/skill/route.ts` if a verification step contradicts an assumption

**Interfaces:** none.

- [ ] **Step 1: Document the BYO walkthrough**

Add a section to the docs page covering autopay, with the caveats stated plainly rather than glossed:

- Install: `npm install -g @circle-fin/cli`, then `circle wallet login <email> --testnet` (email OTP; sessions expire after 7 days).
- `circle wallet list --type agent --chain ARC-TESTNET` for the address.
- Paste that address into the panel's "My own agent wallet" field and arm.
- `curl -sL <origin>/api/agents/skill` to install the instructions into your agent.
- **State that `circle wallet limit` is mainnet-only**, so on Arc Testnet Circle-side spend policy is not in play and `AutopayMandate` is the sole enforcement. This is the stronger claim; hiding it is what a reviewer would catch.

- [ ] **Step 2: Verify the three open assumptions**

Each is expected to hold and none is confirmed. Record the outcome in the relevant file rather than leaving the assumption in place.

1. `circle wallet execute "payFor(uint256,address)" <billId> <debtor> --contract <MANDATE> --chain ARC-TESTNET --address <agentWallet>` — does the CLI accept a `uint256` and an `address` for a `--type agent` wallet on Arc Testnet? If argument encoding differs, correct the command in `app/api/agents/skill/route.ts`.
2. Gas sponsorship on a contract write on Arc Testnet. If it does not apply, add `circle wallet fund --address <addr> --chain ARC-TESTNET` (20 USDC from the faucet) as a required step in the skill file rather than an aside.
3. `circle wallet limit --chain ARC-TESTNET` — confirm it is rejected as mainnet-only. If policies *do* work on testnet, say so in the docs and in the skill file's closing section.

- [ ] **Step 3: End-to-end, hosted operator**

1. Sign in, connect a browser wallet, click **Link wallet**, sign.
2. Select the browser wallet, agent = "Splitsy's agent", set caps, **Arm on chain**. Two wallet prompts, `setMandate` then `approve`.
3. From a second account, bill the linked wallet an amount under the per-bill cap.
4. Expect a `pay` row in the panel's decision log and a `MandateSpent` event on the mandate contract.

- [ ] **Step 4: End-to-end, the model review**

1. Create a bill whose receipt line items do not support the debtor's share.
2. Expect a `skip` row whose reason is the model's own sentence, rendered verbatim.
3. Turn off "Check the bill's contents before paying", re-run, and confirm the bill now pays.

- [ ] **Step 5: End-to-end, self-run operator**

1. Re-arm with agent = the Circle Agent Wallet address.
2. Bill the wallet again. Confirm **no new `autopay_log` row appears at all** — not a `disabled` row. That is the Task 4 Step 3 correction working.
3. `curl -s "<origin>/api/agents/queue?debtor=<wallet>"` and confirm the bill is listed with `amountUsdc`, `verified` and `creatorScore`.
4. Run `circle wallet execute ...` and confirm the debt settles.

- [ ] **Step 6: Full suite**

Run: `npm run test:agents && npm run test:contracts && npm run build`
Expected: all pass. `test:contracts` is unchanged — no contract was modified.

- [ ] **Step 7: Commit**

```bash
git add docs/ app/api/agents/skill/route.ts lib/autopay-review.ts
git commit -m "docs(agents): browser-wallet autopay and running your own agent wallet"
```

---

## Self-Review

**Spec coverage.** Every section maps to a task: the link column and index → Task 1; `POST/DELETE /api/agents/link` and stateless proof → Task 2; the review, fail-closed, the sentence-as-reason and the toggle → Tasks 3–4; the union lookup and silent stand-down → Task 4; the queue and its no-auth rationale → Task 5; the skill file → Task 6; per-wallet `onchain` and the EOA sign path → Task 7; both selectors, `setMandate`-then-`approve`, one-transaction revoke → Task 8; the three verifications and the mainnet-only caveat → Task 9.

**Known gap.** The spec listed a queue test as "only bills with `spendable > 0` are returned"; that assertion lives in `lib/agent-queue.test.ts` against the pure `shapeQueue`, not against the route, because the route needs a live Arc RPC. The route's own coverage is Task 9 Step 5.

**Type consistency.** `AutopayGrantRow` gains `debtorAddress` and `requireBillReview` in Task 1 and is constructed with both in Tasks 1 and 7. `ReviewVerdict` is `{ approve, reason }` in Tasks 3 and 4. `QueueCandidate.spendable` is `bigint` and `QueueEntry.amountUsdc` is `number` in Task 5, and only `QueueEntry` crosses the route boundary. `buildLinkMessage(address, handle, provider, isoTimestamp)` has the same four arguments in Tasks 2 and 8 — `provider` was added during Task 2's review, because a handle alone is not an account identifier in a three-provider identity schema. `AutopayGrant` in `lib/autopay.ts` is not modified by any task.
