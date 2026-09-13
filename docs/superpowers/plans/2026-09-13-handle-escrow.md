# HandleEscrow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop an IOU to someone who has never used Splitsy from losing the money — hold it in an ownerless contract keyed on their handle, and release it to the wallet they actually sign in with.

**Architecture:** A new `HandleEscrow` contract holds USDC against `keccak256("<provider>:<handle>")`. The sender deposits; at login, the Splitsy server signs an EIP-712 `Release` message naming the recipient's real wallet and relays the release. The sender can reclaim at any time before release. No owner, no upgrade path, no admin key over the funds.

**Tech Stack:** Solidity 0.8.36 (evmVersion `cancun`), Hardhat 3 + `hardhat-toolbox-viem`, viem, Next.js App Router, Supabase, Privy (server SDK `@privy-io/node`), Arc Testnet (`eip155:5042002`).

**Spec:** `docs/superpowers/specs/2026-09-13-handle-escrow-design.md`

## Global Constraints

- **Solidity 0.8.36 exactly.** `pragma solidity 0.8.36;` in contracts, `^0.8.36` in `.t.sol` test files — this mirrors the existing split in `contracts/`.
- **evmVersion `cancun`.** Pinned in `hardhat.config.ts`; Arc does not accept `prague` opcodes. Do not change the config.
- **No new dependencies.** There is no OpenZeppelin in this repo. Use the vendored `contracts/interfaces/IERC20.sol`, `contracts/libraries/SafeERC20.sol`, `contracts/security/ReentrancyGuard.sol`.
- **No owner, no upgrade, no pause, no sweep, no `selfdestruct`** in `HandleEscrow`. This is the property that makes it auditable.
- **USDC has 6 decimals.** Amounts are micro-USDC (`1e6` = $1.00).
- **Arc charges gas in USDC.** A wallet cannot spend its entire balance.
- **Tests:** contracts via `npx hardhat test`; TypeScript via `node --test --experimental-strip-types`. Pure TS modules must not import `@/lib/...` aliases or `next/*` — they will not load under `node --test`. Follow `lib/iou.ts` (imports use `./name.ts` with the extension).
- **Comment style:** the house style explains *why*, not *what*, and names what was rejected. Match `contracts/BillSplitRegistry.sol` and `lib/wallet-resolve.ts`.
- **Commit messages:** lowercase `type(scope): summary` in plain words, e.g. `feat(escrow): hold an IOU until its recipient exists`. End every commit message with `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.

## Scope

**In:** §1 and §2 of the spec — the contract, the deposit path, the release-at-login path.

**Out:** §3 (bills/recurring keeping strangers off chain) is blocked on a product decision and is **not** in this plan. Therefore `pregenerateWallet`, `defaultMintPending` and `pending_wallets` **stay exactly as they are** — the three bill routes still need them. Do not delete them.

**After this plan:** the settle rail no longer strands money. Bills remain broken in the older, non-money-losing way (a debt bound to an address the debtor cannot reach). That is expected.

---

### Task 1: The HandleEscrow contract

**Files:**
- Create: `contracts/HandleEscrow.sol`
- Create: `contracts/HandleEscrow.t.sol`

**Interfaces:**
- Consumes: `IERC20`, `SafeERC20`, `ReentrancyGuard` from the vendored paths.
- Produces:
  - `constructor(address usdc_, address attester_)`
  - `deposit(bytes32 handleHash, uint256 amount) returns (uint256 id)`
  - `release(uint256 id, address to, uint256 deadline, bytes calldata signature)`
  - `reclaim(uint256 id)`
  - `deposits(uint256) returns (address depositor, bytes32 handleHash, uint256 amount)`
  - `DOMAIN_SEPARATOR() returns (bytes32)`
  - `RELEASE_TYPEHASH` = `keccak256("Release(uint256 id,address to,uint256 deadline)")`
  - events `Deposited(uint256 indexed id, address indexed depositor, bytes32 indexed handleHash, uint256 amount)`, `Released(uint256 indexed id, address indexed to, uint256 amount)`, `Reclaimed(uint256 indexed id, address indexed depositor, uint256 amount)`

- [ ] **Step 1: Write the failing test**

Create `contracts/HandleEscrow.t.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

import {HandleEscrow} from "./HandleEscrow.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {Test} from "./test/Test.sol";

