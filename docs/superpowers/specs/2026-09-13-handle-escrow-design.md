# HandleEscrow — Design

**Date:** 2026-09-13
**Status:** accepted, not yet built
**Fixes:** the pre-mint stranding measured below
**Partially supersedes:** `2026-09-01-privy-wallet-stack-design.md` §"Open questions" Q2

## Problem

An IOU sent to someone who has never used Splitsy loses the money. Measured on
Preview, 2026-09-13:

```
09:52:11  wtf@splitsy.xyz tags ok@splitsy.xyz  → pre-mint  0x767C0d…1C76
09:52:22  the IOU transfers 1 USDC             → lands at  0x767C0d…1C76
09:53:06  ok@splitsy.xyz signs in              → Privy gives 0x867aB1…3700
```

`users.wallet_address` for `ok@splitsy.xyz` is `0x867aB1…3700`, which holds
**0 USDC**. The 1 USDC is at `0x767C0d…1C76` (tx
`0x351ba3a2d22f09120e367bbc19d729c7b598df23b26c4628ce2ff5ba49940c64`), an address
that person cannot reach and Splitsy cannot sign for.

### Root cause

`lib/privy-wallet.ts:857` pre-mints against a **`custom_auth`** linked account
keyed on the handle. A later email login is a **`type: "email"`** account. Privy
does not treat those as the same person, so the login creates a different user
with a different wallet:

| | Privy user | address |
|---|---|---|
| pre-mint | `uhcr6ber15wc93hex5mqrabt` | `0x767C0d…1C76` |
| real login | `ixejhxkci1dswp709vy728z2` | `0x867aB1…3700` |

`lib/privy-wallet.ts:840` states the assumption — the wallet appears in Alice's
account "when Alice signs in and **links a real account to it**." Nothing
performs that link, and nothing can: the Privy Node SDK exposes `create`,
`delete`, `unlinkLinkedAccount` and the `getBy*` lookups, but **no link method**
(`resources/users/users.d.ts:20-240`). Identity must be present at creation or
never.

The measurement already existed. `scripts/privy-setup.ts:37-44`, written
2026-09-01 while resolving the spec's open question 2:

> Open question 2 — can a social handle be a pregenerated linked account? YES,
> but not from the handle alone. […] `subject`, the provider's `sub` claim, is
> required, so the identity Privy keys on is the provider's account id, not the
> @handle. […] **pregenerating against a typed-in handle does not [work].**

That answer never reached `defaultMintPending`, which ships the handle anyway.

### Blast radius

Not one IOU. Probed against Privy with `signMessage` (signs nothing on chain):

```
CANNOT SIGN  ok@  pre-mint  (1 USDC)     → 401 no valid authorization keys
CANNOT SIGN  wtf@ pre-mint  (1.11 USDC)  → 401
CANNOT SIGN  x:bingchilliing (1 USDC)    → 401
CAN SIGN     x:qfloppa custodial 'prem'  → 0xdac7f95d…   (control)
```

**3.11 USDC across three wallets is unrecoverable.** The control case proves the
probe works and the failure is real ownership, not a bad call.

Every user with a `pending_wallets` row points at a different live wallet — the
sweep in `app/api/wallet/provision/route.ts:215` has never run for anyone,
because it 409s when a user already has a wallet and login always sets one first.

## Two bugs, not one

| | Settle rail (the IOU) | Bill with a stranger |
|---|---|---|
| Money moves? | yes, immediately | no — a debt is recorded |
| What is lost | **USDC**, at an unreachable address | **the position** — debt bound to an unreachable address |
| Symptom | recipient's balance is 0 | "You're not a participant on this bill." |
| Fix | `HandleEscrow` (§1, §2) | off-chain `bill_debts` (§3) |

The bill case has no stranded money: `createBill` binds a share to the pre-mint
address but sends nothing there. When that person signs in with a different
wallet, `app/api/onchain-bills/[billId]/pay/route.ts:54` reads the chain by
`users.wallet_address` and answers "not a participant." It cannot be repaired
after creation — participants are set only in `createBill`, `participantList` is
immutable, and the labels are committed in `billMetadataHash`.

## Decision

Three changes. §1 and §2 fix the settle rail; §3 fixes the bill rail; together
they leave `pregenerateWallet` with no callers.

