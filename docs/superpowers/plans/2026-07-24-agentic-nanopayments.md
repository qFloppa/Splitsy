# Agentic Nanopayments (Scout) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add "Scout", an autonomous agent that pays for Splitsy's own OCR/FX endpoints in USDC fractions via Circle Nanopayments (x402) on Arc, with an on-chain ERC-8004 identity, driven by image-quality + parse-confidence + budget signals.

**Architecture:** Splitsy's `/api/ocr` and `/api/fx` become x402 sellers (wrapped by a `withGateway` HOF using `BatchFacilitatorClient`). A new `/api/scout/scan` route runs Scout server-side on upload: it assesses the image, then pays its own OCR endpoint over HTTP via `GatewayClient.pay()` from a server-held EOA, retries once for a second opinion if confidence is low and budget remains, pays FX if the currency isn't USD, and records every nanopayment. A dashboard panel shows earnings (seller) and Scout's spend/budget (buyer).

**Tech Stack:** Next.js 16 (App Router), React 19, viem 2.52, `@circle-fin/x402-batching`, Supabase (`@supabase/supabase-js`), `node --test --experimental-strip-types` for tests.

## Global Constraints

- **This is NOT the Next.js you know.** Before writing any route/handler code, read the relevant guide under `node_modules/next/dist/docs/` and heed deprecation notices (per `AGENTS.md`).
- Package manager / module type: ESM (`"type": "module"`). Node `--experimental-strip-types` runs `.ts` directly; imports use `@/` alias and `.ts`-less specifiers per existing code.
- Tests: `node --test --experimental-strip-types <file>`; colocate as `*.test.ts`. No test framework beyond `node:test` + `node:assert`.
- Arc Testnet constants (verbatim): network CAIP-2 `eip155:5042002`; USDC `0x3600000000000000000000000000000000000000`; Gateway Wallet `0x0077777d7EBA4688BDeF3E311b846F25870A19B9`; RPC `https://rpc.testnet.arc.network`; ERC-8004 IdentityRegistry `0x8004A818BFB912233c491871b3d84c89A494BD9e`.
- USDC is 6 decimals (ERC-20) / 18 decimals (native gas). Payment `amount` is atomic 6-dp string.
- x402 requirement `extra`: `{ name: "GatewayWalletBatched", version: "1", verifyingContract: <gateway> }`, `scheme: "exact"`, `maxTimeoutSeconds: 345600`.
- Headers: base64 `PAYMENT-REQUIRED` (on 402), `payment-signature` (buyer retry), `PAYMENT-RESPONSE` (on success).
- Secrets live in `.env.local` only (`.env.example` is gitignored repo-wide). New env: `SCOUT_PRIVATE_KEY`, `SELLER_ADDRESS`, `SCOUT_DAILY_CAP_USDC`, `SCOUT_ERC8004_TOKEN_ID`, `NEXT_PUBLIC_BASE_URL`.
- Never break the human upload UX: if the paid path errors, fall back to a direct internal parse.
- Reuse: `lib/snapsplit.ts` (`normalizeParsedBill`, `ParsedBill`), `lib/supabase.ts` (`createSupabaseServerClient`), `lib/erc8004.ts` patterns, `app/DashboardPanel.tsx`, recharts chart primitives.

---

## File Structure

- `lib/x402/constants.ts` — Arc x402 constants (one responsibility: config).
- `lib/x402/seller.ts` — `withGateway(handler, price, endpoint)` HOF (seller verify/settle + record).
- `lib/x402/payments-repo.ts` — insert payment events, sum today's spend.
- `lib/x402/spend.ts` + `lib/x402/spend.test.ts` — pure spend-cap math (testable).
- `lib/ocr-core.ts` — `parseReceipt(imageBase64, mimeType, opts)` extracted from the current `/api/ocr` route.
- `lib/scout/decide.ts` + `lib/scout/decide.test.ts` — pure decision functions (the graded logic).
- `lib/scout/wallet.ts` — `GatewayClient` factory + `ensureGatewayBalance`.
- `lib/scout/scan.ts` + `lib/scout/scan.test.ts` — orchestrator (assess → pay OCR → maybe re-pay → pay FX → record), dependency-injected for tests.
- `app/api/ocr/route.ts` — MODIFY: JSON body + `withGateway`.
- `app/api/fx/route.ts` — MODIFY: `withGateway`.
- `app/api/scout/scan/route.ts` — NEW: multipart upload → orchestrator.
- `app/api/scout/stats/route.ts` — NEW: dashboard stats.
- `app/AgentEconomyPanel.tsx` — NEW: earnings + budget panel.
- `app/DashboardPanel.tsx` — MODIFY: mount the panel.
- `app/HomeClient.tsx` — MODIFY: upload → `/api/scout/scan`; show Scout identity card.
- `scripts/scout-setup.ts` — NEW: generate EOA, register ERC-8004, initial Gateway deposit.
- `schema-x402-payments.sql` — NEW: Supabase table.

---

## Task 1: Install deps + Arc x402 constants

**Files:**
- Modify: `package.json` (add `@circle-fin/x402-batching`)
- Create: `lib/x402/constants.ts`

**Interfaces:**
- Produces: `ARC_TESTNET_NETWORK`, `ARC_TESTNET_USDC`, `ARC_TESTNET_GATEWAY_WALLET`, `ARC_TESTNET_RPC`, `ARC_IDENTITY_REGISTRY` (string consts); `usdToAtomic(price: string): string`.

- [ ] **Step 1: Install the SDK**

Run: `npm install @circle-fin/x402-batching@^2.0.4`
Expected: added to `dependencies`, `npm install` exits 0.

- [ ] **Step 2: Write the constants module**

```ts
// lib/x402/constants.ts
export const ARC_TESTNET_NETWORK = "eip155:5042002" as const;
export const ARC_TESTNET_USDC = "0x3600000000000000000000000000000000000000" as const;
export const ARC_TESTNET_GATEWAY_WALLET = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9" as const;
export const ARC_TESTNET_RPC = "https://rpc.testnet.arc.network" as const;
export const ARC_IDENTITY_REGISTRY = "0x8004A818BFB912233c491871b3d84c89A494BD9e" as const;

/** "$0.005" -> "5000" (atomic 6-dp USDC string). */
export function usdToAtomic(price: string): string {
  const dollars = parseFloat(price.replace("$", ""));
  if (!Number.isFinite(dollars) || dollars < 0) throw new Error(`Invalid price: ${price}`);
  return Math.round(dollars * 1_000_000).toString();
}
```

