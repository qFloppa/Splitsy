# Handle slots — Design

**Date:** 2026-09-15
**Status:** REJECTED — not built. Kept for the contract analysis, not the decision.
**Superseded by:** the signable-slot fix shipped 2026-09-15/16 (see below).

## Why this was rejected

This spec proposed three contracts — a new `HandleRegistry`, a `BillSplitRegistry`
v3 and a `RecurringTab` change — to give a tagged stranger a real on-chain identity.

It was over-built. The mapping it would have put on chain (`handleHash → wallet`)
**already exists in the database** as `pending_wallets`, and the only reason a
contract seemed necessary was that a pre-minted wallet could not be signed for. That
turned out to be one argument to `create()`, not a limitation: `pregenerateWallet`
deliberately minted with no owner quorum and no additional signer, while every other
server-signable wallet in this repo is minted through `walletSpec`, which sets both.

What shipped instead, in about 150 lines and no contract change:

- `defaultMintPending` mints a slot through `getOrCreateWallet`, so the server can
  sign for it. `pregenerateWallet` is deleted.
- A stranger's share goes on chain against that slot, so escrow, due dates, public
  pay links, `payDebtFor`, collect mandates and reputation all work untouched —
  which was the requirement this spec existed to meet.
- `getSlotWalletForUser` (`lib/pending-wallets-repo.ts`) is how `/api/me`,
  `/api/dashboard`, `[billId]/pay` and `[billId]/refund` find the slot again.
- `lib/slot-refund.ts` relays a failed all-or-nothing bill out of the slot and
  forwards it to the wallet the person signed in with.
- Bills 63 and 64 are fixed **retroactively**, where this spec abandoned 64 bills.

**What that concedes, and the reason to keep this document:** a slot is a wallet
Splitsy holds a key to, so the refund hop for a not-yet-joined person is a promise
rather than a guarantee. The escrow itself stays trustless — the audited contract
holds the money and `claim` still only pays the creator — but Splitsy could fail to
forward, or divert, a refund in transit. If that ever matters, the design below is
the way out, and its contract analysis is still accurate.

---

*Everything below is the rejected design, unchanged.*

---

**Fixes:** the invisible-debt bug measured below
**Supersedes:** `2026-09-13-handle-escrow-design.md` §3, which chose the opposite
answer and is withdrawn — see "Why §3 was wrong".

## Problem

A bill split with someone who has not joined Splitsy yet records a debt that
person can never see. Measured on Preview, 2026-09-15:

```
16:37:17  qFloppa tags crap@splitsy.xyz    → pre-mint  0xd3adf94e…4C64
16:37:24  bill 64 is created ($1.00)       → the debtor slot IS that pre-mint
16:46:29  crap@splitsy.xyz signs in        → Privy gives 0x965c7025…9412
```

Read from the registry at `0x924cf4331741401cbc720770937c132a974e1a3b`, with the
same call the settle deck makes (`lib/arc-read.ts:446`):

```
bill 64 participantList : [ 0xd3adf94ef5b31Be78c3d667dbAF5b55C024c4C64 ]
0xd3adf94e…4C64  -> bills=[64]  owed=1000000  paid=0  exists=true
0x965c7025…9412  -> bills=[]    owed=0        paid=0  exists=false
```

The debt is real and correctly recorded. It is attached to an address that person
does not hold, so every screen that asks "what do I owe?" answers nothing. Bill
63 (`okk@splitsy.xyz`, 09:19 the same day) is broken identically.

### Root cause

`lib/wallet-resolve.ts` pre-minted a wallet for a tagged handle. On the Privy
stack that pre-mint is a `custom_auth` Privy user; a later email or social login
is a **different** Privy user, and the Privy Node SDK exposes no method to link
them. The measurement and the SDK survey are in
`2026-09-13-handle-escrow-design.md` — this spec does not re-derive them.

No money is stranded on this path. `_payDebt` (`BillSplitRegistry.sol:764`) never
checks that the funder is the debtor, so USDC paid toward the slot goes into the
bill, not to the dead address. What is lost is **the position**.

## Why §3 was wrong

The earlier spec's §3 answered this by keeping strangers **off** chain as
`bill_debts` rows. That was implemented on 2026-09-15 and is now withdrawn,
because an off-chain row cannot carry the features an on-chain participant has:

