# Landing page — the agent economy pass

The landing page tells the story as it stood before autopay became an agent
economy: Scout buys OCR over x402, and a human pays their share by hand. Two
things shipped since and neither is on the page.

1. **Every user must fund their own agent** before autopay can settle anything.
   That is a real product change with a real friction cost, and a page that
   hides it sells something the app will refuse to do.
2. **A third paid endpoint exists.** `/api/agents/review` — the Auditor sells a
   bill review and the Settler buys it before every settlement. x402 stopped
   being one agent buying from Splitsy and became a market with two sellers.

The page also still positions purely around humans splitting receipts. The
agentic layer is real and load-bearing; it should be a co-equal pillar rather
than a footnote.

---

## Positioning: dual-pillar, not a reposition

The product is still receipt-splitting for people. Most bills are still paid by
hand. Leading with "receipts settle themselves" would be selling the exception.

So the hero keeps its promise and its accent line takes on the second pillar:

| | Before | After |
|---|---|---|
| accent | `Anyone. Anywhere.` | `Anyone — or their agent.` |
| lede | scan · tag · settle in USDC | the same, plus *"Or fund an agent and let it settle your share for you — under ceilings you set."* |

`Anywhere` is not lost — `SectionAnyone` ("No wallet? No problem") still owns
that claim two sections down, with the four provider chips as its proof.

The SplitType reveal is unaffected: it splits on whitespace, so the spaced em
dash becomes its own word and slides up with the rest.

---

## Structure: a two-act agent chapter

```
Hero → Demo → §Agents that buy   (existing SectionAgent, reframed)
            → §Agents that pay   (new SectionAutopay)
            → §The market        (new SectionMarket)
            → Anyone → Onchain → Treasury → Stack → CTA
```

The two acts are labelled with a small uppercase kicker. **The kicker reuses
`SectionStack`'s existing origin-label vocabulary** — `text-[0.62rem]
font-extrabold uppercase tracking-[0.08em] text-[var(--text-muted)]` — rather
than inventing a class. One less thing in `globals.css` to keep consistent.

`SectionAgent` gets the kicker and nothing else. Its heading, lede and
`AgentStage` are accurate today; rewriting them to make room for a sibling
section would be churn.

### Why the new section is static

`DemoStage` pins the scroll and `AgentStage` autoplays a looping transcript.
A third timeline would compete with both for attention and for frame budget.
`SectionAutopay` is a scroll-reveal diptych — the same `gsap.from` +
`ScrollTrigger` pattern `SectionTreasury` already uses, no pin, no loop.

---

## §Agents that pay — `components/landing/SectionAutopay.tsx`

> # Fund an agent. **It settles your share.**
>
> A bill raised against you can be settled without you opening the app. The
> agent is yours — one per account, holding its own USDC on Arc. It spends only
> what you have sent it, only under ceilings you set, and every settlement it
> makes is a public job a second agent has to sign off before any fee is
> released.

### Left — "You fund it first"

| Element | Content | Source of truth |
|---|---|---|
| balance | `2.00 USDC`, labelled *suggested first top-up* | `DEFAULT_FUND_USDC` in `app/SettlementAgentsPanel.tsx` |
| routes | connected browser wallet · your Splitsy wallet · any address | the three routes in `docs/agent-economy.md#funding` |
| the ceiling | *"Funding is a plain transfer, never an approval. An agent holding 5 USDC can never spend 6."* | balance-as-custody, same doc |
| unfunded | *"Until it holds USDC every bill is skipped with `agent_unfunded` — no job, no transaction, nothing owed."* | `app/api/agents/autopay/route.ts:418-422` |

The agent address on the card is illustrative and is labelled as such, exactly
as `AgentStage` labels its own illustrative address and tx hash.

### Right — "Then it has to prove it"

Three role chips over *"three distinct wallets, so nobody grades their own
work"*:

| Role | Who |
|---|---|
| client | your agent |
| provider | the Splitsy Settler |
| evaluator | the Splitsy Auditor |

Then the six-step trail, each step naming its signer:

```
1  createJob    your agent
2  setBudget    the Settler prices its own work
3  fund         0.01 USDC into escrow
4  payDebtFor   the only step that moves bill money
5  submit       keccak256(settlement tx)
6  complete     the Auditor, only when paid ≥ owed
```

Footnote: the escrow only ever holds the fee. If the audit fails the job
expires an hour later and the Settler is not paid.

### Closing facts

Three short items, all checked:

- **6 transactions per settled share** — per share, not per bill.
- **A skip costs zero** — the decision happens before `createJob`.
- **The reputation credits you, not the agent** — `payDebtFor` emits `DebtPaid`
  naming the debtor.

### What this section must not claim

In Funded mode the on-chain caps in `AutopayMandate` are **not** in the path.
The rules are evaluated off-chain before the agent spends. The copy says
"checked before it spends" and points at the balance as the hard ceiling — it
never says "enforced by a contract". Mandate mode is not mentioned at all: no
UI puts a user there any more.

---

## §The market — `components/landing/SectionMarket.tsx`

> # Three endpoints. **Priced in half-cents.**
>
> Splitsy's paid APIs answer HTTP 402 with their own terms. Any agent that signs
> an offchain EIP-3009 authorization gets served — no account, no API key, and
> no gas, because Circle's facilitator batches the settlement.

| Endpoint | Price | Seller → Buyer |
|---|---|---|
| `/api/ocr` | `$0.005` | Splitsy → Scout, per receipt scan |
| `/api/fx` | `$0.001` | Splitsy → Scout, non-USD receipts only |
| `/api/agents/review` | `$0.002` | the Auditor → the Settler, before every settlement |

**Prices are imported from `lib/x402/pricing.ts`**, never restated — the same
discipline `demo/agent-script.ts` already follows, so the page cannot advertise
a price the seller does not charge.

Footnote: the third row is Splitsy's own agents trading with each other, and it
is **excluded** from the earned/spent tiles in the section above, because nobody
outside paid it. That exclusion is real — `INTERNAL_ENDPOINTS` in
`lib/x402/payments-repo.ts` — and saying so is worth more than the 0.002 it
would add to a headline figure.

No live figures here. `getAgentStats()` deliberately cannot report the review
trade, so a "live" tile for it would either be fabricated or would require
loosening an exclusion that exists for a good reason.

---

## §Stack — one new card

**ERC-8183 agent jobs**, origin *ERC standard*, proof
`AgenticCommerce 0x0747…4583`, linking to
`https://docs.arc.io/arc/tutorials/create-your-first-erc-8183-job`. The address
was checked against Arc's own docs page, which lists the same deployment.

The existing `x402` card's proof line stays as it is — it quotes the OCR price
from `PRICES` and remains true.

---

## Accuracy risk, accepted deliberately

`docs/agent-economy.md` marks the job ceremony **UNVERIFIED**: Q2 (can the
evaluator `complete` a job it is not the client of?) could still force a design
change, and Q5–Q7 have never been run end to end. The copy describes the code
that ships, which is what a product page does — but nobody has watched this
succeed on chain.

Raised with the user before writing; they chose to describe it plainly. If Q2
forces the evaluator and client to be the same wallet, the "three distinct
wallets" claim and the role table are what have to change here.

---

## Files

| File | Change |
|---|---|
| `components/landing/Hero.tsx` | accent line + lede |
| `components/landing/SectionAgent.tsx` | kicker only |
| `components/landing/SectionAutopay.tsx` | new |
| `components/landing/SectionMarket.tsx` | new |
| `components/landing/SectionStack.tsx` | one card |
| `components/landing/LandingPage.tsx` | two imports, two slots |
| `components/landing/Nav.tsx` | `Agent APIs` → `Agents` |

No new dependencies, no `globals.css` changes, no new API routes.