contract HandleEscrowTest is Test {
  // Anvil account #0's key, and the address it derives. Used as the attester so
  // the test can produce real signatures with vm.sign.
  uint256 private constant ATTESTER_KEY = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
  address private constant ATTESTER = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;

  address private alice = address(0xA11CE);
  address private dani = address(0xDA17);
  address private stranger = address(0xBAD);

  bytes32 private constant DANI_HASH = keccak256("email:dani@example.com");
  uint256 private constant AMOUNT = 1e6;

  MockUSDC private usdc;
  HandleEscrow private escrow;

  event Deposited(uint256 indexed id, address indexed depositor, bytes32 indexed handleHash, uint256 amount);
  event Released(uint256 indexed id, address indexed to, uint256 amount);
  event Reclaimed(uint256 indexed id, address indexed depositor, uint256 amount);

  function setUp() public {
    usdc = new MockUSDC();
    escrow = new HandleEscrow(address(usdc), ATTESTER);
    usdc.mint(alice, 100e6);
    vm.prank(alice);
    usdc.approve(address(escrow), type(uint256).max);
  }

  /// @dev Builds the EIP-712 digest the contract will check, then signs it with
  ///      the attester key. Mirrors what lib/escrow-release.ts does off chain —
  ///      if these two ever disagree, releases fail in production only.
  function _sign(uint256 id, address to, uint256 deadline) private view returns (bytes memory) {
    bytes32 structHash = keccak256(abi.encode(escrow.RELEASE_TYPEHASH(), id, to, deadline));
    bytes32 digest = keccak256(abi.encodePacked("\x19\x01", escrow.DOMAIN_SEPARATOR(), structHash));
    (uint8 v, bytes32 r, bytes32 s) = vm.sign(ATTESTER_KEY, digest);
    return abi.encodePacked(r, s, v);
  }

  function _deposit() private returns (uint256 id) {
    vm.prank(alice);
    id = escrow.deposit(DANI_HASH, AMOUNT);
  }

  function test_depositHoldsTheMoney() public {
    uint256 id = _deposit();
    assertEq(id, 1);
    assertEq(usdc.balanceOf(address(escrow)), AMOUNT);
    assertEq(usdc.balanceOf(alice), 99e6);
    (address depositor, bytes32 handleHash, uint256 amount) = escrow.deposits(id);
    assertEq(depositor, alice);
    assertTrue(handleHash == DANI_HASH);
    assertEq(amount, AMOUNT);
  }

  function test_releasePaysTheNamedWallet() public {
    uint256 id = _deposit();
    uint256 deadline = block.timestamp + 1 hours;
    escrow.release(id, dani, deadline, _sign(id, dani, deadline));
    assertEq(usdc.balanceOf(dani), AMOUNT);
    assertEq(usdc.balanceOf(address(escrow)), 0);
  }

  function test_releaseRejectsAWrongSigner() public {
    uint256 id = _deposit();
    uint256 deadline = block.timestamp + 1 hours;
    bytes32 structHash = keccak256(abi.encode(escrow.RELEASE_TYPEHASH(), id, dani, deadline));
    bytes32 digest = keccak256(abi.encodePacked("\x19\x01", escrow.DOMAIN_SEPARATOR(), structHash));
    // Anvil account #1 — a real key, but not the attester.
    (uint8 v, bytes32 r, bytes32 s) =
      vm.sign(0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d, digest);
    vm.expectRevert(HandleEscrow.BadSignature.selector);
    escrow.release(id, dani, deadline, abi.encodePacked(r, s, v));
  }

  function test_releaseRejectsAnExpiredDeadline() public {
    uint256 id = _deposit();
    uint256 deadline = block.timestamp + 1 hours;
    bytes memory sig = _sign(id, dani, deadline);
    vm.warp(deadline + 1);
    vm.expectRevert(HandleEscrow.SignatureExpired.selector);
    escrow.release(id, dani, deadline, sig);
  }

  function test_releaseCannotBeReplayed() public {
    uint256 id = _deposit();
    uint256 deadline = block.timestamp + 1 hours;
    bytes memory sig = _sign(id, dani, deadline);
    escrow.release(id, dani, deadline, sig);
    vm.expectRevert(abi.encodeWithSelector(HandleEscrow.NoSuchDeposit.selector, id));
    escrow.release(id, dani, deadline, sig);
  }

  function test_reclaimReturnsTheMoneyToTheSender() public {
    uint256 id = _deposit();
    vm.prank(alice);
    escrow.reclaim(id);
    assertEq(usdc.balanceOf(alice), 100e6);
    assertEq(usdc.balanceOf(address(escrow)), 0);
  }

  function test_reclaimRefusesAStranger() public {
    uint256 id = _deposit();
    vm.prank(stranger);
    vm.expectRevert(abi.encodeWithSelector(HandleEscrow.NotDepositor.selector, id, stranger));
    escrow.reclaim(id);
  }

  function test_reclaimAfterReleaseFindsNothing() public {
    uint256 id = _deposit();
    uint256 deadline = block.timestamp + 1 hours;
    escrow.release(id, dani, deadline, _sign(id, dani, deadline));
    vm.prank(alice);
    vm.expectRevert(abi.encodeWithSelector(HandleEscrow.NoSuchDeposit.selector, id));
    escrow.reclaim(id);
  }

  function test_depositRefusesZero() public {
    vm.prank(alice);
    vm.expectRevert(HandleEscrow.InvalidAmount.selector);
    escrow.deposit(DANI_HASH, 0);
  }

  function test_releaseRefusesTheZeroAddress() public {
    uint256 id = _deposit();
    uint256 deadline = block.timestamp + 1 hours;
    vm.expectRevert(HandleEscrow.InvalidRecipient.selector);
    escrow.release(id, address(0), deadline, _sign(id, address(0), deadline));
  }

  function test_twoSendersToOneHandleKeepSeparateDeposits() public {
    uint256 first = _deposit();
    usdc.mint(stranger, 5e6);
    vm.prank(stranger);
    usdc.approve(address(escrow), type(uint256).max);
    vm.prank(stranger);
    uint256 second = escrow.deposit(DANI_HASH, 2e6);
    assertEq(second, first + 1);
    // Alice reclaims hers; the stranger's is untouched.
    vm.prank(alice);
    escrow.reclaim(first);
    assertEq(usdc.balanceOf(address(escrow)), 2e6);
  }
}
```

**Note:** `MockUSDC` must expose `mint(address,uint256)`. Read `contracts/mocks/MockUSDC.sol` first and use whatever funding method it actually provides.

- [ ] **Step 2: Run the test to make sure it fails**

Run: `npx hardhat test`
Expected: FAIL — the compiler cannot find `./HandleEscrow.sol`.

- [ ] **Step 3: Check whether `vm.sign` exists in the test harness**

`contracts/test/Test.sol` declares a minimal `Vm` interface with only `expectEmit`, `expectRevert`, `prank` and `warp`. It has **no `sign`**. Add it:

```solidity
  function sign(uint256 privateKey, bytes32 digest) external pure returns (uint8 v, bytes32 r, bytes32 s);