- [ ] **Step 3: Commit**

`git add package.json package-lock.json lib/x402/constants.ts && git commit -m "feat(x402): SDK + Arc nanopayments constants"`

---

## Task 2: Pure spend-cap math

**Files:**
- Create: `lib/x402/spend.ts`, `lib/x402/spend.test.ts`

**Interfaces:**
- Produces: `canSpend(spentTodayUsd: number, nextUsd: number, dailyCapUsd: number): boolean`; `remainingBudget(spentTodayUsd: number, dailyCapUsd: number): number`.

- [ ] **Step 1: Write the failing test**

```ts
// lib/x402/spend.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { canSpend, remainingBudget } from "./spend.ts";

test("canSpend allows when under cap", () => {
  assert.equal(canSpend(0.01, 0.005, 0.05), true);
});
test("canSpend blocks when next would exceed cap", () => {
  assert.equal(canSpend(0.048, 0.005, 0.05), false);
});
test("canSpend allows exact fit to cap", () => {
  assert.equal(canSpend(0.045, 0.005, 0.05), true);
});
test("remainingBudget never negative", () => {
  assert.equal(remainingBudget(0.06, 0.05), 0);
  assert.equal(remainingBudget(0.02, 0.05), 0.03);
});
```

- [ ] **Step 2: Run, expect FAIL** — `node --test --experimental-strip-types lib/x402/spend.test.ts` → "Cannot find module './spend.ts'".

- [ ] **Step 3: Implement**

```ts
// lib/x402/spend.ts
// Money compared in atomic cents to dodge float drift at the cap boundary.
const atom = (usd: number) => Math.round(usd * 1_000_000);

export function canSpend(spentTodayUsd: number, nextUsd: number, dailyCapUsd: number): boolean {
  return atom(spentTodayUsd) + atom(nextUsd) <= atom(dailyCapUsd);
}
export function remainingBudget(spentTodayUsd: number, dailyCapUsd: number): number {
  return Math.max(0, (atom(dailyCapUsd) - atom(spentTodayUsd)) / 1_000_000);
}
```

- [ ] **Step 4: Run, expect PASS.** Then commit: `git add lib/x402/spend.* && git commit -m "feat(x402): spend-cap math + tests"`

---

## Task 3: Scout decision core (the graded logic)

**Files:**
- Create: `lib/scout/decide.ts`, `lib/scout/decide.test.ts`

**Interfaces:**
- Consumes: nothing (pure).
- Produces:
  - `assessImage(bytes: number, width: number, height: number): { ok: boolean; reason?: string }`
  - `CONFIDENCE_THRESHOLD = 0.8`
  - `shouldPayAgain(confidence: number, canAfford: boolean): boolean`
  - `pickBetterParse<T extends { confidence: number }>(a: T, b: T): T`

- [ ] **Step 1: Write the failing test**

```ts
// lib/scout/decide.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { assessImage, shouldPayAgain, pickBetterParse, CONFIDENCE_THRESHOLD } from "./decide.ts";

test("assessImage rejects tiny files", () => {
  assert.equal(assessImage(2_000, 1000, 1000).ok, false);
});
test("assessImage rejects tiny dimensions", () => {
  assert.equal(assessImage(500_000, 80, 80).ok, false);
});
test("assessImage accepts a real photo", () => {
  assert.equal(assessImage(500_000, 1200, 1600).ok, true);
});
test("shouldPayAgain only when low confidence AND affordable", () => {
  assert.equal(shouldPayAgain(CONFIDENCE_THRESHOLD - 0.1, true), true);
  assert.equal(shouldPayAgain(CONFIDENCE_THRESHOLD - 0.1, false), false);
  assert.equal(shouldPayAgain(CONFIDENCE_THRESHOLD + 0.1, true), false);
});
test("pickBetterParse takes higher confidence", () => {
  assert.equal(pickBetterParse({ confidence: 0.6 }, { confidence: 0.9 }).confidence, 0.9);
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement**

```ts
// lib/scout/decide.ts
// Scout's autonomous decision logic. Pure so the graded behavior is fully testable.
export const CONFIDENCE_THRESHOLD = 0.8;

const MIN_BYTES = 8 * 1024;   // < 8KB is almost certainly not a legible receipt
const MIN_EDGE = 200;         // px; below this OCR is a waste of a payment

export function assessImage(bytes: number, width: number, height: number): { ok: boolean; reason?: string } {
  if (bytes < MIN_BYTES) return { ok: false, reason: "Image too small to read — use a clearer photo." };
  if (width < MIN_EDGE || height < MIN_EDGE) return { ok: false, reason: "Image resolution too low to read." };
  return { ok: true };
}

export function shouldPayAgain(confidence: number, canAfford: boolean): boolean {
  return confidence < CONFIDENCE_THRESHOLD && canAfford;
}

export function pickBetterParse<T extends { confidence: number }>(a: T, b: T): T {
  return b.confidence > a.confidence ? b : a;
}
```

- [ ] **Step 4: Run, expect PASS.** Commit: `git add lib/scout/decide.* && git commit -m "feat(scout): autonomous decision core + tests"`

---

## Task 4: x402 payments table + repo

**Files:**
- Create: `schema-x402-payments.sql`, `lib/x402/payments-repo.ts`

**Interfaces:**
- Produces:
  - `type X402Direction = "earned" | "spent"`
  - `recordPayment(p: { direction: X402Direction; endpoint: string; counterparty: string; amountUsdc: string; gatewayTx: string | null; billRef?: string | null; confidence?: number | null }): Promise<void>`
  - `sumSpentTodayUsd(): Promise<number>`
  - `getAgentStats(): Promise<{ earnedUsd: number; spentUsd: number; callsServed: number; callsPaid: number }>`

- [ ] **Step 1: Write the schema**

```sql
-- schema-x402-payments.sql  (run in Supabase SQL editor)
create table if not exists x402_payments (
  id           bigint generated always as identity primary key,
  direction    text not null check (direction in ('earned','spent')),
  endpoint     text not null,
  counterparty text not null,
  amount_usdc  numeric(20,6) not null,
  gateway_tx   text,
  bill_ref     text,
  confidence   numeric(4,3),
  created_at   timestamptz not null default now()
);
create index if not exists x402_payments_created_idx on x402_payments (created_at desc);
create index if not exists x402_payments_dir_idx on x402_payments (direction, created_at desc);
```

- [ ] **Step 2: Apply it** — run the SQL in Supabase (or via the supabase MCP `apply_migration`). Verify the table exists.

- [ ] **Step 3: Implement the repo**

```ts
// lib/x402/payments-repo.ts
import { createSupabaseServerClient } from "@/lib/supabase";

