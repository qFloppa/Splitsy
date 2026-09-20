# Arc Mainnet Migration — Design

**Date:** 2026-09-16
**Status:** accepted, not yet built
**Implements:** the "Arc mainnet" item deferred in
`2026-09-01-privy-wallet-stack-design.md` §"Deliberately deferred"

## Problem

The Privy stack was built for this day. `2026-09-01-privy-wallet-stack-design.md`
opens by naming the date — "Arc public mainnet is **2026-09-16**. This is the
revisit" — and gives the reason the stack had to change at all: **Circle Wallets
does not support Arc mainnet.** `ARC-TESTNET` is the only Arc row in Circle's
supported-blockchains matrix, and it is hardcoded with no mainnet value to become
— `lib/circle-dcw.ts:62`, `:114`, `:209` and `:214`. (That spec cited `:50` and
`:99`; the file has moved since.)

So the move to mainnet and the move to Privy are not two changes that happen to
coincide. They are one event. There is no mainnet deployment of the Circle stack
to fall back to.

That spec deferred mainnet itself, and was explicit about why: "blocked anyway:
Arc mainnet's chain id, RPC and USDC address are unpublished." **That blocker is
gone.** Verified on chain today against `https://rpc.mainnet.arc.io`:

| | Arc Mainnet (5042) | Note |
|---|---|---|
| chain id / head | `0x13b2` = 5042, block `0x14343cd` | live |
| USDC | `0x3600000000000000000000000000000000000000`, 6 dp | **same address as testnet** |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` | present |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | present |
| CREATE2 factory | `0x4e59b44847b379578588920cA78FbF26c0B4956C` | present |
| Memo | `0x5294E9927c3306DcBaDb03fe70b92e01cCede505` | present |
| GatewayWallet | `0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE` | **≠ testnet address** |
| GatewayMinter | `0x2222222d7164433c4C09B0b0D809a9b52C04C205` | **≠ testnet address** |
| TokenMessengerV2 | `0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d` | **≠ testnet address** |
| MessageTransmitterV2 | `0x81D40F21F12A8F0E3252Bccb954D722d4c464B64` | **≠ testnet address** |
| ERC-8004 Identity | — | **no code at `0x8004A818…`** |
| ERC-8004 Reputation | — | **no code at `0x8004B663…`** |

Circle's Gateway API confirms Arc mainnet independently: `GET
https://gateway-api.circle.com/v1/info` lists `{"chain":"ARC","network":"Mainnet","domain":26}`
alongside Ethereum, Base and ten others. Bridging and x402 work on mainnet.

Three facts from that table drive the whole design.

1. **USDC keeps its address; Gateway and CCTP do not.** A migration that assumes
   "Arc addresses are the same on both networks" is right about the one contract
   it will check first and wrong about the four it will not.
   `lib/gateway-contracts.ts:2` imports `arcTestnet` and `:30` pins
   `ViemChain: arcTestnet`; `:19` pins `TESTNET_URL`. None of that has a mainnet
   branch today.
2. **ERC-8004 and AgenticCommerce are not on mainnet yet.** Circle intends to
   deploy them. So agent identity, reputation and the job market launch dark and
   switch on when their addresses are entered — no code change at that point,
   and no registry of Splitsy's own.
3. **Nothing else is missing.** The features this app is built around — USDC
   transfers, the bill contracts, Gateway bridging, x402 — are all available.

### The scale, re-measured

The 2026-09-01 spec counted "161 occurrences of `arcTestnet` / `ARC-TESTNET` /
`ARC_TESTNET_*` across 50 files." Today, after the escrow work:

```
total occurrences  222   (arcTestnet 91, ARC_TESTNET_ 113, ARC-TESTNET 18)
files touched       54
production files    40   (excluding tests and scripts)
```

### The specific danger, which is not the scale

Volume is tedious, not dangerous. This is dangerous: **24 call sites across 20
files silently fall back to testnet when their environment variable is missing.**

```
lib/arc-read.ts:114,253,289,455    lib/circle-dcw.ts:34       lib/gateway-pay.ts:34
lib/recurring-contracts.ts:22,222  lib/recurring-read.ts:107  lib/wagmi.ts:26
lib/erc8004.ts:52,177,578          lib/appkit-bridge.ts:72    lib/user-agent.ts:23
app/api/recurring/settle/route.ts:18       app/api/treasury/settle/route.ts:42
app/api/onchain-bills/preimage/route.ts:38 app/api/wallet/transactions/route.ts:15
app/api/escrow/deposit/route.ts:27         app/api/agents/grants/route.ts:41
app/api/pay/[token]/social/route.ts:32     app/api/onchain-bills/[billId]/pay/route.ts:20
app/api/recurring/[tabAddress]/authorize/route.ts:12
```

