// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

import {HandleEscrow} from "./HandleEscrow.sol";
import {IERC20} from "./interfaces/IERC20.sol";
import {SafeERC20} from "./libraries/SafeERC20.sol";
import {ReentrancyGuard} from "./security/ReentrancyGuard.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {MaliciousUSDC} from "./mocks/MaliciousUSDC.sol";
import {Test} from "./test/Test.sol";

/// @notice Checks the SolidityScan claims and isolation of signed authorizations.
contract HandleEscrowSecurityTest is Test {
  uint256 private constant ATTESTER_KEY = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
  uint256 private constant CURVE_ORDER = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
  address private constant ATTESTER = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;
  address private constant ALICE = address(0xA11CE);
  address private constant RECIPIENT = address(0xDA17);
  address private constant STRANGER = address(0xBAD);
  bytes32 private constant HANDLE = keccak256("email:dani@example.com");
  uint256 private constant AMOUNT = 1e6;
  MockUSDC private usdc;
  HandleEscrow private escrow;

  function setUp() public {
    usdc = new MockUSDC();
    escrow = new HandleEscrow(address(usdc), ATTESTER);
    usdc.mint(ALICE, 100e6);
    vm.prank(ALICE);
    usdc.approve(address(escrow), type(uint256).max);
  }

  // Independent protocol encoding: do not read the contract's hashes to sign.
  function _signature(address target, uint256 chainId, uint256 id, address to, uint256 deadline)
    private pure returns (bytes memory)
  {
    bytes32 domain = keccak256(abi.encode(
      keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
      keccak256("Splitsy HandleEscrow"), keccak256("1"), chainId, target
    ));
    bytes32 message = keccak256(abi.encode(
      keccak256("Release(uint256 id,address to,uint256 deadline)"), id, to, deadline
    ));
    (uint8 v, bytes32 r, bytes32 s) = vm.sign(
      ATTESTER_KEY, keccak256(abi.encodePacked("\x19\x01", domain, message))
    );
    return abi.encodePacked(r, s, v);
  }

  function _sign(uint256 id, address to, uint256 deadline) private view returns (bytes memory) {
    return _signature(address(escrow), block.chainid, id, to, deadline);
  }

  function _deposit() private returns (uint256) {
    vm.prank(ALICE);
    return escrow.deposit(HANDLE, AMOUNT);
  }

  function _assertHeld(uint256 id) private view {
    (address depositor, bytes32 handle, uint256 amount) = escrow.deposits(id);
    assertEq(depositor, ALICE);
    assertTrue(handle == HANDLE);
    assertEq(amount, AMOUNT);
  }

  function test_chainIdChangeRejectsOldSignature() public {
    uint256 id = _deposit();
    uint256 deadline = block.timestamp + 1 hours;
    bytes memory sig = _sign(id, RECIPIENT, deadline);
    vm.chainId(block.chainid + 1);
    vm.expectRevert(HandleEscrow.BadSignature.selector);
    escrow.release(id, RECIPIENT, deadline, sig);
    _assertHeld(id);
    assertEq(usdc.balanceOf(RECIPIENT), 0);
  }

  function test_chainIdChangeAcceptsNewChainSignature() public {
    uint256 id = _deposit();
    vm.chainId(block.chainid + 1);
    uint256 deadline = block.timestamp + 1 hours;
    escrow.release(id, RECIPIENT, deadline, _sign(id, RECIPIENT, deadline));
    assertEq(usdc.balanceOf(RECIPIENT), AMOUNT);
  }

  function test_strangerCanRelayButOnlyTheSignedRecipientIsPaid() public {
    uint256 id = _deposit();
    uint256 deadline = block.timestamp + 1 hours;
    bytes memory sig = _sign(id, RECIPIENT, deadline);
    vm.prank(STRANGER);
    escrow.release(id, RECIPIENT, deadline, sig);
    assertEq(usdc.balanceOf(RECIPIENT), AMOUNT);
    assertEq(usdc.balanceOf(STRANGER), 0);
  }

  function test_signatureCannotAuthorizeAnotherDeposit() public {
    uint256 first = _deposit();
    uint256 second = _deposit();
    uint256 deadline = block.timestamp + 1 hours;
    bytes memory sig = _sign(first, RECIPIENT, deadline);
    vm.expectRevert(HandleEscrow.BadSignature.selector);
    escrow.release(second, RECIPIENT, deadline, sig);
    _assertHeld(first);
    _assertHeld(second);
  }

  function test_signatureCannotExtendItsDeadline() public {
    uint256 id = _deposit();
    uint256 deadline = block.timestamp + 1 hours;
    bytes memory sig = _sign(id, RECIPIENT, deadline);
    vm.expectRevert(HandleEscrow.BadSignature.selector);
    escrow.release(id, RECIPIENT, deadline + 1, sig);
    _assertHeld(id);
  }

  function test_signatureForAnotherDeploymentIsRejected() public {
    uint256 id = _deposit();
    HandleEscrow other = new HandleEscrow(address(usdc), ATTESTER);
    uint256 deadline = block.timestamp + 1 hours;
    bytes memory sig = _signature(address(other), block.chainid, id, RECIPIENT, deadline);
    vm.expectRevert(HandleEscrow.BadSignature.selector);
    escrow.release(id, RECIPIENT, deadline, sig);
    _assertHeld(id);
  }

  function test_signatureForAnotherChainIsRejected() public {
    uint256 id = _deposit();
    uint256 deadline = block.timestamp + 1 hours;
    bytes memory sig = _signature(address(escrow), block.chainid + 1, id, RECIPIENT, deadline);
    vm.expectRevert(HandleEscrow.BadSignature.selector);
    escrow.release(id, RECIPIENT, deadline, sig);
    _assertHeld(id);
  }

  function test_highSSignatureIsRejectedAndCanonicalSignatureStillWorks() public {
    uint256 id = _deposit();
    uint256 deadline = block.timestamp + 1 hours;
    bytes memory sig = _sign(id, RECIPIENT, deadline);
    bytes32 r;
    bytes32 s;
    assembly ("memory-safe") {
      r := mload(add(sig, 32))
      s := mload(add(sig, 64))
    }
    bytes memory malleated = abi.encodePacked(r, bytes32(CURVE_ORDER - uint256(s)),
      uint8(sig[64]) == 27 ? uint8(28) : uint8(27));
    vm.expectRevert(HandleEscrow.BadSignature.selector);
    escrow.release(id, RECIPIENT, deadline, malleated);
    _assertHeld(id);
    escrow.release(id, RECIPIENT, deadline, sig);
    assertEq(usdc.balanceOf(RECIPIENT), AMOUNT);
  }

  function test_zeroSignatureIsRejected() public {
    uint256 id = _deposit();
    vm.expectRevert(HandleEscrow.BadSignature.selector);
    escrow.release(id, RECIPIENT, block.timestamp + 1 hours,
      abi.encodePacked(bytes32(0), bytes32(0), uint8(27)));
    _assertHeld(id);
  }

  function test_invalidVIsRejected() public {
    uint256 id = _deposit();
    uint256 deadline = block.timestamp + 1 hours;
    bytes memory sig = _sign(id, RECIPIENT, deadline);
    sig[64] = bytes1(uint8(0));
    vm.expectRevert(HandleEscrow.BadSignature.selector);
    escrow.release(id, RECIPIENT, deadline, sig);
    _assertHeld(id);
  }

  function test_shortSignatureIsRejected() public {
    uint256 id = _deposit();
    vm.expectRevert(HandleEscrow.BadSignature.selector);
    escrow.release(id, RECIPIENT, block.timestamp + 1 hours, new bytes(64));
    _assertHeld(id);
  }

  function test_trailingSignatureBytesAreRejected() public {
    uint256 id = _deposit();
    uint256 deadline = block.timestamp + 1 hours;
    bytes memory sig = bytes.concat(_sign(id, RECIPIENT, deadline), hex"00");
    vm.expectRevert(HandleEscrow.BadSignature.selector);
    escrow.release(id, RECIPIENT, deadline, sig);
    _assertHeld(id);
  }

  function test_reclaimInvalidatesAnOutstandingSignature() public {
    uint256 id = _deposit();
    uint256 deadline = block.timestamp + 1 hours;
    bytes memory sig = _sign(id, RECIPIENT, deadline);
    vm.prank(ALICE);
    escrow.reclaim(id);
    uint256 next = _deposit();
    assertTrue(next > id);
    vm.expectRevert(abi.encodeWithSelector(HandleEscrow.NoSuchDeposit.selector, id));
    escrow.release(id, RECIPIENT, deadline, sig);
    _assertHeld(next);
    assertEq(usdc.balanceOf(RECIPIENT), 0);
  }

  function test_secondAuthorizationCannotSpendAnAlreadyReleasedDeposit() public {
    uint256 id = _deposit();
    uint256 deadline = block.timestamp + 1 hours;
    bytes memory first = _sign(id, RECIPIENT, deadline);
    bytes memory second = _sign(id, STRANGER, deadline + 1);
    escrow.release(id, RECIPIENT, deadline, first);
    vm.expectRevert(abi.encodeWithSelector(HandleEscrow.NoSuchDeposit.selector, id));
    escrow.release(id, STRANGER, deadline + 1, second);
    assertEq(usdc.balanceOf(STRANGER), 0);
  }

  function test_recipientCannotReclaimSomeoneElsesDeposit() public {
    uint256 id = _deposit();
    vm.prank(RECIPIENT);
    vm.expectRevert(abi.encodeWithSelector(HandleEscrow.NotDepositor.selector, id, RECIPIENT));
    escrow.reclaim(id);
    _assertHeld(id);
  }

  function test_attesterCannotReclaimSomeoneElsesDeposit() public {
    uint256 id = _deposit();
    vm.prank(ATTESTER);
    vm.expectRevert(abi.encodeWithSelector(HandleEscrow.NotDepositor.selector, id, ATTESTER));
    escrow.reclaim(id);
    _assertHeld(id);
  }

  function test_releaseAtDeadlineStillWorks() public {
    uint256 id = _deposit();
    uint256 deadline = block.timestamp + 1 hours;
    bytes memory sig = _sign(id, RECIPIENT, deadline);
    vm.warp(deadline);
    escrow.release(id, RECIPIENT, deadline, sig);
    assertEq(usdc.balanceOf(RECIPIENT), AMOUNT);
  }

  function test_failedReleasePreservesDepositAndAuthorizationForRetry() public {
    uint256 id = _deposit();
    uint256 deadline = block.timestamp + 1 hours;
    bytes memory sig = _sign(id, RECIPIENT, deadline);
    vm.mockCall(address(usdc), abi.encodeCall(IERC20.transfer, (RECIPIENT, AMOUNT)), abi.encode(false));
    vm.expectRevert(abi.encodeWithSelector(SafeERC20.SafeERC20FailedOperation.selector, address(usdc)));
    escrow.release(id, RECIPIENT, deadline, sig);
    _assertHeld(id);
    assertEq(usdc.balanceOf(address(escrow)), AMOUNT);
    vm.clearMockedCalls();
    escrow.release(id, RECIPIENT, deadline, sig);
    assertEq(usdc.balanceOf(RECIPIENT), AMOUNT);
  }

  function test_failedReclaimPreservesDepositForRetry() public {
    uint256 id = _deposit();
    vm.mockCall(address(usdc), abi.encodeCall(IERC20.transfer, (ALICE, AMOUNT)), abi.encode(false));
    vm.prank(ALICE);
    vm.expectRevert(abi.encodeWithSelector(SafeERC20.SafeERC20FailedOperation.selector, address(usdc)));
    escrow.reclaim(id);
    _assertHeld(id);
    vm.clearMockedCalls();
    vm.prank(ALICE);
    escrow.reclaim(id);
    assertEq(usdc.balanceOf(ALICE), 100e6);
  }

  function test_failedDepositDoesNotCreateALiabilityOrConsumeAnId() public {
    vm.mockCall(address(usdc), abi.encodeCall(IERC20.transferFrom, (ALICE, address(escrow), AMOUNT)), abi.encode(false));
    vm.prank(ALICE);
    vm.expectRevert(abi.encodeWithSelector(SafeERC20.SafeERC20FailedOperation.selector, address(usdc)));
    escrow.deposit(HANDLE, AMOUNT);
    (,, uint256 amount) = escrow.deposits(1);
    assertEq(amount, 0);
    assertEq(usdc.balanceOf(address(escrow)), 0);
    vm.clearMockedCalls();
    assertEq(_deposit(), 1);
  }

  function test_zeroAttesterIsRejected() public {
    vm.expectRevert(HandleEscrow.InvalidConfiguration.selector);
    new HandleEscrow(address(usdc), address(0));
  }

  function test_zeroTokenIsRejected() public {
    vm.expectRevert(HandleEscrow.InvalidConfiguration.selector);
    new HandleEscrow(address(0), ATTESTER);
  }

  function testFuzz_signatureCannotRedirectPayment(address replacement) public {
    if (replacement == RECIPIENT || replacement == address(0)) return;
    uint256 id = _deposit();
    uint256 deadline = block.timestamp + 1 hours;
    bytes memory sig = _sign(id, RECIPIENT, deadline);
    vm.prank(STRANGER);
    vm.expectRevert(HandleEscrow.BadSignature.selector);
    escrow.release(id, replacement, deadline, sig);
    _assertHeld(id);
    escrow.release(id, RECIPIENT, deadline, sig);
    assertEq(usdc.balanceOf(RECIPIENT), AMOUNT);
  }

  function testFuzz_multipleDepositsConserveFunds(uint96 seed, uint8 releaseMask) public {
    uint256[8] memory amounts;
    uint256 total;
    uint256 paid;
    uint256 refunded;
    uint256 deadline = block.timestamp + 1 hours;
    for (uint256 i; i < 8; ++i) {
      amounts[i] = uint256(keccak256(abi.encode(seed, i))) % 1e6 + 1;
      vm.prank(ALICE);
      assertEq(escrow.deposit(HANDLE, amounts[i]), i + 1);
      total += amounts[i];
    }
    assertEq(usdc.balanceOf(address(escrow)), total);
    for (uint256 i; i < 8; ++i) {
      uint256 id = i + 1;
      if (releaseMask & (1 << i) != 0) {
        escrow.release(id, RECIPIENT, deadline, _sign(id, RECIPIENT, deadline));
        paid += amounts[i];
      } else {
        vm.prank(ALICE);
        escrow.reclaim(id);
        refunded += amounts[i];
      }
      (,, uint256 held) = escrow.deposits(id);
      assertEq(held, 0);
      assertEq(usdc.balanceOf(address(escrow)), total - paid - refunded);
      assertEq(usdc.balanceOf(RECIPIENT), paid);
      assertEq(usdc.balanceOf(ALICE), 100e6 - total + refunded);
    }
  }

  function _reentrantSetup() private returns (MaliciousUSDC token, HandleEscrow target) {
    token = new MaliciousUSDC();
    target = new HandleEscrow(address(token), ATTESTER);
    token.mint(ALICE, 10e6);
    vm.prank(ALICE);
    token.approve(address(target), type(uint256).max);
  }

  function _assertReentryBlocked(MaliciousUSDC token) private view {
    assertTrue(token.reentryAttempted());
    assertTrue(token.reentryReverted());
    assertTrue(token.reentryRevertSelector() == ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
  }

  function test_depositBlocksReentrantRelease() public {
    (MaliciousUSDC token, HandleEscrow target) = _reentrantSetup();
    uint256 deadline = block.timestamp + 1 hours;
    bytes memory sig = _signature(address(target), block.chainid, 1, RECIPIENT, deadline);
    token.arm(address(target), abi.encodeCall(HandleEscrow.release, (1, RECIPIENT, deadline, sig)));
    vm.prank(ALICE);
    target.deposit(HANDLE, AMOUNT);
    _assertReentryBlocked(token);
    assertEq(token.balanceOf(address(target)), AMOUNT);
    assertEq(token.balanceOf(RECIPIENT), 0);
  }

  function test_releaseBlocksReentrantReleaseOfAnotherDeposit() public {
    (MaliciousUSDC token, HandleEscrow target) = _reentrantSetup();
    vm.prank(ALICE);
    target.deposit(HANDLE, AMOUNT);
    vm.prank(ALICE);
    target.deposit(HANDLE, AMOUNT);
    uint256 deadline = block.timestamp + 1 hours;
    bytes memory second = _signature(address(target), block.chainid, 2, RECIPIENT, deadline);
    token.arm(address(target), abi.encodeCall(HandleEscrow.release, (2, RECIPIENT, deadline, second)));
    target.release(1, RECIPIENT, deadline, _signature(address(target), block.chainid, 1, RECIPIENT, deadline));
    _assertReentryBlocked(token);
    (,, uint256 held) = target.deposits(2);
    assertEq(held, AMOUNT);
    assertEq(token.balanceOf(RECIPIENT), AMOUNT);
    target.release(2, RECIPIENT, deadline, second);
    assertEq(token.balanceOf(RECIPIENT), 2 * AMOUNT);
  }

  function test_reclaimBlocksReentrantReleaseOfAnotherDeposit() public {
    (MaliciousUSDC token, HandleEscrow target) = _reentrantSetup();
    vm.prank(ALICE);
    target.deposit(HANDLE, AMOUNT);
    vm.prank(ALICE);
    target.deposit(HANDLE, AMOUNT);
    uint256 deadline = block.timestamp + 1 hours;
    bytes memory second = _signature(address(target), block.chainid, 2, RECIPIENT, deadline);
    token.arm(address(target), abi.encodeCall(HandleEscrow.release, (2, RECIPIENT, deadline, second)));
    vm.prank(ALICE);
    target.reclaim(1);
    _assertReentryBlocked(token);
    (,, uint256 held) = target.deposits(2);
    assertEq(held, AMOUNT);
    assertEq(token.balanceOf(ALICE), 9e6);
    assertEq(token.balanceOf(RECIPIENT), 0);
  }
}