export type X402Direction = "earned" | "spent";

export async function recordPayment(p: {
  direction: X402Direction;
  endpoint: string;
  counterparty: string;
  amountUsdc: string;
  gatewayTx: string | null;
  billRef?: string | null;
  confidence?: number | null;
}): Promise<void> {
  const supabase = createSupabaseServerClient();
  if (!supabase) return; // no-DB dev mode: skip silently
  const { error } = await supabase.from("x402_payments").insert({
    direction: p.direction,
    endpoint: p.endpoint,
    counterparty: p.counterparty,
    amount_usdc: p.amountUsdc,
    gateway_tx: p.gatewayTx,
    bill_ref: p.billRef ?? null,
    confidence: p.confidence ?? null,
  });
  if (error) console.error("[x402] recordPayment failed:", error.message);
}

export async function sumSpentTodayUsd(): Promise<number> {
  const supabase = createSupabaseServerClient();
  if (!supabase) return 0;
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  const { data, error } = await supabase
    .from("x402_payments")
    .select("amount_usdc")
    .eq("direction", "spent")
    .gte("created_at", since.toISOString());
  if (error || !data) return 0;
  return data.reduce((sum, r) => sum + Number(r.amount_usdc), 0);
}

export async function getAgentStats() {
  const supabase = createSupabaseServerClient();
  if (!supabase) return { earnedUsd: 0, spentUsd: 0, callsServed: 0, callsPaid: 0 };
  const { data } = await supabase.from("x402_payments").select("direction, amount_usdc");
  const rows = data ?? [];
  return {
    earnedUsd: rows.filter((r) => r.direction === "earned").reduce((s, r) => s + Number(r.amount_usdc), 0),
    spentUsd: rows.filter((r) => r.direction === "spent").reduce((s, r) => s + Number(r.amount_usdc), 0),
    callsServed: rows.filter((r) => r.direction === "earned").length,
    callsPaid: rows.filter((r) => r.direction === "spent").length,
  };
}
```

- [ ] **Step 4: Commit** — `git add schema-x402-payments.sql lib/x402/payments-repo.ts && git commit -m "feat(x402): payments ledger table + repo"`

---

## Task 5: Extract OCR parse core

**Files:**
- Create: `lib/ocr-core.ts`
- Modify: `app/api/ocr/route.ts:1-104` (extract logic, keep behavior for now)

**Interfaces:**
- Produces: `parseReceipt(imageBase64: string, mimeType: string, opts?: { hq?: boolean }): Promise<ParsedBill>` (throws `Error` with a human message on failure). `hq: true` raises rigor for the second-opinion pass.

- [ ] **Step 1: Implement the core** (lift the fetch + prompt from the current route; `hq` swaps in a stricter prompt and a re-check instruction)

```ts
// lib/ocr-core.ts
import { normalizeParsedBill, type ParsedBill } from "@/lib/snapsplit";

const MODEL = process.env.RECEIPT_SCANNER_MODEL ?? "receipt-scanner-model";

export async function parseReceipt(imageBase64: string, mimeType: string, opts?: { hq?: boolean }): Promise<ParsedBill> {
  const apiKey = process.env.RECEIPT_SCANNER_API_KEY;
  if (!apiKey) throw new Error("Missing RECEIPT_SCANNER_API_KEY on the server.");

  const prompt = [
    "Extract this receipt or bill into strict JSON only.",
    "Return this shape: { merchant, currency, subtotal, tax, tip, total, lineItems, confidence, notes }.",
    "lineItems must be an array of { description, quantity, amount }.",
    "Use ISO 4217 currency codes. Use numbers for money, not strings.",
    "confidence is 0..1 for how sure you are the extraction is correct.",
    opts?.hq
      ? "Be extra rigorous: re-read totals digit by digit, verify lineItems sum near the subtotal, and lower confidence if anything is ambiguous."
      : "If a field is missing, use 0 or an empty string and explain uncertainty in notes.",
  ].join(" ");

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        contents: [{ parts: [{ inline_data: { mime_type: mimeType, data: imageBase64 } }, { text: prompt }] }],
        generationConfig: { responseMimeType: "application/json", temperature: 0 },
      }),
    },
  );
  const payload = await res.json();
  if (!res.ok) throw new Error(payload?.error?.message ?? "Receipt scan failed.");

  const text = payload?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? "").join("").trim();
  if (!text) throw new Error("The receipt scanner returned no bill data.");
  return normalizeParsedBill(JSON.parse(stripJsonFences(text)));
}

function stripJsonFences(v: string) {
  return v.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "");
}
```

- [ ] **Step 2: Point the existing route at the core** — keep it working end-to-end (multipart in, base64 to core). Replace the body of `app/api/ocr/route.ts`'s handler with a call to `parseReceipt`. (Task 6 re-shapes this route into a JSON x402 seller; here we only prove the extraction is behavior-preserving.)

```ts
// app/api/ocr/route.ts  (interim)
import { parseReceipt } from "@/lib/ocr-core";
export const runtime = "nodejs";
const MAX_INLINE_BYTES = 12 * 1024 * 1024;

export async function POST(request: Request) {
  const form = await request.formData();
  const file = form.get("image");
  if (!(file instanceof File)) return Response.json({ error: "Upload a bill image." }, { status: 400 });
  if (!file.type.startsWith("image/")) return Response.json({ error: "The uploaded file must be an image." }, { status: 400 });
  if (file.size > MAX_INLINE_BYTES) return Response.json({ error: "Image is too large for inline OCR." }, { status: 400 });
  try {
    const b64 = Buffer.from(await file.arrayBuffer()).toString("base64");
    return Response.json({ bill: await parseReceipt(b64, file.type) });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "Receipt scan failed." }, { status: 502 });
  }
}
```

- [ ] **Step 3: Verify** — `npx next build` (or `npm run dev` + manual upload) still parses a receipt. Commit: `git add lib/ocr-core.ts app/api/ocr/route.ts && git commit -m "refactor(ocr): extract parseReceipt core"`

---

## Task 6: x402 seller HOF + wrap OCR & FX

**Files:**
- Create: `lib/x402/seller.ts`
- Modify: `app/api/ocr/route.ts` (JSON body + `withGateway`), `app/api/fx/route.ts` (`withGateway`)

**Interfaces:**
- Consumes: `ARC_TESTNET_*`, `usdToAtomic` (Task 1); `recordPayment` (Task 4).
- Produces: `withGateway(handler: (req: Request) => Promise<Response>, price: string, endpoint: string): (req: Request) => Promise<Response>`.

- [ ] **Step 1: Implement the HOF** (adapted from `circlefin/arc-nanopayments` `lib/x402.ts`; records via our repo)

```ts
// lib/x402/seller.ts
import { BatchFacilitatorClient } from "@circle-fin/x402-batching/server";
import { ARC_TESTNET_NETWORK, ARC_TESTNET_USDC, ARC_TESTNET_GATEWAY_WALLET, usdToAtomic } from "./constants";
import { recordPayment } from "./payments-repo";

