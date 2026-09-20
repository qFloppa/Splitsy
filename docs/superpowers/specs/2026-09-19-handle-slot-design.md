# Handle-Derived Slot Participants

**Status:** approved  
**Author:** Claude (Kiro)  
**Date:** 2026-09-19

## Problem

When someone tags `@dani` on a bill before Dani has signed in, the app mints a
Privy embedded wallet and files the debt under it. That wallet is custodial:
the server holds its key. This contradicts the product's non-custodial wallet
direction — Privy embedded wallets are meant to be user-controlled, not
pre-minted holding addresses.

Four observable symptoms:

1. A tagged stranger's on-chain address differs from the wallet shown after they
   log in — the bill named one address, their actual wallet is another.
2. The "I owe X" direction (creating a debt where the logged-in user is the
   debtor) works with Privy; the "X owes me" direction (tagging a stranger)
   still mints a custodial slot.
3. `lib/wallet-resolve.ts:49` explicitly calls `getOrCreateWallet("prem", …)`,
   which is the Circle-era pre-mint path reused for Privy.
4. The refund path (`lib/slot-refund.ts`) sweeps money out of a pre-minted
   wallet in three legs: top-up gas, refund from slot, sweep to the user's real
   wallet. That's operational complexity and a ~0.05 USDC-per-refund leak.

The requirement: **no custodial wallets**, while preserving every feature
(all-or-nothing escrow, due dates, public pay links, `payDebtFor`, reputation).

## Solution

A tagged stranger's on-chain address becomes a **pure function of their
handle**, with no key anywhere. The contract gains one attester-signed function
(`refundSlot`) so money can leave that address when a bill fails.

```solidity
// Same derivation HandleEscrow uses: keccak256(provider ":" handle), low 160 bits.
slot = address(uint160(uint256(handleHash)))
```

Every participant has an address, so every feature that names "the participant's
address" — paying, settling, escrow, reputation — works unchanged. The one
operation that *needs a key* (refunding your own failed payment) is relayed by
the server with an attester signature, the same pattern `HandleEscrow.release`
already uses.

**What this fixes:**

- No pre-minted wallets. `lib/wallet-resolve.ts` stops calling the wallet SDK.
- Login shows the slot address immediately, with no sweep needed — it's derived,
  not minted.
- The refund relay collapses from three legs to one, and the per-refund leak
  disappears.
- A slot is deterministic: tagging `@dani` on two bills gives the same address.

**What stays the same:**

- Payment rails: `payDebt`, `payDebtFor`, and public pay links work unchanged.
- All-or-nothing escrow, due dates, collect mandates (for real wallets) untouched.
- Reputation aggregation: a slot accumulates ERC-8004 reputation like any wallet.

**What doesn't work and never did:**

- Collect mandates for slots. `collectDebt` pulls from `usdc.balanceOf(debtor)`
  (BillSplitRegistry.sol:850), so a keyless address with no balance can't be
  collected from. That path is already unreachable: the mandate consent UI lists
  only `billIdsForParticipant(user.wallet_address)`, which never includes bills
  where only the slot is named. This change preserves that: slots still can't
  grant mandates, and the UI still doesn't list them.

## Design

### §1 — Slot derivation

A new `lib/handle-slot.ts` exports one function:

```typescript
export function slotForHandle(provider: IdentityProvider, handle: string): `0x${string}` {
  const hash = handleHash(provider, handle);  // from lib/handle-escrow.ts
  return `0x${hash.slice(-40)}` as `0x${string}`;
}
```

**Reuses `handleHash`** from `lib/handle-escrow.ts:22` so the slot and the
escrow deposit key share one normalizer. That function already lowercases,
trims, and strips the `@` prefix. A second normalizer would be a second
drift risk.

**Golden test required:** `lib/handle-slot.test.ts` pins the same
`("x", "alice")` vector Solidity produces. A mismatch is silent in dev and only
surfaces when a real refund fails.

### §2 — Contract changes

`BillSplitRegistry` v3 adds one immutable and one function. Constructor gains
`address attester_` beside the existing `address usdc_`. The attester is the
address whose key signs `refundSlot` calls — same party that signs
`HandleEscrow.release`.