Every one reads an `ARC_TESTNET_*` variable and defaults to
`https://rpc.testnet.arc.network`, `https://testnet.arcscan.app`, or a testnet
address. `lib/erc8004.ts:52-55` is the sharpest case — it defaults to the testnet
registry addresses, which on mainnet are addresses with no code.

A mainnet deployment that misses one variable therefore does not crash. It reads
testnet state and renders it as real money. That is the opposite of every other
default in this repo, all of which fail closed: `walletProviderName()`
(`lib/wallet-provider.ts:52`) falls back to the *older* stack, `claimEnabled()`
refuses, `siteContracts()` drops a row rather than printing a dead link.

**Inverting those 24 defaults is the migration.** The other 198 occurrences are
mechanical.

## Decision

### One chain module, one switch

A new `lib/arc-chain.ts` is the only place that knows which network this
deployment is on. It exports the chain object, RPC, explorer, USDC, GatewayWallet
and the CAIP-2 network string, and every one of the 24 sites reads from it.

It is driven by a single variable, `ARC_NETWORK` (`mainnet` | `testnet`), with
everything else derived. The alternative — eight independent variables — is eight
chances to half-configure a deployment, and a half-configured deployment is
exactly the failure this design exists to prevent. One switch cannot be half-set.
This is the same shape as `WALLET_PROVIDER`, and deliberately so.

`ARC_RPC_URL` stays as a separate optional override, because the public endpoint
rate-limits and a keyed URL is per-deployment rather than per-network. It
overrides the RPC only. `lib/x402/constants.ts:16-21` already documents that
exact problem: `-32011 'request limit reached'` surfaces as a failed contract
read, so it reads as a broken call rather than a quota.

Contract addresses Splitsy deploys itself (`NEXT_PUBLIC_BILL_SPLIT_REGISTRY_ADDRESS`,
`NEXT_PUBLIC_RECURRING_TAB_FACTORY_ADDRESS`, `NEXT_PUBLIC_HANDLE_ESCROW_ADDRESS`)
stay as their own variables. They are per-deployment, not per-network, and
`siteContracts()` already handles them correctly.

### Fail closed, and in one direction

Two rules. They apply at different levels, which is what makes them compatible
rather than contradictory:

- **The switch has a default; nothing derived from it does.** `ARC_NETWORK`
  absent entirely means testnet. But once a network is chosen, every value that
  network implies — RPC, explorer, USDC, GatewayWallet, registries — comes from
  the profile with no per-value fallback. There is no path by which a mainnet
  deployment reads a testnet address, because no individual value is
  independently settable any more.
- **The switch defaults toward testnet, never toward mainnet.** The asymmetry is
  deliberate. A mainnet host that degrades to testnet shows a user an empty
  balance, which is confusing and reversible. A testnet host that degrades to
  mainnet moves real money, which is neither. Same direction as
  `walletProviderName()` falling back to the older stack.

The practical consequence: a deployment can be wrong about *which network it is*,
and that is loud and harmless. It can no longer be wrong about *one address
within a network*, which was quiet and expensive.

### Deployment topology

| | splitsy.xyz | testnet.splitsy.xyz |
|---|---|---|
| Vercel project | existing | **the same project** |
| Environment | Production | Preview, branch-scoped |
| Branch | `main` | `testnet` (fast-forwarded from `main`) |
| `ARC_NETWORK` | `mainnet` | `testnet` |
| Chain | 5042 | 5042002 |
| RPC | `rpc.mainnet.arc.io` | `rpc.testnet.arc.io` |
| Explorer | `explorer.arc.io` | `testnet.arcscan.app` |
| `WALLET_PROVIDER` | `privy` | `privy` |
| Database | **new Supabase, clean** | `splitsy-test` (`hdyioojrozodmutpldsu`) |
| Privy app | same `PRIVY_APP_ID` | same `PRIVY_APP_ID` |
| Enclave policy | **new, chain 5042** | existing |
| ERC-8004 / AgenticCommerce | **unset → off** until Circle deploys | set |
| Vercel crons | run | **do not run** (Production only) |
| `NEXT_PUBLIC_STACK_LABEL` | unset | "Arc Testnet — no real funds" |

**No new Vercel project. This repo already runs exactly this arrangement.**
`privy.splitsy.xyz` is a Preview branch domain on the existing project —
`docs/deployments.md:19` calls it "the branch domain", and `:205-212` documents
the rule that makes it safe: the three Supabase variables "must be **SCOPED** to
Preview", because "a variable set for All Environments is inherited by Preview"
and "nothing in the code detects it."

