# Agentic Landing Sections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the x402 seller, Scout (the autonomous buyer agent), and the net-settlement treasury to the public landing page, weighted toward the agent APIs.

**Architecture:** Two new sections are inserted into `LandingPage.tsx`'s existing scroll story. `SectionAgent` wraps a new `AgentStage` — a two-pane GSAP timeline (Scout's decision signals on the left, the x402 HTTP transcript on the right) that autoplays when scrolled into view, unlike the pinned/scrubbed `DemoStage`. `SectionTreasury` is three static stations reusing `SectionOnchain`'s card+arrow pattern. A ledger strip under the stage fetches real figures from the existing `/api/scout/stats`.

**Tech Stack:** Next.js (App Router, client components), React 19, GSAP 3 (`ScrollTrigger` already registered globally in `LandingPage.tsx`), Tailwind v4 with CSS custom properties from `app/globals.css`, lucide-react 1.17.0, `node --test` with `--experimental-strip-types` for pure-logic tests.

## Global Constraints

- **Do not modify** `Hero.tsx`, `app/layout.tsx` metadata, `SectionAnyone.tsx`, `SectionOnchain.tsx`, `FinalCTA.tsx`, or `demo/DemoStage.tsx`. The hero headline, page title, and OpenGraph copy stay exactly as they are.
- **Prices and thresholds are imported, never restated.** `PRICES` from `lib/x402/pricing.ts` and `CONFIDENCE_THRESHOLD` from `lib/scout/decide.ts`. Both are pure modules (no `next/server`, no viem) and are safe in client components.
- `DAILY_CAP_USD` is **not** importable — `lib/scout/deps.ts` pulls in `next/server` and viem. Use the literal `"$0.050"` matching that module's env default, with a comment saying so.
- **No fabricated addresses or transaction hashes presented as real.** The stage carries a visible footnote that the transcript is scripted; the wallet row shows a real address only when `/api/scout/stats` supplies one.
- **Treasury copy must not claim netting moves money.** `lib/treasury.ts` and `DashboardPanel`'s `TreasurySection` both state that the net figure is exposure and that batching removes transactions, not transfers. The landing page says the same.
- Every animated component must handle `prefers-reduced-motion: reduce` by **not building the timeline**, leaving the DOM's authored final state visible.
- Existing landing conventions: `"use client"` at the top, a comment block above the component explaining *why* it exists, `gsap.context()` scoped to a ref, cleanup via `ctx.revert()`.
- Verification for every task: `npm run lint` must pass. Tasks touching pure logic also run their `node --test` suite.

---

### Task 1: Ledger resolver (pure logic + tests)

The one piece of real logic in this feature: folding a `/api/scout/stats` response into three display tiles, falling back to scripted figures when the response is missing or malformed. It shows real money on a public page, so it gets a test.

**Files:**
- Create: `lib/landing-ledger.ts`
- Test: `lib/landing-ledger.test.ts`
- Modify: `package.json` (add `test:landing` script alongside the existing `test:*` scripts)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `type LedgerTiles = { earnedUsdc: string; spentUsdc: string; callsServed: string; live: boolean }`
  - `const SCRIPTED_LEDGER: LedgerTiles`
  - `function resolveLedger(payload: unknown): LedgerTiles`

- [ ] **Step 1: Write the failing test**

Create `lib/landing-ledger.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { resolveLedger, SCRIPTED_LEDGER } from "./landing-ledger.ts";

test("falls back to the scripted figures when there is no payload", () => {
  assert.deepEqual(resolveLedger(null), SCRIPTED_LEDGER);
  assert.deepEqual(resolveLedger(undefined), SCRIPTED_LEDGER);
  assert.deepEqual(resolveLedger("nope"), SCRIPTED_LEDGER);
  assert.deepEqual(resolveLedger(42), SCRIPTED_LEDGER);
});

test("falls back when any single field is missing or unusable", () => {
  // A partial response is worse than none: mixing a real earned figure with a
  // scripted spent one produces two numbers that do not reconcile.
  assert.deepEqual(resolveLedger({ earnedUsd: 1, spentUsd: 1 }), SCRIPTED_LEDGER);
  assert.deepEqual(resolveLedger({ earnedUsd: 1, spentUsd: 1, callsServed: null }), SCRIPTED_LEDGER);
  assert.deepEqual(resolveLedger({ earnedUsd: "1", spentUsd: 1, callsServed: 3 }), SCRIPTED_LEDGER);
  assert.deepEqual(resolveLedger({ earnedUsd: NaN, spentUsd: 1, callsServed: 3 }), SCRIPTED_LEDGER);
  assert.deepEqual(resolveLedger({ earnedUsd: -1, spentUsd: 1, callsServed: 3 }), SCRIPTED_LEDGER);
});

test("formats a complete payload to three decimals and marks it live", () => {
  const tiles = resolveLedger({ earnedUsd: 0.0625, spentUsd: 0.041, callsServed: 18 });
  assert.equal(tiles.earnedUsdc, "0.063");
  assert.equal(tiles.spentUsdc, "0.041");
  assert.equal(tiles.callsServed, "18");
  assert.equal(tiles.live, true);
});

test("an all-zero ledger is still live, not a fallback", () => {
  // A fresh deploy has genuinely served nothing. Showing zeros is honest;
  // showing the scripted figures next to a 'live' dot would not be.
  const tiles = resolveLedger({ earnedUsd: 0, spentUsd: 0, callsServed: 0 });
  assert.equal(tiles.earnedUsdc, "0.000");
  assert.equal(tiles.callsServed, "0");
  assert.equal(tiles.live, true);
});

test("ignores extra fields the stats route also returns", () => {
  const tiles = resolveLedger({
    earnedUsd: 0.01,
    spentUsd: 0.005,
    callsServed: 2,
    callsPaid: 1,
    dailyCapUsd: 0.05,
    agent: { address: null, tokenId: null },
  });
  assert.equal(tiles.live, true);
  assert.equal(tiles.spentUsdc, "0.005");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --experimental-strip-types lib/landing-ledger.test.ts`

Expected: FAIL — `Cannot find module './landing-ledger.ts'`.

- [ ] **Step 3: Write the implementation**

Create `lib/landing-ledger.ts`:

