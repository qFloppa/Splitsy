// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

import {BillSplitRegistry} from "./BillSplitRegistry.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {OddReturnUSDC} from "./mocks/OddReturnUSDC.sol";
import {SafeERC20} from "./libraries/SafeERC20.sol";
import {Test} from "./test/Test.sol";

/// @notice Regression tests for the findings fixed in the v2 audit pass.
/// @dev One test per behaviour that would silently regress if a fix were undone:
///      the pre-call code check, the bounded returndata read, the splitter
///      check having moved inside {BillSplitRegistry._claim}, and the paged
///      reverse-index getters that give clients a bounded alternative to the
///      unbounded ones.
contract AuditFixesTest is Test {
  address private splitter = address(0x5157);
  address private alice = address(0xA11CE);
  address private stranger = address(0xBAD);

  MockUSDC private usdc;
  BillSplitRegistry private registry;

  function setUp() public {
    usdc = new MockUSDC();
    registry = new BillSplitRegistry(address(usdc));

    usdc.mint(alice, 1_000e6);
    vm.prank(alice);
    usdc.approve(address(registry), type(uint256).max);
  }

  // --- SafeERC20: account existence -----------------------------------------

  /// A call to an address with no code succeeds and returns nothing, which is
  /// the exact shape of a successful USDT-style transfer. Without the code
  /// check the registry would credit a debt that no token ever moved.
  function testTransferToCodelessTokenReverts() public {
    address ghost = address(0xDEAD);
    BillSplitRegistry ghostRegistry = new BillSplitRegistry(ghost);

    vm.prank(splitter);
    uint256 billId = ghostRegistry.createBill(bytes32("ghost"), _one(alice), _one(10e6), 0, false);

    vm.prank(alice);
    vm.expectRevert(abi.encodeWithSelector(SafeERC20.SafeERC20FailedOperation.selector, ghost));
    ghostRegistry.payDebt(billId, 10e6);
  }

  // --- SafeERC20: return shapes ---------------------------------------------

  /// USDT-style: no return data at all is a success.
  function testTokenReturningNoDataIsAccepted() public {
    (BillSplitRegistry reg, uint256 billId) = _withOddToken(1, 0);

    vm.prank(alice);
    reg.payDebt(billId, 10e6);

    (, uint256 paid,) = reg.getParticipant(billId, alice);
    assertEq(paid, 10e6, "empty return means success");
  }

  /// A return shorter than one word cannot be an ABI-encoded bool; reading it
  /// would mix the token's bytes with whatever was left in scratch memory.
  function testTokenReturningShortDataReverts() public {
    (BillSplitRegistry reg, uint256 billId) = _withOddToken(2, 0);
    // Built before the prank: a call here would consume it.
    bytes memory expected = abi.encodeWithSelector(SafeERC20.SafeERC20FailedOperation.selector, address(reg.usdc()));

    vm.prank(alice);
    vm.expectRevert(expected);
    reg.payDebt(billId, 10e6);
  }

  /// The silent-failure case the wrapper exists for.
  function testTokenReturningFalseReverts() public {
    (BillSplitRegistry reg, uint256 billId) = _withOddToken(3, 0);
    bytes memory expected = abi.encodeWithSelector(SafeERC20.SafeERC20FailedOperation.selector, address(reg.usdc()));

    vm.prank(alice);
    vm.expectRevert(expected);
    reg.payDebt(billId, 10e6);
  }

  /// A token returning 8192 extra words is still read correctly, and the caller
  /// is not made to pay for copying the blob. The bound below is the ceiling:
  /// the callee's own memory expansion dominates, and decoding the whole
  /// returndata into a `bytes memory` — what this wrapper used to do — would
  /// roughly double it and blow past this figure.
  function testReturnBombIsBoundedAndStillDecoded() public {
    (BillSplitRegistry reg, uint256 billId) = _withOddToken(4, 8192);

    vm.prank(alice);
    uint256 before = gasleft();
    reg.payDebt(billId, 10e6);
    uint256 used = before - gasleft();

    (, uint256 paid,) = reg.getParticipant(billId, alice);
    assertEq(paid, 10e6, "first word is `true`, so the transfer stands");
    assertTrue(used < 400_000);
  }

  // --- _claim: the splitter check lives next to the transfer -----------------

  /// The check moved out of {claim} and into {_claim}; prove it still fires on
  /// both paths rather than only the one that kept an explicit guard.
  function testClaimRejectsNonSplitterOnBothPaths() public {
    uint256 billId = _fundedBill();

    vm.prank(stranger);
    vm.expectRevert(abi.encodeWithSelector(BillSplitRegistry.NotSplitter.selector, billId, stranger));
    registry.claim(billId, 1e6);

    uint256[] memory ids = new uint256[](1);
    ids[0] = billId;
    uint256[] memory none = new uint256[](0);

    vm.prank(stranger);
    vm.expectRevert(abi.encodeWithSelector(BillSplitRegistry.NotSplitter.selector, billId, stranger));
    registry.settle(ids, none, none);
  }

  /// The recipient is read from storage, not taken from `msg.sender`.
  function testClaimPaysTheStoredSplitter() public {
    uint256 billId = _fundedBill();

    vm.prank(splitter);
    registry.claim(billId, 10e6);

    assertEq(usdc.balanceOf(splitter), 10e6, "funds land on the bill's splitter");
  }

  // --- Paged reverse-index getters ------------------------------------------

  function testPagedGettersWindowTheParticipantIndex() public {
    _createBills(5);

    assertEq(registry.billCountForParticipant(alice), 5, "count matches the index length");
    assertEq(registry.billCountForSplitter(splitter), 5, "splitter index too");

    uint256[] memory firstTwo = registry.billIdsForParticipantPaged(alice, 0, 2);
    assertEq(firstTwo.length, 2, "window is the requested size");
    assertEq(firstTwo[0], 1);
    assertEq(firstTwo[1], 2);

    uint256[] memory tail = registry.billIdsForParticipantPaged(alice, 3, 10);
    assertEq(tail.length, 2, "a window past the end is clamped, not reverted");
    assertEq(tail[0], 4);
    assertEq(tail[1], 5);
  }

  function testPagedGettersReturnEmptyOutsideTheIndex() public {
    _createBills(2);

    assertEq(registry.billIdsForParticipantPaged(alice, 2, 10).length, 0, "offset at the end");
    assertEq(registry.billIdsForParticipantPaged(alice, 99, 10).length, 0, "offset past the end");
    assertEq(registry.billIdsForParticipantPaged(alice, 0, 0).length, 0, "zero limit");
    assertEq(registry.billCountForParticipant(stranger), 0, "an address with no bills");

    // A maximal limit must clamp rather than overflow `offset + limit`.
    assertEq(registry.billIdsForParticipantPaged(alice, 1, type(uint256).max).length, 1, "max limit clamps");
    assertEq(registry.billIdsForSplitterPaged(splitter, 0, type(uint256).max).length, 2, "and on the splitter index");
  }

  function testPagedAndWholeArrayGettersAgree() public {
    _createBills(4);

    uint256[] memory whole = registry.billIdsForSplitter(splitter);
    uint256[] memory paged = registry.billIdsForSplitterPaged(splitter, 0, registry.billCountForSplitter(splitter));

    assertEq(whole.length, paged.length, "same length");

    for (uint256 i; i < whole.length; ++i) {
      assertEq(whole[i], paged[i], "same contents, same order");
    }
  }

  // --- helpers ---------------------------------------------------------------

  function _one(address who) private pure returns (address[] memory members) {
    members = new address[](1);
    members[0] = who;
  }

  function _one(uint256 amount) private pure returns (uint256[] memory amounts) {
    amounts = new uint256[](1);
    amounts[0] = amount;
  }

  function _createBills(uint256 n) private {
    for (uint256 i; i < n; ++i) {
      vm.prank(splitter);
      registry.createBill(bytes32("b"), _one(alice), _one(10e6), 0, false);
    }
  }

  function _fundedBill() private returns (uint256 billId) {
    vm.prank(splitter);
    billId = registry.createBill(bytes32("funded"), _one(alice), _one(10e6), 0, false);

    vm.prank(alice);
    registry.payDebt(billId, 10e6);
  }

  function _withOddToken(uint256 mode, uint256 bombWords)
    private
    returns (BillSplitRegistry reg, uint256 billId)
  {
    OddReturnUSDC token = new OddReturnUSDC(mode, bombWords);
    reg = new BillSplitRegistry(address(token));

    token.mint(alice, 1_000e6);
    vm.prank(alice);
    token.approve(address(reg), type(uint256).max);

    vm.prank(splitter);
    billId = reg.createBill(bytes32("odd"), _one(alice), _one(10e6), 0, false);
  }
}