```

Add that line to the `Vm` interface in `contracts/test/Test.sol`, and nothing else. Also confirm `MockUSDC` exposes `mint(address,uint256)`; if it does not, read `contracts/mocks/MockUSDC.sol` and use whatever funding method it provides.

- [ ] **Step 4: Write the contract**

Create `contracts/HandleEscrow.sol`. The header comment must record why this is a separate contract and when to upgrade the key — both are spec decisions that will otherwise be re-litigated:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {IERC20} from "./interfaces/IERC20.sol";
import {SafeERC20} from "./libraries/SafeERC20.sol";
import {ReentrancyGuard} from "./security/ReentrancyGuard.sol";

/// @title HandleEscrow
/// @author Splitsy
/// @notice Holds USDC for someone who has no wallet yet, until they sign in.
/// @dev WHY THIS IS NOT PART OF BillSplitRegistry. That contract's escrow is
///      address-keyed and direction-locked: `bill.splitter = msg.sender`, and
///      {_claim} both requires `msg.sender == splitter` and pays the splitter.
///      This one holds money FOR an address that does not exist at deposit
///      time. Adding that there would break the invariant its header states —
///      "funds can only ever leave via {claim} or {settle}'s claim legs, to the
///      bill's own splitter" — and would force a registry redeploy, which
///      restarts bill ids and leaves a third address to keep readable.
///
///      THE ATTESTER IS IMMUTABLE AND HAS NO SETTER. A settable attester needs
///      an owner, and an owner is the privileged role this avoids. The recovery
///      story is {reclaim}: if the key leaks, depositors withdraw and this
///      contract is redeployed. That only works because reclaim is
///      unconditional — the two decisions hold each other up.
///
///      THE ID IS THE NONCE. Both exits `delete` the deposit, so a replayed
///      signature finds nothing and reverts. One consequence, stated rather
///      than hidden: re-signing the same id for a different `to` (the user
///      changed wallet) leaves both signatures live until one is consumed.
///      `deadline` bounds that; a separate nonce would not change it.
///
///      `handleHash` IS OPAQUE HERE, AND IS NOT A SECRET.
///      keccak256("email:someone@example.com") is brute-forceable in seconds.
///      It is an identifier, not a password, and nothing may treat it as one.
///      Keeping it opaque is what lets a new namespace ship without touching
///      this contract.
///
///      TRUST, PLAINLY: the attester decides which address belongs to a handle.
///      It cannot drain this contract — a signature names one deposit and one
///      recipient and expires — and a depositor can always {reclaim}. But a
///      compromised key can misdirect a release. The intended upgrade is to
///      move the key inside a TEE, which changes only WHERE THE KEY LIVES: same
///      address, same signature, same Solidity. Worth doing once the typical
///      balance held here exceeds about a year of instance cost (~$600 at
///      c6g.large on-demand). Below that the enclave costs more than it
///      protects.
contract HandleEscrow is ReentrancyGuard {
  using SafeERC20 for IERC20;

  /// @notice A deposit waiting for its recipient to sign in.
  /// @param depositor Who paid in, and the only address that may {reclaim}.
  /// @param handleHash Opaque identifier of the intended recipient.
  /// @param amount USDC held, in the token's own units.
  struct Deposit {
    address depositor;
    bytes32 handleHash;
    uint256 amount;
  }

  /// @notice Thrown when a deposit is zero.
  error InvalidAmount();
  /// @notice Thrown when a constructor argument is the zero address.
  error InvalidConfiguration();
  /// @notice Thrown when a release names the zero address.
  error InvalidRecipient();
  /// @notice Thrown when a deposit does not exist, or has already left.
  /// @param id The deposit identifier that was asked for.
  error NoSuchDeposit(uint256 id);
  /// @notice Thrown when someone other than the depositor tries to reclaim.
  /// @param id The deposit identifier.
  /// @param caller The address that tried.
  error NotDepositor(uint256 id, address caller);
  /// @notice Thrown when the signature was not made by the attester.
  error BadSignature();
  /// @notice Thrown when the signature's deadline has passed.
  error SignatureExpired();

  /// @notice Emitted when money is put in for a handle.
  event Deposited(uint256 indexed id, address indexed depositor, bytes32 indexed handleHash, uint256 amount);
  /// @notice Emitted when money is paid out to a recipient's wallet.
  event Released(uint256 indexed id, address indexed to, uint256 amount);
  /// @notice Emitted when a depositor takes their money back.
  event Reclaimed(uint256 indexed id, address indexed depositor, uint256 amount);

  /// @notice The USDC token this escrow holds.
  IERC20 public immutable usdc;
  /// @notice The key whose signature authorises a release. Immutable by design.
  address public immutable attester;

  /// @notice EIP-712 type hash for a release authorisation.
  bytes32 public constant RELEASE_TYPEHASH = keccak256("Release(uint256 id,address to,uint256 deadline)");

  /// @dev Half the secp256k1 curve order. A signature with `s` above this is the
  ///      second, equally valid form of the same signature — accepting both
  ///      would make one authorisation look like two.
  uint256 private constant _HALF_CURVE_ORDER =
    0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

  /// @notice Identifier the next deposit will take.
  uint256 public nextDepositId = 1;

  /// @notice Deposits by identifier; a zero `amount` means "gone".
  mapping(uint256 id => Deposit deposit) public deposits;

  /// @dev Built once at deployment. Binding chainid and this address is what
  ///      stops a signature made for one deployment working on another.
  bytes32 private immutable _domainSeparator;

  /// @notice Binds this escrow to its token and its attester.
  /// @param usdc_ The USDC token address; must be non-zero.
  /// @param attester_ The key that signs releases; must be non-zero.
  constructor(address usdc_, address attester_) {
    if (usdc_ == address(0) || attester_ == address(0)) {
      revert InvalidConfiguration();
    }
    usdc = IERC20(usdc_);
    attester = attester_;
    _domainSeparator = keccak256(
      abi.encode(
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
        keccak256("Splitsy HandleEscrow"),
        keccak256("1"),
        block.chainid,
        address(this)
      )
    );
  }

  /// @notice The EIP-712 domain separator for this deployment.
  function DOMAIN_SEPARATOR() external view returns (bytes32) {
    return _domainSeparator;
  }

  /// @notice Puts USDC aside for whoever proves they own `handleHash`.
  /// @param handleHash Opaque identifier of the intended recipient.
  /// @param amount USDC to hold, in the token's own units; must be non-zero.
  /// @return id The identifier of the new deposit.
  function deposit(bytes32 handleHash, uint256 amount) external nonReentrant returns (uint256 id) {
    if (amount == 0) {
      revert InvalidAmount();
    }

    id = nextDepositId++;
    deposits[id] = Deposit({depositor: msg.sender, handleHash: handleHash, amount: amount});

    emit Deposited(id, msg.sender, handleHash, amount);

    usdc.safeTransferFrom(msg.sender, address(this), amount);
  }

  /// @notice Pays a deposit out to the wallet the attester names.
  /// @dev Callable by anyone holding a valid signature — the signature is the
  ///      authorisation, not the caller. That is deliberate: the recipient's
  ///      wallet is empty, so someone else has to pay the gas, and a permission
  ///      check on msg.sender would mean Splitsy going quiet could strand a
  ///      deposit that is already authorised.
  /// @param id The deposit to pay out.
  /// @param to The recipient's wallet.
  /// @param deadline Unix seconds after which the signature is dead.
  /// @param signature The attester's EIP-712 signature, 65 bytes, r||s||v.
  // The deadline is a wall-clock concept and a few seconds of proposer drift
  // cannot matter to it.
  // slither-disable-next-line timestamp
  function release(uint256 id, address to, uint256 deadline, bytes calldata signature) external nonReentrant {
    if (to == address(0)) {
      revert InvalidRecipient();
    }
    if (block.timestamp > deadline) {
      revert SignatureExpired();
    }

    Deposit memory held = deposits[id];
    if (held.amount == 0) {
      revert NoSuchDeposit(id);
    }

    bytes32 structHash = keccak256(abi.encode(RELEASE_TYPEHASH, id, to, deadline));
    bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparator, structHash));
    if (_recover(digest, signature) != attester) {
      revert BadSignature();
    }

    delete deposits[id];

    emit Released(id, to, held.amount);

    usdc.safeTransfer(to, held.amount);
  }

  /// @notice Takes a deposit back. Available any time before it is released.
  /// @dev Unconditional on purpose. Nothing is ever locked here, and this is
  ///      the backstop if the attester key is ever compromised.
  /// @param id The deposit to take back.
  function reclaim(uint256 id) external nonReentrant {
    Deposit memory held = deposits[id];
    if (held.amount == 0) {
      revert NoSuchDeposit(id);
    }
    if (held.depositor != msg.sender) {
      revert NotDepositor(id, msg.sender);
    }

    delete deposits[id];

    emit Reclaimed(id, msg.sender, held.amount);

    usdc.safeTransfer(msg.sender, held.amount);
  }

  /// @dev ecrecover with the two checks it does not do for you: `s` in the lower
  ///      half of the curve order, so one authorisation has exactly one valid
  ///      encoding, and a zero-address result rejected, which is what ecrecover
  ///      returns for a malformed signature rather than reverting.
  /// @param digest The EIP-712 digest that was signed.
  /// @param signature 65 bytes, r||s||v.
  /// @return signer The recovered address.
  function _recover(bytes32 digest, bytes calldata signature) private pure returns (address signer) {
    if (signature.length != 65) {
      revert BadSignature();
    }

    bytes32 r = bytes32(signature[0:32]);
    bytes32 s = bytes32(signature[32:64]);
    uint8 v = uint8(signature[64]);

    if (uint256(s) > _HALF_CURVE_ORDER) {
      revert BadSignature();
    }
    if (v != 27 && v != 28) {
      revert BadSignature();
    }

    signer = ecrecover(digest, v, r, s);
    if (signer == address(0)) {
      revert BadSignature();
    }
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx hardhat test`
Expected: PASS, all twelve `HandleEscrowTest` cases, and every existing `BillSplitRegistry` / `RecurringTab` / `AutopayMandate` test still passing.

