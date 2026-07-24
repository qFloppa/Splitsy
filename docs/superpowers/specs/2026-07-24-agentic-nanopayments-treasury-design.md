# Splitsy — Agentic Nanopayments + Net-Settlement Treasury

**Date:** 2026-07-24
**Status:** Design approved (brainstorming), pending spec review
**Goal:** Position Splitsy to win a Circle/Arc hackathon across **two tracks** — DeFi and Agentic Economy — by adding two sharp capabilities on top of the existing product, reusing as much as possible.

## Context

Splitsy is a mature, deployed stablecoin-native bill-splitting app on Arc Testnet. It already uses: USDC, Arc, Circle Wallets (developer-controlled), custom Circle Contracts (`BillSplitRegistry`, `RecurringTabFactory`), CCTP v2 bridging, Circle Paymaster (gas-in-USDC via EIP-7702), ERC-8004 payment reputation, multi-provider social identity, AI receipt OCR, a min-transfer netting engine, and an analytics dashboard.

The DeFi track is already largely satisfied by the existing product. The two gaps we close:

1. **Agentic Economy track** — Splitsy has no autonomous agent today. We add one: an **OCR agent ("Scout")** that autonomously pays for AI tooling in USDC fractions via **x402 / Circle Nanopayments**, with on-chain **ERC-8004** identity.
2. **DeFi polish** — a **net-settlement treasury** view that reframes Splitsy as treasury infrastructure.

### Track → feature mapping

| Track rubric item | Covered by |
| --- | --- |
| Autonomous spending/payments/settlement in USDC | Scout agent pays x402 fees per OCR/FX call |
| Clear decision logic tied to real signals | Image-quality + parse-confidence + budget signals |
| Nanopayments / Paymaster / App Kits for service payments | Circle Nanopayments (x402) on Arc |
| Agent onchain identity | Scout registered on Arc canonical ERC-8004 IdentityRegistry |
| Advanced programmable money flows / multi-step settlement | Net-settlement treasury (min-transfer netting) |
| Meaningful use of Arc + USDC | Per-call USDC settlement on Arc; instant finality is the enabler |

## Decisions locked during brainstorming

- **Both tracks**, user-curated feature set.
- **Agent concept:** Nanopayments service-buyer (x402), **both directions** (Splitsy sells its own APIs *and* the agent can buy external APIs).
- **Agent trigger/signal:** OCR-on-upload, confidence-driven.
- **Agent runtime:** Option A — on-upload server-side decision loop (no daemon).
- **Agent identity:** Scout registered as an ERC-8004 agent.
- **Seller endpoints:** both `/api/ocr` and `/api/fx` are x402-paywalled.
- **Settlement path:** **Circle Nanopayments** (Gateway-batched x402), confirmed supported on Arc Testnet (Domain 26, `arcTestnet`). Deposit + pay both on Arc → no bridging, avoids the deposit-latency problem.
- **Explicitly OUT:** Gateway Unified Balance / bridging-for-pay, StableFX/Swap, conditional/scheduled payments.

## Why Arc (the pitch line)

Per-call on-chain USDC settlement is only economical because Arc has **sub-second finality + ~$0.01 USDC-denominated gas**. A $0.005 OCR payment would cost ~$2 in gas on mainnet Ethereum. Nanopayments are impossible without stablecoin-native infrastructure — this is Splitsy's "why this changes what's possible" moment.

---

## Feature 1 — x402 seller (paywall Splitsy's own endpoints)

Turn `/api/ocr` and `/api/fx` into x402-protected sellers priced in USDC fractions
(OCR ~$0.005/call, FX ~$0.001/call — final prices tunable).

### Flow (standard x402 handshake)

```
caller → GET /api/ocr        (no payment)
server → 402 Payment Required
         { x402Version, accepts: [{ scheme, network: "arcTestnet",
             asset: <USDC>, amount, payTo: <Splitsy treasury>, maxTimeoutSeconds }] }
caller → sign EIP-3009 authorization (offchain), retry with PAYMENT-SIGNATURE / X-Payment header
server → submit authorization to Circle facilitator (verify + settle) → 200 + parsed bill
```

### Components