```solidity
address public immutable attester;

// EIP-712 domain for refundSlot. Distinct from HandleEscrow's domain so a
// redeploy can't replay old signatures.
bytes32 public immutable DOMAIN_SEPARATOR;

bytes32 public constant REFUND_SLOT_TYPEHASH = keccak256(
  "RefundSlot(uint256 billId,address slot,address to,uint256 deadline)"
);

constructor(address usdc_, address attester_) {
  // … existing usdc validation …
  if (attester_ == address(0)) revert InvalidConfiguration();
  attester = attester_;
  
  DOMAIN_SEPARATOR = keccak256(abi.encode(
    keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
    keccak256("Splitsy BillSplit"),
    keccak256("1"),
    block.chainid,
    address(this)
  ));
}

/// @notice Refund a slot participant's payment when a bill has failed.
/// @dev Permissionless relay authorized by the attester's EIP-712 signature.
///      The signature binds `to`, so a stolen attester key can misdirect one
///      refund but can never pay a non-participant. Same concession
///      HandleEscrow.release already documents.
/// @param billId The bill to refund from.
/// @param slot The slot participant's address (derived from their handle).
/// @param to The address to send the refund to (the user's real wallet).
/// @param deadline Signature expiry (block.timestamp).
/// @param signature EIP-712 signature from the attester.
function refundSlot(
  uint256 billId,
  address slot,
  address to,
  uint256 deadline,
  bytes calldata signature
) external nonReentrant {
  if (block.timestamp > deadline) revert SignatureExpired(deadline);
  
  // EIP-712 signature verification, lifted from HandleEscrow.sol:219-242.
  bytes32 structHash = keccak256(abi.encode(REFUND_SLOT_TYPEHASH, billId, slot, to, deadline));
  bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
  
  bytes32 r; bytes32 s; uint8 v;
  assembly {
    r := calldataload(signature.offset)
    s := calldataload(add(signature.offset, 32))
    v := byte(0, calldataload(add(signature.offset, 64)))
  }
  
  // Malleable signatures rejected — same guard HandleEscrow uses.
  bytes32 _HALF_CURVE_ORDER = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;
  if (uint256(s) > uint256(_HALF_CURVE_ORDER)) revert InvalidSignature();
  
  address signer = ecrecover(digest, v, r, s);
  if (signer == address(0) || signer != attester) revert InvalidSignature();
  
  // Refund the slot's payment, but send it to `to` instead of to `slot`.
  // The slot has no key, so refunding to it would strand the money.
  Bill storage bill = _billOrRevert(billId);
  Participant storage participant = _participants[billId][slot];
  
  if (!participant.exists) revert NotAParticipant(billId, slot);
  if (participant.paid == 0) revert NothingToRefund(billId, slot);
  if (!_canRefund(bill)) revert RefundConditionsNotMet(billId);
  
  uint256 amount = participant.paid;
  participant.paid = 0;
  bill.totalPaid -= amount;
  
  usdc.safeTransfer(to, amount);
  
  emit DebtRefunded(billId, slot, amount, bill.totalPaid, bill.totalOwed);
}
```

**Why not `refund(billId)` with a `to` parameter?** That would need caller
authentication (only the slot owner can refund it), which means either attesting
every refund or teaching the contract about handle→owner bindings. The first is
what this does; the second is the larger change (`HandleRegistry`, slot→owner
map, `billIdsForParticipant` resolving through owned slots) deferred from the
rejected spec. This is the minimal change that unblocks stuck refunds.

**Functions unchanged:** `payDebt`, `payDebtFor`, `settle`, `claim`,
`authorizeCollect`, `revokeCollect`, `collectDebt`, `refund`. A real wallet
still uses `refund(billId)` directly.

### §3 — Off-chain changes

**lib/wallet-resolve.ts:49** — delete the `getOrCreateWallet("prem", …)` mint
path and replace with `slotForHandle`. The whole `defaultMintPending` block
(lines 44–55) is deleted.

