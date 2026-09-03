# Privy Wallet Stack — Design

**Date:** 2026-09-01
**Status:** accepted, not yet built
**Supersedes (partially):** `2026-07-04-twitter-identity-design.md` §"Wallet underneath = Circle DCW"

## Problem

Splitsy's user wallets are Circle developer-controlled wallets (DCW). That was
chosen deliberately for a testnet demo: `2026-07-04-twitter-identity-design.md`
says custody risk is moot with valueless USDC, and notes "mainnet would
revisit." Arc public mainnet is **2026-09-16**. This is the revisit.

Three facts force a change rather than a config flip:

1. **Circle Wallets does not support Arc mainnet.** `ARC-TESTNET` is the only
   Arc row in Circle's supported-blockchains matrix, and the only testnet entry
   with no mainnet counterpart. `blockchain: "ARC-TESTNET"` is hardcoded at
   `lib/circle-dcw.ts:50` and `:99` with no mainnet value to become.
2. **DCW is custodial by construction.** One `CIRCLE_ENTITY_SECRET` authorizes
   every user wallet, and DCW keys cannot be exported — if Splitsy stops, user
   funds are stranded. Circle's own docs file DCW under "custodial flows."
3. **The per-user agent wallet is the worst of it.** `lib/user-agent.ts:1`
   describes it as "a Circle DCW they fund." Since AutopayMandate was retired in
   favour of funded mode, that wallet is a per-user float of the user's own money,
   spendable server-side, with caps enforced only by our own route —
   `lib/autopay.ts:129-131` says so outright.