```ts
// The landing page's agent-economy tiles. These are real money figures on a
// public marketing page, so a missing or half-formed /api/scout/stats response
// must fall back to the scripted demo numbers rather than render NaN, an empty
// tile, or — worst — a real earned figure beside a scripted spent one.

export type LedgerTiles = {
  earnedUsdc: string;
  spentUsdc: string;
  callsServed: string;
  live: boolean;
};

// What the strip shows before the fetch lands, and forever if it never does:
// exactly what the scripted transcript above it spends (two OCR calls at
// $0.005 plus one FX call at $0.001, all paid to Splitsy's own endpoints).
export const SCRIPTED_LEDGER: LedgerTiles = {
  earnedUsdc: "0.011",
  spentUsdc: "0.011",
  callsServed: "3",
  live: false,
};

function usable(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Fold a /api/scout/stats payload into the three tiles. Returns the scripted
 * figures unchanged unless every field is present and sane — all or nothing,
 * because a mixed row would not add up and the "live" dot would be a lie.
 */
export function resolveLedger(payload: unknown): LedgerTiles {
  if (!payload || typeof payload !== "object") return SCRIPTED_LEDGER;
  const stats = payload as Record<string, unknown>;

  const earned = usable(stats.earnedUsd);
  const spent = usable(stats.spentUsd);
  const served = usable(stats.callsServed);
  if (earned === null || spent === null || served === null) return SCRIPTED_LEDGER;

  return {
    earnedUsdc: earned.toFixed(3),
    spentUsdc: spent.toFixed(3),
    callsServed: Math.round(served).toString(),
    live: true,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test --experimental-strip-types lib/landing-ledger.test.ts`

Expected: PASS — 5 tests, 0 failures.

- [ ] **Step 5: Add the test script**

In `package.json`, add this line immediately after the `"test:treasury"` entry:

```json
    "test:landing": "node --test --experimental-strip-types lib/landing-ledger.test.ts",
```

- [ ] **Step 6: Verify the script and lint**

Run: `npm run test:landing && npm run lint`

Expected: tests PASS, lint reports no errors.

- [ ] **Step 7: Commit**

```bash
git add lib/landing-ledger.ts lib/landing-ledger.test.ts package.json
git commit -m "feat(landing): resolve agent-economy tiles from the x402 ledger

Folds /api/scout/stats into three display tiles. A missing or partial
response falls back to the scripted figures wholesale rather than mixing a
real earned number with a scripted spent one, which would not reconcile.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: SectionTreasury

Three static stations, reusing `SectionOnchain`'s card+arrow pattern verbatim. Delivered first because it is self-contained and makes the `LandingPage` wiring pattern concrete before the harder stage lands.

**Files:**
- Create: `components/landing/SectionTreasury.tsx`
- Modify: `components/landing/LandingPage.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: `export function SectionTreasury(): JSX.Element` — no props.

- [ ] **Step 1: Create the section**

Create `components/landing/SectionTreasury.tsx`:

```tsx
"use client";

import { useEffect, useRef } from "react";
import gsap from "gsap";
import { ArrowRight, ArrowRightLeft, Layers, Scale } from "lucide-react";

// The DeFi half of the story, deliberately three quiet stations so it supports
// the agent stage above rather than competing with it.
//
// The arithmetic is buildTreasury()'s own: grossTxCount = 2 * payLegCount +
// claimLegCount, so 5 bills you owe plus 4 you are owed is 2*5 + 4 = 14. If the
// station copy changes, that identity has to keep holding.
//
// The footnote is not hedging. lib/treasury.ts and DashboardPanel both state
// that the net figure is exposure, not a transfer, and that batching removes
// transactions rather than USDC moved. The landing page must not contradict the
// product a judge can go and read.
export function SectionTreasury() {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const root = rootRef.current;
    if (!root) return;

    const ctx = gsap.context(() => {
      gsap.from("[data-treasury-heading]", {
        y: 26,
        autoAlpha: 0,
        duration: 0.8,
        ease: "expo.out",
        scrollTrigger: { trigger: root, start: "top 74%" },
      });
      gsap.from("[data-treasury-step]", {
        y: 24,
        autoAlpha: 0,
        duration: 0.7,
        ease: "expo.out",
        stagger: 0.14,
        scrollTrigger: { trigger: root, start: "top 62%" },
      });
      gsap.from("[data-treasury-arrow]", {
        autoAlpha: 0,
        scale: 0.6,
        duration: 0.45,
        ease: "back.out(2)",
        stagger: 0.14,
        delay: 0.18,
        scrollTrigger: { trigger: root, start: "top 62%" },
      });
    }, root);

    return () => ctx.revert();
  }, []);

  return (
    <section
      aria-labelledby="treasury-heading"
      className="mx-auto w-full max-w-[80rem] scroll-mt-24 px-4 pb-[var(--lp-section-y)] sm:px-6 lg:px-8"
      id="treasury"
      ref={rootRef}
    >
      <h2 className="lp-display-lg max-w-3xl" data-treasury-heading id="treasury-heading">
        Many debts. <span className="lp-headline-accent">One position.</span>
      </h2>
      <p className="lp-lede mt-5 max-w-xl" data-treasury-heading>
        Every share you owe and are owed collapses into one net figure per person. Settling fires them
        as a batch — one atomic transaction on a Circle wallet instead of an approve and a payment per
        bill.
      </p>

      <div className="mt-12 flex flex-col items-stretch gap-3 lg:flex-row lg:items-center">
        <div
          className="flex-1 rounded-[calc(var(--radius)+4px)] border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow-soft)] backdrop-blur-xl"
          data-treasury-step
        >
          <Layers className="text-[var(--text-soft)]" size={20} />
          <p className="mt-3 text-sm font-bold text-[var(--text)]">The open ledger</p>
          <p className="mt-1 text-sm text-[var(--text-muted)]">
            Shares scattered across every bill you joined or created.
          </p>
          <p className="mono mt-3 truncate text-xs text-[var(--text-muted)]">
            5 bills you owe · 4 you&apos;re owed
          </p>
        </div>

        <ArrowRight
          className="mx-auto shrink-0 rotate-90 text-[var(--text-muted)] lg:rotate-0"
          data-treasury-arrow
          size={18}
        />

        <div
          className="flex-1 rounded-[calc(var(--radius)+4px)] border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow-soft)] backdrop-blur-xl"
          data-treasury-step
        >
          <Scale className="text-[var(--text-soft)]" size={20} />
          <p className="mt-3 text-sm font-bold text-[var(--text)]">One net position</p>
          <p className="mt-1 text-sm text-[var(--text-muted)]">
            Everything owed in both directions, collapsed per counterparty.
          </p>
          <p className="mono mt-3 truncate text-xs text-[var(--accent)]">
            −12.40 Alex · +8.00 Sam · −0.60 0x9f…
          </p>
        </div>

        <ArrowRight
          className="mx-auto shrink-0 rotate-90 text-[var(--text-muted)] lg:rotate-0"
          data-treasury-arrow
          size={18}
        />

        <div
          className="flex-1 rounded-[calc(var(--radius)+4px)] border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow-soft)] backdrop-blur-xl"
          data-treasury-step
        >
          <ArrowRightLeft className="text-[var(--success)]" size={20} />
          <p className="mt-3 text-sm font-bold text-[var(--text)]">One settlement</p>
          <p className="mt-1 text-sm text-[var(--text-muted)]">
            Every approval, payment and claim lands together, or none of it does.
          </p>
          <p className="mono mt-3 truncate text-xs text-[var(--success)]">1 atomic tx instead of 14</p>
        </div>
      </div>

      <p className="mt-6 max-w-2xl text-xs text-[var(--text-muted)]">
        Netting is a view, not a transfer. Each bill escrows its own USDC on Arc, so every debt is still
        paid to its own bill — batching removes transactions, never the money owed, and it never
        collects what someone else still owes you.
      </p>
    </section>
  );
}
```