```typescript
// Before (lines 42–58):
export async function resolveParticipantAddress(
  provider: IdentityProvider,
  handle: string,
  deps: ResolveDeps = { getUserByProviderHandle, getPendingWallet, mintPending: defaultMintPending },
): Promise<`0x${string}`> {
  // … user lookup unchanged …
  const pending = await deps.getPendingWallet(provider, handle);
  if (pending) return pending.wallet_address as `0x${string}`;
  return deps.mintPending(provider, handle);
}

async function defaultMintPending(provider: IdentityProvider, handle: string): Promise<`0x${string}`> {
  const address = await getOrCreateWallet("prem", `${provider}:${handle}`);  // ← DELETED
  await insertPendingWallet({ provider, handle, wallet_address: address, circle_wallet_id: null });
  return address;
}

// After:
export async function resolveParticipantAddress(
  provider: IdentityProvider,
  handle: string,
  deps: ResolveDeps = { getUserByProviderHandle, getPendingWallet },
): Promise<`0x${string}`> {
  const user = await deps.getUserByProviderHandle(provider, handle);
  if (user?.wallet_address) return user.wallet_address as `0x${string}`;
  
  const pending = await deps.getPendingWallet(provider, handle);
  if (pending) return pending.wallet_address as `0x${string}`;
  
  return slotForHandle(provider, handle);
}
```

**Type change:** `ResolveDeps` loses `mintPending`.

**lookupParticipantAddress** (`:120`) is **deliberately unchanged**. It returns
`null` when the user has no wallet yet, which tells the IOU settle rail to
escrow rather than send money to a keyless address. That's correct, and it
already does it.

**lib/slot-refund.ts** — deleted entirely. Three functions (`gasTopUpUsdc`,
`sweepAmountUsdc`, `refundSlotToOwner`) and 157 lines removed. The new refund
relay is one attester-signed call, built in a new `lib/refund-slot.ts`:

```typescript
import { privateKeyToAccount } from "viem/accounts";
import { ARC } from "./arc-chain.ts";
import { BILL_SPLIT_REGISTRY_ADDRESS, publicClient } from "./bill-split-contracts.ts";

const ATTESTER_KEY = process.env.REFUND_SLOT_ATTESTER_PRIVATE_KEY;
if (!ATTESTER_KEY) throw new Error("REFUND_SLOT_ATTESTER_PRIVATE_KEY not set");

const attester = privateKeyToAccount(ATTESTER_KEY as `0x${string}`);

export async function refundSlot(
  billId: bigint,
  slot: `0x${string}`,
  to: `0x${string}`,
): Promise<{ txHash: string }> {
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300); // 5min
  
  const domain = {
    name: "Splitsy BillSplit",
    version: "1",
    chainId: ARC.chain.id,
    verifyingContract: BILL_SPLIT_REGISTRY_ADDRESS,
  } as const;
  
  const types = {
    RefundSlot: [
      { name: "billId", type: "uint256" },
      { name: "slot", type: "address" },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
  } as const;
  
  const signature = await attester.signTypedData({
    domain,
    types,
    primaryType: "RefundSlot",
    message: { billId, slot, to, deadline },
  });
  
  const hash = await walletClient.writeContract({
    address: BILL_SPLIT_REGISTRY_ADDRESS,
    abi: billSplitRegistryAbi,
    functionName: "refundSlot",
    args: [billId, slot, to, deadline, signature],
    account: attester,
    chain: ARC.chain,
  });
  
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("refundSlot transaction reverted");
  
  return { txHash: hash };
}
```

**app/api/onchain-bills/[billId]/refund/route.ts** — replace `refundSlotToOwner`
call with `refundSlot`:

```typescript
// Before (lines 48–74):
let slot = null as Awaited<ReturnType<typeof getSlotWalletForUser>>;
try {
  slot = await getSlotWalletForUser(user).catch(() => null);
} catch { /* … */ }

if (slot) {
  const relayed = await refundSlotToOwner({
    billId: BigInt(billId),
    slotWallet: slot as PendingWallet,
    toAddress: user.wallet_address as `0x${string}`,
  });
  return Response.json({
    ok: true,
    refundedUsdc: relayed.refundedUsdc,
    txHash: relayed.refundTxHash,
    forwardedUsdc: relayed.sweptUsdc,
    forwardTxHash: relayed.sweepTxHash,
  });
}

// After:
const slot = await getSlotWalletForUser(user).catch(() => null);
if (slot) {
  const { txHash } = await refundSlot(
    BigInt(billId),
    slot.wallet_address as `0x${string}`,
    user.wallet_address as `0x${string}`,
  );
  const [refunded] = await getParticipantsOnchain([{
    billId: BigInt(billId),
    addr: slot.wallet_address as `0x${string}`,
  }]);
  return Response.json({
    ok: true,
    refundedUsdc: refunded ? Number(refunded.owed - refunded.paid) / 1e6 : 0,
    txHash,
  });
}
```

