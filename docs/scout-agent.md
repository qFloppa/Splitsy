# Scout — Autonomous OCR Agent

Scout is a server-side autonomous agent that pays for Splitsy's own OCR and FX
endpoints in USDC fractions via Circle Nanopayments (x402) on Arc Testnet. It
has an on-chain ERC-8004 identity and drives its spending decisions from three
real signals: image quality, parse confidence, and remaining daily budget.

---

## Architecture

Every receipt upload is routed through `POST /api/scout/scan` instead of
directly to `/api/ocr`. Scout runs its decision loop server-side on the same
request, pays the paywalled endpoint over HTTP, and returns the parsed bill to
the client. If the paid path fails at any point the route falls back to a
direct internal call to `lib/ocr-core.ts` so the human upload UX never breaks.

```
POST /api/scout/scan  (multipart)
  │
  ├─ lib/scout/decide.ts: assessImage(bytes, width, height)
  │     too small / low-res → 400, ask for a better photo (no spend)
  │
  ├─ lib/scout/scan.ts: runScout(deps)
  │     pay /api/ocr via GatewayClient.pay()          ← x402 call 1
  │     parse + confidence
  │     confidence < 0.8 AND budget remains
  │       └─ pay /api/ocr again (hq: true prompt)     ← x402 call 2
  │          pickBetterParse(first, second)
  │
  ├─ currency !== USD → pay /api/fx                   ← x402 call 3 (optional)
  │
  └─ record every payment in x402_payments (Supabase)
       return { bill, payments, agentAddress, tokenId }
```

---

## x402 Seller Endpoints

`/api/ocr` and `/api/fx` are wrapped by `lib/x402/seller.ts`'s `withGateway`
higher-order function. On a request without a valid payment header they return
HTTP 402 with a `PAYMENT-REQUIRED` challenge. On a valid settled payment they
serve the result and record an `earned` row in `x402_payments`.

Prices (from `lib/x402/pricing.ts`, the single source of truth for both sides):

| Endpoint   | Price per call | Buyer |
|------------|---------------|-------|
| `/api/ocr` | $0.005 USDC   | Scout |
| `/api/fx`  | $0.001 USDC   | Scout |
| `/api/agents/review` | $0.002 USDC | the Splitsy Settler |

The third is not Scout's, and is listed only because it shares this table and the
same `withGateway` seller wrapper: the Splitsy Auditor sells a bill review and the
Settler buys one before every autopay settlement. See
[`agent-economy.md`](./agent-economy.md).

The facilitator is Circle's `BatchFacilitatorClient` (`@circle-fin/x402-batching`).
Requirement shape: `scheme: "exact"`, `extra.name: "GatewayWalletBatched"`,
`extra.version: "1"`, `extra.verifyingContract: 0x0077777d7EBA4688BDeF3E311b846F25870A19B9`,
`maxTimeoutSeconds: 345600` (7 days — required because Circle's SDK default of
4 days is shorter than the Gateway's auth validity window on Arc).

---

## Scout's Wallet

Scout is a **server-held EOA** (raw viem private key in `SCOUT_PRIVATE_KEY`),
not a Circle DCW. `lib/scout/wallet.ts` constructs a `GatewayClient` from
`@circle-fin/x402-batching` with `chain: "arcTestnet"` and that key. The rest
of Splitsy continues to use DCWs; Scout's EOA is only its x402 payment signer.

Scout's Gateway balance is established once with `gateway.deposit()` (run
`scripts/scout-setup.ts`). The client auto-redeposits when the available
balance drops below a threshold.

---

## Decision Logic (`lib/scout/decide.ts`)

All three functions are pure and fully unit-tested (`lib/scout/decide.test.ts`).

| Function | Signal | Threshold |
|---|---|---|
| `assessImage(bytes, width, height)` | Image quality | < 8 KB or < 200 px on either edge → reject |
| `shouldPayAgain(confidence, canAfford)` | Parse confidence + budget | confidence < 0.8 AND budget remains |
| `pickBetterParse(a, b)` | Reconcile two parses | higher `confidence` wins |

`CONFIDENCE_THRESHOLD = 0.8` is exported and imported by the landing page so
the displayed threshold is always in sync with the code.

---

## Spend Cap (`lib/x402/spend.ts`)

```ts
canSpend(spentTodayUsd, nextUsd, dailyCapUsd): boolean
remainingBudget(spentTodayUsd, dailyCapUsd): number
```