### §1 — `contracts/HandleEscrow.sol`

A new contract, **not** a change to `BillSplitRegistry`. The registry's escrow is
address-keyed and direction-locked: `bill.splitter = msg.sender` (`:306`),
`_claim` requires `msg.sender == splitter` and transfers to `splitter`
(`:809`, `:832`). What this needs is the opposite — money held *for* an address
not known at creation. Adding that would break the invariant the registry's own
header states (`:28-31`): "no privileged owner […] funds can only ever leave via
{claim} or {settle}'s claim legs, to the bill's own splitter." A redeploy would
also make a third registry address to keep readable, since bill ids restart per
deployment (`lib/arc-read.ts:10-13`).

Ownerless, immutable, no upgrade path — same posture as the registry.

```
constructor(address usdc_, address attester_)   both immutable, both non-zero

deposit(bytes32 handleHash, uint256 amount) → uint256 id
  pulls USDC from msg.sender; records {depositor, handleHash, amount}

release(uint256 id, address to, uint256 deadline, bytes sig)
  ├─ EIP-712 digest over Release(uint256 id, address to, uint256 deadline)
  ├─ recovered signer == attester
  ├─ block.timestamp <= deadline
  ├─ delete deposits[id]            ← effects before interaction
  └─ safeTransfer(to, amount)

reclaim(uint256 id)
  ├─ msg.sender == depositor
  ├─ delete deposits[id]
  └─ safeTransfer(depositor, amount)
```

**The id is the nonce.** `delete deposits[id]` on both exits means a replayed
signature finds nothing and reverts, removing a mapping and its bug class. One
consequence, stated rather than hidden: re-signing the same id for a new `to`
(user changed wallet) leaves both signatures live until one is consumed. Bounded
by `deadline`; a separate nonce would not change it.

**The attester is immutable, with no setter.** A settable attester needs an
owner, and an owner is the privileged role this avoids. Recovery is `reclaim`:
if the key leaks, depositors withdraw and the contract is redeployed. That works
only because reclaim is unconditional — the two decisions hold each other up.

**`handleHash` is opaque to the contract.** It never interprets it, so new
namespaces need no contract change. It is **not a secret**:
`keccak256("email:ok@splitsy.xyz")` is brute-forceable in seconds. It is an
identifier, and nothing may treat it as private.

**Reclaim is unconditional** — any time before release. Nothing is ever locked,
nothing is ever stuck, and it is the backstop against a compromised attester key.
The trade accepted: a depositor could withdraw just before the recipient claims.
A debt is a promise, not a commitment, until it is collected.

**Per-deposit ids, not a pooled balance per handle.** Two people sending to the
same handle each own their own deposit and can reclaim only their own. Pooling
would need per-depositor accounting anyway to make reclaim safe — which is
per-deposit ids with extra steps.

#### Why a server signature, and not something stronger

The attester decides that an address belongs to a handle. Four rungs exist:

| Rung | Assumption | Covers | Cost |
|---|---|---|---|
| Bare key (EIP-712) | server not compromised | all 4 login methods | ~0 |
| Key in a TEE | enclave runs the published code | all 4 | ~$50–65/mo |
| ZK over a signed artifact | provider key registry is honest | Google + email only | verifier on Arc, prover, registry |
| Trustless | — | does not exist for social handles | — |

**zkTLS (Reclaim) is rejected on trust model, not cost.** Its verifier recovers
ECDSA signatures and checks them against a witness list supplied by
`addNewEpoch(...) external onlyOwner`, with the threshold also owner-chosen and a
UUPS upgrade path gated by the same owner. That is a permissioned oracle with an
admin key we do not control — strictly weaker than signing ourselves.

