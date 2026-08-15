# Splitsy — hackathon project description

Programmable Money Hackathon. DeFi track + Agentic Economy track.

- Demo: https://splitsy.xyz
- Repo: https://github.com/qFloppa/Splitsy

---

Scan a receipt, that's it. Splitsy reads the bill for you, splits it, and lets you tag each person by their social handle (X, Discord, Google or Email). From one photo you're done: the people you tagged get paid-in-stablecoin requests even if they've never touched crypto! no wallet address to ask for, no seed phrase, no gas token. They just log in, and settle in USDC on Arc.

Here's the part that pays for itself: the scan isn't done by Splitsy, it's done by Scout, an autonomous agent with its own wallet, its own ERC-8004 identity on Arc, and a daily budget it cannot exceed. Scout sizes up your photo before spending anything, then buys the parse from Splitsy's own x402 endpoints, $0.005 for OCR and $0.001 for currency conversion, paying per call in USDC fractions. If a parse comes back under 0.80 confidence it buys a second opinion and keeps the better one. Every payment is a gasless signature that Circle Gateway batches and settles on Arc, so Scout never sends a transaction or touches a gas token. Splitsy is both the seller and the agent's principal, so you can watch a real agent economy settle onchain. And if the paid path ever fails your upload still works, it just falls back to an unpaid parse.

Scout is only the first customer, because the same endpoints are open to anybody's agent. `GET /api/agents/catalog` is free to read and lists every paid service with its price, input shape, example call and payment terms, so an agent can discover the whole market and start paying without a human in the loop. Three of those services exist purely for outside agents, at $0.001 a call: an ERC-8004 reputation oracle that answers for a wallet or a social handle, a debt-netting solver that turns a pile of charges into the fewest USDC transfers, and a dunning verdict that says whether to nudge, escalate or collect on an overdue share. No account, no API key, no signup: pay per call in USDC over Gateway and the response comes back with its own receipt.

Autopay is where the agents start trading with each other. Every settlement runs as an ERC-8183 job on Arc's already-deployed AgenticCommerce contract with three separate wallets, so nothing grades its own work: your own agent is the client that posts the job and escrows the fee, the Splitsy Settler is the provider that does it, and the Splitsy Auditor is the evaluator that decides whether the Settler gets paid at all. Before any of that, the Settler has to buy a bill review from the Auditor for $0.002 over x402, out of its own fee income; a 402, a timeout or an unreadable verdict all read as no, and a Settler that cannot buy a review settles nothing. At the end the Auditor reads `getParticipant` on the registry itself and releases the escrow only when paid is at least owed, with `keccak256(settlementTxHash)` as the deliverable so anyone holding the settlement transaction can recompute it and check the job against it. A refusal costs zero transactions, because the decision happens before the job is opened. A settlement costs six, and the escrow only ever holds the 0.01 USDC fee, never the bill money.

You fund that agent yourself, and it is a plain USDC transfer rather than an approval, so its balance is the hard ceiling: an agent holding 5 USDC can never spend 6. Under that ceiling it checks a per-bill cap, a rolling daily cap, a creator allowlist, an ERC-8004 score floor, whether the published bill details still recompute to the hash committed onchain, and the bought review of whether your share is even plausible. The last two fail closed. Every decision is logged with its reason, and the skips are the point: they are the evidence the rules bind. Underfunded is its own logged outcome that opens no job and costs nothing. And because the settlement call credits you as the payer, the reputation earned flows to you rather than to your agent.

The creditor side has an agent too. Once a day it sweeps the bills you raised that carry a due date and still have an unpaid share, emails a nudge three days out, escalates once the deadline passes, and where the debtor authorised collection on that specific bill in the registry pulls the overdue amount onchain instead of asking again. Being straight about it: once a day means within a day, not the moment it comes due, and a nudge is an email, because the X and Discord DM APIs are gated behind scopes a signin flow doesn't get.

Want the blockchain as the source of truth instead? Connect a normal wallet (MetaMask/Rabby) and run the split as a trustless onchain bill escrowed in the registry, discoverable and auditable with zero dependence on Splitsy's servers.

Once a few bills pile up, the Treasury view collapses them: every share you owe and are owed nets into one figure per person, so you see your real exposure instead of a list. Hit "Settle net" and the whole thing goes out as one batch. On a Splitsy wallet that is literally one atomic transaction, every approval, payment and claim bundled together, all-or-nothing; five debts and four claims would otherwise be 14 separate transactions. To be straight about it: each debt is escrowed to its own bill onchain, so batching removes transactions, not transfers, and every amount is re-read from the chain before anything is signed.

And for costs that repeat, spin up recurring USDC tabs; weekly, monthly, or custom! that pull each member's fixed share automatically while their funds stay in their own wallet until a cycle is due.

---

## Accuracy notes

Every figure traces to code, same as the deck:

| Claim | Source |
| --- | --- |
| `$0.005` / `$0.001` / `$0.002` | `lib/x402/pricing.ts` |
| `0.80` confidence gate | `lib/scout/decide.ts` (`CONFIDENCE_THRESHOLD`) |
| Scout's daily budget | `SCOUT_DAILY_CAP_USDC`, `lib/scout/deps.ts` (1 USDC in this deployment, so no figure is quoted in the prose) |
| gasless, Gateway-batched | EIP-3009 authorization, `@circle-fin/x402-batching` |
| unpaid fallback | `runScout`'s `degraded` path, `lib/scout/scan.ts` |
| free discovery catalog | `app/api/agents/catalog/route.ts` |
| three `$0.001` services for outside agents | `/api/reputation`, `/api/agents/netting`, `/api/agents/dunning/verdict` in `PRICES` |
| client / provider / evaluator wallets | `docs/agent-economy.md`, roles table; three distinct wallets |
| six transactions per settled share, zero on a skip | `app/api/agents/autopay/route.ts` ceremony, cost table in `docs/agent-economy.md` |
| escrow holds only the `0.01` fee | `SETTLEMENT_FEE_USDC` default; bill money never enters the job |
| deliverable is `keccak256(settlementTxHash)` | `lib/erc8183.ts`, verified against `getParticipant` before `complete` |
| balance is the hard ceiling | funding is a USDC `transfer`, never an allowance; `agent_unfunded` opens no job |
| rules, and which fail closed | `lib/autopay.ts` (`require_verified_hash`, `require_bill_review`), `schema-agent-economy.sql` |
| reputation flows to the user | `payDebtFor` emits `DebtPaid` naming the debtor as payer |
| dunning: daily, 3-day nudge, email only | `vercel.json` (`0 12 * * *`), `NUDGE_WINDOW_SECONDS`, `lib/dunning.ts` |
| collection is authorised per bill | `BillSplitRegistry.authorizeCollect` / `collectMandate` / `collectDebt`, revocable by the debtor |
| one atomic transaction | `encodeExecuteBatch` on the Circle SCA wallet, `app/api/treasury/settle/route.ts` |
| 14 transactions | `grossTxCount = 2 * payLegCount + claimLegCount`, so `2*5 + 4` |
| amounts re-read from chain | both settle paths; neither accepts a client-supplied amount |
| X / Discord / Google / Email | the four identity providers actually wired up |

Three things deliberately worded this way, to match what the product itself says:

1. Batching removes **transactions, not transfers**, and the net figure is
   **exposure**. `lib/treasury.ts` and `DashboardPanel` state the same, so a judge
   reading the repo finds agreement rather than a contradiction.
2. The dunning cadence is stated as **within a day**. Vercel Hobby refuses to
   deploy a cron that fires more than daily, and the route comment says so.
3. No em dashes.