- [ ] **Step 6: Run the static analyser**

Run: `npm run audit:contracts`
Expected: the only findings on `HandleEscrow.sol` are the documented `block.timestamp` comparison (suppressed inline) and anything informational. If Slither reports a reentrancy, a state-variable-shadowing or an unchecked-transfer finding, stop and fix it — those are real.

- [ ] **Step 7: Commit**

```bash
git add contracts/HandleEscrow.sol contracts/HandleEscrow.t.sol contracts/test/Test.sol
git commit -m "$(cat <<'EOF'
feat(escrow): hold an IOU until its recipient exists

Ownerless, immutable, no upgrade path. A deposit is keyed on a hash of the
handle; the attester's EIP-712 signature names the wallet it pays out to, and
the depositor can take it back at any time before that.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: The deposit key, in TypeScript

**Files:**
- Create: `lib/handle-escrow.ts`
- Create: `lib/handle-escrow.test.ts`

**Interfaces:**
- Consumes: `keccak256`, `toHex`, `encodeFunctionData` from `viem`; `normalizeHandle` from `./iou.ts`.
- Produces:
  - `handleHash(provider: string, handle: string): \`0x${string}\`` — `keccak256(utf8 of "<provider>:<normalized handle>")`
  - `HANDLE_ESCROW_ABI` — the four functions and three events used off chain
  - `encodeDeposit(handleHash: \`0x${string}\`, amountUnits: bigint): \`0x${string}\``
  - `encodeRelease(id: bigint, to: \`0x${string}\`, deadline: bigint, signature: \`0x${string}\`): \`0x${string}\``
  - `RELEASE_TYPES` and `releaseDomain(chainId: number, verifyingContract: \`0x${string}\`)` for viem's `signTypedData`

**Why its own file:** the hash must be computed identically in the browser (which deposits), the server (which releases) and Solidity (which checks). One definition, three callers, one test.

- [ ] **Step 1: Write the failing test**

Create `lib/handle-escrow.test.ts`:

```typescript
import assert from "node:assert/strict";
import { test } from "node:test";
import { keccak256, toHex } from "viem";
import { handleHash, releaseDomain, RELEASE_TYPES } from "./handle-escrow.ts";

test("the hash is keccak256 of '<provider>:<handle>'", () => {
  assert.equal(handleHash("email", "dani@example.com"), keccak256(toHex("email:dani@example.com")));
});

test("handles are normalized the same way the rest of the app does", () => {
  // A leading @ is stripped and case is folded, so @Dani, Dani and dani are one
  // person. Without this, tagging @Dani and signing in as dani are two escrows.
  assert.equal(handleHash("x", "@Dani"), handleHash("x", "dani"));
  assert.equal(handleHash("email", "OK@Splitsy.xyz"), handleHash("email", "ok@splitsy.xyz"));
});

test("the same handle in two namespaces is two different hashes", () => {
  assert.notEqual(handleHash("x", "dani"), handleHash("discord", "dani"));
});

test("the typed-data domain binds the chain and the contract", () => {
  const a = releaseDomain(5042002, "0x1111111111111111111111111111111111111111");
  const b = releaseDomain(5042002, "0x2222222222222222222222222222222222222222");
  assert.notDeepEqual(a, b);
  assert.equal(a.name, "Splitsy HandleEscrow");
  assert.equal(a.version, "1");
  assert.equal(a.chainId, 5042002);
});

test("the Release type matches the contract's typehash", () => {
  // keccak256("Release(uint256 id,address to,uint256 deadline)") — the same
  // string RELEASE_TYPEHASH is built from in HandleEscrow.sol. If the field
  // names or their order ever drift, every release reverts with BadSignature.
  const encoded = `Release(${RELEASE_TYPES.Release.map((f) => `${f.type} ${f.name}`).join(",")})`;
  assert.equal(encoded, "Release(uint256 id,address to,uint256 deadline)");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --experimental-strip-types lib/handle-escrow.test.ts`
Expected: FAIL — cannot find module `./handle-escrow.ts`.

- [ ] **Step 3: Write the module**

Create `lib/handle-escrow.ts`:

```typescript
// The one definition of "which escrow deposit belongs to which handle".
//
// THREE PLACES COMPUTE THIS AND THEY MUST AGREE: the browser when it deposits,
// the server when it signs a release, and HandleEscrow.sol when it checks. A
// second copy anywhere is a deposit nobody can release — the money would sit
// under a hash no signature ever names.
//
// Pure and framework-free (no "use client", no next/*, no @/ aliases) so it
// stays importable by `node --test`. Same rule as lib/iou.ts.
import { encodeFunctionData, keccak256, parseAbi, toHex } from "viem";
import { normalizeHandle } from "./iou.ts";

/// The identifier a deposit is filed under.
///
/// NOT A SECRET. The input is a short, guessable string, so the hash is
/// brute-forceable in seconds — it is a filing key, never a password. Anything
/// that treats knowing this hash as proof of identity is wrong.
///
/// Normalized through the same helper the composer and the resolve route use,
/// because "@Dani" typed on a bill and "dani" reported by an OAuth login have to
/// land on the same string or the money never reaches them.
export function handleHash(provider: string, handle: string): `0x${string}` {
  return keccak256(toHex(`${provider.toLowerCase()}:${normalizeHandle(handle)}`));
}

export const HANDLE_ESCROW_ABI = parseAbi([
  "function deposit(bytes32 handleHash, uint256 amount) returns (uint256)",
  "function release(uint256 id, address to, uint256 deadline, bytes signature)",
  "function reclaim(uint256 id)",
  "function deposits(uint256) view returns (address depositor, bytes32 handleHash, uint256 amount)",
  "event Deposited(uint256 indexed id, address indexed depositor, bytes32 indexed handleHash, uint256 amount)",
  "event Released(uint256 indexed id, address indexed to, uint256 amount)",
  "event Reclaimed(uint256 indexed id, address indexed depositor, uint256 amount)",
]);

export const encodeDeposit = (hash: `0x${string}`, amountUnits: bigint) =>
  encodeFunctionData({ abi: HANDLE_ESCROW_ABI, functionName: "deposit", args: [hash, amountUnits] });

export const encodeRelease = (id: bigint, to: `0x${string}`, deadline: bigint, signature: `0x${string}`) =>
  encodeFunctionData({ abi: HANDLE_ESCROW_ABI, functionName: "release", args: [id, to, deadline, signature] });

// The EIP-712 shape, mirroring RELEASE_TYPEHASH in HandleEscrow.sol. Field names
// and order are part of the hash: rename or reorder one and every signature
// stops verifying.
export const RELEASE_TYPES = {
  Release: [
    { name: "id", type: "uint256" },
    { name: "to", type: "address" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

// Chain id and contract address are in the domain, so a signature made for one
// deployment cannot be replayed against another.
export const releaseDomain = (chainId: number, verifyingContract: `0x${string}`) =>
  ({ name: "Splitsy HandleEscrow", version: "1", chainId, verifyingContract }) as const;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test --experimental-strip-types lib/handle-escrow.test.ts`