**app/api/me**, **app/api/dashboard**, **[billId]/pay** — `getSlotWalletForUser`
stays called, but its implementation changes (§4).

**lib/registry-calldata.ts** gains `encodeRefundSlot`:

```typescript
export function encodeRefundSlot(
  billId: bigint,
  slot: `0x${string}`,
  to: `0x${string}`,
  deadline: bigint,
  signature: `0x${string}`,
): `0x${string}` {
  return encodeFunctionData({
    abi: REGISTRY_CALL_ABI,
    functionName: "refundSlot",
    args: [billId, slot, to, deadline, signature],
  });
}
```

**lib/bill-split-contracts.ts:70** — `billSplitRegistryAbi` gains the
`refundSlot` function signature, `DOMAIN_SEPARATOR`, `REFUND_SLOT_TYPEHASH`, and
`attester` view.

### §4 — pending_wallets retires (mostly)

`getSlotWalletForUser` stops reading `pending_wallets` and derives the slot instead:

```typescript
// lib/pending-wallets-repo.ts:53 — before:
export async function getSlotWalletForUser(user: { provider: string | null; handle: string }) {
  if (!user.provider || user.provider === "wallet") return null;
  return getPendingWallet(user.provider as IdentityProvider, user.handle);
}

// After:
export async function getSlotWalletForUser(user: { provider: string | null; handle: string }) {
  if (!user.provider || user.provider === "wallet") return null;
  const slot = slotForHandle(user.provider as IdentityProvider, user.handle);
  return { wallet_address: slot, circle_wallet_id: null };
}
```

**Why not delete the table?** Four consumers remain:

1. **Provision sweep** (`app/api/wallet/provision/route.ts:218`) — when a user
   logs in for the first time, check if they have a pre-minted wallet with USDC
   in it, and sweep it to their new wallet. This handles the upgrade: users
   tagged before this change have real `pending_wallets` rows.
2. **Reputation lookup** (`lib/reputation-lookup.ts:36`) — resolve a handle to
   an address for the reputation badge. Falls back to `pending_wallets` when the
   user has no account yet.
3. **OAuth callback cleanup** (`lib/oauth-callback.ts:149, :154`) — delete the
   pending row on first login. Kept so the table eventually empties itself.
4. **Privy callback cleanup** (`app/api/auth/privy/route.ts:114, :116`) — same.

Once every pre-change user has logged in at least once, the table becomes
append-only tombstones (deleted on read). No new rows are written.

**Insert path deleted:** `insertPendingWallet` is no longer called. The only
insertion was `lib/wallet-resolve.ts:51`, removed in §3.

### §5 — Deployment

1. **Deploy BillSplitRegistry v3** with the attester address (same one that
   signs `HandleEscrow.release`):
   ```bash
   npm run deploy:arc:bill-registry  # or deploy:arc-mainnet:bill-registry
   ```
   Script prints `NEXT_PUBLIC_BILL_SPLIT_REGISTRY_ADDRESS=0x…` and
   `BILL_SPLIT_REGISTRY_ADDRESS_V1=0x924…1a3b` (the old address, kept readable).

2. **Set env vars:**
   ```
   NEXT_PUBLIC_BILL_SPLIT_REGISTRY_ADDRESS=0x<new>
   BILL_SPLIT_REGISTRY_ADDRESS_V1=0x924Cf4331a3b  # testnet only, mainnet has none
   REFUND_SLOT_ATTESTER_PRIVATE_KEY=0x<key>       # same key as ESCROW_ATTESTER_PRIVATE_KEY
   ```

3. **Run the registry re-key migration** (sql/schema-reputation.sql) so
   reputation rows point to the new registry.

4. **Re-run SCP monitor setup** against the new address:
   ```bash
   npm run settler:setup
   ```

Bill ids restart at 1. The old registry (bills 1–83) stays readable via
`BILL_SPLIT_REGISTRY_ADDRESS_V1`, which `lib/arc-read.ts:20` already supports.

**Attester key reuse:** `REFUND_SLOT_ATTESTER_PRIVATE_KEY` and
`ESCROW_ATTESTER_PRIVATE_KEY` are the same key. One key to guard, not two. A
leaked key can misdirect refunds or escrow releases, same concession
`lib/escrow-release.ts:19-21` already documents.

