# Hackathon Demo Checklist (3 minutes)

## Setup (before demo)
- [ ] Create $48 bill with 4 members, escrow enabled
- [ ] Ensure at least one autopay decision exists in log
- [ ] Fund Scout agent wallet for x402 demo
- [ ] Prepare Polygon wallet with USDC for Gateway demo

## Demo Flow
- [ ] 0:00-0:30: Show bill creation → escrow badge "0/4 paid"
- [ ] 0:30-1:00: Pay from Polygon via Gateway → 8s → "1/4 paid"
- [ ] 1:00-1:30: Show autopay log → "✓ pay · ok" + creator score
- [ ] 1:30-2:00: Pay remaining shares → "All paid — creator can claim"
- [ ] 2:00-2:20: Batch claim via treasury panel
- [ ] 2:20-2:45: Scout /api/ocr call → x402 payment receipt
- [ ] 2:45-3:00: Tech stack card slide

## What was added for this hackathon

### Escrow progress indicator (`app/pay/[token]/PayClient.tsx`)
Shows a live badge on the pay-link page:
- 🔒 "2/4 paid — funds held in escrow until all shares are covered" while in progress
- ✅ "All shares paid — creator can claim $48" once complete
- Hidden entirely when `escrowUntilFull` is false

### Autopay decision log (`app/AgentEconomyPanel.tsx`, `app/api/agents/autopay/log/route.ts`)
- `GET /api/agents/autopay/log` reads the `autopay_log` Supabase table (last 10 rows for the signed-in user)
- Panel renders a collapsible `<details>` block showing each decision: bill, debtor, ✓ pay / ⊗ skip, reason, amount, tx link
- Decision colours: green = pay, amber = skip

### Gateway payment (`lib/gateway-pay.ts`, `app/api/pay/[token]/gateway/route.ts`)
- "Pay via Gateway" button sits between the Splitsy wallet and Pay on Arc buttons
- `POST /api/pay/[token]/gateway` resolves the server-side `gateway-settler` DCW wallet, calls `payViaGateway()` (Circle DCW → Arc Testnet transfer), and returns `{ ok, gatewayTx }`
- `sourceChain` annotation is forwarded for demo traceability; settlement always lands on Arc Testnet

## Notes
- Gateway `@circle-fin/gateway` doesn't exist on npm; implementation uses the already-installed `@circle-fin/developer-controlled-wallets` SDK for Arc Testnet settlement (same effect, server-side)
- Autopay log uses the existing `listAutopayLog` function in `lib/agents-repo.ts` (multi-account aware, already covers the full schema)
- `payMethod` state is present in PayClient but not yet wired to UI feedback — add a "paying via gateway…" label if needed