- **x402 seller middleware** wrapping the two routes. Uses the x402 protocol
  (Coinbase `x402` reference packages) configured with **Circle Nanopayments as
  the facilitator/payment method** (`GatewayWalletBatched` / `exact` scheme).
  Facilitator settle endpoint: `POST https://gateway-api-testnet.circle.com/v1/x402/settle`
  (verify endpoint pinned in planning). `payTo` = a Splitsy treasury DCW address on Arc.
- **Payments ledger** (Supabase): every served call recorded with amount, payer,
  endpoint, facilitator `transaction` id, timestamp.
- **Decision (was open):** the human upload path **routes through Scout**, so the
  agent is the paying client for every real scan — this is what makes the demo
  coherent (a human uploads; the agent decides and pays). A server-internal parse
  function (no HTTP paywall) backs the endpoint and is the failure fallback if the
  facilitator is unavailable. The HTTP x402 paywall is what Scout (and any external
  caller) hits; internal callers use the function directly.

### Seller dashboard panel

New "Agent economy" panel in the existing `DashboardPanel` (recharts already present):
live x402 earnings, calls served, USDC collected, and Scout's budget burn-down.
Backed by the payments ledger; can reuse the existing Supabase read + SWR cache pattern.

---

## Feature 2 — Scout, the OCR agent (buyer)

An autonomous agent that decides how much to spend on paid tooling per receipt,
pays in USDC fractions via Nanopayments, and has an on-chain ERC-8004 identity.

### Wallet & funding

- Dedicated **Circle DCW** on Arc = Scout's agent wallet (separate from user wallets),
  provisioned like existing DCWs (`lib/circle-dcw.ts` patterns).
- **One-time Gateway deposit on Arc** establishes Scout's nanopayments balance
  (done before demo; Arc's fast finality keeps this short).
- **Spending policy** (per-call cap + daily cap) enforced in app logic (and, if
  available, Circle wallet policy). The cap *is* the agent's risk management.

### Decision loop (on receipt upload — Option A)

```
upload receipt
  │
  ▼
assess image  → quality heuristic (bytes, dimensions, aspect ratio)
  │              too small/garbage → decline, ask user for a better photo (no spend)
  ▼
pay OCR (x402 → Splitsy /api/ocr) from Scout's Gateway balance
  │
  ▼
parse + confidence
  ├─ confidence ≥ THRESHOLD → done, return bill
  └─ confidence < THRESHOLD AND budget remains
        ▼
     pay again (second-opinion pass: retry / higher-tier prompt), reconcile, take better
        ▼
     still low + budget low → stop; return best-effort, flag "low confidence", report spend
```

Every payment is logged with its facilitator transaction id. When Scout nears its
cap it stops paying and reports remaining budget.

### The three real signals (graded by judges)

1. **Image quality** → whether to pay at all.
2. **Parse confidence** (already emitted by the OCR prompt as `confidence`) → whether to pay for a second pass.
3. **Remaining budget** → whether it is allowed to.

### ERC-8004 identity

- Register Scout on Arc's **canonical IdentityRegistry** `0x8004A818BFB912233c491871b3d84c89A494BD9e`
  via `register(metadataURI)`, reusing `lib/erc8004.ts` patterns. Metadata JSON
  (name "Splitsy Scout", type "ocr", capabilities) pinned to IPFS (Pinata already wired).
- Scout's identity NFT + agent card surfaced in the UI ("this bill was scanned by
  agent 0x… — see its onchain identity").
- **Stretch:** Scout earns ERC-8004 reputation per successful job. ERC-8004 forbids
  self-scoring, so the scorer is Splitsy's existing reputation-registrar DCW (or the
  bill creator accepting the parse). Reputation-earning is an enhancement; identity
  registration is the core deliverable.

### "Both directions" — external buy (scoped as stretch, graceful-degrade)

If external Arc-Testnet x402 endpoints are live (e.g. Circle marketplace: merchant
categorization), Scout buys **one** enrichment call via the same client to fill a
missing merchant category / normalize a foreign currency. Behind a feature flag;
if unavailable at demo time it no-ops and the self-contained loop still tells the
whole story. **This is the only piece that may be cut without touching the core.**

---