- [ ] **Step 2: Wire it into the landing story**

In `components/landing/LandingPage.tsx`, add the import after the `SectionOnchain` import (line 13):

```tsx
import { SectionTreasury } from "./SectionTreasury";
```

Then, in the JSX, insert the element between `<SectionOnchain />` and `<SectionStack />`:

```tsx
          <SectionOnchain />
          <SectionTreasury />
          <SectionStack />
```

- [ ] **Step 3: Verify**

Run: `npm run lint && npm run build`

Expected: lint clean, build succeeds.

Then run `npm run dev`, open `http://localhost:3000`, scroll to the treasury section and confirm: three cards with connecting arrows appear on scroll, the arrows sit horizontally at `lg` and rotate vertical below it, and the footnote reads under the cards.

- [ ] **Step 4: Commit**

```bash
git add components/landing/SectionTreasury.tsx components/landing/LandingPage.tsx
git commit -m "feat(landing): add the net-settlement treasury section

Three stations reusing SectionOnchain's card+arrow pattern. The station
numbers satisfy buildTreasury's grossTxCount identity (2*5 + 4 = 14), and the
footnote carries lib/treasury.ts's own warning that netting is a view and
batching removes transactions rather than transfers.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Agent script data + static AgentStage + SectionAgent

The stage's DOM authored in its **final** state, so this task alone produces the complete `prefers-reduced-motion` experience — a readable static diagram. No timeline yet.

**Files:**
- Create: `components/landing/demo/agent-script.ts`
- Create: `components/landing/demo/AgentStage.tsx`
- Create: `components/landing/SectionAgent.tsx`
- Modify: `components/landing/LandingPage.tsx`
- Modify: `components/landing/Nav.tsx`

**Interfaces:**
- Consumes: `PRICES` from `lib/x402/pricing.ts`, `CONFIDENCE_THRESHOLD` from `lib/scout/decide.ts`.
- Produces:
  - From `agent-script.ts`: `type Line`, `type Act`, `const ACTS: Act[]`, `const STEPS: string[]`, `const STEP_LABELS: string[]`, `const OCR_PRICE: string`, `const FX_PRICE: string`, `const THRESHOLD: string`, `const DEMO_CAP: string`, `const TOTAL_SPEND: string`.
  - `export function AgentStage(): JSX.Element` — no props.
  - `export function SectionAgent(): JSX.Element` — no props.

- [ ] **Step 1: Create the script data**

Create `components/landing/demo/agent-script.ts`:

```ts
import { PRICES } from "@/lib/x402/pricing";
import { CONFIDENCE_THRESHOLD } from "@/lib/scout/decide";

// Prices and the confidence gate are IMPORTED, never restated. This page must
// not be able to advertise a price the seller does not charge, and the two
// modules are pure — no next/server, no viem — so they are safe on the client.
export const OCR_PRICE = PRICES["/api/ocr"];
export const FX_PRICE = PRICES["/api/fx"];
export const THRESHOLD = CONFIDENCE_THRESHOLD.toFixed(2);

// SCOUT_DAILY_CAP_USDC's default from lib/scout/deps.ts. Not importable — that
// module pulls in next/server and viem — so it is restated here. The live
// dailyCapUsd from /api/scout/stats supersedes it where the fetch succeeds.
export const DEMO_CAP = "$0.050";

// Two OCR calls plus one FX call: 0.005 + 0.005 + 0.001. Kept as a constant so
// the left pane's counter and the closing transcript line cannot disagree.
export const TOTAL_SPEND = "$0.011";

export type Line =
  | { kind: "req" | "res" | "note"; text: string }
  | { kind: "field"; text: string; value: string; note?: string }
  | { kind: "check"; text: string; value: string; state: "ok" | "warn" };

export type Act = { step: string; label: string; lines: Line[] };

// Each act maps to one rail step and one block of transcript. Field names,
// header names and values below are the ones lib/x402/seller.ts actually emits
// — see the traceability table in the design spec.
export const ACTS: Act[] = [
  {
    step: "Assess",
    label: "assess",
    lines: [
      { kind: "req", text: "scout.assess(receipt.jpg)" },
      { kind: "check", text: "image size", value: `1.4 MB ≥ 8 KB`, state: "ok" },
      { kind: "check", text: "resolution", value: "1290 × 1720 ≥ 200 px", state: "ok" },
      { kind: "check", text: "budget", value: `${DEMO_CAP} left ≥ ${OCR_PRICE}`, state: "ok" },
    ],
  },
  {
    step: "402",
    label: "challenge",
    lines: [
      { kind: "req", text: "POST /api/ocr" },
      { kind: "res", text: "402 Payment Required" },
      { kind: "note", text: "PAYMENT-REQUIRED (base64)" },
      { kind: "field", text: "scheme", value: '"exact"' },
      { kind: "field", text: "network", value: '"eip155:5042002"', note: "Arc Testnet" },
      { kind: "field", text: "asset", value: "0x3600…0000", note: "USDC" },
      { kind: "field", text: "amount", value: '"5000"', note: OCR_PRICE },
      { kind: "field", text: "maxTimeoutSeconds", value: "608400" },
      { kind: "field", text: "extra.name", value: '"GatewayWalletBatched"' },
    ],
  },
  {
    step: "Sign",
    label: "sign",
    lines: [
      { kind: "req", text: "sign EIP-3009 authorization" },
      { kind: "note", text: "offchain · Scout sends no transaction · zero gas" },
      { kind: "req", text: "POST /api/ocr" },
      { kind: "field", text: "payment-signature", value: "eyJ4NDAyVmVyc2lvbiI6Mi…" },
    ],
  },
  {
    step: "Settle",
    label: "settle",
    lines: [
      { kind: "note", text: "facilitator.verify()  →  isValid" },
      { kind: "note", text: "facilitator.settle()  →  batched by Circle Gateway" },
      { kind: "res", text: "200 OK" },
      { kind: "field", text: "PAYMENT-RESPONSE", value: "transaction 0x9f1c…4b2e" },
      { kind: "check", text: "ledger", value: `earned ${OCR_PRICE}`, state: "ok" },
    ],
  },
  {
    step: "Second opinion",
    label: "retry",
    lines: [
      { kind: "check", text: "confidence", value: `0.62 < ${THRESHOLD}`, state: "warn" },
      { kind: "req", text: "POST /api/ocr   { hq: true }" },
      { kind: "res", text: "200 OK   confidence 0.94" },
      { kind: "note", text: "pickBetterParse → keep the high-quality parse" },
      { kind: "check", text: "ledger", value: `earned ${OCR_PRICE}`, state: "ok" },
    ],
  },
  {
    step: "FX",
    label: "fx",
    lines: [
      { kind: "note", text: "bill currency EUR ≠ USD" },
      { kind: "req", text: `POST /api/fx   ${FX_PRICE}` },
      { kind: "res", text: "200 OK   { rate, source, asOf }" },
      { kind: "check", text: "run complete", value: `spent ${TOTAL_SPEND}`, state: "ok" },
    ],
  },
];