Expected: PASS, five tests.

- [ ] **Step 5: Add it to the test script**

In `package.json`, find the `test:wallet-provider` line and add a new script beside it:

```json
"test:escrow": "node --test --experimental-strip-types lib/handle-escrow.test.ts",
```

If there is an aggregate script that runs the others (check for a `test` or `test:all` entry), add `test:escrow` to it.

- [ ] **Step 6: Commit**

```bash
git add lib/handle-escrow.ts lib/handle-escrow.test.ts package.json
git commit -m "$(cat <<'EOF'
feat(escrow): one definition of which deposit belongs to which handle

The browser, the server and the contract all have to derive the same key or a
deposit is filed under a hash no signature will ever name.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Deploy the contract to Arc Testnet

**Files:**
- Create: `scripts/deploy-handle-escrow.ts`
- Modify: `package.json` (add the deploy script)
- Modify: `.env.example` (document the two new variables)

**Interfaces:**
- Consumes: `hardhat`'s `network.create`, the `HandleEscrow` artifact from Task 1.
- Produces: the deployed address, printed for `NEXT_PUBLIC_HANDLE_ESCROW_ADDRESS`.

- [ ] **Step 1: Write the deploy script**

Create `scripts/deploy-handle-escrow.ts`, following `scripts/deploy-bill-split-registry.ts`:

```typescript
import { network } from "hardhat";

const usdcAddress = process.env.ARC_TESTNET_USDC_ADDRESS;
const attester = process.env.ESCROW_ATTESTER_ADDRESS;

if (!usdcAddress) {
  throw new Error("Missing ARC_TESTNET_USDC_ADDRESS in .env.local");
}
if (!/^0x[a-fA-F0-9]{40}$/.test(usdcAddress)) {
  throw new Error("ARC_TESTNET_USDC_ADDRESS must be a 0x-prefixed EVM address.");
}
// Demanded rather than defaulted. The attester is immutable once deployed, so a
// wrong or empty value here is not a misconfiguration you can correct later —
// it is a contract that can never release anything, and the only exit is every
// depositor reclaiming.
if (!attester || !/^0x[a-fA-F0-9]{40}$/.test(attester)) {
  throw new Error("Set ESCROW_ATTESTER_ADDRESS to the address whose key will sign releases.");
}

const { viem } = await network.create({ network: "arcTestnet", chainType: "l1" });
const [deployer] = await viem.getWalletClients();

console.log("Deploying HandleEscrow to Arc Testnet");
console.log("Deployer:", deployer.account.address);
console.log("USDC:", usdcAddress);
console.log("Attester:", attester);

const escrow = await viem.deployContract("HandleEscrow", [
  usdcAddress as `0x${string}`,
  attester as `0x${string}`,
]);

console.log("HandleEscrow deployed:", escrow.address);
console.log(`Arcscan: https://testnet.arcscan.app/address/${escrow.address}`);
console.log("");
console.log("Next steps:");
console.log(`  NEXT_PUBLIC_HANDLE_ESCROW_ADDRESS=${escrow.address}`);
console.log("  Deposit ids restart at 1 per deployment, so escrow_deposits rows");
console.log("  are keyed by (escrow_address, deposit_id) — an old address stays");
console.log("  readable rather than being overwritten.");
```

- [ ] **Step 2: Add the npm script**

In `package.json`, beside the other `deploy:arc:*` entries:

```json
"deploy:arc:handle-escrow": "node --env-file=.env.local ./node_modules/hardhat/dist/src/cli.js run --network arcTestnet scripts/deploy-handle-escrow.ts",
```

- [ ] **Step 3: Document the new variables**

Add to `.env.example`, after the wallet block:

```
# The escrow that holds an IOU sent to someone who has not signed up yet
# (contracts/HandleEscrow.sol). Unset means the settle rail refuses to send to a
# stranger rather than stranding the money — the same fail-closed default as
# WALLET_PROVIDER. Deposit ids restart at 1 per deployment, so escrow_deposits
# rows are keyed by (escrow_address, deposit_id).
NEXT_PUBLIC_HANDLE_ESCROW_ADDRESS=

# The address whose key signs releases, and the private key itself. IMMUTABLE in
# the deployed contract: it cannot be changed afterwards, only redeployed. The
# key can misdirect a release but can never drain the escrow — a signature names
# one deposit and one recipient and expires — and any depositor can reclaim.
# Keep it out of the browser: it is read only by the server.
ESCROW_ATTESTER_ADDRESS=
ESCROW_ATTESTER_PRIVATE_KEY=
```

- [ ] **Step 4: Generate the attester key and deploy**

Generate a fresh key — do not reuse the deployer or any wallet that holds funds:

```bash
node -e "const {generatePrivateKey,privateKeyToAccount}=require('viem/accounts');const k=generatePrivateKey();console.log('ESCROW_ATTESTER_PRIVATE_KEY='+k);console.log('ESCROW_ATTESTER_ADDRESS='+privateKeyToAccount(k).address)"
```

Put both in `.env.local`, then:

```bash
npm run deploy:arc:handle-escrow
```

Copy the printed `NEXT_PUBLIC_HANDLE_ESCROW_ADDRESS` into `.env.local`.

- [ ] **Step 5: Verify the deployment answers**

```bash
node -e "
const {createPublicClient,http}=require('viem');const {arcTestnet}=require('viem/chains');
const c=createPublicClient({chain:arcTestnet,transport:http('https://rpc.testnet.arc.network')});
const abi=[{name:'attester',type:'function',stateMutability:'view',inputs:[],outputs:[{type:'address'}]},
           {name:'nextDepositId',type:'function',stateMutability:'view',inputs:[],outputs:[{type:'uint256'}]}];
(async()=>{
  const a='$NEXT_PUBLIC_HANDLE_ESCROW_ADDRESS';
  console.log('attester', await c.readContract({address:a,abi,functionName:'attester'}));
  console.log('nextDepositId', await c.readContract({address:a,abi,functionName:'nextDepositId'}));
})()"
```

Expected: the attester matches `ESCROW_ATTESTER_ADDRESS`, and `nextDepositId` is `1`.

- [ ] **Step 6: Commit**

```bash
git add scripts/deploy-handle-escrow.ts package.json .env.example
git commit -m "$(cat <<'EOF'
feat(escrow): deploy script, and the two variables it needs

The attester is demanded rather than defaulted: it is immutable once deployed,
so an empty value is a contract that can never release anything.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: The deposits table

**Files:**
- Create: `schema-escrow-deposits.sql`
- Create: `lib/escrow-deposits-repo.ts`

**Interfaces:**
- Consumes: `createSupabaseServerClient` from `@/lib/supabase` (read `lib/pending-wallets-repo.ts` first and copy its client-handling exactly).
- Produces:
  - `insertEscrowDeposit(row: { escrow_address: string; deposit_id: string; provider: string; handle: string; depositor_address: string; amount_usdc: string; tx_hash: string | null }): Promise<void>`
  - `getOpenDeposits(provider: string, handle: string): Promise<{ escrow_address: string; deposit_id: string; amount_usdc: string }[]>`
  - `markDepositReleased(escrowAddress: string, depositId: string, txHash: string | null): Promise<void>`

