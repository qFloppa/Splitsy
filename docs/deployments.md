# Deployments

One repo, two wallet stacks. `WALLET_PROVIDER` is the only switch, and `circle`
is the default in `walletProviderName()` (`lib/wallet-provider.ts:42`) — the match
is exact, so a typo, a capitalised value or an unset variable in a new
environment all land on the Circle stack rather than the newer one.

The Preview column below describes the arrangement this branch is meant to run
under. The console half of it — the branch domain, the four OAuth/Turnstile
callback registrations and the environment variables — is done by hand; nothing in
this repo asserts it is in place.

---

## Which is which

| | splitsy.xyz (Production) | privy.splitsy.xyz (Preview) |
|---|---|---|
| Branch | `main` | `privy-wallet-stack` |
| `WALLET_PROVIDER` | unset → `circle` | `privy` |
| Wallets | Circle DCW, SCA | Privy embedded, EOA |
| Network | Arc Testnet (5042002) | Arc Testnet (5042002) |
| Database | `mhm233's Project` | `splitsy-test` (`hdyioojrozodmutpldsu`) |
| Autopay money-mode default | `mandate` | `funded` |
| Agent spend cap | `decideAutopay` only | `decideAutopay` + a Privy enclave policy |
| Settle net | works | **refused, 503** |
| Arming an on-chain mandate | works | **throws** |
| Mandate address env | whatever Production holds | **must not inherit it** |
| Circle env vars | set | absent |
| Banner | none | "Privy stack — Arc Testnet" |

That money-mode row is the server's answer for a save that does not name a mode
(`defaultMoneyMode()`, `lib/autopay.ts:175`), not what accounts are on. The
settings panel sends `funded` on every save on both stacks
(`app/SettlementAgentsPanel.tsx:418`) because it is the only mode it knows how to
describe, and the PUT keeps `funded` when asked for it and falls back to the
default otherwise (`app/api/agents/grants/route.ts:232`). `splitsy-test`'s column
default is `'funded'` and no row in it is on `'mandate'`.

`CIRCLE_WEBHOOKS_ENABLED` is one of the Circle variables that must stay absent on
Preview, and it is absent for a reason of its own rather than as tidiness. Unset,
`app/api/debts/[id]/pay/route.ts:68` marks a debt paid on the spot, and on this
stack the id it stores IS the chain hash (`lib/privy-wallet.ts:375`), so
`paid_tx_hash` holds something an explorer resolves. Set it, and — with no Circle
webhook coming to confirm a Privy transfer — every debt would sit in `settling`
for ever.

---

## The banner

`NEXT_PUBLIC_STACK_LABEL` is the whole mechanism (`app/layout.tsx`): a non-empty
value renders a row naming the stack, anything else renders nothing. Production
leaves it unset, so forgetting it produces an unlabelled preview rather than a
mislabelled live site.

What `NEXT_PUBLIC_*` inlining actually does here, measured against a build rather
than assumed. The bundled guide
(`node_modules/next/dist/docs/01-app/02-guides/environment-variables.md`) says
these are inlined at build time, "replacing all references to
`process.env.[variable]` with a hard-coded value", and frozen thereafter. That is
what happens when the variable **is** set at build time: the compiled server
chunk for `lib/supabase.ts` carries its Supabase URL as a literal and no longer
mentions `NEXT_PUBLIC_SUPABASE_URL` at all. When it is **not** set, the reference
survives verbatim — the root layout's SSR chunk still contains
`process.env.NEXT_PUBLIC_STACK_LABEL ? … : null` and evaluates it per request,
which it can because the layout renders dynamically. So: unset renders nothing
either way, and a changed value wants a redeploy, because the inlined case cannot
see a new one.

---

## The Privy stack is not the Circle stack minus Circle

Four differences no variable papers over. Three of them are one fact: a Privy
wallet is an **EOA** where a Circle DCW is a smart contract account.

**Settle net is unavailable.** `app/api/treasury/settle/route.ts:63` refuses with
503 when `WALLET_PROVIDER=privy`. The route is one `executeBatch` sent to the
wallet's own address, which only an SCA can execute — and an EOA does not revert
on calldata it cannot run, it **succeeds and does nothing**. Measured, not
reasoned: tx `0x5870092926417f148363962be768594b7e555bfd7d7f6e8d82f1547b00dadf95`
(block 60147923) carried 324 bytes of `executeBatch` calldata to a Privy wallet's
own address and came back `status: 0x1`, `gasUsed: 25290` — base cost plus
calldata, zero execution — `logs: []`, with `eth_getCode` on the target `0x`.
Before the refusal the route answered `{ok: true, paid: […]}` naming every leg as
settled and queued ERC-8004 payment feedback for debts nobody paid.