export const STEPS = ACTS.map((act) => act.step);
export const STEP_LABELS = ACTS.map((act) => act.label);
```

- [ ] **Step 2: Create the static stage**

Create `components/landing/demo/AgentStage.tsx`. This step authors the DOM only — the `useEffect` timeline arrives in Task 4.

```tsx
"use client";

import { useRef, useState } from "react";
import { Bot, Check, Terminal, TriangleAlert } from "lucide-react";

import { ACTS, DEMO_CAP, OCR_PRICE, STEPS, THRESHOLD, TOTAL_SPEND, type Line } from "./agent-script";

/**
 * The agent-economy demo: Scout's decision signals on the left, the x402 HTTP
 * exchange on the right.
 *
 * Same authoring discipline as DemoStage — the DOM below is written in its
 * FINAL state and transient props carry opacity-0, so under
 * prefers-reduced-motion we never build a timeline and this static frame is
 * what renders. Unlike DemoStage this stage does NOT pin: two scroll-jacked
 * sections on one page is one too many, so it autoplays in view instead.
 */
export function AgentStage() {
  const stageRef = useRef<HTMLDivElement>(null);
  const [activeStep, setActiveStep] = useState(0);
  const seekRef = useRef<(index: number) => void>(() => {});

  return (
    <div className="relative grid gap-5 p-5 md:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] md:p-7" ref={stageRef}>
      <p className="sr-only">
        Animated walkthrough of an agent payment. Scout, an autonomous agent, checks that the uploaded
        receipt is legible and that its daily budget can cover the call. It requests Splitsy&apos;s OCR
        endpoint, receives an HTTP 402 Payment Required challenge quoting {OCR_PRICE} in USDC on Arc
        Testnet, signs an offchain EIP-3009 authorization instead of sending a transaction, and retries.
        Circle Gateway verifies and settles the payment, and the endpoint returns the parsed bill. The
        first parse scores 0.62 confidence, below the {THRESHOLD} threshold, so Scout pays a second time
        for a higher-quality parse and keeps the better of the two. Finally it buys a foreign-exchange
        rate to convert the total to USD, spending {TOTAL_SPEND} in all.
      </p>

      {/* LEFT · Scout's decision signals */}
      <div className="flex flex-col">
        <p className="flex items-center gap-2 text-sm font-bold text-[var(--text)]">
          <Bot className="text-[var(--accent)]" size={16} /> Scout · the buyer
        </p>

        <div className="mt-3 space-y-2">
          <Signal
            index={0}
            title="Image is legible"
            detail="1.4 MB · 1290 × 1720"
            foot="floors: 8 KB · 200 px"
          />
          <Signal
            index={1}
            title="Budget allows it"
            detail={`${DEMO_CAP} cap · ${OCR_PRICE} per call`}
            foot="the cap is the risk control"
          />
          <Signal
            index={2}
            title="Confidence"
            detail="0.94 — kept the better parse"
            foot={`below ${THRESHOLD} it buys a second opinion`}
            warnDetail={`0.62 — under ${THRESHOLD}, buying again`}
          />
        </div>

        <div className="mt-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-strong)] px-3 py-2.5">
          <p className="flex items-baseline justify-between text-xs text-[var(--text-muted)]">
            <span>Spent this run</span>
            <span className="amount-text font-bold text-[var(--text)]" data-spend>
              {TOTAL_SPEND}
            </span>
          </p>
          <p className="mt-1.5 text-[11px] text-[var(--text-muted)]" data-wallet>
            Scout signs from its own wallet — a server-held EOA on Arc with an ERC-8004 identity.
          </p>
        </div>
      </div>

      {/* RIGHT · the x402 transcript */}
      <div className="flex min-w-0 flex-col">
        <p className="flex items-center gap-2 text-sm font-bold text-[var(--text)]">
          <Terminal className="text-[var(--accent)]" size={16} /> x402 · HTTP
        </p>

        {/* A fixed-height viewport over a track the timeline slides upward, so
            the transcript behaves like a real terminal rather than overflowing:
            the six acts are ~36rem of lines in a 24rem pane. Under reduced
            motion nothing slides, so the viewport is hand-scrollable instead
            and no line is unreachable. */}
        <div className="mono mt-3 h-[24rem] overflow-hidden rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-strong)] p-3 text-[11px] leading-[1.7] motion-reduce:overflow-y-auto sm:text-xs">
          <div data-track>
            {ACTS.map((act, actIndex) => (
              <div className="space-y-0.5" data-act={actIndex} data-act-group key={act.label}>
                {act.lines.map((line, lineIndex) => (
                  <TranscriptLine key={`${act.label}-${lineIndex}`} line={line} />
                ))}
              </div>
            ))}
          </div>
        </div>

        <p className="mt-2 text-[11px] text-[var(--text-muted)]">
          Scripted walkthrough — the field names, headers, prices and thresholds are the ones the server
          uses. The address and transaction hash are illustrative.
        </p>
      </div>

      {/* loop-reset veil */}
      <div className="pointer-events-none absolute inset-0 z-40 bg-[var(--surface)] opacity-0" data-overlay />

      {/* step rail */}
      <nav aria-label="Agent demo steps" className="col-span-full mt-1 flex flex-wrap items-center justify-center gap-1.5">
        {STEPS.map((step, i) => (
          <button
            className={`rounded-full px-3 py-1 text-xs font-bold transition-colors duration-[var(--dur-1)] ${
              i === activeStep
                ? "bg-[var(--accent-soft)] text-[var(--accent)]"
                : "text-[var(--text-muted)] hover:text-[var(--text)]"
            }`}
            key={step}
            onClick={() => seekRef.current(i)}
            type="button"
          >
            {step}
          </button>
        ))}
      </nav>
    </div>
  );
}