- [ ] **Step 1: Write the schema**

Create `schema-escrow-deposits.sql`:

```sql
-- schema-escrow-deposits.sql — run in the Supabase SQL editor (additive).
--
-- An index of HandleEscrow deposits, so login can find the money waiting for a
-- handle without walking chain logs. Arc's public RPC refuses an eth_getLogs
-- range wider than ~25k blocks, so "scan for deposits" is not a thing the
-- login path can do inside a request.
--
-- AN INDEX, NOT AN AUTHORITY. The contract is the authority: a row saying
-- 'open' for a deposit that has already been released is a stale row, and the
-- release call simply reverts with NoSuchDeposit. Nothing reads this table to
-- decide whether money may move — it reads it to decide what to TRY.
--
-- Keyed by (escrow_address, deposit_id), the same reasoning as
-- onchain_bill_preimages: deposit ids restart at 1 in every deployment, so a
-- bare id is only meaningful next to the escrow it came from. deposit_id is
-- text because it is a uint256 and can exceed numeric range.
create table if not exists escrow_deposits (
  escrow_address    text not null,            -- lowercased 0x escrow address
  deposit_id        text not null,            -- uint256 as decimal string
  provider          text not null,            -- 'x' | 'discord' | 'email'
  handle            text not null,            -- normalized: no leading @, lowercased
  depositor_address text not null,            -- lowercased 0x sender address
  amount_usdc       numeric(20,6) not null,
  status            text not null default 'open' check (status in ('open','released')),
  tx_hash           text,                     -- the deposit transaction
  release_tx_hash   text,
  created_at        timestamptz not null default now(),
  released_at       timestamptz,
  primary key (escrow_address, deposit_id)
);

-- The lookup login performs: "is anything waiting for this handle?"
create index if not exists idx_escrow_deposits_open
  on escrow_deposits (provider, lower(handle))
  where status = 'open';

-- Deny-all to the anon and authenticated roles, matching every other table in
-- this project: no policies, and the service role bypasses RLS.
alter table escrow_deposits enable row level security;
```

- [ ] **Step 2: Run it**

Paste the file into the Supabase SQL editor for the `splitsy-test` project and run it. Confirm with:

```sql
select column_name, data_type from information_schema.columns
where table_name = 'escrow_deposits' order by ordinal_position;
```

Expected: eleven columns.

- [ ] **Step 3: Write the repo module**

First read `lib/pending-wallets-repo.ts` — copy its client handling, its error handling and its comment density. Then create `lib/escrow-deposits-repo.ts` with the three functions from the Interfaces block above. Normalize `handle` with `normalizeHandle` from `./iou.ts` and lowercase both addresses on the way in, so a lookup never misses on case.

- [ ] **Step 4: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add schema-escrow-deposits.sql lib/escrow-deposits-repo.ts
git commit -m "$(cat <<'EOF'
feat(escrow): index the deposits so login can find them

Arc caps eth_getLogs at ~25k blocks, so scanning for a handle's deposits is not
something a login request can do. The table is an index, never an authority —
the contract decides whether money may move.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Ask whether a handle has a wallet, without minting one

**Files:**
- Modify: `lib/wallet-resolve.ts`
- Modify: `app/api/onchain-bills/resolve/route.ts`

**Interfaces:**
- Consumes: the existing `ResolveDeps` seam in `lib/wallet-resolve.ts`.
- Produces: `lookupParticipantAddress(provider, handle, deps?): Promise<string | null>` — the same walk as `resolveParticipantAddress` (user wallet → pending wallet) but returning `null` instead of minting.

**Critical:** this is **purely additive**. Do **not** change `resolveParticipantAddress`, `resolveParticipants`, `defaultMintPending` or `pregenerateWallet`. The three bill/recurring routes share them and will break. The spec's §3 removes them later.

- [ ] **Step 1: Write the failing test**

Add to `lib/wallet-resolve.test.ts` (read the existing file first and match how it builds stub deps):

```typescript
test("lookup finds a real user's wallet", async () => {
  const address = await lookupParticipantAddress("email", "dani@example.com", {
    getUserByProviderHandle: async () => ({ wallet_address: "0xUSER" }),
    getPendingWallet: async () => null,
    mintPending: async () => { throw new Error("must not mint"); },
  });
  assert.equal(address, "0xUSER");
});

test("lookup answers null for someone who has never signed in", async () => {
  // The whole point: no wallet is minted, so no money can be sent to an address
  // its supposed owner cannot reach.
  const address = await lookupParticipantAddress("email", "nobody@example.com", {
    getUserByProviderHandle: async () => null,
    getPendingWallet: async () => null,
    mintPending: async () => { throw new Error("must not mint"); },
  });
  assert.equal(address, null);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test --experimental-strip-types lib/wallet-resolve.test.ts`
Expected: FAIL — `lookupParticipantAddress` is not exported.

- [ ] **Step 3: Add the function**

In `lib/wallet-resolve.ts`, beside `resolveParticipantAddress`:

```typescript
/**
 * The same walk as {@link resolveParticipantAddress}, stopping at "there is
 * nobody here" instead of minting.
 *
 * ADDITIVE ON PURPOSE. resolveParticipants is shared by the three bill and
 * recurring routes, which still need an address for every participant at
 * createBill time; changing its answer would break them. The settle rail is the
 * one that MOVES money, so it is the one that must not send to an address
 * nobody holds — it asks this instead and escrows when the answer is null.
 */
export async function lookupParticipantAddress(
  provider: IdentityProvider,
  handle: string,
  deps: ResolveDeps = realDeps,
): Promise<string | null> {
  const user = await deps.getUserByProviderHandle(provider, handle);
  if (user?.wallet_address) return user.wallet_address;

  const pending = await deps.getPendingWallet(provider, handle);
  return pending?.wallet_address ?? null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test --experimental-strip-types lib/wallet-resolve.test.ts`
Expected: PASS, including every pre-existing test in the file.

- [ ] **Step 5: Expose it to the browser**

`app/api/onchain-bills/resolve/route.ts` currently always mints. Add an opt-in flag so the settle rail can ask without minting, leaving the default path byte-identical for the bill routes that call it:

- Accept an optional `mint?: boolean` in the request body, defaulting to `true`.
- When `mint === false`, call `lookupParticipantAddress` per row and return `{ resolved: [{ provider, handle, address: string | null }] }`.
- Keep every existing validation (provider allow-list, `validHandle`, `MAX_PARTICIPANTS`) exactly as it is.

- [ ] **Step 6: Verify the existing behaviour is unchanged**

Run: `npx tsc --noEmit` and `npm run test:contracts` is not needed here, but run the full TS suite that touches resolve:

```bash
node --test --experimental-strip-types lib/wallet-resolve.test.ts lib/iou.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/wallet-resolve.ts lib/wallet-resolve.test.ts app/api/onchain-bills/resolve/route.ts
git commit -m "$(cat <<'EOF'
feat(escrow): let a caller ask who has a wallet without minting one

Additive: the bill and recurring routes still need an address for every
participant, so resolveParticipants is untouched. The settle rail is the one
that moves money, so it is the one that must be able to hear "nobody".

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Deposit instead of stranding, on both settle rails

**Files:**
- Modify: `app/IouClient.tsx` (`resolveTarget`, `settleNow`, `settleWithWallet`)
- Modify: `lib/bill-split-contracts.ts` (add an escrow approve/deposit helper beside `approveBillRegistry`)

**Interfaces:**
- Consumes: `handleHash`, `encodeDeposit`, `HANDLE_ESCROW_ABI` from `lib/handle-escrow.ts`; `lookupParticipantAddress` via the resolve route's `mint: false` mode from Task 5.
- Produces: an escrowed IOU — a `Deposited` event on chain and an `escrow_deposits` row with `status = 'open'`.

- [ ] **Step 1: Read the two rails first**

Read `app/IouClient.tsx:552-564` (`resolveTarget`), `:591-608` (`settleNow`) and `:667-674` (`settleWithWallet`), and `lib/bill-split-contracts.ts:400-410` (`approveBillRegistry`). Both rails must end up doing the same thing on a null address; only the signer differs.

- [ ] **Step 2: Add the escrow helper**

In `lib/bill-split-contracts.ts`, beside `approveBillRegistry`, add an `approveHandleEscrow` and a `depositToHandleEscrow` following the identical shape — approve for exactly the amount, then call. Read the existing function and mirror it rather than inventing a new pattern.

- [ ] **Step 3: Branch both rails**

In `app/IouClient.tsx`:

- Change `resolveTarget` to ask with `mint: false` and return `string | null`.
- In `settleNow`: when the address is null, `approve` + `deposit` through the server-signed path (`walletPost`, the same route pattern the transfer uses), then POST the resulting deposit id to a new route that writes the `escrow_deposits` row.
- In `settleWithWallet`: when the address is null, do the same two calls through the browser wallet, then POST the deposit id the same way.
- The `ponytail:` comment at `:588-590` ("no deferred 'I owe' — that needs an off-chain row against a creditor who may not have an account") is now resolved. Replace it with a line saying the escrow is that row.

- [ ] **Step 4: Add the route that records a deposit**

Create `app/api/escrow/deposits/route.ts`: session-gated POST taking `{ escrowAddress, depositId, provider, handle, txHash }`, reading the deposit back **from the chain** to confirm it exists and to take its amount and depositor, then calling `insertEscrowDeposit`.

**Read the amount from the chain, never from the request body.** A client-supplied amount would let a caller record a row claiming more than they deposited — and while the contract would refuse to pay it out, the ledger would be lying to the user.

- [ ] **Step 5: Give the ledger its third word**

An escrowed IOU is neither pending nor settled: the money has left, and has not arrived. Find where `RecentRow`'s `state` is rendered (`app/IouClient.tsx:56`) and add a third state — `"escrowed"` — displayed as *waiting for @dani*. The composer still reports success, because the IOU did succeed.

- [ ] **Step 6: Verify by hand on Preview**

With `NEXT_PUBLIC_HANDLE_ESCROW_ADDRESS` set, send an IOU to an address-shaped handle that has never signed in. Then confirm:

```bash
# The deposit exists on chain and the escrow holds the money
node -e "/* readContract deposits(1) against NEXT_PUBLIC_HANDLE_ESCROW_ADDRESS */"
```

And in Supabase:

```sql
select escrow_address, deposit_id, provider, handle, amount_usdc, status from escrow_deposits;
```

Expected: one row, `status = 'open'`, amount matching the IOU, and the escrow's USDC balance equal to it.

- [ ] **Step 7: Commit**

```bash
git add app/IouClient.tsx lib/bill-split-contracts.ts app/api/escrow/deposits/route.ts
git commit -m "$(cat <<'EOF'
feat(escrow): pay an IOU into escrow when its recipient has no wallet yet

Both settle rails ask who has a wallet and escrow when the answer is nobody,
rather than transferring to a pre-minted address neither side can reach. The
amount on the row is read from the chain, never from the request.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Release at login

**Files:**
- Create: `lib/escrow-release.ts`
- Create: `lib/escrow-release.test.ts`
- Modify: `lib/oauth-callback.ts:29` (add `walletAddress?` to the params) and `:75-81` (the call site)
- Modify: `app/api/auth/privy/route.ts:125` (pass `walletAddress: linked`)

**Interfaces:**
- Consumes: `getOpenDeposits`, `markDepositReleased` from Task 4; `encodeRelease`, `RELEASE_TYPES`, `releaseDomain` from Task 2; `getOrCreateWallet` and `executeContract` from `@/lib/wallet-provider`.
- Produces:
  - `releaseEscrowForHandle(userId: string, provider: IdentityProvider, handle: string, walletAddress: string | null, deps?: ReleaseDeps): Promise<void>`
  - `type ReleaseDeps` — the injection seam, same pattern and same reason as `ResolveDeps` in `lib/wallet-resolve.ts`: the three side-effecting calls are stubbed so the decision layer can be tested under `node --test` with no database, no Privy and no chain.

```typescript
export type ReleaseDeps = {
  getOpenDeposits: (
    provider: string,
    handle: string,
  ) => Promise<{ escrow_address: string; deposit_id: string; amount_usdc: string }[]>;
  signRelease: (escrowAddress: string, depositId: string, to: string, deadline: bigint) => Promise<string>;
  relay: (escrowAddress: string, depositId: string, data: string) => Promise<{ txHash: string | null }>;
  markReleased: (escrowAddress: string, depositId: string, txHash: string | null) => Promise<void>;
};
```

- [ ] **Step 1: Write the module**

Create `lib/escrow-release.ts`. It must:

1. **Return immediately when `walletAddress` is null.** The Privy route calls `finishProviderLogin` once before the wallet exists and again once it does (`app/api/auth/privy/route.ts:74-78` explains why). Without this guard the first call signs a release to `null` and the second never happens.
2. Look up open deposits for `(provider, handle)`.
3. For each: sign `Release(id, to, deadline)` with `ESCROW_ATTESTER_PRIVATE_KEY` via viem's `signTypedData`, using `releaseDomain(5042002, escrowAddress)`. Set `deadline` to now + 10 minutes — long enough to survive a slow block, short enough that a leaked signature dies quickly.
4. Relay `release(...)` from the `getOrCreateWallet("splitsy", "escrow-releaser")` wallet, matching how `app/api/pay/[token]/gateway/route.ts:42` gets a server wallet.
5. Call `markDepositReleased` on success.
6. **Never throw.** Log and continue, exactly like `resolveDebtsForHandle`'s caller.

Write the header comment to say why the release is signed rather than sent by a privileged caller, and that the releaser wallet needs USDC for gas because Arc charges gas in USDC.

- [ ] **Step 2: Write the failing test**

Create `lib/escrow-release.test.ts`, testing the pure decision layer with injected deps (same seam pattern as `lib/wallet-resolve.ts`):