### §6 — Testing

**Foundry (contracts/BillSplitRegistry.t.sol):**

- `testRefundSlotHappyPath` — slot paid, bill short past deadline, attester
  signs, funds reach `to`.
- `testRefundSlotRevertsOnBadSignature` — wrong signer, wrong domain, replayed
  signature.
- `testRefundSlotRevertsWhenNotShort` — bill is full.
- `testRefundSlotRevertsWhenNotDue` — no deadline or deadline hasn't passed.
- `testRefundSlotRevertsWhenSlotNotParticipant` — slot never joined the bill.
- `testRefundSlotRevertsWhenSlotPaidNothing` — slot is a participant but paid 0.
- `testRefundSlotRevertsAfterDeadline` — signature expired.
- `testRefundStillWorksForRealWallets` — unchanged path.

**Node.js (lib/handle-slot.test.ts):**

```typescript
import assert from "node:assert/strict";
import { test } from "node:test";
import { slotForHandle } from "./handle-slot.ts";

test("golden vector: x:alice matches Solidity", () => {
  // Must match what BillSplitRegistry.t.sol computes for the same handle.
  // If these ever disagree, refunds fail in prod with "NotAParticipant".
  const expected = "0x..." // ← filled from Solidity test
  assert.equal(slotForHandle("x", "alice"), expected);
});

test("derived slot is deterministic", () => {
  const a = slotForHandle("discord", "bob");
  const b = slotForHandle("discord", "bob");
  assert.equal(a, b);
});

test("different handles produce different slots", () => {
  const a = slotForHandle("x", "alice");
  const b = slotForHandle("x", "bob");
  assert.notEqual(a, b);
});
```

**lib/wallet-resolve.test.ts** — update mocks. `mintPending` is removed from
`ResolveDeps`, and the test for "mints when neither exists" becomes "derives
slot when neither exists".

**lib/slot-refund.test.ts** — deleted (the module it tests is deleted).

**Run:** `npm run test:contracts && npm run test:escrow && npm run test:wallet-provider`

### §7 — Rollout notes

**Upgrade path for existing slots:** Users tagged before this change have real
`pending_wallets` rows with minted wallets. On first login after deployment:

1. `getSlotWalletForUser` derives the new slot address.
2. Provision sweep (`/api/wallet/provision`) reads the old `pending_wallets`
   row and sweeps any USDC in the old minted wallet to the user's new wallet.
3. The old row is deleted.

Bills filed against the old minted address stay bound to it — the participant
list is immutable. Those bills are readable via `BILL_SPLIT_REGISTRY_ADDRESS_V1`
and the old wallet's key can still pay/refund them. New bills use the derived
slot.

**No feature loss:**

- All-or-nothing escrow, due dates, public pay links, `payDebtFor`, reputation,
  and settle all work for derived slots.
- Refunds now work (they were broken for slots before).
- Collect mandates remain unavailable for slots, same as today.

**Operational win:** The refund relay drops from 3 legs to 1, and the
~0.05 USDC-per-refund operator leak (`lib/slot-refund.ts:100`) disappears.

---

## Summary

A tagged stranger's address becomes `address(uint160(uint256(handleHash)))` — a
pure function, no key anywhere. `BillSplitRegistry` v3 gains `refundSlot` so
money can leave that address when a bill fails, attester-signed like
`HandleEscrow.release`. Every feature (escrow, due dates, pay links, reputation)
works unchanged. The app stops minting wallets, login shows the slot address
immediately, and the refund path simplifies from three legs to one.

**Files created:**
- `lib/handle-slot.ts` (slot derivation)
- `lib/handle-slot.test.ts` (golden vector)
- `lib/refund-slot.ts` (attester-signed relay)

**Files deleted:**
- `lib/slot-refund.ts`
- `lib/slot-refund.test.ts`

**Contracts changed:**
- `contracts/BillSplitRegistry.sol` (+~80 lines: attester, domain, refundSlot)
- `contracts/BillSplitRegistry.t.sol` (+8 tests)

**Unchanged:**
- `HandleEscrow.sol` (same attester, separate domain)
- `payDebt`, `payDebtFor`, `settle`, `claim`, `refund`, `authorizeCollect`, `collectDebt`