Note what is *not* affected: the service agents already moved off DCW.
`lib/settler.ts:4-8` is a raw EOA ("deliberately not a Circle DCW, for one
reason: x402 needs a raw key"), same for `lib/scout/wallet.ts`, and
`app/api/agents/grants/route.ts:371-375` resolves the autopay agent to the
Settler EOA with "No DCW fallback any more." Every remaining DCW holds user
money.

## Decision

Run **two wallet stacks from one repo**, selected by a `WALLET_PROVIDER` env var,
and get there in two phases so the live site is never the thing being
experimented on.

**Phase 1 — build beside the live site (Tasks 1–7).** Work on the branch
`privy-wallet-stack`. `splitsy.xyz` keeps its domain, its database, its Circle
env and its `main` deployment — unchanged and unredeployed. The Privy stack goes
up on Vercel's **Preview** environment at `privy.splitsy.xyz`, pointed at the
`splitsy-test` Supabase project.

| | `splitsy.xyz` (Production) | `privy.splitsy.xyz` (Preview) |
|---|---|---|
| Branch | `main` | `privy-wallet-stack` |
| `WALLET_PROVIDER` | unset → `circle` | `privy` |
| Wallets | Circle DCW (SCA) | Privy embedded (EOA) |
| Network | Arc Testnet | Arc Testnet |
| Database | `mhm233's Project` | `splitsy-test` |

**Phase 2 — the flip (Task 8), only when explicitly chosen.** Merging to `main`
and moving the domains are two separate decisions, taken days apart. Merging
alone changes nothing a user can see, because Production never sets
`WALLET_PROVIDER` and `walletProviderName()` defaults to `circle`. Only the
domain move makes `splitsy.xyz` the Privy stack and demotes today's build to
`testnet.splitsy.xyz`. Rollback at that point is a domain move, not a deploy.

Not a migration. Both implementations ship and stay live. The demoted subdomain
preserves today's behaviour byte-for-byte, including the Circle SDK, the Gas
Station notes, and the SCP monitor.

### Why the default direction matters

`walletProviderName()` returns `privy` only on an exact string match, and
`circle` for everything else — a typo, a capitalised value, a variable an
environment forgot. The fallback is the stack whose USDC is worthless. That is
the most load-bearing line in the change: it means every way of being wrong
lands somewhere harmless.

### Why an interface with two implementations is justified here

Normally two implementations behind one interface is over-engineering. It holds
here because both are real, both ship at once, and the seam already exists:
`lib/circle-dcw.ts` exports exactly four functions, and all 19 API routes plus
`lib/oauth-callback.ts`, `lib/wallet-resolve.ts` and `lib/user-agent.ts` go
through them. The interface is a rename of a shape the codebase already has.

### Privy, specifically

- **Wallets only. Privy does not own login.** Keep the four working OAuth flows
  (`lib/twitter-oauth.ts`, `discord-oauth.ts`, `google-oauth.ts`,
  `email-otp.ts`) and the existing session cookie. Privy users are keyed to our
  own `users.id`. This deletes nothing and risks nothing on the identity spine
  15 days before launch.
- **Server SDK only, no client SDK.** All signing is server-side, so there is no
  `PrivyProvider`, no iframe, no CSP change, and no client bundle cost. One new
  dependency: `@privy-io/server-auth`.
- **Wallets are app-created with an app signer attached at creation.** Privy's
  pregeneration accepts `additional_signers` up front, so no per-user consent
  step is needed and server-driven pay/claim keeps working exactly as today.

### What this honestly is, and is not

It is **app-signed, user-exportable, policy-capped**. It is *not* "the user
holds the keys." Privy splits each key into two shares (an enclave share that
"can only be decrypted within the TEE" and an auth share "encrypted and stored
by Privy"), both inside Privy's infrastructure; 2-of-2 is required to sign.
Control rests on who holds the authorization key, and that is us.

What we gain over DCW is still substantial and is the point of the change:

- **Users can export their wallet.** DCW has no such exit. This alone justifies it.
- **Caps move out of our route and into the enclave.** A Privy policy refuses the
  transaction; `decideAutopay` can be wrong and the spend still cannot happen.
  That retires the `ponytail:` at `lib/autopay.ts:129-131` far cheaper than the
  AutopayMandate contract it names as the upgrade path.
- **Blast radius is scoped** by authorization key plus per-wallet policy instead
  of one entity secret over every wallet.
- SOC 2 Type I and II, audits by Cure53/Zellic/Doyensec, HackerOne bounty.

True self-custody would mean client-side signing on every action — a UX rewrite
of 13 routes. Deferred, deliberately.

### The agent wallet stays a separate wallet

The agent wallet gets its own Privy user, keyed `agent:<userId>`, rather than a
second `wallet_index` on the user's own Privy user. The two keys are different
shapes and cannot be merged without a third mapping table: a pay wallet is
per-identity (`<provider>:<providerUserId>`, from `lib/oauth-callback.ts`) while
the agent is one per ACCOUNT (`lib/user-agent.ts:4-7`). Keying it separately
falls straight out of the existing seam and needs no index parameter for one
caller.

Outcome is what matters and it is unchanged: a distinct address, its own
ERC-8004 identity, its own Privy policy cap. The cost is that when client-side
Privy auth eventually lands, exporting both wallets will be two flows rather
than one.

The tempting simplification — collapse to one wallet, no top-up, agent signs
from the user's own wallet — is rejected. It merges the agent's ERC-8004
identity into the user's, which `lib/user-agent.ts:146-158` is explicit about
being wrong ("this used to copy the reputation handover and left the agent
identity-less"). The top-up ritual has to survive regardless: per
`lib/user-agent.ts:9-11` the agent needs USDC for its own gas and the job fee it
escrows, in both money modes.

### Separate databases, and why that is not optional

`users.circle_wallet_id` is an opaque provider id. Two stacks writing one row
would give a user a `wallet_address` from one stack and an id the other stack
cannot sign with. The column is only written when `wallet_address` is null
(`lib/oauth-callback.ts:91`), so nothing is overwritten — it is simply wrong for
one of the two stacks. Separate Supabase projects; no schema change.

## Deliberately deferred

- **The PIN stays, in both stacks.** `verifyWalletUnlock` is a cookie check in
  the route (`app/api/debts/[id]/pay/route.ts:23-29`), entirely independent of
  which wallet signs, so it works unchanged on Privy. Retiring it in favour of
  Privy MFA is a follow-up, and it is 10 routes plus `lib/pin.ts` plus two
  gates in `app/XAuthControl.tsx:365-514` — orthogonal to this work.
- **Arc mainnet.** 161 occurrences of `arcTestnet` / `ARC-TESTNET` /
  `ARC_TESTNET_*` across 50 files, plus redeploying BillSplitRegistry,
  RecurringTabFactory and the ERC-8004 registrar. Separate plan, and blocked
  anyway: Arc mainnet's chain id, RPC and USDC address are unpublished
  (`docs.arc.io` still says "Arc is currently available on Testnet only"). Both
  stacks run Arc Testnet until those exist, which is what makes this plan
  testable today.
- **Retiring the AutopayMandate code path.** Dead once every armed user's row
  has migrated, but `syncMandateOnchain` at `app/api/agents/grants/route.ts:308`
  is still doing that migration. Separate cleanup.

## Open questions

1. **Privy policy expressiveness — RESOLVED (`docs/deployments.md:105-114`).** Yes in
   Privy's API: an Aggregation over a rolling window (1-72 hours, metric function
   `sum`) expresses a rolling daily total. No through `@privy-io/node@0.34.0`: the
   `PrivyClient` this repo uses exposes no `aggregations()` accessor at all
   (`public-api/PrivyClient.d.mts`), and the generated resource behind the low-level
   client is an empty class — `export declare class Aggregations extends APIResource
   {}` (`resources/aggregations.d.mts:4`) — so there is no method to create or read
   one. Only the PER-TRANSACTION cap moved into the enclave
   (`PRIVY_AGENT_POLICY_ID`); `sumAutopaySpentTodayUsdc` stays authoritative for the
   daily cap on both stacks, enforced off chain.
2. **Pregeneration against a social handle** — the pregenerate recipe documents
   `email` and custom-JWT linked accounts only. If X/Discord usernames cannot be
   a linked account, the `pending_wallets` adoption branch
   (`lib/oauth-callback.ts:93-99`) survives as-is rather than collapsing. Task 1
   resolves this. Either answer is fine; only the size of the diff changes.