const facilitator = new BatchFacilitatorClient();
const sellerAddress = process.env.SELLER_ADDRESS as `0x${string}`;

function requirementsFor(price: string) {
  return {
    scheme: "exact" as const,
    network: ARC_TESTNET_NETWORK,
    asset: ARC_TESTNET_USDC,
    amount: usdToAtomic(price),
    payTo: sellerAddress,
    maxTimeoutSeconds: 345600,
    extra: { name: "GatewayWalletBatched", version: "1", verifyingContract: ARC_TESTNET_GATEWAY_WALLET },
  };
}

export function withGateway(handler: (req: Request) => Promise<Response>, price: string, endpoint: string) {
  const requirements = requirementsFor(price);
  return async (req: Request): Promise<Response> => {
    const sig = req.headers.get("payment-signature");
    if (!sig) {
      const challenge = {
        x402Version: 2,
        resource: { url: endpoint, description: `Paid resource (${price} USDC)`, mimeType: "application/json" },
        accepts: [requirements],
      };
      return new Response(JSON.stringify({}), {
        status: 402,
        headers: { "Content-Type": "application/json", "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(challenge)).toString("base64") },
      });
    }
    try {
      const payload = JSON.parse(Buffer.from(sig, "base64").toString("utf-8"));
      const verify = await facilitator.verify(payload, requirements);
      if (!verify.isValid) return Response.json({ error: "Payment verification failed", reason: verify.invalidReason }, { status: 402 });
      const settle = await facilitator.settle(payload, requirements);
      if (!settle.success) return Response.json({ error: "Payment settlement failed", reason: settle.errorReason }, { status: 402 });

      const payer = settle.payer ?? verify.payer ?? "unknown";
      await recordPayment({
        direction: "earned", endpoint, counterparty: payer,
        amountUsdc: (Number(requirements.amount) / 1e6).toString(), gatewayTx: settle.transaction ?? null,
      });

      const response = await handler(req);
      response.headers.set("PAYMENT-RESPONSE", Buffer.from(JSON.stringify({ success: true, transaction: settle.transaction, network: requirements.network, payer })).toString("base64"));
      return response;
    } catch (e) {
      return Response.json({ error: "Payment processing error", message: e instanceof Error ? e.message : String(e) }, { status: 500 });
    }
  };
}
```

- [ ] **Step 2: Re-shape `/api/ocr` as a JSON seller** (Scout sends `{ imageBase64, mimeType, hq? }`)

```ts
// app/api/ocr/route.ts
import { parseReceipt } from "@/lib/ocr-core";
import { withGateway } from "@/lib/x402/seller";
export const runtime = "nodejs";

const handler = async (req: Request): Promise<Response> => {
  const { imageBase64, mimeType, hq } = (await req.json()) as { imageBase64?: string; mimeType?: string; hq?: boolean };
  if (!imageBase64 || !mimeType) return Response.json({ error: "imageBase64 and mimeType required." }, { status: 400 });
  try {
    return Response.json({ bill: await parseReceipt(imageBase64, mimeType, { hq }) });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "Receipt scan failed." }, { status: 502 });
  }
};
export const POST = withGateway(handler, "$0.005", "/api/ocr");
```

- [ ] **Step 3: Wrap `/api/fx`** — keep its existing JSON handler body; export it wrapped.

```ts
// app/api/fx/route.ts  — rename the existing `export async function POST` to `const handler = async (request: Request) => {...}` (unchanged body), then:
import { withGateway } from "@/lib/x402/seller";
export const POST = withGateway(handler, "$0.001", "/api/fx");
```

- [ ] **Step 4: Verify** — with `SELLER_ADDRESS` set, `curl -s -X POST localhost:3000/api/fx -d '{}'` returns HTTP 402 with a `PAYMENT-REQUIRED` header. Commit: `git add lib/x402/seller.ts app/api/ocr/route.ts app/api/fx/route.ts && git commit -m "feat(x402): paywall OCR + FX as nanopayment sellers"`

---

## Task 7: Scout wallet (buyer)

**Files:**
- Create: `lib/scout/wallet.ts`

**Interfaces:**
- Consumes: `ARC_TESTNET_*` (Task 1).
- Produces:
  - `getScout(): { gateway: GatewayClient; address: `0x${string}` }` (memoized singleton from `SCOUT_PRIVATE_KEY`)
  - `ensureGatewayBalance(minAtomic?: bigint): Promise<void>` (deposit `DEPOSIT_AMOUNT` if available balance is below threshold)

- [ ] **Step 1: Implement**

```ts
// lib/scout/wallet.ts
import { GatewayClient } from "@circle-fin/x402-batching/client";
import { privateKeyToAccount } from "viem/accounts";

let cached: { gateway: GatewayClient; address: `0x${string}` } | null = null;

export function getScout() {
  if (cached) return cached;
  const pk = process.env.SCOUT_PRIVATE_KEY as `0x${string}` | undefined;
  if (!pk) throw new Error("Missing SCOUT_PRIVATE_KEY — run scripts/scout-setup.ts");
  cached = { gateway: new GatewayClient({ chain: "arcTestnet", privateKey: pk }), address: privateKeyToAccount(pk).address };
  return cached;
}

const REDEPOSIT_THRESHOLD = 500_000n; // 0.5 USDC atomic
const DEPOSIT_AMOUNT = process.env.SCOUT_DEPOSIT_AMOUNT ?? "1";

