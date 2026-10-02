// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

import {HandleEscrow} from "./HandleEscrow.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {Test} from "./test/Test.sol";

/// @notice The two bounds that exist because the attester key cannot be rotated:
///         `holdWindow` and `maxReleasePerDay`.
/// @dev Neither is a permission check, so every case here signs with the REAL
///      attester key. That is the whole point — a stolen key produces signatures
///      indistinguishable from these, so a bound that only stopped a bad
///      signature would stop nothing. What is asserted is that a perfectly valid
///      authorisation still cannot move money past the window or past the
///      ceiling, and that {reclaim} is outside both so the escape hatch cannot
///      be outrun.
///
///      Deliberately tight values: a 7-day window and a 10 USDC/day ceiling, so
///      the boundaries are reachable in a test. The deployed values are far
///      wider (see scripts/deploy-handle-escrow.ts).
contract HandleEscrowBoundsTest is Test {
  uint256 private constant ATTESTER_KEY = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
  address private constant ATTESTER = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;
  address private constant ALICE = address(0xA11CE);
  address private constant RECIPIENT = address(0xDA17);
  address private constant STRANGER = address(0xBAD);
  bytes32 private constant HANDLE = keccak256("email:dani@example.com");

  uint256 private constant HOLD_WINDOW = 7 days;
  uint128 private constant CAP = 10e6;

  MockUSDC private usdc;
  HandleEscrow private escrow;

  function setUp() public {
    usdc = new MockUSDC();
    escrow = new HandleEscrow(address(usdc), ATTESTER, HOLD_WINDOW, CAP);
    usdc.mint(ALICE, 1000e6);
    vm.prank(ALICE);
    usdc.approve(address(escrow), type(uint256).max);
  }

  // Independent protocol encoding: do not read the contract's hashes to sign.
  function _sign(uint256 id, address to, uint256 deadline) private view returns (bytes memory) {
    bytes32 domain = keccak256(abi.encode(
      keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
      keccak256("Splitsy HandleEscrow"), keccak256("1"), block.chainid, address(escrow)
    ));
    bytes32 message = keccak256(abi.encode(
      keccak256("Release(uint256 id,address to,uint256 deadline)"), id, to, deadline
    ));
    (uint8 v, bytes32 r, bytes32 s) = vm.sign(
      ATTESTER_KEY, keccak256(abi.encodePacked("\x19\x01", domain, message))
    );
    return abi.encodePacked(r, s, v);
  }

  function _deposit(uint256 amount) private returns (uint256 id) {
    vm.prank(ALICE);
    id = escrow.deposit(HANDLE, amount);
  }

  function _release(uint256 id, address to) private {
    uint256 deadline = block.timestamp + 365 days;
    vm.prank(STRANGER);
    escrow.release(id, to, deadline, _sign(id, to, deadline));
  }

  // --- holdWindow -----------------------------------------------------------

  function test_depositRecordsTheWindow() public {
    uint256 id = _deposit(1e6);
    (, uint64 expiresAt,,) = escrow.deposits(id);
    assertEq(expiresAt, block.timestamp + HOLD_WINDOW);
  }

  /// @dev The bound that stops the attack surface accumulating: an old deposit
  ///      is not part of what a key leaking next year could reach.
  function test_expiredDepositCannotBeReleasedEvenWithAValidSignature() public {
    uint256 id = _deposit(1e6);
    (, uint64 expiresAt,,) = escrow.deposits(id);

    vm.warp(uint256(expiresAt) + 1);

    uint256 deadline = block.timestamp + 1 hours;
    vm.prank(STRANGER);
    vm.expectRevert(abi.encodeWithSelector(HandleEscrow.DepositExpired.selector, id, expiresAt));
    escrow.release(id, RECIPIENT, deadline, _sign(id, RECIPIENT, deadline));
  }

  /// @dev `>` not `>=`: at the expiry instant exactly, the release still lands.
  function test_releaseAtTheExpiryInstantStillWorks() public {
    uint256 id = _deposit(1e6);
    (, uint64 expiresAt,,) = escrow.deposits(id);

    vm.warp(uint256(expiresAt));
    _release(id, RECIPIENT);

    assertEq(usdc.balanceOf(RECIPIENT), 1e6);
  }

  /// @dev Expiry REDIRECTS the exit, it does not freeze the money. If this ever
  ///      fails, the window has turned into a way to strand funds.
  function test_expiredDepositIsStillReclaimable() public {
    uint256 id = _deposit(1e6);
    (, uint64 expiresAt,,) = escrow.deposits(id);
    uint256 before = usdc.balanceOf(ALICE);

    vm.warp(uint256(expiresAt) + 365 days);

    vm.prank(ALICE);
    escrow.reclaim(id);

    assertEq(usdc.balanceOf(ALICE), before + 1e6, "the depositor's exit never closes");
    assertEq(usdc.balanceOf(address(escrow)), 0);
  }

  // --- maxReleasePerDay -----------------------------------------------------

  function test_depositAboveTheCeilingIsRefusedAtDeposit() public {
    vm.prank(ALICE);
    vm.expectRevert(abi.encodeWithSelector(HandleEscrow.AmountExceedsDailyLimit.selector, CAP + 1, CAP));
    escrow.deposit(HANDLE, CAP + 1);

    assertEq(usdc.balanceOf(address(escrow)), 0, "nothing was taken in");
  }

  function test_depositAtTheCeilingExactlyIsAccepted() public {
    uint256 id = _deposit(CAP);
    _release(id, RECIPIENT);
    assertEq(usdc.balanceOf(RECIPIENT), CAP);
  }

  /// @dev A valid signature, a live deposit, and still refused: this is what a
  ///      leaked key runs into after one day's worth.
  function test_releasesAreCappedPerDay() public {
    uint256 first = _deposit(6e6);
    uint256 second = _deposit(6e6);

    _release(first, RECIPIENT);
    assertEq(escrow.releasableNow(), CAP - 6e6);

    uint256 deadline = block.timestamp + 1 hours;
    vm.prank(STRANGER);
    vm.expectRevert(abi.encodeWithSelector(HandleEscrow.DailyLimitExceeded.selector, 6e6, 4e6));
    escrow.release(second, RECIPIENT, deadline, _sign(second, RECIPIENT, deadline));

    assertEq(usdc.balanceOf(RECIPIENT), 6e6, "only the first got out");
  }

  /// @dev A bucket, not a calendar day. Half a day refills half the ceiling.
  function test_theBucketRefillsOverTime() public {
    uint256 first = _deposit(6e6);
    uint256 second = _deposit(6e6);

    _release(first, RECIPIENT);
    vm.warp(block.timestamp + 12 hours);

    // 12h of a 10 USDC/day refill is 5 USDC, so the 6 USDC spent decays to 1.
    assertEq(escrow.releasableNow(), CAP - 1e6);

    _release(second, RECIPIENT);
    assertEq(usdc.balanceOf(RECIPIENT), 12e6, "both out, a day apart in bucket terms");
  }

  function test_theBucketFullyRefillsAfterADay() public {
    uint256 first = _deposit(CAP);
    _release(first, RECIPIENT);
    assertEq(escrow.releasableNow(), 0);

    vm.warp(block.timestamp + 1 days);
    assertEq(escrow.releasableNow(), CAP);
  }

  /// @dev AN ESCAPE HATCH WITH A RATE LIMIT IS NOT ONE. With the bucket full, a
  ///      capped reclaim would let a leaked key outrun the depositors trying to
  ///      get out. This is the test that says it cannot.
  function test_reclaimIsExemptFromTheCeiling() public {
    uint256 drain = _deposit(CAP);
    uint256 mine = _deposit(CAP);

    _release(drain, RECIPIENT);
    assertEq(escrow.releasableNow(), 0, "ceiling is spent for the day");

    uint256 before = usdc.balanceOf(ALICE);
    vm.prank(ALICE);
    escrow.reclaim(mine);

    assertEq(usdc.balanceOf(ALICE), before + CAP, "the depositor got out anyway");
  }

  /// @dev A failed release must not consume ceiling. Otherwise anyone could
  ///      exhaust the day's room with calls that move nothing.
  function test_aRefusedReleaseDoesNotConsumeTheCeiling() public {
    uint256 id = _deposit(6e6);
    uint256 deadline = block.timestamp + 1 hours;

    // Wrong signer: reverts after the bucket has been read but before it is written.
    vm.prank(STRANGER);
    vm.expectRevert(HandleEscrow.BadSignature.selector);
    escrow.release(id, RECIPIENT, deadline, _sign(id, STRANGER, deadline));

    assertEq(escrow.releasableNow(), CAP, "nothing was spent");

    _release(id, RECIPIENT);
    assertEq(usdc.balanceOf(RECIPIENT), 6e6);
  }

  // --- constructor ----------------------------------------------------------

  function test_zeroHoldWindowIsRejected() public {
    vm.expectRevert(HandleEscrow.InvalidConfiguration.selector);
    new HandleEscrow(address(usdc), ATTESTER, 0, CAP);
  }

  function test_zeroCeilingIsRejected() public {
    vm.expectRevert(HandleEscrow.InvalidConfiguration.selector);
    new HandleEscrow(address(usdc), ATTESTER, HOLD_WINDOW, 0);
  }

  function test_boundsAreReadable() public view {
    assertEq(escrow.holdWindow(), HOLD_WINDOW);
    assertEq(escrow.maxReleasePerDay(), CAP);
    assertEq(escrow.releasableNow(), CAP, "an untouched bucket is empty");
  }
}