| | on-chain participant | off-chain `bill_debts` row |
|---|---|---|
| all-or-nothing escrow | `escrowUntilFull` + `refund` | none — nowhere trustless to hold it |
| due date | `bill.dueDate`, in the metadata hash | no column |
| public pay link | `/pay/<token>` + `payDebtFor` | not reachable |
| collect mandate | `authorizeCollect` | none |
| reputation | keyed by bill + registry | not graded |

Reaching parity off chain means re-implementing escrow in a second contract with
Splitsy as the arbiter, and keeping two notions of a bill in step forever. The
cheaper answer is to stop making strangers unrepresentable on chain.

## Decision

A tagged stranger becomes a real on-chain participant whose address is
**derived from their handle** instead of pre-minted:

```
slot = address(uint160(uint256(handleHash)))
handleHash = keccak256("<provider>:<normalized handle>")     // lib/handle-escrow.ts:22, unchanged
```

`uint160(uint256(…))` truncates to the **low** 160 bits, so the slot is the
**last 20 bytes** of the 32-byte hash — `("0x" + handleHash.slice(-40))` in
TypeScript, not the first 20. Both sides get the same pinned vector in their
tests, because a silent disagreement here would put bills against addresses the
app never looks at.

A slot colliding with a real wallet is a 160-bit preimage problem and is ignored.
Even if one occurred it would not grant anything: `ownerOfSlot` is empty unless
the attester bound it, and `_canAct` falls back to `caller == slot`, which is what
that wallet's own key already authorises.

Nobody holds a key to a slot and nobody needs to. A slot is an ordinary
participant, so escrow, due dates, pay links, `payDebtFor`, refunds, collect
mandates and reputation all work with no change to that machinery. The registry
learns who owns a slot when that person signs in.

Three contracts change. `HandleEscrow` does not.

### §1 — `contracts/HandleRegistry.sol` (new, ~90 lines)

The one place that answers "which wallet owns this handle".

```
address public immutable attester;                      // ESCROW_ATTESTER_PRIVATE_KEY
mapping(bytes32 handleHash => address owner) public ownerOf;
mapping(address slot => address owner)       public ownerOfSlot;
mapping(address owner => address[] slots)    private _slotsByOwner;

function slotFor(bytes32 handleHash) public pure returns (address);
function bindHandle(bytes32 handleHash, address to, uint256 deadline, bytes calldata signature) external;
function slotsOf(address owner) external view returns (address[] memory);
```

`bindHandle` is permissionless and authorised by the attester's EIP-712
signature, for the reason `HandleEscrow.release` is: the recipient's wallet is
empty, so someone else has to pay the gas, and gating on `msg.sender` would let
Splitsy going quiet strand an already-authorised binding. `_recover`, the
`_HALF_CURVE_ORDER` check and the domain separator are lifted from
`HandleEscrow.sol:219` unchanged.

**One call binds a handle for every bill and every tab it appears on, past and
future.** That retroactive property is the reason this is a contract of its own.

**`bindHandle` is one-way.** Once `ownerOf[handleHash]` is set it cannot change.
A rebindable handle would let a leaked attester key move a position repeatedly;
the price is that a mis-bind is permanent, and unlike `HandleEscrow` there is no
`reclaim` backstop here.

**Why not inside `BillSplitRegistry`.** Two contracts read the binding, and a
binding must outlive a registry redeploy — bill ids are disposable (64 are being
abandoned by this spec) but "this wallet owns this handle" is not. Burying it in
the registry means a future v4 silently discards every binding. This is the same
argument `HandleEscrow.sol:11-18` already makes for keeping identity concerns out
of the registry.

### §2 — `BillSplitRegistry` v3

Additive. The existing 924 lines keep their logic and their invariants.

- `HandleRegistry public immutable handles` — new constructor argument.
- `_canAct(address slot, address caller)` → `caller == slot || handles.ownerOfSlot(slot) == caller`.
- `refundSlot(uint256 billId, address slot)` — the payer-side mirror for a slot.
  `refund(billId)` becomes `refundSlot(billId, msg.sender)`. Funds still go to
  `msg.sender`, so a bound owner refunds into their own wallet.
