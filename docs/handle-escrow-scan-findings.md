# HandleEscrow: SolidityScan findings, answered

SolidityScan reported four findings against `contracts/HandleEscrow.sol`
(deployed at `0x9820f2889710a2a5190187993c31ff1d4f15efa5`, see
[deployments](./deployments.md)). All four are false positives. This file is the
written justification that a self-published SolidityScan report requires, and
the evidence for each is a passing test, not an assertion.

Cross-checks, both run against the current source:

- `npx hardhat test solidity` — **187 passing**.
- `slither . --config-file slither.config.json` — 102 detectors over 33
  contracts. Its only `HandleEscrow` finding is that `DOMAIN_SEPARATOR()` is not
  mixedCase, which is deliberate: that is the name EIP-712 tooling expects.

No code changes were made in response to this scan. Each section says why.

## H001 — "Absence of nonce in signature leading to replay attacks"

**The claim.** `Release(uint256 id,address to,uint256 deadline)` has no field
named `nonce`, so a signature can be replayed.

**Why it is wrong.** The deposit id *is* the nonce. `release` deletes the
deposit (`HandleEscrow.sol:271`) before it pays out, so a replayed signature
finds `amount == 0` and reverts `NoSuchDeposit`. `nextDepositId` only ever
increments (`:213`), so an id is never reused and a retired signature can never
match a future deposit. `DOMAIN_SEPARATOR()` (`:181-191`) is rebuilt from
`block.chainid` and `address(this)` on every call, so a signature cannot be
replayed across chains, across a fork, or against another deployment.

**Tests.** `test_releaseCannotBeReplayed`,
`test_secondAuthorizationCannotSpendAnAlreadyReleasedDeposit`,
`test_signatureCannotAuthorizeAnotherDeposit`,
`test_signatureCannotExtendItsDeadline`, `test_chainIdChangeRejectsOldSignature`,
`test_signatureForAnotherDeploymentIsRejected`,
`test_signatureForAnotherChainIsRejected`,
`test_reclaimInvalidatesAnOutstandingSignature`.

**The one real nuance, and why a nonce would not help.** Re-signing the same id
for a different `to` — the user changed wallet — leaves two live signatures
until one is consumed. This is stated in the contract header (`:47-51`) rather
than hidden. A nonce field does not fix it: both signatures would carry the same
nonce, and only one can ever be consumed either way, because the first to land
deletes the deposit. There is no double-spend in either design. The bound is the
deadline, which the off-chain releaser sets to 600 seconds
(`lib/escrow-release.ts:53`).

**Not fixed because:** adding a `nonce` field changes `RELEASE_TYPEHASH`, which
invalidates every outstanding signature, forces a redeploy of a contract that
holds user funds, and adds a storage slot plus gas to every release — to satisfy
a field-name match while changing no security property.

## H002 — "Claim reward token ownership not checked"

**The claim.** A payout function transfers to a caller-supplied address without
checking the caller is entitled to it.

**Why it is wrong.** `release` has no `msg.sender` check by design, documented at
`:223-227`: the recipient's wallet is empty by definition — that is the entire
reason this contract exists — so a third party has to pay the gas. The
authorization is the signature, not the caller. `to` is inside the signed struct
(`:261`), so substituting a different recipient makes the signature fail to
recover to the attester.

`reclaim`, the function that *does* need an ownership check, has one: it
requires `held.depositor == msg.sender` (`:290`).

**Tests.** `testFuzz_signatureCannotRedirectPayment` fuzzes 256 random
replacement addresses; every one reverts `BadSignature` and leaves the deposit
held, after which the signed recipient is still paid.
`test_strangerCanRelayButOnlyTheSignedRecipientIsPaid` confirms a relayer
receives nothing. `test_recipientCannotReclaimSomeoneElsesDeposit` and
`test_attesterCannotReclaimSomeoneElsesDeposit` cover the `reclaim` side.

**Not fixed because:** a `msg.sender` check on `release` would break gasless
relay, which is the feature. There is nothing to fix.

## H003 — "Signature malleability"

**The claim.** Raw `ecrecover` accepts both forms of a signature.

**Why it is wrong.** `_recover` (`:336-356`) performs every check `ecrecover`
omits:

- `s` must lie in the lower half of the curve order (`:345`). Without this, one
  authorization has two valid encodings.
- `v` must be 27 or 28 (`:348`).
- A zero-address result is rejected (`:353`), which is what `ecrecover` returns
  for a malformed signature instead of reverting.
- Length must be exactly 65 bytes (`:337`), which also rejects trailing bytes.

`_HALF_CURVE_ORDER` was verified against the curve rather than trusted:
`secp256k1_n // 2` equals
`0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0`
exactly, which is the value at `:148-149`.

**Tests.** `test_highSSignatureIsRejectedAndCanonicalSignatureStillWorks` flips
`s` to `n - s` and swaps `v`, asserts the revert and that the deposit is still
held, then proves the canonical signature still pays. Plus
`test_invalidVIsRejected`, `test_zeroSignatureIsRejected`,
`test_shortSignatureIsRejected`, `test_trailingSignatureBytesAreRejected`.

**Additionally:** even a malleable signature could not double-spend here,
because the deposit is deleted on release and no signature hash is used as a
uniqueness key. Malleability has no reachable consequence in this contract.

**Not fixed because:** the guards are already present and correct. Swapping in
OpenZeppelin's `ECDSA.recover` to satisfy import recognition would add a
dependency to a repo that deliberately vendors its own `SafeERC20` and
`ReentrancyGuard`, replacing code that performs the identical three checks.

## L001 — "Missing zero address validation"

**The claim.** One address input reaches state or a transfer unvalidated.

**Why it is wrong.** Every address input in the contract is validated:

| Input | Check | Test |
| --- | --- | --- |
| `usdc_` | `:169` | `test_zeroTokenIsRejected` |
| `attester_` | `:169` | `test_zeroAttesterIsRejected` |
| `to` in `release` | `:241` | `test_releaseRefusesTheZeroAddress` |
| recovered signer | `:353` | `test_zeroSignatureIsRejected` |

The scan report gave no line number for the instance, so the trigger is
inferred: the constructor folds four validations into a single `||` condition
that reverts with a custom `InvalidConfiguration()` error, rather than one
`require` per parameter, which is the shape this detector matches on.

**Not fixed because:** splitting the guard is cosmetic — identical semantics,
identical revert — and shipping it would mean redeploying a contract that holds
user funds, migrating open deposits, and rotating
`NEXT_PUBLIC_HANDLE_ESCROW_ADDRESS`. If the escrow is redeployed for an
independent reason, the split can ride along at no cost.

## What the scan did not find, and what actually matters

Neither SolidityScan nor slither flags these, because they are disclosed design
choices rather than pattern violations. They are the real risk surface, and both
are already written into the contract header:

- **A compromised attester key can misdirect every deposit the contract
  currently holds**, one signature per id (`:59-69`). `holdWindow` and
  `maxReleasePerDay` bound the reachable balance; they do not remove the risk.
- **There is no pause and no key rotation** (`:20-25`). The attester is immutable
  on purpose — a setter needs an owner, which is the privileged role this design
  avoids. Recovery is `reclaim`, and it is explicitly a race: a malicious release
  may confirm before a depositor's reclaim.

The intended upgrade is moving the attester key into a TEE, which changes only
where the key lives — same address, same signature, same Solidity.