export async function ensureGatewayBalance(minAtomic: bigint = REDEPOSIT_THRESHOLD): Promise<void> {
  const { gateway } = getScout();
  const balances = await gateway.getBalances();
  if (balances.gateway.available < minAtomic) {
    await gateway.deposit(DEPOSIT_AMOUNT); // one-time-ish; fast on Arc
  }
}
```

- [ ] **Step 2: Verify it type-checks** — `npx tsc --noEmit` clean for this file (ignore pre-existing repo TS noise). Commit: `git add lib/scout/wallet.ts && git commit -m "feat(scout): Gateway buyer wallet + balance top-up"`

---

## Task 8: Scout orchestrator

**Files:**
- Create: `lib/scout/scan.ts`, `lib/scout/scan.test.ts`

**Interfaces:**
- Consumes: `assessImage`, `shouldPayAgain`, `pickBetterParse` (Task 3); `canSpend`, `remainingBudget` (Task 2); `ParsedBill`.
- Produces:
  - `type ScanDeps = { pay: (path: string, body: unknown) => Promise<{ result: any; amountUsd: number; tx: string | null }>; parseDirect: (b64: string, mime: string, hq?: boolean) => Promise<ParsedBill>; spentTodayUsd: () => Promise<number>; record: (d: "spent", endpoint: string, amountUsd: number, tx: string | null, confidence?: number) => Promise<void>; dailyCapUsd: number }`
  - `type ScanResult = { bill: ParsedBill | null; declined?: string; payments: { endpoint: string; amountUsd: number; tx: string | null; confidence?: number }[]; totalSpentUsd: number; budgetRemainingUsd: number; degraded: boolean }`
  - `runScout(input: { imageBase64: string; mimeType: string; bytes: number; width: number; height: number }, deps: ScanDeps): Promise<ScanResult>`

- [ ] **Step 1: Write the failing test** (fakes for all deps — no network, no chain)

```ts
// lib/scout/scan.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { runScout } from "./scan.ts";
import { emptyParsedBill } from "@/lib/snapsplit";

const img = { imageBase64: "x", mimeType: "image/jpeg", bytes: 500_000, width: 1200, height: 1600 };
function deps(overrides = {}) {
  const payments: any[] = [];
  return {
    payments,
    dailyCapUsd: 0.05,
    spentTodayUsd: async () => 0,
    record: async () => {},
    parseDirect: async () => ({ ...emptyParsedBill, confidence: 0.99 }),
    pay: async (path: string) => ({
      result: { bill: { ...emptyParsedBill, merchant: "Cafe", total: 10, confidence: path.includes("ocr") ? 0.95 : 1 } },
      amountUsd: path.includes("ocr") ? 0.005 : 0.001, tx: "0xtx",
    }),
    ...overrides,
  };
}

test("declines a garbage image without paying", async () => {
  const d = deps();
  const r = await runScout({ ...img, bytes: 100 }, d as any);
  assert.equal(r.bill, null);
  assert.ok(r.declined);
  assert.equal(r.payments.length, 0);
});

test("pays once for a high-confidence scan (USD → no FX)", async () => {
  const r = await runScout(img, deps() as any);
  assert.equal(r.payments.length, 1);
  assert.equal(r.bill?.merchant, "Cafe");
  assert.ok(r.totalSpentUsd > 0);
});

test("pays twice when first confidence is low and budget allows", async () => {
  let call = 0;
  const d = deps({
    pay: async (path: string) => {
      call++;
      const confidence = path.includes("ocr") ? (call === 1 ? 0.5 : 0.9) : 1;
      return { result: { bill: { ...emptyParsedBill, total: 10, confidence } }, amountUsd: path.includes("ocr") ? 0.005 : 0.001, tx: "0xtx" };
    },
  });
  const r = await runScout(img, d as any);
  assert.equal(r.payments.filter((p) => p.endpoint === "/api/ocr").length, 2);
  assert.equal(r.bill?.confidence, 0.9);
});