## Feature 3 — Net-settlement treasury (DeFi)

A treasury view over all of a user's open positions.

- **Read model:** aggregate every open debt and credit across all bills into one
  **net position per counterparty**. Reuse `lib/netting.ts` (`computeNetPositions`,
  `computeMinimumTransfers`, `previewSettlement`) — already implemented and tested.
- **Action:** "Settle net" fires the **minimum set of USDC transfers** through the
  existing pay path (DCW server-transfer for social, browser-signed for wallet).
- **Framing:** presented as treasury infrastructure — "one balance, one settlement"
  — on the dashboard.
- Scope note: netting math exists; new work is the cross-bill aggregation read model,
  the view, and wiring "settle net" to the existing per-transfer execution.

---

## Architecture summary

### Reused (no rewrite)
`/api/ocr` parse logic, `lib/snapsplit.ts` normalization, `lib/circle-dcw.ts`,
DCW provisioning, Supabase + repos, `DashboardPanel` + recharts + SWR pattern,
`lib/netting.ts`, `lib/erc8004.ts` + Pinata image pipeline, existing USDC pay path,
Arc read helpers.

### New
- x402 seller middleware + minimal facilitator wiring to Circle Nanopayments.
- Scout agent module: decision loop, spending policy, x402 buyer client (`GatewayClient`).
- Scout DCW provisioning + one-time Gateway deposit script.
- Scout ERC-8004 registration (reusing erc8004 patterns).
- Payments ledger table + repo.
- "Agent economy" dashboard panel.
- Net-settlement treasury read model + view + "settle net" action.

### Data model additions (Supabase)
- `x402_payments` — id, direction (`earned`|`spent`), endpoint, payer/payee, amount_usdc,
  facilitator_tx, bill_id (nullable), confidence (nullable), created_at.
- Scout config — agent wallet address, gateway balance ref, ERC-8004 agent id/token,
  per-call cap, daily cap. (Table or env-backed singleton — decide in planning.)

## Error handling & graceful degradation
- Facilitator/verify failure → fall back to serving via server-internal parse so the
  human UX never breaks; log the failure; the *agentic* demo path reports the error honestly.
- External x402 unavailable → flag off, no-op, core loop intact.
- Budget exhausted → Scout stops paying, returns best-effort + explicit low-confidence flag.
- Gateway deposit is a pre-demo operational step, not a runtime path.

## Testing (per ponytail: one runnable check per non-trivial unit)
- Decision-loop unit test: given (image-quality, confidence, budget) inputs, asserts
  the pay/second-pass/stop branch taken and total spend (pure function, `node --test`).
- x402 seller: test 402 challenge shape + that a valid settled payment yields 200
  (facilitator mocked).
- Treasury aggregation: extends existing netting tests with a multi-bill fixture.

## Open validation items (resolve first in planning)
1. Exact x402/Nanopayments **package names** for buyer (`GatewayClient` + x402 client)
   and seller (x402 middleware) and the **verify** endpoint URL. Mirror the
   `circlefin/arc-nanopayments` sample repo.
2. Confirm `/api/ocr` `confidence` field is reliable enough to threshold on; if not,
   derive a proxy (e.g. presence of total + line items summing correctly).
3. Confirm Scout wallet policy caps can be set via Circle (else enforce in app only).

## Out of scope
Gateway Unified Balance / bridging-to-pay, StableFX/Swap, conditional/scheduled
payments, mainnet, agent-to-agent negotiation, ERC-8183 jobs.

## Demo script (target narrative)
1. Upload a clean receipt → Scout assesses, pays $0.005 USDC (x402), returns high-confidence split. Show the on-chain payment + Scout's ERC-8004 identity card.
2. Upload a blurry receipt → low confidence → Scout autonomously pays again for a second pass, reconciles, flags residual uncertainty. Show two nanopayments and budget burn-down.
3. Show the "Agent economy" dashboard: earnings ticking up as Scout pays Splitsy's own endpoint.
4. Switch to treasury view: many debts across bills collapse to one net position; "Settle net" fires the minimum USDC transfers on Arc.
5. Close on the pitch line: instant, sub-cent USDC settlement per call — only possible because Arc is stablecoin-native.