- `authorizeCollectSlot` / `revokeCollectSlot` — same `_canAct` gate.
- `billIdsForParticipant(addr)` unions `_billsByParticipant[addr]` with the same
  list for every slot in `handles.slotsOf(addr)`. `getParticipant(billId, addr)`
  resolves through a bound slot when the address itself is not a participant.

**No new pay function.** `payDebtFor(billId, slot, amount)` is already
permissionless and already credits the slot, so the owner, a friend, a pay link
or an autopay agent can pay it as-is. `refundSlot` is the only new money path.

**The address-based read API keeps its signatures.** Sixteen files read
participants and nine read the bill-id indexes; resolving inside the contract
means almost none of them change.

**Refunds follow the slot, not the funder.** If a third party pays a stranger's
share through a pay link and the bill then fails, the money returns to the
stranger once bound — not to whoever paid. This is exactly what v2 already does
for `payDebtFor`, and per-funder accounting would add storage to the hot payment
path and change refund semantics for existing address participants too.

### §3 — `RecurringTab` + `RecurringTabFactory` v2

`_settleMember` (`RecurringTab.sol:266`) pulls with
`safeTransferFrom(member, …)`, so a slot member holds nothing and can never be
collected. Four lines, resolving the **source of funds only**:

```solidity
address payer = handles.ownerOfSlot(member);
if (payer == address(0)) payer = member;
uint256 collectibleAmount =
  _min(amountDue, _min(usdc.allowance(payer, address(this)), usdc.balanceOf(payer)));
// …
usdc.safeTransferFrom(payer, address(this), collectibleAmount);
```

The `allowance` and `balanceOf` reads at line 279 must move to `payer` as well.
Reading only `safeTransferFrom` through the payer would leave `collectibleAmount`
computed from the slot's zero allowance, and the tab would shortfall forever even
after binding.

Accounting stays keyed by `member`, so the immutability invariant
`RecurringTab.sol:298-302` relies on is untouched. An unbound slot emits the
`SettlementShortfall` it already emits and begins collecting when that person
signs in — no new failure mode.

`RecurringTabFactory` gains a `handles` immutable and passes it to each tab.

### §4 — off chain

`lib/wallet-resolve.ts` collapses to one function that always answers:

```ts
// A real wallet if they have one, else the slot derived from their handle.
// Never mints. Never returns null.
participantSlot(provider, handle)
```

Because every tagged person now has an address, `/api/onchain-bills/resolve`
answers for every row again and **HomeClient's browser-wallet split path needs no
new branch** — it throws on a null address today. Both bill rails are fixed by
the same swap.

**Added**

- `bindHandle` in `finishProviderLogin` (`lib/oauth-callback.ts`), beside
  `releaseEscrowForHandle`: same attester, same best-effort-and-retry-next-login
  shape, same reason it is relayed rather than user-signed.
- `encodeRefundSlot` in `lib/registry-calldata.ts`, `refundSlot` in
  `lib/bill-split-contracts.ts`, and `app/api/onchain-bills/[billId]/refund/route.ts`
  deriving the caller's slot from their handle.
- `slotForHandle` in TypeScript, with a test pinning the same vector Solidity
  produces — the convention `handleHash` already follows.
- `/api/recurring/create` no longer needs to refuse anyone.

**Deleted**

- `app/api/onchain-bills/create/split-strangers.ts` and its five tests. No share
  leaves the chain, so there is nothing to partition.
- The off-chain `bill_debts` write in the create route, its `offChainCount`
  response, and the `onchainTotal` subtraction. The committed total is the full
  receipt total again, so the "chain shows a smaller number than the receipt"
  trade-off disappears.
- The `prepare`-with-no-`transaction` guard in `app/signed-send.ts`. There is
  always a chain leg again, so it is dead code.
- `HomeClient`'s null-`billId` branch.
- `pregenerateWallet` (`lib/privy-wallet.ts`) and `defaultMintPending`
  (`lib/wallet-resolve.ts`) — last callers gone. `pending_wallets` stops being
  written.

**Kept:** the Privy gate added to `lookupParticipantAddress` on 2026-09-15. It is
what makes "no wallet" mean "derive a slot" rather than "reuse a dead pre-mint",
and it still guards the settle rail's escrow decision.

