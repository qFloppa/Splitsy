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
    // Armed before the call, with no external call in between — vm.prank inside
    // _deposit is a cheatcode, not a call, so it does not consume this. The id
    // is a literal because the first deposit is always 1, asserted just below.
    vm.expectEmit(true, true, true, true, address(escrow));
    emit Deposited(1, alice, DANI_HASH, AMOUNT);

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

  function test_releaseAnnouncesWhoWasPaid() public {
    uint256 id = _deposit();
    uint256 deadline = block.timestamp + 1 hours;
    // Signed before arming: _sign staticcalls the escrow for the typehash and
    // the domain separator, and those calls would consume the expectation.
    bytes memory sig = _sign(id, dani, deadline);

    vm.expectEmit(true, true, false, true, address(escrow));
    emit Released(id, dani, AMOUNT);

    escrow.release(id, dani, deadline, sig);
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

    vm.expectEmit(true, true, false, true, address(escrow));
    emit Reclaimed(id, alice, AMOUNT);

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
    // Signed before arming expectRevert: _sign reads the typehash and domain
    // separator from the escrow, and those calls would consume the expectation.
    bytes memory sig = _sign(id, address(0), deadline);
    vm.expectRevert(HandleEscrow.InvalidRecipient.selector);
    escrow.release(id, address(0), deadline, sig);
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