```typescript
test("does nothing when the wallet has not arrived yet", async () => {
  // The Privy login route calls this twice: once the instant authentication
  // flips true, when createOnLogin has not built the wallet yet, and again once
  // it has. Signing a release to a null address on the first pass would burn the
  // deposit id and the second pass would find nothing.
  let signed = 0;
  await releaseEscrowForHandle("user-1", "email", "dani@example.com", null, {
    getOpenDeposits: async () => [{ escrow_address: "0xESC", deposit_id: "1", amount_usdc: "1.000000" }],
    signRelease: async () => { signed++; return "0xSIG"; },
    relay: async () => ({ txHash: "0xTX" }),
    markReleased: async () => {},
  });
  assert.equal(signed, 0);
});

test("releases every open deposit for the handle", async () => {
  const released: string[] = [];
  await releaseEscrowForHandle("user-1", "email", "dani@example.com", "0xWALLET", {
    getOpenDeposits: async () => [
      { escrow_address: "0xESC", deposit_id: "1", amount_usdc: "1.000000" },
      { escrow_address: "0xESC", deposit_id: "2", amount_usdc: "2.000000" },
    ],
    signRelease: async () => "0xSIG",
    relay: async () => ({ txHash: "0xTX" }),
    markReleased: async (_addr, id) => { released.push(id); },
  });
  assert.deepEqual(released, ["1", "2"]);
});

test("one failed release does not stop the next", async () => {
  // A deposit already released by an earlier attempt reverts with NoSuchDeposit.
  // That must not strand the others — the row stays open and the next sign-in
  // retries it.
  const released: string[] = [];
  await releaseEscrowForHandle("user-1", "email", "dani@example.com", "0xWALLET", {
    getOpenDeposits: async () => [
      { escrow_address: "0xESC", deposit_id: "1", amount_usdc: "1.000000" },
      { escrow_address: "0xESC", deposit_id: "2", amount_usdc: "2.000000" },
    ],
    signRelease: async () => "0xSIG",
    relay: async (_addr, id) => {
      if (id === "1") throw new Error("NoSuchDeposit");
      return { txHash: "0xTX" };
    },
    markReleased: async (_addr, id) => { released.push(id); },
  });
  assert.deepEqual(released, ["2"]);
});
```

- [ ] **Step 3: Run it and watch it fail, then make it pass**

Run: `node --test --experimental-strip-types lib/escrow-release.test.ts`
Expected: FAIL, then PASS once the deps seam matches the test.

- [ ] **Step 4: Wire it into login**

`finishProviderLogin` (`lib/oauth-callback.ts:29`) takes `{ provider, profile, request, sessionSecret, mode?, ... }` and has **no wallet address today**. Add one optional field:

```typescript
  // The wallet this login landed on, when the caller already knows it. Only the
  // Privy route does: it links the embedded wallet itself, before calling this.
  // The OAuth routes leave it undefined and the escrow release reads the user
  // row instead — by the time they reach here, provisioning has already set it.
  walletAddress?: string | null;
```

Then, directly after the `resolveDebtsForHandle` block at `:75-81`, add the same shape — same `provider !== "wallet"` guard, same try/catch, same "login continues" comment — calling `releaseEscrowForHandle` with `params.walletAddress ?? appUser.wallet_address`.

`finishProviderLogin` is called by both stacks, so this one call site covers Privy and the OAuth routes. In `app/api/auth/privy/route.ts`, pass `walletAddress: linked` at the call on `:125` (`linked` is declared at `:77` and set at `:102`). That is what makes the second call — the one that fires once `createOnLogin` has built the wallet — actually release.

- [ ] **Step 5: Add to the test script**

Extend the `test:escrow` script from Task 2:

```json
"test:escrow": "node --test --experimental-strip-types lib/handle-escrow.test.ts lib/escrow-release.test.ts",
```

- [ ] **Step 6: Fund the releaser and verify end to end**

Find the releaser's address (call `getOrCreateWallet("splitsy", "escrow-releaser")` once, or read it from `privy_wallets` after the first run) and send it a few USDC — **Arc charges gas in USDC, so an unfunded releaser cannot release anything.**

Then, on Preview: send an IOU to a handle nobody has used, sign in as that handle, and confirm the money arrives.

```sql
select deposit_id, status, release_tx_hash from escrow_deposits;
```

Expected: `status = 'released'`, a release tx hash, and the recipient's wallet holding the amount.

- [ ] **Step 7: Commit**

```bash
git add lib/escrow-release.ts lib/escrow-release.test.ts lib/oauth-callback.ts app/api/auth/privy/route.ts package.json
git commit -m "$(cat <<'EOF'
feat(escrow): hand over the money when its owner signs in

Beside resolveDebtsForHandle, which already says "you proved who you are, take
what is tagged with your handle" — this is the same sentence with money in it.
No-ops until the wallet exists, because the Privy route calls the tail twice.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Say what is still broken

**Files:**
- Modify: `docs/deployments.md`
- Modify: `lib/privy-wallet.ts:838-856` (the `pregenerateWallet` comment)

- [ ] **Step 1: Correct the comment that shipped the wrong assumption**

`lib/privy-wallet.ts:840` says the wallet appears in Alice's account "when Alice signs in and links a real account to it." That is the assumption that cost 3.11 USDC. Replace it with what was measured: Privy does not merge a `custom_auth` account with a later email or social login, and the Node SDK has no link method, so identity must be present at creation. Point at the spec, and note that the settle rail no longer depends on this path — but the bill routes still do, until §3.

- [ ] **Step 2: Write the operational notes**

Add a section to `docs/deployments.md` covering:

- `NEXT_PUBLIC_HANDLE_ESCROW_ADDRESS`, `ESCROW_ATTESTER_ADDRESS`, `ESCROW_ATTESTER_PRIVATE_KEY` — what each is, and that the attester is immutable in the deployed contract.
- **The releaser wallet needs USDC.** If it runs dry, releases stall silently: deposits stay safe and reclaimable, but money stops arriving at login and nothing surfaces an error. Say how to check its balance.
- **What is still broken after this plan:** bills and recurring tabs still bind a stranger's share to a pre-minted address, so that person still reads as "not a participant" when they sign in. That is spec §3, blocked on a product decision.
- **The 3.11 USDC already stranded is unrecoverable** — user-owned wallets, 401 on every signing path, no link method.

- [ ] **Step 3: Commit**

```bash
git add docs/deployments.md lib/privy-wallet.ts
git commit -m "$(cat <<'EOF'
docs(escrow): correct the comment that cost 3.11 USDC, and name what is left

Privy does not merge a custom_auth account with a later email login, and the
SDK has no link method. Also: the releaser wallet needs USDC or releases stall
without an error, and bills are still bound to pre-minted addresses until §3.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Definition of done

- `npx hardhat test` passes, including twelve new `HandleEscrowTest` cases.
- `npm run audit:contracts` reports nothing on `HandleEscrow.sol` beyond the documented `block.timestamp` suppression.
- `node --test --experimental-strip-types lib/handle-escrow.test.ts lib/escrow-release.test.ts lib/wallet-resolve.test.ts` passes.
- `npx tsc --noEmit` is clean.
- On Preview: an IOU to a never-seen handle produces an `escrow_deposits` row and an on-chain `Deposited` event; signing in as that handle moves the USDC into the new wallet and flips the row to `released`.
- The sender can `reclaim` a deposit that has not been released.
- Bills and recurring tabs behave exactly as they did before this plan.