`testnet.splitsy.xyz` is the same pattern with a clearer name, on a long-lived
`testnet` branch that is only ever fast-forwarded from `main`
(`git push origin main:testnet`). `privy.splitsy.xyz` is retired.

**The apex never moves** either way: `splitsy.xyz` stays on Production in the
project it is in today and only its variables change. An earlier draft of this
spec called for a second Vercel project to protect the apex — that was wrong. A
branch domain does not touch Production, so there is nothing to protect it from,
and a second project would mean maintaining two copies of every variable.

Branch-scoping also solves the cron problem for free, rather than by a checkbox
somebody has to remember. `vercel.json` schedules `/api/recurring/settle` and
`/api/agents/dunning`, both of which spend money; **Vercel runs crons only on
Production deployments**, so a Preview branch domain never fires them. Two
separate projects would have run both jobs twice a day against the same rows
until someone noticed.

One thing branch-scoping does require: **Vercel Deployment Protection must be
off** for this branch domain, or the testnet host answers with an auth wall
instead of the app.

### A clean mainnet database, nothing copied

The 2026-09-01 spec already established separate databases as non-optional, on a
Circle-specific argument: `users.circle_wallet_id` is an opaque provider id, only
written when `wallet_address` is null (`lib/oauth-callback.ts:144-151` — that
spec cited `:91`, and the guard has since gained a `walletProviderName() !==
"privy"` clause), so two stacks sharing a row give a user an address from one
stack and an id the other cannot sign with.

The same conclusion holds here for a different and stronger reason: a testnet row
and a mainnet row in one database means a testnet balance can render as real
money, and there is no single place that would enforce the separation. Tagging
every row with its network would need a filter on every query against `bills`,
`escrow_deposits`, `privy_wallets`, `agents` and more — and one missed filter is
the failure.

**Nothing is copied.** This is cheaper than it sounds, because Privy embedded
wallets are EOAs: the same person signing in with the same Privy account gets
**the same address on 5042 as on 5042002**. So `users` and `privy_wallets` rebuild
themselves on first login at the address the user already had. Copying them would
save a round trip and add a migration script that can be wrong.

What genuinely does not come across is money history — bills, IOUs, escrow
deposits, agent records. That is correct. Those rows describe testnet events.

### Reputation and jobs launch dark, and switch on with a variable

Circle has not yet deployed ERC-8004 or AgenticCommerce to Arc mainnet, and will.
So these are not features to cut and rebuild — they are features that must be
**off while their address is unknown and on the moment it is entered**, with no
code change and no redeploy of anything Splitsy owns.

`AgenticCommerce already works this way`, and its comment states the rule this
whole spec is arguing for (`lib/erc8183.ts:18-25`):

```ts
// Unset means "no job market configured", which reads as autopay OFF — never as
// "settle without the job". Same rule as MANDATE_ADDRESS in lib/arc-read.ts.
export const AGENTIC_COMMERCE_ADDRESS = (process.env.NEXT_PUBLIC_AGENTIC_COMMERCE_ADDRESS ??
  ZERO_ADDRESS) as `0x${string}`;

export function isJobsConfigured() {
  return AGENTIC_COMMERCE_ADDRESS !== ZERO_ADDRESS;
}
```

**No change is needed for AgenticCommerce.** Leave
`NEXT_PUBLIC_AGENTIC_COMMERCE_ADDRESS` unset on mainnet and jobs are off; set it
when Circle publishes the address and they are on.

**ERC-8004 is the one that is wrong**, and it is wrong in the specific way this
design exists to fix. `lib/erc8004.ts:51-55` defaults to the *testnet* registry
addresses rather than to zero:

```ts
// Arc Testnet ERC-8004 registries (docs.arc.io); env-overridable for redeploys.
export const IDENTITY_REGISTRY = (process.env.ERC8004_IDENTITY_REGISTRY ??
  "0x8004A818BFB912233c491871b3d84c89A494BD9e") as `0x${string}`;
```

On mainnet that address has no code. So unset does not mean off — it means "call
an address with nothing at it", which fails in a way that looks like a bug rather
than like missing configuration.

The fix is to make it match the module next door: default to `ZERO_ADDRESS`, add
`isReputationConfigured()`, and guard the call sites the way `isJobsConfigured()`
already guards `lib/erc8183.ts:281` and `:313` by returning `[]` and `null`. The
repo has three more precedents for the same shape — `isSettlerConfigured()`
(`lib/settler.ts:27`), `ensureRegistryConfigured()` and
`ensureHandleEscrowConfigured()` (`lib/bill-split-contracts.ts`).