test("stops at budget cap and flags degraded=false but no second pay", async () => {
  const d = deps({ spentTodayUsd: async () => 0.049, pay: async () => ({ result: { bill: { ...require("@/lib/snapsplit").emptyParsedBill, total: 10, confidence: 0.4 } }, amountUsd: 0.005, tx: "0xtx" }) });
  const r = await runScout(img, d as any);
  assert.equal(r.payments.length, 1); // couldn't afford the second pass
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement**

```ts
// lib/scout/scan.ts
import { assessImage, shouldPayAgain, pickBetterParse } from "./decide";
import { canSpend, remainingBudget } from "@/lib/x402/spend";
import type { ParsedBill } from "@/lib/snapsplit";

export type ScanDeps = {
  pay: (path: string, body: unknown) => Promise<{ result: any; amountUsd: number; tx: string | null }>;
  parseDirect: (b64: string, mime: string, hq?: boolean) => Promise<ParsedBill>;
  spentTodayUsd: () => Promise<number>;
  record: (d: "spent", endpoint: string, amountUsd: number, tx: string | null, confidence?: number) => Promise<void>;
  dailyCapUsd: number;
};
export type ScanPayment = { endpoint: string; amountUsd: number; tx: string | null; confidence?: number };
export type ScanResult = {
  bill: ParsedBill | null; declined?: string;
  payments: ScanPayment[]; totalSpentUsd: number; budgetRemainingUsd: number; degraded: boolean;
};

const OCR_PRICE = 0.005;
const FX_PRICE = 0.001;

export async function runScout(
  input: { imageBase64: string; mimeType: string; bytes: number; width: number; height: number },
  deps: ScanDeps,
): Promise<ScanResult> {
  const payments: ScanPayment[] = [];
  let spent = await deps.spentTodayUsd();
  const budget = () => remainingBudget(spent, deps.dailyCapUsd);

  // Signal 1: image quality — decline without spending.
  const quality = assessImage(input.bytes, input.width, input.height);
  if (!quality.ok) return { bill: null, declined: quality.reason, payments, totalSpentUsd: 0, budgetRemainingUsd: budget(), degraded: false };

  // Signal 3: budget gate before the first pay.
  if (!canSpend(spent, OCR_PRICE, deps.dailyCapUsd)) {
    // Degrade: parse directly (unpaid) so the human UX still works.
    const bill = await deps.parseDirect(input.imageBase64, input.mimeType).catch(() => null);
    return { bill, declined: bill ? undefined : "Scout budget exhausted and fallback failed.", payments, totalSpentUsd: 0, budgetRemainingUsd: 0, degraded: true };
  }

  let bill: ParsedBill;
  try {
    const first = await deps.pay("/api/ocr", { imageBase64: input.imageBase64, mimeType: input.mimeType });
    bill = first.result.bill as ParsedBill;
    spent += first.amountUsd;
    payments.push({ endpoint: "/api/ocr", amountUsd: first.amountUsd, tx: first.tx, confidence: bill.confidence });
    await deps.record("spent", "/api/ocr", first.amountUsd, first.tx, bill.confidence);
  } catch {
    // Degrade: paid path failed → direct parse so the user is never blocked.
    const fallback = await deps.parseDirect(input.imageBase64, input.mimeType).catch(() => null);
    return { bill: fallback, declined: fallback ? undefined : "Scan failed.", payments, totalSpentUsd: 0, budgetRemainingUsd: budget(), degraded: true };
  }

  // Signal 2: confidence — pay again for a second opinion if affordable.
  if (shouldPayAgain(bill.confidence, canSpend(spent, OCR_PRICE, deps.dailyCapUsd))) {
    try {
      const second = await deps.pay("/api/ocr", { imageBase64: input.imageBase64, mimeType: input.mimeType, hq: true });
      const better = pickBetterParse(bill, second.result.bill as ParsedBill);
      spent += second.amountUsd;
      payments.push({ endpoint: "/api/ocr", amountUsd: second.amountUsd, tx: second.tx, confidence: (second.result.bill as ParsedBill).confidence });
      await deps.record("spent", "/api/ocr", second.amountUsd, second.tx, (second.result.bill as ParsedBill).confidence);
      bill = better;
    } catch { /* keep first parse */ }
  }

  // Foreign currency → pay FX (second seller) if affordable.
  if (bill.currency && bill.currency !== "USD" && canSpend(spent, FX_PRICE, deps.dailyCapUsd)) {
    try {
      const fx = await deps.pay("/api/fx", { amount: bill.total, fromCurrency: bill.currency });
      spent += fx.amountUsd;
      payments.push({ endpoint: "/api/fx", amountUsd: fx.amountUsd, tx: fx.tx });
      await deps.record("spent", "/api/fx", fx.amountUsd, fx.tx);
    } catch { /* FX optional */ }
  }

  return { bill, payments, totalSpentUsd: payments.reduce((s, p) => s + p.amountUsd, 0), budgetRemainingUsd: budget(), degraded: false };
}
```

- [ ] **Step 4: Run, expect PASS.** Commit: `git add lib/scout/scan.* && git commit -m "feat(scout): confidence+budget-driven scan orchestrator + tests"`

---

## Task 9: `/api/scout/scan` route (wire buyer → seller)

**Files:**
- Create: `app/api/scout/scan/route.ts`

**Interfaces:**
- Consumes: `runScout` (Task 8), `getScout`/`ensureGatewayBalance` (Task 7), `parseReceipt` (Task 5), `sumSpentTodayUsd`/`recordPayment` (Task 4), `getScout().address`.
- Produces: HTTP `POST` accepting multipart `image`; returns `{ bill, payments, totalSpentUsd, budgetRemainingUsd, degraded, agent: { address, tokenId } }` or `{ declined }`.

- [ ] **Step 1: Implement** — the route bridges Scout's `pay` to `GatewayClient.pay` against Splitsy's own origin, and reads image dimensions cheaply from the JPEG/PNG header (fallback: skip dimension gate if unreadable).

```ts
// app/api/scout/scan/route.ts
import { runScout, type ScanDeps } from "@/lib/scout/scan";
import { getScout, ensureGatewayBalance } from "@/lib/scout/wallet";
import { parseReceipt } from "@/lib/ocr-core";
import { sumSpentTodayUsd, recordPayment } from "@/lib/x402/payments-repo";
import { imageSize } from "@/lib/image-size"; // tiny header reader (Step 2)

export const runtime = "nodejs";
const MAX_INLINE_BYTES = 12 * 1024 * 1024;
const DAILY_CAP = Number(process.env.SCOUT_DAILY_CAP_USDC ?? "0.05");

export async function POST(request: Request) {
  const form = await request.formData();
  const file = form.get("image");
  if (!(file instanceof File) || !file.type.startsWith("image/")) return Response.json({ error: "Upload a bill image." }, { status: 400 });
  if (file.size > MAX_INLINE_BYTES) return Response.json({ error: "Image too large." }, { status: 400 });

  const buf = Buffer.from(await file.arrayBuffer());
  const b64 = buf.toString("base64");
  const dims = imageSize(buf) ?? { width: 9999, height: 9999 }; // unknown → don't block on dimensions

  const base = process.env.NEXT_PUBLIC_BASE_URL ?? new URL(request.url).origin;
  const { gateway, address } = getScout();
  await ensureGatewayBalance().catch(() => {}); // best-effort top-up

  const deps: ScanDeps = {
    dailyCapUsd: DAILY_CAP,
    spentTodayUsd: sumSpentTodayUsd,
    parseDirect: (b, m, hq) => parseReceipt(b, m, { hq }),
    record: (dir, endpoint, amountUsd, tx, confidence) =>
      recordPayment({ direction: dir, endpoint, counterparty: address, amountUsdc: amountUsd.toString(), gatewayTx: tx, confidence }),
    pay: async (path, body) => {
      const r = await gateway.pay(`${base}${path}`, { method: "POST", body });
      // GatewayClient.pay returns { formattedAmount, data|response, txHash? }; normalize:
      const result = (r as any).data ?? (r as any).response ?? r;
      return { result, amountUsd: parseFloat((r as any).formattedAmount ?? "0"), tx: (r as any).txHash ?? (r as any).transaction ?? null };
    },
  };

  const out = await runScout({ imageBase64: b64, mimeType: file.type, bytes: file.size, width: dims.width, height: dims.height }, deps);
  return Response.json({ ...out, agent: { address, tokenId: process.env.SCOUT_ERC8004_TOKEN_ID ?? null } });
}
```

- [ ] **Step 2: Add the tiny image-size reader** (avoid a dependency — read JPEG SOF0/PNG IHDR headers; return null if unknown)

```ts
// lib/image-size.ts
// ponytail: minimal header parse for JPEG + PNG only — enough for the quality gate.
// Returns null when unknown; callers must treat null as "don't block on dimensions".
export function imageSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length > 24 && buf.toString("ascii", 12, 16) === "IHDR") {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }; // PNG
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) { // JPEG: scan for SOF marker
    let o = 2;
    while (o + 9 < buf.length) {
      if (buf[o] !== 0xff) { o++; continue; }
      const marker = buf[o + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buf.readUInt16BE(o + 5), width: buf.readUInt16BE(o + 7) };
      }
      o += 2 + buf.readUInt16BE(o + 2);
    }
  }
  return null;
}
```

- [ ] **Step 3: Verify** — `npx next build` compiles the new route. Commit: `git add app/api/scout/scan/route.ts lib/image-size.ts && git commit -m "feat(scout): /api/scout/scan wires buyer to own seller endpoints"`

---

## Task 10: Scout setup script (EOA + ERC-8004 + deposit)

**Files:**
- Create: `scripts/scout-setup.ts`
- Modify: `package.json` (add `scout:setup` script)

**Interfaces:**
- Consumes: `ARC_TESTNET_RPC`, `ARC_IDENTITY_REGISTRY` (Task 1).
- Produces: prints `SCOUT_PRIVATE_KEY`, `SCOUT_ADDRESS`, and (after funding) registers ERC-8004 and prints `SCOUT_ERC8004_TOKEN_ID`.

- [ ] **Step 1: Implement** (generate key if absent; register identity; deposit). Registration uses the canonical IdentityRegistry `register(string)` via viem.

```ts
// scripts/scout-setup.ts
import { createWalletClient, createPublicClient, http, parseAbi } from "viem";
import { arcTestnet } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { GatewayClient } from "@circle-fin/x402-batching/client";
import { ARC_TESTNET_RPC, ARC_IDENTITY_REGISTRY } from "../lib/x402/constants.ts";

const pk = (process.env.SCOUT_PRIVATE_KEY as `0x${string}`) ?? generatePrivateKey();
const account = privateKeyToAccount(pk);
console.log("SCOUT_PRIVATE_KEY=", pk);
console.log("SCOUT_ADDRESS=", account.address);
console.log("→ Fund this address with Arc Testnet USDC: https://faucet.circle.com/ then re-run.");

const publicClient = createPublicClient({ chain: arcTestnet, transport: http(ARC_TESTNET_RPC) });
const balance = await publicClient.getBalance({ address: account.address });
if (balance === 0n) { console.log("No balance yet — fund and re-run to register + deposit."); process.exit(0); }

const wallet = createWalletClient({ account, chain: arcTestnet, transport: http(ARC_TESTNET_RPC) });
const META = process.env.SCOUT_METADATA_URI ?? "ipfs://bafkreibdi6623n3xpf7ymk62ckb4bo75o3qemwkpfvp5i25j66itxvsoei";
const hash = await wallet.writeContract({ address: ARC_IDENTITY_REGISTRY, abi: parseAbi(["function register(string) returns (uint256)"]), functionName: "register", args: [META] });
const receipt = await publicClient.waitForTransactionReceipt({ hash });
console.log("ERC-8004 register tx:", receipt.transactionHash, "— read the minted tokenId from the Transfer log and set SCOUT_ERC8004_TOKEN_ID.");

const gateway = new GatewayClient({ chain: "arcTestnet", privateKey: pk });
const dep = await gateway.deposit(process.env.SCOUT_DEPOSIT_AMOUNT ?? "1");
console.log("Gateway deposit tx:", dep.depositTxHash);
console.log("Gateway balance:", (await gateway.getBalances()).gateway.formattedAvailable);
```

- [ ] **Step 2: Add the npm script** — in `package.json` scripts: `"scout:setup": "node --experimental-strip-types --env-file=.env.local scripts/scout-setup.ts"`.

- [ ] **Step 3: Run once** — `npm run scout:setup`, paste keys into `.env.local`, fund the address, re-run to register + deposit. Record `SCOUT_ERC8004_TOKEN_ID`. Commit (code only, never `.env.local`): `git add scripts/scout-setup.ts package.json && git commit -m "feat(scout): setup script (EOA, ERC-8004 register, Gateway deposit)"`

---

## Task 11: Wire the UI upload through Scout + identity card

**Files:**
- Modify: `app/HomeClient.tsx:605-648` (upload → `/api/scout/scan`); add a small Scout card near the OCR result.

**Interfaces:**
- Consumes: `/api/scout/scan` response `{ bill, payments, totalSpentUsd, budgetRemainingUsd, degraded, declined, agent }`.

- [ ] **Step 1: Repoint the scan fetch** — replace the `/api/ocr` call in the upload handler with `/api/scout/scan` (same multipart `formData`), and handle the new shape:

```tsx
// app/HomeClient.tsx — inside the upload handler (was lines ~609-624)
const response = await fetch("/api/scout/scan", { method: "POST", body: formData });
const payload = await response.json();
if (!response.ok || payload.declined || !payload.bill) {
  setOcrState("error");
  setError(payload.declined ?? payload.error ?? "Receipt scan failed.");
  return;
}
const parsed = normalizeParsedBill(payload.bill);
setBill(parsed);
setScoutReport(payload); // new state: { payments, totalSpentUsd, budgetRemainingUsd, degraded, agent }
setManualBillEntry(false);
setOcrState("ready");
```

- [ ] **Step 2: Add `scoutReport` state + a compact card** near the parsed-bill UI, showing: agent address (link to `https://testnet.arcscan.app/address/<address>`), ERC-8004 token id, each nanopayment (amount + tx link), total spent, budget remaining, and a "degraded (unpaid fallback)" note when `degraded`.

```tsx
// near other useState calls
const [scoutReport, setScoutReport] = useState<null | {
  payments: { endpoint: string; amountUsd: number; tx: string | null; confidence?: number }[];
  totalSpentUsd: number; budgetRemainingUsd: number; degraded: boolean;
  agent: { address: string; tokenId: string | null };
}>(null);
```

```tsx
// render block (place under the OCR result)
{scoutReport && (
  <div className="rounded-lg border p-3 text-sm">
    <div className="font-medium">Scanned by Scout · agent{" "}
      <a className="underline" href={`https://testnet.arcscan.app/address/${scoutReport.agent.address}`} target="_blank" rel="noreferrer">
        {scoutReport.agent.address.slice(0, 6)}…{scoutReport.agent.address.slice(-4)}
      </a>
      {scoutReport.agent.tokenId ? ` · ERC-8004 #${scoutReport.agent.tokenId}` : ""}
    </div>
    <ul className="mt-1 space-y-0.5">
      {scoutReport.payments.map((p, i) => (
        <li key={i}>
          Paid {p.amountUsd.toFixed(3)} USDC → {p.endpoint}
          {p.confidence != null ? ` (confidence ${(p.confidence * 100).toFixed(0)}%)` : ""}
          {p.tx ? <> · <a className="underline" href={`https://testnet.arcscan.app/tx/${p.tx}`} target="_blank" rel="noreferrer">tx</a></> : null}
        </li>
      ))}
    </ul>
    <div className="mt-1 text-muted-foreground">
      Spent {scoutReport.totalSpentUsd.toFixed(3)} USDC · budget left {scoutReport.budgetRemainingUsd.toFixed(3)} USDC
      {scoutReport.degraded ? " · fell back to unpaid scan" : ""}
    </div>
  </div>
)}
```

- [ ] **Step 3: Verify** — `npm run dev`, upload a receipt, confirm the split fills and the Scout card shows ≥1 payment with a tx link. Commit: `git add app/HomeClient.tsx && git commit -m "feat(scout): route uploads through Scout + agent identity card"`

---

## Task 12: Agent-economy dashboard panel

**Files:**
- Create: `app/api/scout/stats/route.ts`, `app/AgentEconomyPanel.tsx`
- Modify: `app/DashboardPanel.tsx` (mount the panel)

**Interfaces:**
- Consumes: `getAgentStats` (Task 4), `SCOUT_DAILY_CAP_USDC`.
- Produces: `GET /api/scout/stats` → `{ earnedUsd, spentUsd, callsServed, callsPaid, budgetRemainingUsd }`.

- [ ] **Step 1: Stats endpoint**

```ts
// app/api/scout/stats/route.ts
import { getAgentStats, sumSpentTodayUsd } from "@/lib/x402/payments-repo";
import { remainingBudget } from "@/lib/x402/spend";
export const runtime = "nodejs";
export async function GET() {
  const stats = await getAgentStats();
  const cap = Number(process.env.SCOUT_DAILY_CAP_USDC ?? "0.05");
  return Response.json({ ...stats, budgetRemainingUsd: remainingBudget(await sumSpentTodayUsd(), cap) });
}
```

- [ ] **Step 2: Panel component** — four stat tiles (earned, spent, calls served, budget left). Match the existing dashboard card styling; fetch on mount with the same pattern used elsewhere in `DashboardPanel`.

```tsx
// app/AgentEconomyPanel.tsx
"use client";
import { useEffect, useState } from "react";
import { Card } from "@/components/ui/card";