Both functions compare in atomic integer cents to avoid float drift at the cap
boundary. The daily cap is read from `SCOUT_DAILY_CAP_USDC` (default `1`, i.e.
$1.00 USDC — see `DAILY_CAP_USD` in `lib/scout/deps.ts`).
When the cap is exhausted Scout stops paying, returns the best-effort parse, and
sets a `lowConfidence` flag in the response.

---

## ERC-8004 Identity

Scout is registered on Arc's canonical IdentityRegistry
(`0x8004A818BFB912233c491871b3d84c89A494BD9e`) via `register(metadataURI)`,
reusing `lib/erc8004.ts` patterns. Metadata JSON (name "Splitsy Scout",
type "ocr", capabilities list) is pinned to IPFS via Pinata if `PINATA_JWT` is
set; otherwise a `data:` URI is used and registration still works.

The token ID is stored in `SCOUT_ERC8004_TOKEN_ID`. The upload UI shows a Scout
identity card ("this bill was scanned by agent 0x… — see its onchain identity")
linking to Arcscan.

---

## Payments Ledger (`x402_payments`)

Every payment — earned by Splitsy's endpoints and spent by Scout — is recorded
in Supabase. Schema: `schema-x402-payments.sql`.

| Column | Type | Notes |
|---|---|---|
| `direction` | `text` | `'earned'` or `'spent'` |
| `endpoint` | `text` | `/api/ocr`, `/api/fx`, etc. |
| `counterparty` | `text` | payer address (earned) or payee address (spent) |
| `amount_usdc` | `numeric(20,6)` | |
| `gateway_tx` | `text` | facilitator transaction id, nullable |
| `bill_ref` | `text` | bill id, nullable |
| `confidence` | `numeric(4,3)` | OCR confidence at time of payment, nullable |
| `created_at` | `timestamptz` | |

`lib/x402/payments-repo.ts` exposes `recordPayment`, `sumSpentTodayUsd`, and
`getAgentStats`.

---

## Agent Economy Dashboard Panel

`app/AgentEconomyPanel.tsx` shows four tiles (earned, spent, calls served,
budget left today) fetched from `GET /api/scout/stats` on mount with a 5-second
poll. It is mounted inside `app/DashboardPanel.tsx` alongside the existing
analytics panels.

---

## Setup

1. **Generate Scout's EOA and register ERC-8004:**

   ```bash
   node --env-file=.env.local --experimental-strip-types scripts/scout-setup.ts
   ```

   This generates a private key (print it, add to `.env.local` as
   `SCOUT_PRIVATE_KEY`), registers Scout on the IdentityRegistry, and makes an
   initial Gateway deposit. Run once per environment.

2. **Apply the payments table:**

   Run `schema-x402-payments.sql` in the Supabase SQL editor.

3. **Set environment variables** (see `.env.example`):

   ```ini
   SCOUT_PRIVATE_KEY=0x...
   SELLER_ADDRESS=0x...          # Splitsy treasury DCW — receives x402 earnings
   SCOUT_DAILY_CAP_USDC=1
   SCOUT_ERC8004_TOKEN_ID=...    # set after scout-setup.ts runs
   NEXT_PUBLIC_BASE_URL=https://your-deployment.vercel.app
   ```

4. **Fund Scout's Gateway balance** — use the Circle faucet to send test USDC
   to Scout's EOA on Arc Testnet, then `scout-setup.ts` deposits it into the
   Gateway. Repeat when the balance runs low.

---

## Graceful Degradation

| Failure | Behaviour |
|---|---|
| Facilitator verify/settle error | Fall back to `lib/ocr-core.ts` direct parse; log error; human UX unaffected |
| Budget exhausted | Return best-effort parse with `lowConfidence: true`; no further spend |
| Image too small / low-res | Return 400 with a user-facing reason; no spend |
| External x402 enrichment unavailable | No-op (feature-flagged via `SCOUT_ENRICH_ENABLED`) |

---

## Arc Testnet Constants

| Name | Value |
|---|---|
| Network CAIP-2 | `eip155:5042002` |
| USDC | `0x3600000000000000000000000000000000000000` |
| Gateway Wallet | `0x0077777d7EBA4688BDeF3E311b846F25870A19B9` |
| RPC | `https://rpc.testnet.arc.network` |
| ERC-8004 IdentityRegistry | `0x8004A818BFB912233c491871b3d84c89A494BD9e` |

All constants live in `lib/x402/constants.ts`.
