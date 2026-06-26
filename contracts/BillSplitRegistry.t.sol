// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BillSplitRegistry} from "./BillSplitRegistry.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {Test} from "./test/Test.sol";

contract BillSplitRegistryTest is Test {
  uint256 private constant BILL_ID = 1;
  uint256 private constant ALICE_OWED = 42e6;
  uint256 private constant BOB_OWED = 18e6;

  address private splitter = address(0x5157);
  address private alice = address(0xA11CE);
  address private bob = address(0xB0B);
  address private stranger = address(0xBAD);

  MockUSDC private usdc;
  BillSplitRegistry private registry;

  function setUp() public {
    usdc = new MockUSDC();
    registry = new BillSplitRegistry(address(usdc));

    _fundAndApprove(alice, 100e6);
    _fundAndApprove(bob, 100e6);
    _fundAndApprove(stranger, 100e6);
  }

  function testSplitterCreatesBillWithParticipantDebts() public {
    vm.prank(splitter);
    uint256 billId = registry.createBill(bytes32("dinner"), _participants(), _amounts());

    assertEq(billId, BILL_ID);

    (address billSplitter,, uint256 totalOwed, uint256 totalPaid, uint256 claimed, address[] memory members) =
      registry.getBill(BILL_ID);

    assertEq(billSplitter, splitter);
    assertEq(totalOwed, ALICE_OWED + BOB_OWED);
    assertEq(totalPaid, 0);
    assertEq(claimed, 0);
    assertEq(members.length, 2);
    assertEq(members[0], alice);
    assertEq(members[1], bob);

    (uint256 owed, uint256 paid, bool exists) = registry.getParticipant(BILL_ID, alice);
    assertEq(owed, ALICE_OWED);
    assertEq(paid, 0);
    assertTrue(exists);
  }

  function testParticipantCanPayPartiallyThenFully() public {
    _createBill();

    vm.prank(alice);
    registry.payDebt(BILL_ID, 12e6);

    (uint256 owed, uint256 paid,) = registry.getParticipant(BILL_ID, alice);
    assertEq(owed, ALICE_OWED);
    assertEq(paid, 12e6);
    assertEq(usdc.balanceOf(address(registry)), 12e6);

    vm.prank(alice);
    registry.payDebt(BILL_ID, ALICE_OWED - 12e6);

    (, paid,) = registry.getParticipant(BILL_ID, alice);
    assertEq(paid, ALICE_OWED);
    assertEq(usdc.balanceOf(address(registry)), ALICE_OWED);
  }

  function testCannotOverpayDebt() public {
    _createBill();

    vm.prank(alice);
    vm.expectRevert(BillSplitRegistry.InvalidAmount.selector);
    registry.payDebt(BILL_ID, ALICE_OWED + 1);
  }

  function testNonParticipantCannotPayBill() public {
    _createBill();

    vm.prank(stranger);
    vm.expectRevert(abi.encodeWithSelector(BillSplitRegistry.NotParticipant.selector, BILL_ID, stranger));
    registry.payDebt(BILL_ID, 1e6);
  }

  function testSplitterCanClaimPaidFunds() public {
    _createBill();

    vm.prank(alice);
    registry.payDebt(BILL_ID, 20e6);
    vm.prank(bob);
    registry.payDebt(BILL_ID, BOB_OWED);

    assertEq(registry.claimable(BILL_ID), 38e6);

    vm.prank(splitter);
    registry.claim(BILL_ID, 25e6);

    assertEq(usdc.balanceOf(splitter), 25e6);
    assertEq(registry.claimable(BILL_ID), 13e6);

    vm.prank(splitter);
    registry.claim(BILL_ID, 13e6);

    assertEq(usdc.balanceOf(splitter), 38e6);
    assertEq(registry.claimable(BILL_ID), 0);
  }

  function testOnlySplitterCanClaim() public {
    _createBill();

    vm.prank(alice);
    registry.payDebt(BILL_ID, 10e6);

    vm.prank(alice);
    vm.expectRevert(abi.encodeWithSelector(BillSplitRegistry.NotSplitter.selector, BILL_ID, alice));
    registry.claim(BILL_ID, 10e6);
  }

  function testWalletLookupListsDebtsAndOwnedBills() public {
    _createBill();

    uint256[] memory aliceBills = registry.billIdsForParticipant(alice);
    assertEq(aliceBills.length, 1);
    assertEq(aliceBills[0], BILL_ID);

    uint256[] memory splitterBills = registry.billIdsForSplitter(splitter);
    assertEq(splitterBills.length, 1);
    assertEq(splitterBills[0], BILL_ID);
  }

  function _createBill() private {
    vm.prank(splitter);
    registry.createBill(bytes32("dinner"), _participants(), _amounts());
  }

  function _participants() private view returns (address[] memory participants) {
    participants = new address[](2);
    participants[0] = alice;
    participants[1] = bob;
  }

  function _amounts() private pure returns (uint256[] memory amounts) {
    amounts = new uint256[](2);
    amounts[0] = ALICE_OWED;
    amounts[1] = BOB_OWED;
  }

  function _fundAndApprove(address account, uint256 amount) private {
    usdc.mint(account, amount);

    vm.prank(account);
    usdc.approve(address(registry), type(uint256).max);
  }
}