type Stats = { earnedUsd: number; spentUsd: number; callsServed: number; callsPaid: number; budgetRemainingUsd: number };
const tiles = (s: Stats) => [
  { label: "Earned (x402)", value: `${s.earnedUsd.toFixed(3)} USDC`, sub: `${s.callsServed} calls served` },
  { label: "Scout spent", value: `${s.spentUsd.toFixed(3)} USDC`, sub: `${s.callsPaid} calls paid` },
  { label: "Budget left today", value: `${s.budgetRemainingUsd.toFixed(3)} USDC`, sub: "daily cap" },
  { label: "Net", value: `${(s.earnedUsd - s.spentUsd).toFixed(3)} USDC`, sub: "earned − spent" },
];

export default function AgentEconomyPanel() {
  const [stats, setStats] = useState<Stats | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => fetch("/api/scout/stats").then((r) => r.json()).then((s) => live && setStats(s)).catch(() => {});
    load();
    const t = setInterval(load, 5000);
    return () => { live = false; clearInterval(t); };
  }, []);
  if (!stats) return null;
  return (
    <Card className="p-4">
      <h3 className="mb-3 text-sm font-medium">Agent economy</h3>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {tiles(stats).map((t) => (
          <div key={t.label}>
            <div className="text-xs text-muted-foreground">{t.label}</div>
            <div className="text-lg font-semibold tabular-nums">{t.value}</div>
            <div className="text-xs text-muted-foreground">{t.sub}</div>
          </div>
        ))}
      </div>
    </Card>
  );
}
```

- [ ] **Step 3: Mount it** — import and render `<AgentEconomyPanel />` in `app/DashboardPanel.tsx` alongside the existing panels.

- [ ] **Step 4: Verify** — dashboard shows the panel; numbers move after a scan (5s poll). Commit: `git add app/api/scout/stats/route.ts app/AgentEconomyPanel.tsx app/DashboardPanel.tsx && git commit -m "feat(scout): agent-economy dashboard panel"`

---

## Task 13 (STRETCH, cuttable): external x402 enrichment buy

**Files:**
- Modify: `lib/scout/scan.ts` (add an optional enrichment step behind a flag)

**Interfaces:**
- Consumes: `getScout().gateway`; env `SCOUT_ENRICH_URL`, `SCOUT_ENRICH_ENABLED`.

- [ ] **Step 1:** Behind `process.env.SCOUT_ENRICH_ENABLED === "true"`, after a successful parse with a missing/unknown merchant category and budget remaining, call `gateway.pay(process.env.SCOUT_ENRICH_URL!, { method: "POST", body: { merchant: bill.merchant } })`, record it as a `spent` payment, and attach the category to the bill notes. Wrap in try/catch so any failure (endpoint down) no-ops. This is the only task that may be dropped without touching the core.

- [ ] **Step 2:** Verify the flag defaults off (no behavior change) and, when on with a reachable endpoint, a third payment appears. Commit: `git add lib/scout/scan.ts && git commit -m "feat(scout): optional external x402 enrichment (flagged)"`

---

## Self-Review

**Spec coverage:**
- x402 seller (OCR + FX) → Tasks 5, 6. ✅
- Scout buyer + confidence/budget/image signals → Tasks 2, 3, 7, 8, 9. ✅
- ERC-8004 identity → Task 10 (+ card in Task 11). ✅
- Payments ledger + dashboard → Tasks 4, 12. ✅
- Human UX never breaks / graceful degradation → Task 8 (`degraded` fallback) + Task 9. ✅
- External buy (stretch) → Task 13. ✅
- "Both directions" → Splitsy sells (Task 6) + Scout buys own + external (Tasks 9, 13). ✅

**Placeholder scan:** No TBD/TODO; every code step has real code. `imageSize` returns null → callers skip the dimension gate (explicit).

**Type consistency:** `ScanDeps.pay` returns `{ result, amountUsd, tx }` — matches the fake in `scan.test.ts` and the real adapter in `/api/scout/scan`. `runScout` result shape matches the UI consumer in Task 11 and stats in Task 12. `recordPayment` signature (Task 4) matches calls in Task 8/9's `record` adapter.

**Open validation to confirm at Task 6/9:** `GatewayClient.pay` return field names (`formattedAmount`, `data`/`response`, `txHash`) are normalized defensively in Task 9's adapter; confirm against the installed SDK's types and tighten if they differ. `BatchFacilitatorClient` verify/settle field names (`isValid`, `invalidReason`, `payer`, `success`, `errorReason`, `transaction`) are from the sample's `lib/x402.ts`.
