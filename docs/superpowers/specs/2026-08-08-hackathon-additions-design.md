# Hackathon Additions Design

> **Created:** 2026-08-08  
> **For:** DeFi Track + Agentic Economy Track dual submission

## Goal

Add three targeted features to maximize Splitsy's coverage of both hackathon tracks' core products:

1. **Gateway pay option** — fast-chain cross-chain payments (Polygon, Avalanche, Solana)
2. **Autopay decision log UI** — surface agent decision signals in real time
3. **Escrow progress indicator** — make conditional-payment story visually obvious

## Track Coverage

### DeFi Track Core Products
- ✅ Arc (already)
- ✅ USDC (already)
- ✅ App Kits (already: CCTP bridging, Circle Wallets)
- ✅ CCTP (already: `appkit-bridge.ts`)
- ✅ Gateway (NEW: fast-chain payment path)
- ✅ Circle Wallets (already: DCW + browser wallet dual-identity)
- ⚠️ StableFX (DROPPED: only USDC↔EURC, existing FX API covers more currencies)

### Agentic Economy Track Core Products
- ✅ Arc (already)
- ✅ USDC (already)
- ✅ Agent Stack (already: autopay, dunning, netting agents)
- ✅ App Kits (already)
- ✅ Circle Wallets (already)
- ✅ Nanopayments (already: x402 Scout)
- ✅ Paymaster (already: CCTP bridge path in `paymaster-bridge.ts`)
- ✅ Agent decision signals (NEW: autopay log UI)

## Architecture

### Addition 1: Gateway Pay Option

**Scope:** Only fast chains (Polygon ~8s, Avalanche ~8s, Solana ~8s, Sei ~5s, Sonic ~8s). Ethereum/Base/Arbitrum stay on CCTP path (~15-19 min).

**Flow:**
1. User opens `/pay/[token]` with wallet on Polygon
2. Sees "Pay via Gateway" button (fast chains only)
3. Click → POST `/api/pay/[token]/gateway` with `{ debtor, amount }`
4. Server: Gateway client settles cross-chain USDC → calls `payBillDebtFor` on Arc to credit registry
5. UI: 8-second confirmation, same success state as existing paths

**Files:**
- `lib/gateway-pay.ts` — Gateway client init + payment logic
- `app/api/pay/[token]/gateway/route.ts` — server handler
- `app/pay/[token]/PayClient.tsx` — add Gateway button

**Why Gateway over CCTP for fast chains:**
- CCTP Fast Transfer: 8 seconds (same as Gateway)
- But Gateway is a unified balance — no source chain picker, payer sees one USDC balance across all chains
- Demonstrates "stablecoin-native infrastructure changes what is possible"

### Addition 2: Autopay Decision Log UI

**What:** Read `autopay_log` table and surface in `AgentEconomyPanel`.

**Why:** "Agents with clear decision logic tied to real signals" — the log already records `ok`, `over_daily_cap`, `low_creator_score`, `hash_mismatch`, `untrusted_creator`. This makes it visible.

**Flow:**
1. User opens `/app`, sees Agent Economy panel
2. New collapsible section: "Decision log (last 10)"
3. Each row: bill #, debtor (truncated), decision badge (✓ paid / ⊗ skipped), reason, amount, tx link

**Files:**
- `lib/agents-repo.ts` — add `listAutopayDecisions(userId, limit)`
- `app/api/agents/autopay/log/route.ts` — GET handler
- `app/AgentEconomyPanel.tsx` — render decision log

**Data shape:**
```ts
type DecisionLogRow = {
  billId: string;
  debtorAddress: string;
  decision: "pay" | "skip";
  reason: string;
  amountUsdc: number;
  txHash: string | null;
  createdAt: string;
};
```

### Addition 3: Escrow Progress Indicator

**What:** When `escrowUntilFull: true`, show "2/3 paid — funds held in escrow" badge on pay poster.

**Why:** Escrow-conditional payment is the strongest DeFi primitive already built. It just needs to be visually obvious.

**Flow:**
1. Payer opens pay link
2. If `escrowUntilFull: true` and not all shares paid, show escrow badge with lock icon
3. Badge shows: "{paidCount}/{totalCount} paid — funds held in escrow until all shares are covered"
4. When all paid, badge changes to: "All shares paid — {creator} can claim {total}"

**Files:**
- `app/pay/[token]/PayClient.tsx` — compute escrow state, render badge
- `app/globals.css` — add `.escrow-badge` styles

## Demo Script (3 minutes)

| Time | Action | Track Coverage |
|------|--------|----------------|
| 0:00–0:30 | Create $48 dinner bill (4 friends) → escrow enabled → "0/4 paid — funds held in escrow" | DeFi: conditional payment |
| 0:30–1:00 | Friend 1 pays from Polygon via Gateway → 8s confirmation → "1/4 paid" | DeFi: Gateway, Arc, USDC |
| 1:00–1:30 | Friend 2: autopay panel → decision log shows "ok — paid $12" + creator score + hash verification | Agentic: decision signals |
| 1:30–2:00 | Friends 3 & 4 pay → escrow releases → "All paid — creator can claim $48" | DeFi: conditional release |
| 2:00–2:20 | Creator batch-claims → one approve + one settle() for all 4 legs | DeFi: batch settlement |
| 2:20–2:45 | Scout: `/api/ocr` call → pays 0.001 USDC via x402 → feeds autopay | Agentic: nanopayments |
| 2:45–3:00 | Tech stack card: Arc · USDC · CCTP · Gateway · Wallets · Paymaster · x402 · Agent Stack · ERC-8183 | Both tracks |

## Dependencies

- Gateway SDK: `@circle-fin/gateway` (already installed via x402-batching dependency)
- No new npm packages needed

## Environment Variables

```env
# Gateway API key (required for Addition 1)
CIRCLE_API_KEY=<existing key, already set for DCW>
```

## Testing Strategy

**Addition 1 (Gateway):**
- Unit: mock Gateway client, verify payment flow
- Integration: testnet payment on Polygon → verify registry credit on Arc

**Addition 2 (Decision log):**
- Unit: `listAutopayDecisions` returns correct shape
- Integration: seed autopay_log → verify UI renders

**Addition 3 (Escrow indicator):**
- Unit: escrow state computed correctly
- Visual: screenshot escrow badge in both states (in-progress, released)

## Risks

**Gateway confirmation time:** 8 seconds is honest for fast chains, but Ethereum/Base/Arbitrum (~15-19 min) would be unusable. Mitigation: only show Gateway button for fast chains.

**Autopay log empty for new users:** The panel should gracefully handle empty log with "No autopay decisions yet — bills will appear here as your agent evaluates them."

**Escrow badge clutter:** Badge should only show when escrow is active. When bill is settled or not escrowed, hide it.

## Out of Scope

- Gateway support for slow chains (Ethereum, Base, Arbitrum) — keep CCTP path
- StableFX integration (only handles USDC↔EURC, less useful than existing FX API)
- Paymaster for autopay settlements (Arc gas is already USDC-native, nothing to add)