This also means **Splitsy does not deploy its own ERC-8004 registries.** An
earlier draft proposed it as a fallback; it is the wrong trade, because a
non-canonical registry makes agent identity non-portable, which is most of the
point of the standard — and it is unnecessary when the canonical ones are coming.

### A separate attester key

`HandleEscrow`'s attester is immutable — there is no setter, only redeployment.
Today the attester key and the deployer key are the same key, in both `.env.local`
and on the deployed testnet contract. `2026-09-13-handle-escrow-HANDOVER.md`
records this as a known decision against the plan's instruction, and states the
cost plainly: that account holds ~98 USDC, so a leak takes the money as well as
the ability to misdirect deposits.

On testnet that is a recorded shortcut. On mainnet the same key would be a
deployer, a funded account and the signing authority over every deposit the
escrow holds. **Mainnet gets a fresh attester key, used for nothing else.**

### Privy: one app, a new policy, fresh agent wallets

One `PRIVY_APP_ID` serves both hosts, with `splitsy.xyz` added to allowed
origins. A user gets one login and one address that works on both chains, which
is a genuine benefit of EOAs rather than a compromise.

Two things do not carry over:

- **The enclave policy is pinned to `chain_id 5042002`**
  (`scripts/privy-policy.ts:81`, with `ARC_TESTNET_USDC` pinned as the `to`
  address at `:93`). Mainnet needs its own policy from
  `npm run privy:policy -- <cap>` run against a mainnet environment.
- **Policies apply at wallet creation.** `.env.example` says so: "It applies at
  creation, so setting it later leaves existing agent wallets uncapped." Existing
  agent wallets therefore carry a testnet-pinned policy and would refuse every
  mainnet transaction. Agent wallets are re-created on mainnet. User pay wallets
  are unaffected — no policy is attached to them.

### viem: no bump, define the chain locally

The installed 2.52.2 ships `arc` as a stub — no RPC urls, no block explorer, no
multicall3 — so `createPublicClient({ chain: arc })` throws on use. **viem@2.56.5
and viem@latest ship exactly the same stub**, verified against the published
package, so an upgrade fixes nothing. Arc's docs say both chains are "bundled
with viem"; the export exists, but it is not usable.

So `lib/arc-chain.ts` defines Arc mainnet itself with `defineChain`, using the
values verified in the table above, and there is **no dependency change in this
work at all**. `arcTestnet` keeps coming from viem, where it is fully populated.

## Order of work

The order is the risk control, not a formality.

**1. Stand up `testnet.splitsy.xyz` on today's configuration.** Branch `testnet`
fast-forwarded from `main`, assigned as a Preview branch domain on the existing
Vercel project, Deployment Protection off. Copy the Preview-scoped variables that
`privy.splitsy.xyz` already uses — `docs/deployments.md:205-212` is the checklist,
and its warning applies unchanged: the three Supabase variables must be **scoped
to Preview**, or they inherit Production's and point the testnet host at the live
database with nothing in the code detecting it. Register the host with X,
Discord, Google, Turnstile and Privy. Nothing changes for anyone; `splitsy.xyz`
is untouched.

Confirm `X_OAUTH_REDIRECT_ORIGIN`, `GOOGLE_OAUTH_REDIRECT_ORIGIN` and
`DISCORD_OAUTH_REDIRECT_ORIGIN` are **unset** in the new project. They default to
`request.nextUrl.origin` (`lib/twitter-oauth.ts:52`, `google-oauth.ts:44`,
`discord-oauth.ts:43`), so sign-in works on a new host with no code change — but
pinned to `https://splitsy.xyz` they would bounce users to the wrong host.

**2. Land `lib/arc-chain.ts` and ship it to testnet.** The 222 occurrences, the
24 fallbacks, the viem bump, `isReputationConfigured()`. Deploy to
`testnet.splitsy.xyz` and prove the app behaves identically with the refactor in
place.

This is the entire risk of the migration, and this step pays for itself: it is
the same code that will run on mainnet, exercised against a chain where being
wrong costs nothing.

**3. Mainnet setup.** Fresh attester key, funded mainnet deployer, four contracts
deployed and verified, clean Supabase with the `schema-*.sql` files, new Privy
policy, `splitsy.xyz` added to Privy origins.

**4. Flip the apex.** Change environment variables on the existing Vercel
project. No DNS change, no domain move, and step 2 has already proven the code.

## What this costs existing users