## Migration

Bill ids restart at 1, as they did for v2. The 64 bills on
`0x924cf433…1a3b` are abandoned rather than made readable — the same treatment v1
(`0x867051b5…120B`) got, whose reader `REGISTRY_ADDRESS_V1` was declared and never
built. They are throwaway testnet bills, twenty of them "Cider Cellar" at $6, and
two are already broken by the bug this spec fixes. Existing recurring tabs on
factory `0x9Cc377C9…0a41E` are abandoned on the same reasoning, since the app
points at a single factory address.

`schema-reputation.sql` already keys verdicts by `(wallet_address,
registry_address, bill_id)` and already carries a v1→v2 re-key migration at line
79. v3 needs the same one-line update before the app is repointed.

## What stays broken

- **The three pre-mints with no account stay unreachable.** `discord:voltagevibe`,
  `x:bingchilliing` and `x:arc` hold pre-mint rows and no user row; the wallets
  are Privy `custom_auth` users the server gets 401 for. Nothing here recovers
  them. Testnet.
- **A mis-bind is permanent.** `bindHandle` is one-way and has no `reclaim`.
- **The attester can misdirect a binding**, and that now reaches tabs as well as
  bills. Bounded: a wrongly bound handle *owes* the share, so there is no gain
  there; the exposure is refunding money a third party paid into that slot on a
  failed all-or-nothing bill, and a tab still cannot pull without the bound
  wallet's own USDC approval. Same trust `HandleEscrow` already carries; the
  intended upgrade is the same TEE move its header describes.
- **One handle, one identifier.** Tagging someone as `@dani` on X and as
  `dani@work.com` yields two slots. Both bind when their own identity signs in;
  they never merge. Inherent to identity-keyed addressing.
- **`HandleEscrow` is not migrated** to `HandleRegistry`. Its per-deposit
  attestation works and is deployed and verified; folding the two together is a
  later tidy-up.

## Testing

- **`contracts/HandleRegistry.t.sol`** — bind with a valid signature; wrong
  signer; expired deadline; rebind rejected; `slotFor` vector; `ownerOfSlot` and
  `slotsOf` after binding; zero-address recipient.
- **`contracts/BillSplitRegistry.t.sol`** — pay a slot via `payDebtFor` before
  binding; `refundSlot` by the bound owner on a failed all-or-nothing bill;
  `refundSlot` refused for an unbound slot and for a non-owner;
  `billIdsForParticipant` unions after binding; `getParticipant` resolves through
  a bound slot; `authorizeCollectSlot` gated by `_canAct`; a bill with one slot
  and one address participant completing and being claimed.
- **`contracts/RecurringTab.t.sol`** — an unbound slot member shortfalls without
  reverting the tab; the same member collects from the bound wallet after
  binding; `totalSettledByMember` stays keyed by the slot.
- **`node --test`** — `slotForHandle` pinned against the Solidity vector, and the
  EIP-712 digest for `bindHandle`, both computed the same way on both sides.
- **`npm run audit:contracts`** — Slither, with only the documented findings
  surviving. `arbitrary-send-erc20` on `_settleMember` needs its disable comment
  rewritten: the justification changes from "from is a member" to "from is the
  member or the wallet that owns their slot".

## Sequencing

1. `HandleRegistry` + its tests + Slither. Deploy first — the other two take its
   address in their constructors.
2. `BillSplitRegistry` v3 + tests. Deploy. Do **not** repoint the app yet.
3. `RecurringTabFactory` v2 + `RecurringTab` + tests. Deploy.
4. Off-chain §4, behind the new addresses. Reputation re-key migration runs
   before the repoint.
5. Repoint `NEXT_PUBLIC_BILL_SPLIT_REGISTRY_ADDRESS`,
   `NEXT_PUBLIC_RECURRING_TAB_FACTORY_ADDRESS` and the new
   `NEXT_PUBLIC_HANDLE_REGISTRY_ADDRESS`. Delete the pre-mint code in the same
   commit — it has no callers by then.
6. Re-create bills 63 and 64 as the acceptance check: tag an address that has
   never signed in, confirm the debt appears in their settle deck the moment they
   do, with a due date, escrow, and a working pay link.