// One decision signal. Signal 3 carries two mutually exclusive detail lines —
// the amber "under threshold" reading and the resolved green one — because
// swapping textContent from a timeline does not survive scrubbing backwards,
// whereas toggling two elements with tl.set() reverts cleanly.
function Signal({
  index,
  title,
  detail,
  foot,
  warnDetail,
}: {
  index: number;
  title: string;
  detail: string;
  foot: string;
  warnDetail?: string;
}) {
  return (
    <div
      className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 data-[state=warn]:border-[var(--warning-text)]"
      data-signal
      data-signal-index={index}
      data-state="ok"
    >
      <p className="flex items-center gap-2 text-xs font-bold text-[var(--text)]">
        {/* Both glyphs share one slot so swapping them cannot shift the title.
            They stack absolutely rather than toggling `hidden`, because the
            timeline crossfades them with autoAlpha and a display:none element
            cannot be tweened back in. */}
        <span className="relative inline-flex size-[13px] shrink-0 items-center justify-center">
          <span className="absolute inset-0 text-[var(--success)]" data-signal-ok>
            <Check size={13} />
          </span>
          {warnDetail ? (
            <span className="absolute inset-0 text-[var(--warning-text)] opacity-0" data-signal-warn>
              <TriangleAlert size={13} />
            </span>
          ) : null}
        </span>
        {title}
      </p>
      <p className="mt-1 text-xs text-[var(--text-muted)]" data-signal-detail>
        {detail}
      </p>
      {warnDetail ? (
        <p className="mt-1 text-xs text-[var(--warning-text)] opacity-0" data-signal-warn-detail>
          {warnDetail}
        </p>
      ) : null}
      <p className="mt-1 text-[11px] text-[var(--text-muted)]">{foot}</p>
    </div>
  );
}

// Act membership comes from the wrapping [data-act-group], so a line only
// needs to mark itself animatable.
function TranscriptLine({ line }: { line: Line }) {
  const common = "flex items-baseline gap-2";

  if (line.kind === "req") {
    return (
      <p className={`${common} text-[var(--accent)]`} data-line>
        <span aria-hidden="true">→</span>
        <span className="min-w-0 break-all font-semibold">{line.text}</span>
      </p>
    );
  }

  if (line.kind === "res") {
    return (
      <p className={`${common} text-[var(--success)]`} data-line>
        <span aria-hidden="true">←</span>
        <span className="min-w-0 break-all font-semibold">{line.text}</span>
      </p>
    );
  }

  if (line.kind === "note") {
    return (
      <p className="pl-4 text-[var(--text-muted)]" data-line>
        {line.text}
      </p>
    );
  }

  if (line.kind === "check") {
    return (
      <p className={`${common} pl-4`} data-line>
        <span className={line.state === "warn" ? "text-[var(--warning-text)]" : "text-[var(--success)]"}>
          {line.state === "warn" ? "!" : "✓"}
        </span>
        <span className="text-[var(--text-muted)]">{line.text}</span>
        <span className="min-w-0 flex-1 break-all text-right text-[var(--text)]">{line.value}</span>
      </p>
    );
  }

  return (
    <p className={`${common} pl-4`} data-line>
      <span className="shrink-0 text-[var(--text-muted)]">{line.text}</span>
      <span className="min-w-0 flex-1 break-all text-right text-[var(--text)]">{line.value}</span>
      {line.note ? <span className="shrink-0 text-[var(--text-muted)]">{line.note}</span> : null}
    </p>
  );
}
```

- [ ] **Step 3: Create the section wrapper**

Create `components/landing/SectionAgent.tsx`:

```tsx
"use client";

import { useEffect, useRef } from "react";
import gsap from "gsap";

import { BrowserFrame } from "./BrowserFrame";
import { AgentStage } from "./demo/AgentStage";

// Sits directly after the product demo on purpose: DemoStage's first act is a
// receipt sliding into a scan beam, and this section is what happens inside
// that beam and who paid for it. The frame docks the same way DemoSection's
// does, so the two read as one continuous story rather than two demos.
export function SectionAgent() {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const root = rootRef.current;
    if (!root) return;

    const ctx = gsap.context(() => {
      gsap.from("[data-agent-heading]", {
        y: 26,
        autoAlpha: 0,
        duration: 0.8,
        ease: "expo.out",
        scrollTrigger: { trigger: root, start: "top 78%" },
      });
    }, root);

    return () => ctx.revert();
  }, []);

  return (
    <section
      aria-labelledby="agent-heading"
      className="mx-auto w-full max-w-[96rem] scroll-mt-24 px-4 pt-[var(--lp-section-y)] sm:px-6 lg:px-8"
      id="agent"
      ref={rootRef}
    >
      <h2 className="lp-display-lg max-w-3xl" data-agent-heading id="agent-heading">
        Upload a receipt. <span className="lp-headline-accent">An agent goes shopping.</span>
      </h2>
      <p className="lp-lede mt-5 max-w-2xl" data-agent-heading>
        Scout has its own wallet, an ERC-8004 identity on Arc, and a daily budget of five cents. It
        judges your photo before spending anything, pays Splitsy&apos;s own x402 endpoints per call, and
        buys a second opinion when the parse looks shaky — signing gasless authorizations that Circle
        Gateway batches and settles on Arc.
      </p>

      <div className="mt-12">
        <BrowserFrame>
          <AgentStage />
        </BrowserFrame>
      </div>
    </section>
  );
}
```

- [ ] **Step 4: Wire it into the landing story**

In `components/landing/LandingPage.tsx`, add the import after the `DemoSection` import (line 11):

```tsx
import { SectionAgent } from "./SectionAgent";
```

Then place it directly after `<DemoSection />`:

```tsx
          <Hero />
          <DemoSection />
          <SectionAgent />
          <SectionAnyone />
```

- [ ] **Step 5: Add the nav anchor**

In `components/landing/Nav.tsx`, insert this anchor immediately after the existing `How it works` link (which ends at line 31) and before the `Docs` link:

```tsx
          <a
            className="hidden rounded-md px-3 py-2 text-sm font-semibold text-[var(--text-soft)] no-underline transition-colors duration-[var(--dur-1)] hover:text-[var(--text)] sm:block"
            href="#agent"
          >
            Agent APIs
          </a>
