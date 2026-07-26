# Landing page — the agent economy, x402, and the treasury

**Date:** 2026-07-26
**Status:** Design approved (brainstorming), pending spec review
**Goal:** Put the x402 seller, Scout (the buyer agent), and the net-settlement
treasury on the public landing page, with the weight on the agent APIs. Hackathon
audience: a judge who lands on `/`, skims, and needs to see that the agentic work
is real and running.

## Context

`components/landing/` already tells one continuous scroll story: `Hero` →
`DemoSection` (a pinned, scroll-scrubbed GSAP master timeline in
`demo/DemoStage.tsx`) → `SectionAnyone` → `SectionOnchain` → `SectionStack` →
`FinalCTA`. `LandingPage.tsx` owns scroll plumbing (Lenis + ScrollTrigger on one
clock); each section only authors its own timeline.

Nothing on that page mentions the work from the
[agentic-nanopayments design](2026-07-24-agentic-nanopayments-treasury-design.md):
`/api/ocr` and `/api/fx` are x402-paywalled sellers, Scout is an autonomous buyer
with an ERC-8004 identity, and the dashboard has a net-settlement treasury view.

## Decisions locked during brainstorming

- **Additive placement.** The hero headline, `app/layout.tsx` metadata, and the
  copy of every existing section stay exactly as they are. Two new sections are
  inserted; `Nav` and `SectionStack` each take a small, additive edit.
- **Agent section sits third**, immediately after `DemoSection`. `DemoStage`'s
  Act 1 is a receipt sliding into a scan beam; the agent section is what happens
  inside that beam and who paid for it. That hinge beats spacing the two demos
  apart, and the two stages look nothing alike (light product UI vs. dark
  protocol transcript), so it does not read as demo fatigue.
- **Agent stage is two-pane**: Scout's decision signals on the left, the live
  HTTP transcript on the right, a ledger strip and a step rail beneath. Mirrors
  `DemoStage`'s two-column grid so it reads as the same design system.
- **Autoplay, not pinned.** The stage loops when scrolled into view and the rail
  seeks. A second pinned section would scroll-jack the visitor twice and add
  ~200vh to the page.
- **Scripted transcript, live ledger.** The choreography is authored and
  deterministic; the earned/spent/served figures fetch once from
  `/api/scout/stats`.
- **Treasury is three static stations**, reusing `SectionOnchain`'s card+arrow
  pattern. It is the supporting act and should not compete with the agent stage.

## Placement

```
Hero
DemoSection
SectionAgent        ← new, id="agent"
SectionAnyone
SectionOnchain
SectionTreasury     ← new, id="treasury"
SectionStack        ← +2 cards
FinalCTA
```

## Files

**New**

- `components/landing/SectionAgent.tsx` — heading, lede, wraps the stage in the
  existing `BrowserFrame`.
- `components/landing/demo/AgentStage.tsx` — the two-pane timeline.
- `components/landing/SectionTreasury.tsx` — three stations.

**Modified**

- `components/landing/LandingPage.tsx` — two imports, two elements.
- `components/landing/Nav.tsx` — one `Agent APIs` anchor to `#agent`, following
  the existing `hidden … sm:block` pattern used by `How it works`.
- `components/landing/SectionStack.tsx` — two entries appended to the `STACK`
  array. No structural change to the component.

## Accuracy: the numbers come from the source of truth

`lib/x402/pricing.ts` and `lib/scout/decide.ts` are pure modules with no server
imports, so `AgentStage` imports `PRICES` and `CONFIDENCE_THRESHOLD` directly.
The landing page then cannot quote a price the seller does not charge. This is
less code than retyping the strings and stands in for a unit test — the stage is
otherwise presentational and has no logic worth testing.

`DAILY_CAP_USD` cannot come along: `lib/scout/deps.ts` pulls in `next/server` and
viem. It arrives instead in the `/api/scout/stats` payload as `dailyCapUsd`, with
a literal `0.05` fallback matching the env default.

Fixed values used in the transcript, each traceable:

| Value | Source |
| --- | --- |
| `8 KB` / `200 px` image floors | `lib/scout/decide.ts` `MIN_BYTES`, `MIN_EDGE` |
| `0.80` confidence threshold | `lib/scout/decide.ts` `CONFIDENCE_THRESHOLD` |
| `$0.005` OCR, `$0.001` FX | `lib/x402/pricing.ts` `PRICES` |
| `"exact"`, `eip155:5042002`, `0x3600…0000` | `lib/x402/constants.ts` |
| `amount "5000"` | `usdToAtomic("$0.005")` |
| `maxTimeoutSeconds 608400` | `604800` min validity + `3600` margin, `lib/x402/seller.ts` |
| `GatewayWalletBatched` v1 | `lib/x402/seller.ts` `requirementsFor` `extra` |
| `PAYMENT-REQUIRED` / `payment-signature` / `PAYMENT-RESPONSE` | `lib/x402/seller.ts` headers |

## AgentStage — six acts

Rail: **Assess · 402 · Sign · Settle · Second opinion · FX**