Worth stating plainly rather than discovering on the day. Everyone using
`splitsy.xyz` today has a **Circle** wallet, because `WALLET_PROVIDER` is unset in
Production and `walletProviderName()` returns `circle` for anything that is not
exactly `privy`. Merging the Privy branch to `main` did not change that; only the
environment variable does.

So the apex flip gives every existing user a **new wallet at a new address**, and
their bill history and testnet balances stay in a database no deployment serves
any more. That is unavoidable whenever the Privy switch happens — Circle has no
Arc mainnet to migrate to — but it lands on mainnet day unless it is announced
first. The old Supabase project is left in place, untouched, as a record.

## Deliberately deferred

- **Turning reputation and jobs on.** Both are one variable each once Circle
  publishes the addresses — `ERC8004_IDENTITY_REGISTRY`,
  `ERC8004_REPUTATION_REGISTRY`, `NEXT_PUBLIC_AGENTIC_COMMERCE_ADDRESS`. Note
  that the last is `NEXT_PUBLIC_`, so it is inlined at build time and needs a
  **redeploy**, not just a saved variable (`docs/deployments.md` makes the same
  point about `NEXT_PUBLIC_SUPABASE_URL`). Agent NFT metadata refresh
  (`lib/erc8004.ts:581`) depends on open question 3 and can follow separately.
- **The PIN.** Still a cookie check in the route — `verifyWalletUnlock` imported
  at `app/api/debts/[id]/pay/route.ts:13` and called at `:38`, now from
  `lib/session-core` rather than the `lib/pin.ts` the 2026-09-01 spec named.
  Independent of which chain signs. Unaffected by this work, same as it was
  unaffected by the Privy work.
- **Retiring the AutopayMandate code path.** `syncMandateOnchain`
  (`app/api/agents/grants/route.ts:279`, defined at `:317`) is still migrating
  armed rows. Separate cleanup, and a clean mainnet database has no armed rows to
  migrate.
- **Renaming `ARC_TESTNET_*` to `ARC_*` in scripts.** 13 of the 19 files under
  `scripts/` carry the identifiers, but they are run by hand against an explicit
  `--env-file`, so they are not a deployment hazard. They follow after the app.
- **`X-Robots-Tag: noindex` on non-canonical hosts.** Worth doing — every page
  already emits `<link rel="canonical">` to `splitsy.xyz` via `metadataBase`
  (`app/layout.tsx:25,50`), but a canonical is a hint and a directive is not, and
  an indexed `testnet.splitsy.xyz` next to a real-money apex is a page someone
  pays into by mistake. Four lines in `proxy.ts`, which already sets per-request
  headers. Folded into step 1 if it is free; its own change if it is not.

## Open questions

1. **The x402 Gateway transfer URL on mainnet.** `lib/x402/constants.ts:31` pins
   `https://gateway-api-testnet.circle.com/v1/x402/transfers/`, and its comment
   warns that the neighbouring `/v1/transfers/` namespace 404s on these ids — so
   it "reads as 'this payment never happened' rather than 'wrong endpoint'."
   `https://gateway-api.circle.com/v1` is confirmed live and lists Arc as domain
   26, but the `/x402/transfers/` path on the mainnet host has **not** been
   verified against a real id. Verify before trusting a mainnet receipt link.
   Same check applies to `app/JobTrail.tsx:236` and
   `app/api/agents/catalog/route.ts:233`, which hardcode the same testnet host.
2. **Gas on mainnet.** Arc's gas token is USDC. Circle's Gas Station sponsorship
   is documented for Arc *Testnet* only; whether it extends to mainnet is
   unconfirmed. If it does not, the settler and releaser accounts need funding
   with real USDC, and `2026-09-13-handle-escrow-HANDOVER.md` has the measured
   per-release cost to size it: 0.001404 USDC on the Privy stack.
3. **Whether `explorer.arc.io` exposes a Blockscout API — and whether a server
   can reach it at all.** `lib/erc8004.ts:581` and
   `scripts/reputation-backfill.ts:144` call `/api/v2/tokens/…/refetch-metadata`,
   which is Blockscout-specific. Testnet's `testnet.arcscan.app` is Blockscout
   (`hardhat.config.ts:46-54` registers it as such). The mainnet explorer answers
   200 but **sits behind a Cloudflare bot challenge** — a probe gets "Just a
   moment…" rather than JSON — so the API shape could not be confirmed from a
   server, and any server-side call from Vercel may be challenged the same way.
   Only affects NFT metadata refresh, which is off until the registries exist.
   Separately, `hardhat.config.ts` needs a mainnet `chainDescriptors` entry or
   `hardhat verify` has nowhere to send source.