**ZK Email / SP1 are real but narrow.** Both need a provider-signed artifact.
Checked against this repo: Google returns `id_token`, a signed OIDC JWT
(`lib/google-oauth.ts:70`); X and Discord return opaque `access_token` only
(`lib/twitter-oauth.ts:76`, `lib/discord-oauth.ts:67`). So ZK can never cover X
or Discord — there is nothing signed to prove. Both also anchor on a key registry
that is `Ownable` with no timelock (ZK Email's `DKIMRegistry`), so they relocate
trust rather than removing it. And a ZK release needs the *recipient* to produce
a proof, which contradicts the requirement that funds arrive immediately at
signup with nothing for them to do.

**The upgrade path is deliberate and additive.** A TEE changes *who holds the
key*, not the contract — same attester address, same signature, same Solidity.
A ZK path would be a second function, `releaseWithProof(...)`, beside the first;
existing deposits keep working. Both are reachable without invalidating anything
built here.

**Upgrade threshold, to be written into the contract header:** move the key into
a Nitro Enclave when the escrow's typical balance exceeds roughly one year of
instance cost (~$600). AWS charges nothing for Nitro Enclaves themselves; the
cost is one always-on EC2 instance, and a 2-vCPU Graviton (`c6g.large`,
$49.64/mo on-demand, ~$30 reserved) is sufficient — the docs permit allocating
1 vCPU to the enclave on a 2-vCPU Graviton parent. Below that threshold the
monthly cost exceeds the funds at risk.

#### Security posture

No owner, no upgrade, no pause, no sweep, no `selfdestruct`, no loops (so no
gas-bound DoS), immutables, custom errors, `SafeERC20`, `nonReentrant`, strict
checks-effects-interactions. Vendored `IERC20` / `SafeERC20` / `ReentrancyGuard`
as the registry does — there is no OpenZeppelin dependency in this repo.

Two findings are expected and are not to be papered over:

- **`block.timestamp`** in the deadline check. Inherent to EIP-712 deadlines;
  takes the same `slither-disable-next-line timestamp` the registry already uses
  for `dueDate`.
- **`ecrecover`**. Written by hand, so it needs an explicit `s <= secp256k1n/2`
  malleability guard and a zero-address reject. Without both it is a real hole,
  not a style nit.

### §2 — the off-chain side

The trigger point exists already. `lib/oauth-callback.ts:75-81` runs
`resolveDebtsForHandle` at login — "you proved who you are, claim what is tagged
with your handle." Release is that sentence with money attached, so it goes
beside it, in the shared tail both stacks call.

```
                    IOU to a stranger
                            │
          ┌─────────────────┴─────────────────┐
          │  resolve: real user with a wallet? │
          └────────┬─────────────────┬────────┘
              yes  │                 │  no
                   ▼                 ▼
            transfer (today)   approve + deposit(handleHash, amount)
                                     │
                              escrow_deposits: open
                                     │
                          … they sign in …
                                     │
                    oauth-callback tail, beside resolveDebtsForHandle
                                     │
                    sign Release(id, to, deadline); relay release()
                                     ▼
                          USDC lands in their wallet
```

1. **`lib/wallet-resolve.ts`** — add a way to ask without minting.
   `resolveParticipantAddress` keeps its signature and its callers; a new
   `lookupParticipantAddress` does the same walk (user wallet → pending wallet)
   and returns **null** instead of minting.

   **Additive on purpose — see Sequencing.** `resolveParticipants` is shared by
   the three bill/recurring routes, so changing its return type here would break
   bill creation before §3 is ready to catch it. The pre-mint is deleted in §3,
   once nothing needs an address for a stranger.
2. **`app/IouClient.tsx`** — both settle rails (`settleNow`, `settleWithWallet`)
   call `lookupParticipantAddress` and branch on null. Real wallet → transfer,
   unchanged. No wallet → `approve` + `deposit`, the same approve-then-spend
   shape as `approveBillRegistry` (`lib/bill-split-contracts.ts:400`).
3. **`schema-escrow-deposits.sql`** — one additive table, modelled on
   `onchain_bill_preimages`: keyed `(escrow_address, deposit_id)` because ids
   restart per deployment, holding provider, handle, depositor, amount, status.
   An **index, not an authority** — the chain is the authority. It exists so
   login can find open deposits without walking logs, which matters because Arc
   caps `eth_getLogs` at ~25k blocks (`lib/privy-wallet.ts:876-885`).
4. **`lib/escrow-release.ts`** — sign the EIP-712 message, relay `release()`.
   **Idempotent by necessity:** the Privy route calls `finishProviderLogin` once
   before the wallet exists (`walletAddress: null`) and again once it does, so
   this must no-op without a wallet and fire on the second pass.
5. **`lib/oauth-callback.ts` + `app/api/auth/privy/route.ts`** — the call site,
   best-effort and wrapped like its neighbour. A failed release must never block
   a login; the deposit stays open and the next sign-in retries.

**Splitsy pays the release gas.** The recipient's wallet is empty — that is the
point — and Arc charges gas in USDC, so they cannot relay it. A
`getOrCreateWallet("splitsy", "escrow-releaser")` wallet does it, matching
`gateway-settler` (`app/api/pay/[token]/gateway/route.ts:42`). **That wallet
needs funding and monitoring.** If it runs dry, releases stall: deposits stay
safe and reclaimable, but "immediately" quietly stops being true — a failure that
goes unnoticed without a check.

**The UI needs a third state.** A row is pending or settled today. An escrowed
IOU is neither: the money has left the sender's wallet and has not arrived.
"Settled" would be a lie; "pending" reads as nothing happened. It gets its own
word in the ledger — *waiting for @dani* — while the composer still reports the
IOU as successful, because it was.

### §3 — bills and recurring tabs: keep strangers off chain

No contract, no escrow — there is nothing to escrow, because the stranger *owes*
rather than receives.

On-chain participants become people who have a real wallet. A stranger's share
stays an off-chain `bill_debts` row, which already carries `debtor_provider` +
`debtor_handle` with a null `debtor_user_id`. `resolveDebtsForHandle`
(`lib/bills-repo.ts:84`) already claims those rows at login and is already wired
into `lib/oauth-callback.ts:77`. They then pay through `/api/debts/[id]/pay`,
which exists.

Touches `app/api/onchain-bills/create/route.ts`,
`app/api/onchain-bills/resolve/route.ts` and `app/api/recurring/create/route.ts`
— all three call the same `resolveParticipants`. Once they no longer need an
address for a stranger, `resolveParticipants` stops minting, `defaultMintPending`
and `pregenerateWallet` lose their last callers, and `pending_wallets` stops
being written.

**Open decision, deliberately not settled here:** an on-chain bill's `totalOwed`
then excludes the stranger's share. Either the on-chain bill covers only its
on-chain participants (totals still reconcile, at a smaller number), or on-chain
creation is deferred until every participant has a wallet. This is a product
question; §3 should not start until it is answered.

## What stays broken

Stated so nobody re-derives it later:

- **The 3.11 USDC already stranded is gone.** The wallets are user-owned, the
  server gets 401 on every signing path, and the SDK cannot link their identities
  to the real accounts. Testnet; re-send after the fix.
- **A pre-mint is keyed to one identifier.** Tagging someone as `@dani` on X and
  as `dani@work.com` yields two escrow deposits. Both release correctly when
  their own identity signs in; they never merge. Inherent to identity-keyed
  escrow.
- **X and Discord can never leave rung 2.** Opaque bearer tokens, nothing signed,
  no artifact a circuit could verify.
- **The attester can misdirect a release.** Bounded to one deposit and one
  address per signature, expiring at `deadline`, with `reclaim` as the backstop —
  but not zero. No option available on Arc today reaches zero.

## Testing

- **`contracts/HandleEscrow.t.sol`** — release with a valid signature; wrong
  signer; expired deadline; replay after delete; reclaim by depositor; reclaim by
  a stranger; reclaim after release; deposit of zero.
- **`node --test`** — the pure parts: the EIP-712 digest and `handleHash`
  derivation, matching the `lib/*.test.ts` convention. Both must be computed the
  same way in Solidity and TypeScript, so both get a test that pins the same
  vector.
- **`npm run audit:contracts`** — Slither, with only the two documented findings
  above surviving.

## Sequencing

**§1 and §2 ship together.** The contract is useless without the rails, and the
rails cannot branch without the contract. §2 is purely additive to
`lib/wallet-resolve.ts`: it adds `lookupParticipantAddress` beside the existing
`resolveParticipantAddress` rather than changing it, because the three
bill/recurring routes share that function and would break if it stopped
returning an address. After §2, the settle rail no longer strands money and the
bill rails behave exactly as they do today — still pre-minting, still leaving a
position bound to an address the debtor cannot reach.

**§3 ships after, and is blocked on its open decision.** It removes the last
need for an address a stranger does not have. Only then can `resolveParticipants`
stop minting and `pregenerateWallet` be deleted — so the deletion is the final
step of §3, not of §2.

Doing §3 first would be wrong: it leaves the settle rail stranding money, which
is the bug that was actually reported.