```

- [ ] **Step 6: Verify**

Run: `npm run lint && npm run build`

Expected: lint clean, build succeeds.

Then run `npm run dev` and check at `http://localhost:3000`:
- The agent section appears directly below the product demo, inside browser chrome.
- Both panes render fully: three signal cards on the left, the entire transcript on the right.
- The `Agent APIs` nav link scrolls to it.
- In devtools, emulate `prefers-reduced-motion: reduce` and reload — the stage must still be fully readable, because this task has no timeline yet and that is exactly the reduced-motion frame.

- [ ] **Step 7: Commit**

```bash
git add components/landing/demo/agent-script.ts components/landing/demo/AgentStage.tsx components/landing/SectionAgent.tsx components/landing/LandingPage.tsx components/landing/Nav.tsx
git commit -m "feat(landing): add the agent-economy section

Two panes: Scout's decision signals and the x402 HTTP transcript. Prices and
the confidence threshold are imported from lib/x402/pricing.ts and
lib/scout/decide.ts rather than restated, so the page cannot advertise a price
the seller does not charge.

DOM is authored in its final state, which is also the prefers-reduced-motion
frame. The timeline follows separately.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: AgentStage timeline and drive

Bring the static frame to life. Autoplay in view, clickable rail, no pin.

**Files:**
- Modify: `components/landing/demo/AgentStage.tsx`

**Interfaces:**
- Consumes: `ACTS`, `STEP_LABELS`, `OCR_PRICE`, `TOTAL_SPEND` from `agent-script.ts`; the `data-track`, `data-act-group`, `data-line`, `data-signal`, `data-signal-detail`, `data-signal-warn-detail`, `data-signal-ok`, `data-signal-warn`, `data-spend`, `data-overlay` hooks authored in Task 3.
- Produces: no new exports. `seekRef.current` becomes functional; `activeStep` starts tracking timeline progress.

- [ ] **Step 1: Add the imports**

At the top of `components/landing/demo/AgentStage.tsx`, replace the React import line and add GSAP:

```tsx
import { useEffect, useRef, useState } from "react";
import gsap from "gsap";
```

And extend the script import to pull in `STEP_LABELS`:

```tsx
import {
  ACTS,
  DEMO_CAP,
  OCR_PRICE,
  STEP_LABELS,
  STEPS,
  THRESHOLD,
  TOTAL_SPEND,
  type Line,
} from "./agent-script";
```

- [ ] **Step 2: Add the timeline effect**

Insert this `useEffect` inside `AgentStage`, immediately after the `seekRef` declaration and before the `return`:

```tsx
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const stage = stageRef.current;
    if (!stage) return;

    let ctx: gsap.Context | undefined;
    let tickFn: (() => void) | undefined;
    let stepIndex = 0;

    const build = () => {
      if (tickFn) gsap.ticker.remove(tickFn);
      tickFn = undefined;
      ctx?.revert();

      ctx = gsap.context(() => {
        const q = gsap.utils.selector(stage);
        const el = (sel: string) => q(sel)[0];

        const signals = q("[data-signal]");
        const overlay = el("[data-overlay]");
        const spendOut = el("[data-spend]");
        const track = el("[data-track]");
        const groups = q("[data-act-group]");
        const viewport = track.parentElement as HTMLElement;
        const confidence = signals[2];
        const confOk = confidence.querySelector("[data-signal-ok]");
        const confWarn = confidence.querySelector("[data-signal-warn]");
        const confDetail = confidence.querySelector("[data-signal-detail]");
        const confWarnDetail = confidence.querySelector("[data-signal-warn-detail]");

        // ---- reset to the starting frame ----
        // autoAlpha uses visibility, not display, so hidden lines still occupy
        // layout and the offsets measured below are the final ones.
        gsap.set(track, { y: 0 });
        gsap.set(q("[data-line]"), { autoAlpha: 0, y: 5 });
        gsap.set(signals, { autoAlpha: 0, y: 8 });
        gsap.set(overlay, { autoAlpha: 0 });
        gsap.set(confOk, { autoAlpha: 0 });
        gsap.set(confDetail, { autoAlpha: 0 });
        gsap.set([confWarn, confWarnDetail], { autoAlpha: 0 });

        // How far the track must slide so act i's last line sits just inside
        // the viewport's bottom edge. Clamped at 0 so early acts never scroll.
        const trackTop = track.getBoundingClientRect().top;
        const groupBottoms = groups.map((g) => g.getBoundingClientRect().bottom - trackTop);
        const viewInner = viewport.clientHeight - 24; // p-3 top + bottom
        const scrollFor = (i: number) => -Math.max(0, groupBottoms[i] - viewInner);

        // The spend counter is a tweened proxy rather than a sequence of
        // textContent writes, so scrubbing backwards unwinds it correctly.
        const spend = { usd: 0 };
        const renderSpend = () => {
          spendOut.textContent = `$${spend.usd.toFixed(3)}`;
        };
        renderSpend();

        const tl = gsap.timeline({ paused: true });

        ACTS.forEach((act, actIndex) => {
          tl.addLabel(act.label);

          // Signals 1 and 2 are the pre-flight gates: both fire before a cent
          // is spent, which is the whole point of the first act.
          if (actIndex === 0) {
            tl.to([signals[0], signals[1]], {
              autoAlpha: 1,
              y: 0,
              duration: 0.4,
              ease: "expo.out",
              stagger: 0.18,
            });
          }

          // Signal 3 appears amber when the parse comes back unsure, then
          // resolves green once the second opinion is in. Both transitions use
          // tl.set() on two sibling elements so reverse playback restores them.
          if (actIndex === 4) {
            tl.to(confidence, { autoAlpha: 1, y: 0, duration: 0.4, ease: "expo.out" })
              .set(confidence, { attr: { "data-state": "warn" } }, "<")
              .set([confWarn, confWarnDetail], { autoAlpha: 1 }, "<");
          }

          // Slide the track first so the incoming act has room, then reveal it.
          tl.to(track, { y: scrollFor(actIndex), duration: 0.45, ease: "power2.inOut" }).to(
            groups[actIndex].querySelectorAll("[data-line]"),
            { autoAlpha: 1, y: 0, duration: 0.3, ease: "power2.out", stagger: 0.14 },
            "-=0.25",
          );

          // Money moves as its ledger line lands, not before.
          if (actIndex === 3 || actIndex === 4) {
            tl.to(spend, { usd: `+=${parseFloat(OCR_PRICE.replace("$", ""))}`, duration: 0.4, onUpdate: renderSpend }, "<");
          }
          if (actIndex === 5) {
            tl.to(spend, { usd: parseFloat(TOTAL_SPEND.replace("$", "")), duration: 0.4, onUpdate: renderSpend }, "<");
          }

          if (actIndex === 4) {
            tl.set(confidence, { attr: { "data-state": "ok" } })
              .set([confWarn, confWarnDetail], { autoAlpha: 0 }, "<")
              .set([confOk, confDetail], { autoAlpha: 1 }, "<");
          }

          tl.to({}, { duration: actIndex === ACTS.length - 1 ? 1.6 : 0.55 });
        });

        tl.to(overlay, { autoAlpha: 1, duration: 0.5, ease: "power2.in" }).to(overlay, {
          autoAlpha: 0,
          duration: 0.01,
        });

        // ---- rail highlighting ----
        const labelTimes = STEP_LABELS.map((label) => tl.labels[label] / tl.duration());
        tl.eventCallback("onUpdate", () => {
          const p = tl.progress();
          let idx = 0;
          for (let i = 0; i < labelTimes.length; i++) if (p >= labelTimes[i]) idx = i;
          if (idx !== stepIndex) {
            stepIndex = idx;
            setActiveStep(idx);
          }
        });

        // ---- drive: autoplay while on screen ----
        // No pin and no scrub. DemoStage already scroll-jacks this page once;
        // a second pinned section would make the scroll feel taken away.
        let inView = false;
        let seeking = false;

        const io = new IntersectionObserver(([entry]) => (inView = entry.isIntersecting), {
          threshold: 0.15,
        });
        io.observe(stage);

        tickFn = () => {
          if (!inView || seeking) return;
          tl.progress((tl.progress() + gsap.ticker.deltaRatio(60) / 60 / tl.duration()) % 1);
        };
        gsap.ticker.add(tickFn);

        seekRef.current = (index: number) => {
          seeking = true;
          gsap.to(tl, {
            progress: labelTimes[index] + 0.001,
            duration: 0.6,
            ease: "power2.inOut",
            onComplete: () => {
              seeking = false;
            },
          });
        };

        return () => io.disconnect();
      }, stage);
    };

    build();

    let resizeTimer: ReturnType<typeof setTimeout>;
    let lastWidth = stage.clientWidth;
    const ro = new ResizeObserver(() => {
      if (stage.clientWidth === lastWidth) return; // height changes as lines reveal; only width needs a rebuild
      lastWidth = stage.clientWidth;
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(build, 250);
    });
    ro.observe(stage);

    return () => {
      ro.disconnect();
      clearTimeout(resizeTimer);
      if (tickFn) gsap.ticker.remove(tickFn);
      ctx?.revert();
    };
  }, []);
