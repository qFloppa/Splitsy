# Splitsy — hackathon project description

Programmable Money Hackathon. DeFi track + Agentic Economy track.

- Demo: https://splitsy.xyz
- Repo: https://github.com/qFloppa/Splitsy

---

Scan a receipt, that's it. Splitsy reads the bill for you, splits it, and lets you tag each person by their social handle (X, Discord, Google or Email). From one photo you're done: the people you tagged get paid-in-stablecoin requests even if they've never touched crypto! no wallet address to ask for, no seed phrase, no gas token. They just log in, and settle in USDC on Arc.

Here's the part that pays for itself: the scan isn't done by Splitsy, it's done by Scout, an autonomous agent with its own wallet, its own ERC-8004 identity on Arc, and a daily budget of five cents. Scout sizes up your photo before spending anything, then buys the parse from Splitsy's own x402 endpoints, $0.005 for OCR and $0.001 for currency conversion, paying per call in USDC fractions. If a parse comes back under 0.80 confidence it buys a second opinion and keeps the better one. Every payment is a gasless signature that Circle Gateway batches and settles on Arc, so Scout never sends a transaction or touches a gas token. Splitsy is both the seller and the agent's principal, so you can watch a real agent economy settle onchain. And if the paid path ever fails your upload still works, it just falls back to an unpaid parse.

Want the blockchain as the source of truth instead? Connect a normal wallet (MetaMask/Rabby) and run the split as a trustless onchain bill escrowed in the registry, discoverable and auditable with zero dependence on Splitsy's servers.

Once a few bills pile up, the Treasury view collapses them: every share you owe and are owed nets into one figure per person, so you see your real exposure instead of a list. Hit "Settle net" and the whole thing goes out as one batch. On a Splitsy wallet that is literally one atomic transaction, every approval, payment and claim bundled together, all-or-nothing; five debts and four claims would otherwise be 14 separate transactions. To be straight about it: each debt is escrowed to its own bill onchain, so batching removes transactions, not transfers, and every amount is re-read from the chain before anything is signed.

And for costs that repeat, spin up recurring USDC tabs; weekly, monthly, or custom! that pull each member's fixed share automatically while their funds stay in their own wallet until a cycle is due.

---

## Accuracy notes

Every figure traces to code, same as the deck:

| Claim | Source |
| --- | --- |
| `$0.005` / `$0.001` | `lib/x402/pricing.ts` |
| `0.80` confidence gate | `lib/scout/decide.ts` (`CONFIDENCE_THRESHOLD`) |
| five cent daily budget | `SCOUT_DAILY_CAP_USDC` default, `lib/scout/deps.ts` |
| gasless, Gateway-batched | EIP-3009 authorization, `@circle-fin/x402-batching` |
| unpaid fallback | `runScout`'s `degraded` path, `lib/scout/scan.ts` |
| one atomic transaction | `encodeExecuteBatch` on the Circle SCA wallet, `app/api/treasury/settle/route.ts` |
| 14 transactions | `grossTxCount = 2 * payLegCount + claimLegCount`, so `2*5 + 4` |
| amounts re-read from chain | both settle paths; neither accepts a client-supplied amount |
| X / Discord / Google / Email | the four identity providers actually wired up |

Two things deliberately worded this way, to match what the product itself says:

1. Batching removes **transactions, not transfers**, and the net figure is
   **exposure**. `lib/treasury.ts` and `DashboardPanel` state the same, so a judge
   reading the repo finds agreement rather than a contradiction.
2. No em dashes.