| Act | Left pane | Right pane |
| --- | --- | --- |
| **Assess** | Signal 1 lights: `image legible · 1.4 MB · 1290×1720` (floors 8 KB / 200 px). Signal 2 lights: `budget ok · needs $0.005 of $0.050 left`. Both gates run *before* any spend, so the figure shown is the pre-payment balance. | `scout.assess(receipt.jpg)` |
| **402** | — | `→ POST /api/ocr`, `← 402 Payment Required`, then the decoded `PAYMENT-REQUIRED`: scheme, network, asset, `amount "5000"`, `payTo`, `maxTimeoutSeconds`, `extra` |
| **Sign** | — | `→ sign EIP-3009 · gasless, no tx from Scout`, then the retry carrying `payment-signature: eyJ…` |
| **Settle** | Wallet row resolves: `0x…` + `ERC-8004 #` | `verify() ✓`, `settle() → batched`, `← 200 OK`, `PAYMENT-RESPONSE tx 0x…` |
| **Second opinion** | Signal 3 goes amber: `confidence 0.62 < 0.80 → buy a second opinion` | `→ POST /api/ocr { hq: true }`, `← 200 · confidence 0.94`, `pickBetterParse → keep hq` |
| **FX** | Running spend reaches `$0.011` | `currency EUR ≠ USD`, `→ POST /api/fx`, `← 200 { rate, asOf }` |

The three signals are the agent's decision logic and are graded as such, so they
get three distinct chips rather than being folded into one "assess" step.

### Technique

Ported from `DemoStage`, deliberately:

- DOM authored in its **final** state; transient elements carry `opacity-0`.
  `buildTimeline()` measures, `gsap.set()`s to the starting frame, then plays
  with `.to()` tweens only.
- Typing is a tweened proxy object with an `onUpdate` renderer, never a
  one-shot callback, so scrubbing backwards works.
- Attribute flips use `tl.set()`, which reverts on reverse.
- A loop-reset veil covers the jump from progress 1 back to 0.

### Drive

Simpler than `DemoStage` — no pin, no scrub:

- Master timeline built paused.
- An `IntersectionObserver` gates a `gsap.ticker` callback that advances
  `progress` modulo 1, so the timeline only runs on screen.
- The rail seeks via `gsap.to(tl, { progress: labelTime })`, suppressing the
  ticker while it animates.
- A `ResizeObserver` rebuilds on **width** change only.
- Under `prefers-reduced-motion` the timeline is never built and the authored
  final frame renders as a static diagram.

### Ledger strip

One `fetch("/api/scout/stats")` on mount. No polling — this is a marketing page,
not the dashboard. Three tiles (earned / Scout spent / calls served) plus a pulse
dot reading *live from the x402 ledger*. On fetch failure, on a non-OK response,
or when Scout is unconfigured (`agent.address === null`), the scripted figures
stay and the dot does not render.

## Copy

**SectionAgent**

> ### Upload a receipt. An agent goes shopping.
>
> Scout has its own wallet, an ERC-8004 identity on Arc, and a daily budget of
> five cents. It judges your photo before spending anything, pays Splitsy's own
> x402 endpoints per call, and buys a second opinion when the parse looks shaky —
> signing gasless authorizations that Circle Gateway batches and settles on Arc.

**SectionTreasury**

> ### Many debts. One position.
>
> Every share you owe and are owed collapses into one net figure per person.
> Settling fires them as a batch — one atomic transaction on a Circle wallet
> instead of an approve and a payment per bill.
>
> *Netting is a view, not a transfer. Each bill escrows its own USDC on Arc, so
> batching removes transactions — never the money owed.*

That last line is not hedging. `lib/treasury.ts` and `DashboardPanel`'s
`TreasurySection` both carry explicit warnings that the net figure is exposure,
not a transfer, and that batching saves transactions rather than USDC moved. The
landing copy must not contradict the product, and a judge who checks will find
the page and the code saying the same thing.

Stations: `5 bills you owe · 4 you're owed` → `net per counterparty` →
`1 atomic transaction instead of 14`. The 14 is `buildTreasury`'s
`grossTxCount` = `2 × payLegCount + claimLegCount` = `2 × 5 + 4`, so the three
stations are arithmetically consistent with each other and with the code.

## SectionStack — two appended cards

Inserted at index 2, directly after the Arc row, so the agent rails sit high in
the grid rather than last.

1. **x402 nanopayments** — origin `Circle`, `wide: true`.
   Splitsy's own `/api/ocr` and `/api/fx` answer `402 Payment Required` with the
   terms; a buyer signs an EIP-3009 authorization instead of sending a
   transaction, so a call costs it no gas.
   Proof: `402 → payment-signature → 200 · $0.005/call`.
   Link: `https://developers.circle.com/gateway/nanopayments/concepts/x402`
2. **Gateway batched settlement** — origin `Circle`.
   The facilitator verifies each authorization and settles net positions in
   bulk, paying gas once per batch instead of once per payment — which is what
   makes sub-cent calls viable at all.
   Proof: `GatewayWalletBatched v1 · 0x0077…19B9`.
   Link: `https://developers.circle.com/gateway/nanopayments/concepts/batched-settlement`

Grid packing is preserved. Column spans on `lg` total 12 — four exact rows of
three — with `arc` and `erc8004` already wide and `x402` joining them.

## Accessibility

- An `sr-only` paragraph in `AgentStage` narrates the full exchange, matching the
  pattern at `DemoStage.tsx:356`.
- Rail entries are real `<button>` elements.
- Reduced motion yields a static, complete frame rather than an empty one.
- The stage is decorative: it steals no focus and the transcript is not a live
  region.

## Error handling

| Case | Behaviour |
| --- | --- |
| `/api/scout/stats` fails or is slow | Scripted figures render; no live dot. No spinner, no layout shift. |
| Scout unconfigured (`agent.address` null) | Same as above. The seller side still earns, so the tiles remain truthful. |
| `prefers-reduced-motion` | Timeline never built; static final frame. |
| Narrow viewport | Panes stack; the rail wraps, as `DemoStage`'s does. |

## Out of scope

Hero, page title, and OpenGraph metadata changes. A live "run it live" x402 call
from the landing page (spends the daily cap, depends on facilitator uptime,
needs a new public spend route). Any change to `SectionAnyone`, `SectionOnchain`,
`FinalCTA`, or `DemoStage` itself.