```

- [ ] **Step 3: Verify**

Run: `npm run lint && npm run build`

Expected: lint clean, build succeeds.

Then run `npm run dev` and check at `http://localhost:3000`:
- Scroll the agent section into view: the transcript types itself out act by act, the rail highlight advances, the spend counter climbs `$0.000 → $0.005 → $0.010 → $0.011`.
- The confidence signal turns amber with the `0.62` reading during **Second opinion**, then resolves green to `0.94`.
- Clicking any rail step jumps to it and playback resumes from there.
- Scroll the section off screen: the timeline stops advancing (add a temporary `console.log` in `tickFn` if you need to confirm, then remove it).
- The loop reset is covered by the veil — no visible snap back to an empty transcript.
- The transcript scrolls itself so the newest act is always visible, and the earliest lines slide up out of view rather than being clipped mid-pane.
- Emulate `prefers-reduced-motion: reduce` and reload: the full static frame renders, nothing animates, and the transcript pane is **scrollable by hand** so no line is unreachable.
- Resize the window across the `md` breakpoint: the stage rebuilds and still plays.

- [ ] **Step 4: Commit**

```bash
git add components/landing/demo/AgentStage.tsx
git commit -m "feat(landing): animate the agent stage

One paused master timeline per act, driven by the ticker while the section is
on screen and seekable from the rail. Deliberately not pinned: DemoStage
already scroll-jacks this page once and twice is too much.

The spend counter is a tweened proxy and the confidence signal toggles two
sibling elements via tl.set(), so scrubbing backwards unwinds cleanly.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Live ledger strip

Three tiles under the stage showing the real cumulative x402 ledger, plus the real Scout wallet when one is configured.

**Files:**
- Modify: `components/landing/demo/AgentStage.tsx`

**Interfaces:**
- Consumes: `resolveLedger`, `SCRIPTED_LEDGER`, `type LedgerTiles` from `lib/landing-ledger.ts` (Task 1).
- Produces: no new exports.

- [ ] **Step 1: Add the imports**

In `components/landing/demo/AgentStage.tsx`, add:

```tsx
import { ExternalLink } from "lucide-react";
import { resolveLedger, SCRIPTED_LEDGER, type LedgerTiles } from "@/lib/landing-ledger";
```

`ExternalLink` joins the existing lucide import line rather than a second one:

```tsx
import { Bot, Check, ExternalLink, Terminal, TriangleAlert } from "lucide-react";
```

- [ ] **Step 2: Add the fetch**

Inside `AgentStage`, add this state and effect after the existing `seekRef` declaration:

```tsx
  const [ledger, setLedger] = useState<LedgerTiles>(SCRIPTED_LEDGER);
  const [agent, setAgent] = useState<{ address: string; tokenId: string | null } | null>(null);

  // One fetch, no polling: this is a marketing page, not the dashboard. A
  // failure is silent by design — the scripted figures already on screen stay
  // put, and the "live" dot simply never appears.
  useEffect(() => {
    let live = true;
    fetch("/api/scout/stats")
      .then((response) => (response.ok ? response.json() : null))
      .then((payload) => {
        if (!live) return;
        setLedger(resolveLedger(payload));
        const found = payload?.agent;
        if (found?.address) setAgent({ address: found.address, tokenId: found.tokenId ?? null });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
```

- [ ] **Step 3: Render the strip**

Insert this block immediately after the closing `</div>` of the RIGHT transcript pane and before the loop-reset veil:

```tsx
      {/* LIVE · the real x402 ledger, not the scripted run above */}
      <div className="col-span-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.08em] text-[var(--text-muted)]">
            {ledger.live ? (
              <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-[var(--success)]" />
            ) : null}
            {ledger.live ? "Live from the x402 ledger" : "Agent economy · all time"}
          </p>
          {agent ? (
            <a
              className="inline-flex items-center gap-1 text-[11px] text-[var(--text-muted)]"
              href={`https://testnet.arcscan.app/address/${agent.address}`}
              rel="noreferrer"
              target="_blank"
            >
              Scout {agent.address.slice(0, 6)}…{agent.address.slice(-4)}
              {agent.tokenId ? ` · ERC-8004 #${agent.tokenId}` : ""}
              <ExternalLink size={11} />
            </a>
          ) : null}
        </div>

        <div className="mt-2 grid grid-cols-3 gap-3">
          <LedgerTile label="Earned" sub="x402 calls served" value={`${ledger.earnedUsdc} USDC`} />
          <LedgerTile label="Scout spent" sub="paid to Splitsy's own APIs" value={`${ledger.spentUsdc} USDC`} />
          <LedgerTile label="Calls served" sub="paid API responses" value={ledger.callsServed} />
        </div>
      </div>
```

- [ ] **Step 4: Add the tile component**

Append at the bottom of the file:

```tsx
function LedgerTile({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="min-w-0">
      <p className="amount-text truncate text-base font-bold tabular-nums text-[var(--text)] sm:text-lg">{value}</p>
      <p className="truncate text-[11px] font-semibold text-[var(--text)]">{label}</p>
      <p className="truncate text-[11px] text-[var(--text-muted)]">{sub}</p>
    </div>
  );
}
```

- [ ] **Step 5: Update the wallet line**

Replace the static wallet paragraph from Task 3 so it does not duplicate the address now shown in the strip:

```tsx
          <p className="mt-1.5 text-[11px] text-[var(--text-muted)]" data-wallet>
            Signed from Scout&apos;s own wallet — a server-held EOA on Arc, capped at {DEMO_CAP} a day.
          </p>
```

- [ ] **Step 6: Verify**

Run: `npm run lint && npm run build`

Expected: lint clean, build succeeds.

Then run `npm run dev` and check at `http://localhost:3000`:
- With Supabase reachable, the strip shows real figures, a pulsing green dot, and the heading `Live from the x402 ledger`. If `SCOUT_PRIVATE_KEY` is set, the Scout address links to Arcscan.
- In devtools, block `/api/scout/stats` (Network → block request URL) and reload: the strip falls back to `0.011 / 0.011 / 3`, the dot disappears, the heading reads `Agent economy · all time`, and there is **no** layout shift or error in the console.

- [ ] **Step 7: Commit**

```bash
git add components/landing/demo/AgentStage.tsx
git commit -m "feat(landing): show the real x402 ledger under the agent stage

One fetch of /api/scout/stats, no polling — this is a marketing page. The
scripted transcript keeps its own figures; these three tiles are the
cumulative total that has actually settled, and they fall back silently.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: SectionStack cards

Two entries appended to the existing `STACK` array so the agent rails appear in the page's "receipts for the infrastructure" grid.

**Files:**
- Modify: `components/landing/SectionStack.tsx`

**Interfaces:**
- Consumes: the existing `Tech` type in that file — `{ key, origin, name, description, proof, href, linkLabel, icon, wide? }`.
- Produces: no new exports.

- [ ] **Step 1: Add the icon imports**

In `components/landing/SectionStack.tsx`, add `Bot` and `Coins` to the existing lucide import:

```tsx
import {
  ArrowLeftRight,
  ArrowUpRight,
  BadgeCheck,
  Bot,
  Coins,
  Fuel,
  Layers,
  WalletCards,
  Webhook,
  Zap,
} from "lucide-react";
```

- [ ] **Step 2: Insert the two cards**

In the `STACK` array, insert these two entries **between** the `usdc-gas` entry and the `circle-wallets` entry — placing them in the second grid row so the agent rails sit high rather than last:

```tsx
  {
    key: "x402",
    origin: "Circle",
    name: "x402 machine payments",
    description:
      "Splitsy's own /api/ocr and /api/fx answer HTTP 402 with the terms of the call. A buying agent signs an offchain EIP-3009 authorization instead of sending a transaction, so it pays for the API in USDC and spends no gas doing it.",
    proof: "402 → payment-signature → 200 · $0.005 per scan",
    href: "https://developers.circle.com/gateway/nanopayments/concepts/x402",
    linkLabel: "developers.circle.com",
    icon: <Bot size={17} />,
    wide: true,
  },
  {
    key: "nanopayments",
    origin: "Circle",
    name: "Gateway batched settlement",
    description:
      "The facilitator verifies each authorization and settles net positions in bulk, paying gas once per batch instead of once per payment. That is what makes a half-cent API call worth charging for at all.",
    proof: "GatewayWalletBatched v1 · 0x0077…19B9",
    href: "https://developers.circle.com/gateway/nanopayments/concepts/batched-settlement",
    linkLabel: "developers.circle.com",
    icon: <Coins size={17} />,
  },
```

- [ ] **Step 3: Verify grid packing**

The `lg` grid is three columns and `wide` spans two. Column spans in order must total a multiple of 3 with no card straddling a row boundary:

`arc` 2 + `usdc-gas` 1 = 3 · `x402` 2 + `nanopayments` 1 = 3 · `circle-wallets` 1 + `aa` 1 + `cctp` 1 = 3 · `erc8004` 2 + `scp` 1 = 3 → **12, four exact rows.**

Run: `npm run lint && npm run build`

Expected: lint clean, build succeeds.

Then run `npm run dev`, scroll to the stack section at a viewport ≥1024px wide, and confirm there are four full rows with no gaps.

- [ ] **Step 4: Commit**

```bash
git add components/landing/SectionStack.tsx
git commit -m "feat(landing): add x402 and Gateway cards to the stack grid

Placed in the second row so the agent rails sit high in the grid. Column
spans still total 12 on lg, so the four rows stay exactly packed.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Final verification

- [ ] **Run the full check**

```bash
npm run test:landing && npm run lint && npm run build
```

Expected: 5 tests pass, lint clean, build succeeds.

- [ ] **Walk the page once, top to bottom**, at a desktop width:

1. Hero, product demo, and every existing section are **visually unchanged**.
2. The agent section follows the demo; its stage autoplays, the rail seeks, the spend counter climbs, the confidence signal goes amber then green.
3. The ledger strip shows live figures with a pulsing dot, or falls back cleanly.
4. The treasury section's three stations appear on scroll, footnote included.
5. The stack grid has four full rows with x402 in the second.
6. `Agent APIs` in the nav scrolls to the agent section.

- [ ] **Repeat at 375px wide.** Both new stages stack to one column, the rails wrap, nothing overflows horizontally.

- [ ] **Repeat with `prefers-reduced-motion: reduce`.** Every section renders its complete static frame; nothing is blank or mid-animation.