**Arming an on-chain mandate throws.** `app/api/agents/grants/route.ts:363`, for
the same reason — `approve` + `setMandate` are sent as one `executeBatch`.
Revoking still works, because revoking is a single call. It is unreachable twice
over today: `NEXT_PUBLIC_AUTOPAY_MANDATE_ADDRESS` is unset, so
`isMandateConfigured()` is false and `:312` returns first, and the mode is always
`funded` here, so the PUT hands the sync `enabled: false` and the revoke branch
returns before the throw. The throw is there for the deployment that changes one
of those.

**The agent wallet's cap is enforced inside Privy's enclave, per transaction.**
The policy in `PRIVY_AGENT_POLICY_ID` is attached to the signer at wallet
**creation** (`lib/privy-wallet.ts:418`), so it applies from the agent's first
signature and cannot be argued with by a bug in `decideAutopay`. It caps a
**single transaction** only. A rolling daily total is expressible in Privy's API —
an Aggregation over a rolling window, 1-72 hours, function `sum` — but
`@privy-io/node@0.34.0` ships `Aggregations` as an empty class
(`resources/aggregations.d.mts:4`), so there is no method to create one. The daily
cap therefore remains `sumAutopaySpentTodayUsdc` (`lib/agents-repo.ts:343`) on
both stacks, enforced off chain.

**`privy_wallets` exists only in `splitsy-test`.** The Circle stack never reads
it: `lib/privy-wallet.ts` is the only importer of `lib/privy-wallets-repo.ts`, and
it is lazy-imported by `backend()` (`lib/wallet-provider.ts:46`) only when the
provider is `privy`.

---

## Before the first sign-in on Preview

**`PRIVY_AGENT_POLICY_ID` must be set in Preview before any user signs in.** The
policy attaches at wallet creation and nowhere else; the adopt path reads an
existing wallet's signers only to confirm our key quorum can sign, never to see
what policies that signer carries, and no code detects a wallet that lacks one.
An agent wallet minted before the variable is set is uncapped **forever** —
bounded only by `decideAutopay`, which is our own code — and nothing surfaces it.
The id is produced by `npm run privy:policy -- <per-transaction cap in USDC>`,
which prints it; each run creates a new policy and edits nothing.

**Set the cap above the largest per-bill cap a user can save.** The enclave
refuses at step 4 of the six-step settlement ceremony, *after* the job fee is
escrowed at step 3, so a cap set too low burns 0.01 USDC plus gas on every bill
the user's own rules allow, on a job that then sits until its one-hour TTL
expires.

---

## Shared contracts

Both stacks read and write the same deployed Arc Testnet contracts —
BillSplitRegistry, RecurringTabFactory and the ERC-8004 registries. That is
deliberate: no redeploy is needed while both are on testnet. It does mean preview
activity lands on the contracts the live site reads. Live users never see it,
because each stack resolves bills by its own wallet addresses out of its own
database.

Arc mainnet is not live for either stack: see
`docs/superpowers/specs/2026-09-01-privy-wallet-stack-design.md` "Deliberately
deferred". Handing `splitsy.xyz` to the Privy stack is Task 8 of
`docs/superpowers/plans/2026-09-01-privy-wallet-stack.md` and has not happened.

---

## Never point the two at one database

`users.circle_wallet_id` holds an opaque provider id and one row cannot name a
wallet in both systems. Sharing the database would also put this stack's writes
in front of live users, which is the one outcome the whole arrangement exists to
prevent.

---

## Open question: Settle net on an EOA

Making net settlement work on the Privy stack needs a decision nobody has taken.
Two candidates, neither costless:

- **Two sequential transactions** — `approve`, then `settle`. Atomicity is what
  the feature is for (`docs/treasury.md`), and this gives it up: a failure
  between the two leaves an approval standing with nothing settled.
- **An `approve` + `settle` entry point on the registry** — atomic again, but it
  is a contract change and a redeploy, and both stacks go on reading the current
  registry until each is pointed at the new one.

Until one is chosen, the 503 is the answer, and it is the honest one: the
alternative was a success response for money that never moved.
