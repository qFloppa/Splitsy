// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

import {BillSplitRegistry} from "./BillSplitRegistry.sol";
import {FeeOnTransferUSDC} from "./mocks/FeeOnTransferUSDC.sol";
import {MaliciousUSDC} from "./mocks/MaliciousUSDC.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {ReentrancyGuard} from "./security/ReentrancyGuard.sol";
import {SafeERC20} from "./libraries/SafeERC20.sol";
import {Test} from "./test/Test.sol";

contract BillSplitRegistryTest is Test {
  uint256 private constant BILL_ID = 1;
  uint256 private constant ALICE_OWED = 42e6;
  uint256 private constant BOB_OWED = 18e6;
  uint256 private constant DUE_IN = 7 days;

  address private splitter = address(0x5157);
  address private alice = address(0xA11CE);
  address private bob = address(0xB0B);
  address private stranger = address(0xBAD);

  MockUSDC private usdc;
  BillSplitRegistry private registry;

  /// @dev Local mirrors of the registry's events so {vm.expectEmit} has a shape
  ///      to match against; the cheatcode compares topics and data, not the
  ///      declaring contract.
  event DebtPaid(uint256 indexed billId, address indexed payer, uint256 amount, uint256 paidTotal, uint256 owedTotal);
  event DebtRefunded(
    uint256 indexed billId,
    address indexed payer,
    uint256 amount,
    uint256 paidTotal,
    uint256 owedTotal
  );

  function setUp() public {
    usdc = new MockUSDC();
    registry = new BillSplitRegistry(address(usdc));

    _fundAndApprove(alice, 100e6);
    _fundAndApprove(bob, 100e6);
    _fundAndApprove(stranger, 100e6);

    // The splitter is deliberately left with a zero balance — several tests rely
    // on it paying purely out of claim proceeds — but it still needs an approval.
    vm.prank(splitter);
    usdc.approve(address(registry), type(uint256).max);
  }

  // --- Original v1 behaviour: must survive the v2 refactor untouched ---------

  function testSplitterCreatesBillWithParticipantDebts() public {
    vm.prank(splitter);
    uint256 billId = registry.createBill(bytes32("dinner"), _participants(), _amounts(), 0, false);

    assertEq(billId, BILL_ID);

    (
      address billSplitter,
      ,
      uint256 totalOwed,
      uint256 totalPaid,
      uint256 claimed,
      uint64 dueDate,
      bool escrowUntilFull,
      address[] memory members
    ) = registry.getBill(BILL_ID);

    assertEq(billSplitter, splitter);
    assertEq(totalOwed, ALICE_OWED + BOB_OWED);
    assertEq(totalPaid, 0);
    assertEq(claimed, 0);
    assertEq(uint256(dueDate), 0);
    assertFalse(escrowUntilFull);
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

  // --- Task 2: stored due date ----------------------------------------------

  function testCreateBillStoresDueDate() public {
    uint64 due = _due();
    _createBillWith(due, false);

    (,,,,, uint64 dueDate, bool escrowUntilFull,) = registry.getBill(BILL_ID);
    assertEq(uint256(dueDate), uint256(due));
    assertFalse(escrowUntilFull);
  }

  function testCreateBillRejectsPastDueDate() public {
    vm.warp(block.timestamp + 10 days);

    vm.prank(splitter);
    vm.expectRevert(BillSplitRegistry.InvalidConfiguration.selector);
    registry.createBill(bytes32("late"), _participants(), _amounts(), uint64(block.timestamp - 1), false);
  }

  // --- Task 2b: escrowUntilFull --------------------------------------------

  function testCreateBillRejectsEscrowWithoutDueDate() public {
    vm.prank(splitter);
    vm.expectRevert(BillSplitRegistry.InvalidConfiguration.selector);
    registry.createBill(bytes32("locked"), _participants(), _amounts(), 0, true);
  }

  function testClaimRevertsWhileEscrowed() public {
    _createBillWith(_due(), true);

    vm.prank(alice);
    registry.payDebt(BILL_ID, ALICE_OWED);

    vm.prank(splitter);
    vm.expectRevert(
      abi.encodeWithSelector(BillSplitRegistry.Escrowed.selector, BILL_ID, ALICE_OWED, ALICE_OWED + BOB_OWED)
    );
    registry.claim(BILL_ID, 1e6);
  }

  function testClaimableIsZeroWhileEscrowed() public {
    _createBillWith(_due(), true);

    vm.prank(alice);
    registry.payDebt(BILL_ID, ALICE_OWED);

    assertEq(registry.claimable(BILL_ID), 0);
  }

  function testClaimSucceedsOnceFullyPaid() public {
    _createBillWith(_due(), true);

    vm.prank(alice);
    registry.payDebt(BILL_ID, ALICE_OWED);
    vm.prank(bob);
    registry.payDebt(BILL_ID, BOB_OWED);

    assertEq(registry.claimable(BILL_ID), ALICE_OWED + BOB_OWED);

    vm.prank(splitter);
    registry.claim(BILL_ID, ALICE_OWED + BOB_OWED);

    assertEq(usdc.balanceOf(splitter), ALICE_OWED + BOB_OWED);
  }

  /// @dev The deadline does *not* hand a short bill to the splitter. If it did,
  ///      a creditor could simply wait out the escrow and keep a partial pot for
  ///      a purchase that never happened, which is precisely what a payer ticks
  ///      the box to prevent. Past the deadline the funds belong to the payers —
  ///      see {testRefundReturnsPayerContributionAfterDeadline} for the hatch
  ///      that keeps this from being an unrecoverable lock.
  function testClaimStaysEscrowedAtDueDateWhenShort() public {
    _createBillWith(_due(), true);

    vm.prank(alice);
    registry.payDebt(BILL_ID, ALICE_OWED);

    vm.warp(block.timestamp + DUE_IN + 1);

    assertEq(registry.claimable(BILL_ID), 0);

    vm.prank(splitter);
    vm.expectRevert(
      abi.encodeWithSelector(BillSplitRegistry.Escrowed.selector, BILL_ID, ALICE_OWED, ALICE_OWED + BOB_OWED)
    );
    registry.claim(BILL_ID, ALICE_OWED);

    assertEq(usdc.balanceOf(splitter), 0);
  }

  /// @dev Proof the escrow gate landed in `_claim` and not in the outer `claim`:
  ///      `settle` shares the internal, so it cannot be used to bypass escrow.
  function testSettleClaimLegRespectsEscrow() public {
    _createBillWith(_due(), true);

    vm.prank(alice);
    registry.payDebt(BILL_ID, ALICE_OWED);

    vm.prank(splitter);
    vm.expectRevert(
      abi.encodeWithSelector(BillSplitRegistry.Escrowed.selector, BILL_ID, ALICE_OWED, ALICE_OWED + BOB_OWED)
    );
    registry.settle(_ids(BILL_ID), _noIds(), _noIds());
  }

  // --- refund: the payer's exit from a failed all-or-nothing bill -----------

  /// @dev The counterpart to {testClaimStaysEscrowedAtDueDateWhenShort}: the
  ///      deadline is what makes the *payer's* withdrawal available, so an
  ///      escrowed bill can never strand funds in a contract with no owner, no
  ///      pause and no sweep.
  function testRefundReturnsPayerContributionAfterDeadline() public {
    _createBillWith(_due(), true);

    uint256 aliceBefore = usdc.balanceOf(alice);

    vm.prank(alice);
    registry.payDebt(BILL_ID, ALICE_OWED);

    vm.warp(block.timestamp + DUE_IN + 1);

    vm.expectEmit(true, true, false, true, address(registry));
    emit DebtRefunded(BILL_ID, alice, ALICE_OWED, 0, ALICE_OWED);

    vm.prank(alice);
    registry.refund(BILL_ID);

    assertEq(usdc.balanceOf(alice), aliceBefore, "payer made whole");
    assertEq(usdc.balanceOf(address(registry)), 0, "registry holds nothing");

    (, uint256 paid,) = registry.getParticipant(BILL_ID, alice);
    assertEq(paid, 0, "participant credit cleared");

    (,,, uint256 totalPaid,,,,) = registry.getBill(BILL_ID);
    assertEq(totalPaid, 0, "bill total reduced");
  }

  function testRefundRevertsBeforeDueDate() public {
    // Captured rather than recomputed: `_due()` moves with `block.timestamp`.
    uint64 dueDate = _due();
    _createBillWith(dueDate, true);

    vm.prank(alice);
    registry.payDebt(BILL_ID, ALICE_OWED);

    vm.prank(alice);
    vm.expectRevert(abi.encodeWithSelector(BillSplitRegistry.NotYetDue.selector, BILL_ID, dueDate));
    registry.refund(BILL_ID);
  }

  /// @dev The bill got where it was going, so the money is the splitter's. A
  ///      payer must not be able to yank their share back out from under a
  ///      purchase the group already funded.
  function testRefundRevertsWhenBillIsFullyPaid() public {
    _createBillWith(_due(), true);

    vm.prank(alice);
    registry.payDebt(BILL_ID, ALICE_OWED);
    vm.prank(bob);
    registry.payDebt(BILL_ID, BOB_OWED);

    vm.warp(block.timestamp + DUE_IN + 1);

    vm.prank(alice);
    vm.expectRevert(abi.encodeWithSelector(BillSplitRegistry.NotRefundable.selector, BILL_ID));
    registry.refund(BILL_ID);
  }

  /// @dev Without the toggle, a payment is the splitter's the moment it lands.
  function testRefundRevertsOnNonEscrowBill() public {
    _createBillWith(_due(), false);

    vm.prank(alice);
    registry.payDebt(BILL_ID, ALICE_OWED);

    vm.warp(block.timestamp + DUE_IN + 1);

    vm.prank(alice);
    vm.expectRevert(abi.encodeWithSelector(BillSplitRegistry.NotRefundable.selector, BILL_ID));
    registry.refund(BILL_ID);
  }

  function testRefundRevertsWhenCallerPutNothingIn() public {
    _createBillWith(_due(), true);

    vm.prank(alice);
    registry.payDebt(BILL_ID, ALICE_OWED);

    vm.warp(block.timestamp + DUE_IN + 1);

    // On the bill but never paid.
    vm.prank(bob);
    vm.expectRevert(BillSplitRegistry.InvalidAmount.selector);
    registry.refund(BILL_ID);

    // Never on the bill at all.
    vm.prank(stranger);
    vm.expectRevert(BillSplitRegistry.InvalidAmount.selector);
    registry.refund(BILL_ID);
  }

  /// @dev Zeroing `paid` before the transfer is what makes this hold; a second
  ///      call must not drain a bill funded by somebody else.
  function testRefundIsNotRepeatable() public {
    _createBillWith(_due(), true);

    vm.prank(alice);
    registry.payDebt(BILL_ID, ALICE_OWED);
    vm.prank(bob);
    registry.payDebt(BILL_ID, BOB_OWED - 1);

    vm.warp(block.timestamp + DUE_IN + 1);

    vm.prank(alice);
    registry.refund(BILL_ID);

    vm.prank(alice);
    vm.expectRevert(BillSplitRegistry.InvalidAmount.selector);
    registry.refund(BILL_ID);

    // Bob's money is untouched and still his to withdraw.
    assertEq(usdc.balanceOf(address(registry)), BOB_OWED - 1);
  }

  /// @dev A refund puts the share back on the board rather than killing the
  ///      bill, so a late payer can still complete it and the splitter can still
  ///      be paid in full. Proves `totalPaid` stayed consistent across the
  ///      round trip.
  function testRefundedBillCanBeRevivedAndClaimedInFull() public {
    _createBillWith(_due(), true);

    vm.prank(alice);
    registry.payDebt(BILL_ID, ALICE_OWED);

    vm.warp(block.timestamp + DUE_IN + 1);

    vm.prank(alice);
    registry.refund(BILL_ID);

    vm.prank(alice);
    registry.payDebt(BILL_ID, ALICE_OWED);
    vm.prank(bob);
    registry.payDebt(BILL_ID, BOB_OWED);

    assertEq(registry.claimable(BILL_ID), ALICE_OWED + BOB_OWED);

    vm.prank(splitter);
    registry.claim(BILL_ID, ALICE_OWED + BOB_OWED);

    assertEq(usdc.balanceOf(splitter), ALICE_OWED + BOB_OWED);
    assertEq(usdc.balanceOf(address(registry)), 0);
  }

  /// @dev The one interaction worth pinning down: {collectDebt} still unlocks at
  ///      the deadline on an escrowed bill, because pulling from mandated
  ///      debtors is what can carry it over the line. Anything pulled into a
  ///      bill that stays short is refundable to the debtor it came from, so the
  ///      mandate cannot be used to extract money from a failed bill.
  function testCollectedFundsOnAFailedEscrowBillAreRefundableToTheDebtor() public {
    _createBillWith(_due(), true);

    vm.prank(alice);
    registry.authorizeCollect(BILL_ID);

    vm.warp(block.timestamp + DUE_IN + 1);

    uint256 aliceBefore = usdc.balanceOf(alice);

    vm.prank(splitter);
    registry.collectDebt(BILL_ID, alice, ALICE_OWED);

    assertEq(usdc.balanceOf(alice), aliceBefore - ALICE_OWED);

    // Bob never paid, so the bill is still short and the pull bought nothing.
    vm.prank(splitter);
    vm.expectRevert(
      abi.encodeWithSelector(BillSplitRegistry.Escrowed.selector, BILL_ID, ALICE_OWED, ALICE_OWED + BOB_OWED)
    );
    registry.claim(BILL_ID, ALICE_OWED);

    vm.prank(alice);
    registry.refund(BILL_ID);

    assertEq(usdc.balanceOf(alice), aliceBefore, "collected funds returned to the debtor");
  }

  // --- Task 3: payDebtFor ---------------------------------------------------

  function testPayDebtForCreditsDebtorAndPullsFromFunder() public {
    _createBill();

    uint256 funderBefore = usdc.balanceOf(stranger);

    vm.prank(stranger);
    registry.payDebtFor(BILL_ID, alice, 30e6);

    (, uint256 paid,) = registry.getParticipant(BILL_ID, alice);
    assertEq(paid, 30e6);
    assertEq(usdc.balanceOf(stranger), funderBefore - 30e6);
    assertEq(usdc.balanceOf(alice), 100e6, "debtor's own balance untouched");
    assertEq(usdc.balanceOf(address(registry)), 30e6);
  }

  /// @dev The `payer` topic must stay the debtor or every existing indexer and
  ///      the ERC-8004 scorer silently stops matching.
  function testPayDebtForEmitsDebtPaidWithDebtorAsPayer() public {
    _createBill();

    vm.expectEmit(true, true, false, true, address(registry));
    emit DebtPaid(BILL_ID, alice, 30e6, 30e6, ALICE_OWED);

    vm.prank(stranger);
    registry.payDebtFor(BILL_ID, alice, 30e6);
  }

  function testPayDebtForRevertsForNonParticipantDebtor() public {
    _createBill();

    vm.prank(stranger);
    vm.expectRevert(abi.encodeWithSelector(BillSplitRegistry.NotParticipant.selector, BILL_ID, address(0xDEAD)));
    registry.payDebtFor(BILL_ID, address(0xDEAD), 1e6);
  }

  function testPayDebtForRevertsWhenOverRemaining() public {
    _createBill();

    vm.prank(stranger);
    vm.expectRevert(BillSplitRegistry.InvalidAmount.selector);
    registry.payDebtFor(BILL_ID, alice, ALICE_OWED + 1);
  }

  function testPayDebtForRevertsOnZeroDebtor() public {
    _createBill();

    vm.prank(stranger);
    vm.expectRevert(BillSplitRegistry.InvalidConfiguration.selector);
    registry.payDebtFor(BILL_ID, address(0), 1e6);
  }

  // --- Task 4: authorizeCollect / revokeCollect / collectDebt --------------

  function testAuthorizeCollectOnlyParticipant() public {
    _createBillWith(_due(), false);

    vm.prank(stranger);
    vm.expectRevert(abi.encodeWithSelector(BillSplitRegistry.NotParticipant.selector, BILL_ID, stranger));
    registry.authorizeCollect(BILL_ID);
  }

  function testCollectDebtRevertsWithoutMandate() public {
    _createBillWith(_due(), false);
    vm.warp(block.timestamp + DUE_IN + 1);

    vm.prank(splitter);
    vm.expectRevert(abi.encodeWithSelector(BillSplitRegistry.NoCollectMandate.selector, BILL_ID, alice));
    registry.collectDebt(BILL_ID, alice, 1e6);
  }

  function testCollectDebtOnlySplitter() public {
    uint64 due = _due();
    _createBillWith(due, false);

    vm.prank(alice);
    registry.authorizeCollect(BILL_ID);

    vm.warp(block.timestamp + DUE_IN + 1);

    vm.prank(bob);
    vm.expectRevert(abi.encodeWithSelector(BillSplitRegistry.NotSplitter.selector, BILL_ID, bob));
    registry.collectDebt(BILL_ID, alice, 1e6);
  }

  function testCollectDebtRevertsBeforeDueDate() public {
    uint64 due = _due();
    _createBillWith(due, false);

    vm.prank(alice);
    registry.authorizeCollect(BILL_ID);

    vm.prank(splitter);
    vm.expectRevert(abi.encodeWithSelector(BillSplitRegistry.NotYetDue.selector, BILL_ID, due));
    registry.collectDebt(BILL_ID, alice, 1e6);
  }

  /// @dev A bill with no deadline is never collectible — there is no moment that
  ///      "the deadline" names.
  function testCollectDebtRevertsWhenNoDueDate() public {
    _createBill();

    vm.prank(alice);
    registry.authorizeCollect(BILL_ID);

    vm.warp(block.timestamp + 365 days);

    vm.prank(splitter);
    vm.expectRevert(abi.encodeWithSelector(BillSplitRegistry.NotYetDue.selector, BILL_ID, uint64(0)));
    registry.collectDebt(BILL_ID, alice, 1e6);
  }

  function testRevokeCollectThenCollectReverts() public {
    _createBillWith(_due(), false);

    vm.prank(alice);
    registry.authorizeCollect(BILL_ID);
    assertTrue(registry.collectMandate(BILL_ID, alice));

    vm.prank(alice);
    registry.revokeCollect(BILL_ID);
    assertFalse(registry.collectMandate(BILL_ID, alice));

    vm.warp(block.timestamp + DUE_IN + 1);

    vm.prank(splitter);
    vm.expectRevert(abi.encodeWithSelector(BillSplitRegistry.NoCollectMandate.selector, BILL_ID, alice));
    registry.collectDebt(BILL_ID, alice, 1e6);
  }

  function testRevokeCollectOnlyParticipant() public {
    _createBillWith(_due(), false);

    vm.prank(stranger);
    vm.expectRevert(abi.encodeWithSelector(BillSplitRegistry.NotParticipant.selector, BILL_ID, stranger));
    registry.revokeCollect(BILL_ID);
  }

  function testCollectDebtPullsOverdueShare() public {
    _createBillWith(_due(), false);

    vm.prank(alice);
    registry.authorizeCollect(BILL_ID);

    vm.warp(block.timestamp + DUE_IN + 1);

    vm.prank(splitter);
    registry.collectDebt(BILL_ID, alice, ALICE_OWED);

    (, uint256 paid,) = registry.getParticipant(BILL_ID, alice);
    assertEq(paid, ALICE_OWED);
    assertEq(usdc.balanceOf(alice), 100e6 - ALICE_OWED);
    assertEq(usdc.balanceOf(address(registry)), ALICE_OWED);
  }

  function testCollectDebtCollectsPartialWhenAllowanceShort() public {
    _createBillWith(_due(), false);

    vm.prank(alice);
    usdc.approve(address(registry), 21e6);

    vm.prank(alice);
    registry.authorizeCollect(BILL_ID);

    vm.warp(block.timestamp + DUE_IN + 1);

    vm.prank(splitter);
    registry.collectDebt(BILL_ID, alice, ALICE_OWED);

    (, uint256 paid,) = registry.getParticipant(BILL_ID, alice);
    assertEq(paid, 21e6, "exactly the allowance moved");
    assertEq(usdc.balanceOf(address(registry)), 21e6);
  }

  function testCollectDebtRevertsWhenNothingCollectible() public {
    _createBillWith(_due(), false);

    vm.prank(alice);
    usdc.approve(address(registry), 0);

    vm.prank(alice);
    registry.authorizeCollect(BILL_ID);

    vm.warp(block.timestamp + DUE_IN + 1);

    vm.prank(splitter);
    vm.expectRevert(abi.encodeWithSelector(BillSplitRegistry.NothingCollectible.selector, BILL_ID, alice));
    registry.collectDebt(BILL_ID, alice, ALICE_OWED);
  }

  // --- Task 5: settle -------------------------------------------------------

  /// @dev The ordering contract: claims run first so their proceeds fund the pay
  ///      legs inside the same transaction. The splitter starts with zero USDC.
  function testSettleClaimsThenPays() public {
    _createBill();

    vm.prank(alice);
    registry.payDebt(BILL_ID, 30e6);

    uint256 owedBySplitter = 20e6;
    uint256 secondBillId = _createBillOwedBySplitter(owedBySplitter);

    assertEq(usdc.balanceOf(splitter), 0, "splitter is broke before settling");

    vm.prank(splitter);
    registry.settle(_ids(BILL_ID), _ids(secondBillId), _amountsOf(owedBySplitter));

    assertEq(usdc.balanceOf(splitter), 30e6 - owedBySplitter);
    assertEq(registry.claimable(BILL_ID), 0);

    (, uint256 paid,) = registry.getParticipant(secondBillId, splitter);
    assertEq(paid, owedBySplitter);
  }

  function testSettleZeroAmountMeansRemaining() public {
    _createBill();

    vm.prank(alice);
    registry.payDebt(BILL_ID, 30e6);

    uint256 secondBillId = _createBillOwedBySplitter(20e6);

    vm.prank(splitter);
    registry.settle(_ids(BILL_ID), _ids(secondBillId), _amountsOf(0));

    (, uint256 paid,) = registry.getParticipant(secondBillId, splitter);
    assertEq(paid, 20e6, "zero means my whole remaining share");
  }

  function testSettleRevertsWhenEmpty() public {
    vm.prank(splitter);
    vm.expectRevert(BillSplitRegistry.InvalidConfiguration.selector);
    registry.settle(_noIds(), _noIds(), _noIds());
  }

  function testSettleRevertsOnMismatchedPayArrays() public {
    _createBill();

    vm.prank(splitter);
    vm.expectRevert(BillSplitRegistry.InvalidConfiguration.selector);
    registry.settle(_noIds(), _ids(BILL_ID), _noIds());
  }

  function testSettleRevertsOverMaxBatch() public {
    uint256 tooMany = registry.MAX_BATCH() + 1;
    uint256[] memory oversized = new uint256[](tooMany);

    vm.prank(splitter);
    vm.expectRevert(abi.encodeWithSelector(BillSplitRegistry.BatchTooLarge.selector, tooMany, registry.MAX_BATCH()));
    registry.settle(oversized, _noIds(), _noIds());
  }

  function testSettleRevertsOverMaxBatchOnPayLegs() public {
    uint256 tooMany = registry.MAX_BATCH() + 1;
    uint256[] memory oversized = new uint256[](tooMany);

    vm.prank(splitter);
    vm.expectRevert(abi.encodeWithSelector(BillSplitRegistry.BatchTooLarge.selector, tooMany, registry.MAX_BATCH()));
    registry.settle(_noIds(), oversized, oversized);
  }

  function testSettleClaimLegRequiresSplitter() public {
    _createBill();

    vm.prank(alice);
    registry.payDebt(BILL_ID, 10e6);

    vm.prank(alice);
    vm.expectRevert(abi.encodeWithSelector(BillSplitRegistry.NotSplitter.selector, BILL_ID, alice));
    registry.settle(_ids(BILL_ID), _noIds(), _noIds());
  }

  /// @dev Atomic or nothing: the claim that succeeded earlier in the same call
  ///      must be rolled back by a later bad pay leg.
  function testSettleRevertsWholeBatchOnOneBadLeg() public {
    _createBill();

    vm.prank(alice);
    registry.payDebt(BILL_ID, 30e6);

    uint256 secondBillId = _createBillOwedBySplitter(20e6);

    vm.prank(splitter);
    vm.expectRevert(BillSplitRegistry.InvalidAmount.selector);
    registry.settle(_ids(BILL_ID), _ids(secondBillId), _amountsOf(20e6 + 1));

    assertEq(usdc.balanceOf(splitter), 0, "the claim leg was rolled back too");
    assertEq(registry.claimable(BILL_ID), 30e6);
  }

  function testSettleRevertsOnZeroClaimableBill() public {
    _createBill();

    vm.prank(splitter);
    vm.expectRevert(BillSplitRegistry.ClaimExceedsBalance.selector);
    registry.settle(_ids(BILL_ID), _noIds(), _noIds());
  }

  // --- Task 6: collectible view --------------------------------------------

  function testCollectibleIsZeroWithoutMandateOrBeforeDue() public {
    uint64 due = _due();
    _createBillWith(due, false);

    assertEq(registry.collectible(BILL_ID, alice), 0, "no mandate");

    vm.prank(alice);
    registry.authorizeCollect(BILL_ID);

    assertEq(registry.collectible(BILL_ID, alice), 0, "not yet due");
  }

  /// @dev The view and the state-changing function must never disagree.
  function testCollectibleMatchesWhatCollectDebtMoves() public {
    _createBillWith(_due(), false);

    vm.prank(alice);
    usdc.approve(address(registry), 15e6);

    vm.prank(alice);
    registry.authorizeCollect(BILL_ID);

    vm.warp(block.timestamp + DUE_IN + 1);

    uint256 quoted = registry.collectible(BILL_ID, alice);
    assertEq(quoted, 15e6);

    uint256 registryBefore = usdc.balanceOf(address(registry));

    vm.prank(splitter);
    registry.collectDebt(BILL_ID, alice, type(uint256).max);

    assertEq(usdc.balanceOf(address(registry)) - registryBefore, quoted);
    assertEq(registry.collectible(BILL_ID, alice), 0, "allowance is spent");
  }

  // --- Task 7: adversarial tokens ------------------------------------------

  function testPayDebtForReentrancyIsBlocked() public {
    (MaliciousUSDC evil, BillSplitRegistry reg, uint256 billId) = _deployWithEvilToken();

    evil.arm(address(reg), abi.encodeCall(BillSplitRegistry.payDebt, (billId, 1)));

    vm.prank(stranger);
    reg.payDebtFor(billId, alice, 10e6);

    _assertGuardBlockedReentry(evil);
  }

  function testCollectDebtReentrancyIsBlocked() public {
    (MaliciousUSDC evil, BillSplitRegistry reg, uint256 billId) = _deployWithEvilToken();

    vm.prank(alice);
    reg.authorizeCollect(billId);

    vm.warp(block.timestamp + DUE_IN + 1);

    evil.arm(address(reg), abi.encodeCall(BillSplitRegistry.payDebt, (billId, 1)));

    vm.prank(splitter);
    reg.collectDebt(billId, alice, 10e6);

    _assertGuardBlockedReentry(evil);
  }

  /// @dev The loop is the new surface: a token with a callback gets one chance
  ///      per leg rather than one per transaction.
  function testSettleReentrancyIsBlocked() public {
    (MaliciousUSDC evil, BillSplitRegistry reg, uint256 billId) = _deployWithEvilToken();

    evil.arm(address(reg), abi.encodeCall(BillSplitRegistry.payDebt, (billId, 1)));

    vm.prank(alice);
    reg.settle(_noIds(), _ids(billId), _amountsOf(10e6));

    _assertGuardBlockedReentry(evil);
  }

  function testClaimReentrancyIsBlocked() public {
    (MaliciousUSDC evil, BillSplitRegistry reg, uint256 billId) = _deployWithEvilToken();

    vm.prank(alice);
    reg.payDebt(billId, 10e6);

    // Arm only now: the payment above would otherwise consume the single shot.
    evil.arm(address(reg), abi.encodeCall(BillSplitRegistry.payDebt, (billId, 1)));

    vm.prank(splitter);
    reg.claim(billId, 10e6);

    _assertGuardBlockedReentry(evil);
  }

  /// @dev Known and accepted limitation, pinned so nobody "fixes" it with
  ///      balance-delta accounting: `usdc` is immutable and set once to a known,
  ///      non-fee-on-transfer token, so this state is unreachable in production.
  function testFeeOnTransferTokenBreaksAccountingDocumented() public {
    FeeOnTransferUSDC leaky = new FeeOnTransferUSDC(1e6);
    BillSplitRegistry reg = new BillSplitRegistry(address(leaky));

    leaky.mint(alice, 100e6);
    vm.prank(alice);
    leaky.approve(address(reg), type(uint256).max);

    vm.prank(splitter);
    uint256 billId = reg.createBill(bytes32("leaky"), _participants(), _amounts(), 0, false);

    vm.prank(alice);
    reg.payDebt(billId, 10e6);

    assertEq(reg.claimable(billId), 10e6, "the registry credits the requested amount");
    assertEq(leaky.balanceOf(address(reg)), 9e6, "but only receives amount - fee");

    vm.prank(splitter);
    vm.expectRevert(abi.encodeWithSelector(SafeERC20.SafeERC20FailedOperation.selector, address(leaky)));
    reg.claim(billId, 10e6);
  }

  // --- Task 8: invariants ---------------------------------------------------

  function testInvariantPaidNeverExceedsOwed() public {
    (uint256 firstBill, uint256 secondBill) = _mixedSequence();

    _assertPaidWithinOwed(firstBill);
    _assertPaidWithinOwed(secondBill);
  }

  function testInvariantClaimedNeverExceedsPaid() public {
    (uint256 firstBill, uint256 secondBill) = _mixedSequence();

    _assertClaimedWithinPaid(firstBill);
    _assertClaimedWithinPaid(secondBill);
  }

  /// @dev The solvency invariant. If this can break, funds are stealable.
  function testInvariantContractBalanceCoversUnclaimed() public {
    (uint256 firstBill, uint256 secondBill) = _mixedSequence();

    uint256 unclaimed = _unclaimed(firstBill) + _unclaimed(secondBill);
    assertTrue(usdc.balanceOf(address(registry)) >= unclaimed);
  }

  /// @dev Guards against a storage-collision class of bug: actions on one bill
  ///      must never touch another's fields.
  function testInvariantBillsAreIndependent() public {
    vm.prank(bob);
    uint256 untouched = registry.createBill(bytes32("untouched"), _oneParticipant(stranger, 9e6), _oneAmount(9e6), 0, false);

    _mixedSequence();

    (
      address billSplitter,
      bytes32 metadataHash,
      uint256 totalOwed,
      uint256 totalPaid,
      uint256 claimed,
      uint64 dueDate,
      bool escrowUntilFull,
      address[] memory members
    ) = registry.getBill(untouched);

    assertEq(billSplitter, bob);
    assertTrue(metadataHash == bytes32("untouched"));
    assertEq(totalOwed, 9e6);
    assertEq(totalPaid, 0);
    assertEq(claimed, 0);
    assertEq(uint256(dueDate), 0);
    assertFalse(escrowUntilFull);
    assertEq(members.length, 1);
    assertEq(members[0], stranger);
    assertFalse(registry.collectMandate(untouched, stranger));
  }

  // --- Task 8: access-control matrix ---------------------------------------

  function testAccessControlUnknownBillIsRejectedEverywhere() public {
    uint256 ghost = 999;

    vm.expectRevert(abi.encodeWithSelector(BillSplitRegistry.UnknownBill.selector, ghost));
    registry.claimable(ghost);

    vm.prank(alice);
    vm.expectRevert(abi.encodeWithSelector(BillSplitRegistry.UnknownBill.selector, ghost));
    registry.authorizeCollect(ghost);

    vm.prank(alice);
    vm.expectRevert(abi.encodeWithSelector(BillSplitRegistry.UnknownBill.selector, ghost));
    registry.revokeCollect(ghost);

    vm.prank(splitter);
    vm.expectRevert(abi.encodeWithSelector(BillSplitRegistry.UnknownBill.selector, ghost));
    registry.collectDebt(ghost, alice, 1e6);

    vm.prank(splitter);
    vm.expectRevert(abi.encodeWithSelector(BillSplitRegistry.UnknownBill.selector, ghost));
    registry.settle(_ids(ghost), _noIds(), _noIds());
  }

  // --- helpers --------------------------------------------------------------

  function _due() private view returns (uint64) {
    return uint64(block.timestamp + DUE_IN);
  }

  function _createBill() private {
    vm.prank(splitter);
    registry.createBill(bytes32("dinner"), _participants(), _amounts(), 0, false);
  }

  function _createBillWith(uint64 dueDate, bool escrowUntilFull) private {
    vm.prank(splitter);
    registry.createBill(bytes32("dinner"), _participants(), _amounts(), dueDate, escrowUntilFull);
  }

  /// @dev A bill created by alice on which the splitter is the sole debtor, so
  ///      `settle` has something for the splitter to pay.
  function _createBillOwedBySplitter(uint256 amount) private returns (uint256 billId) {
    vm.prank(alice);
    return registry.createBill(bytes32("owed"), _oneParticipant(splitter, amount), _oneAmount(amount), 0, false);
  }

  /// @dev Deploys a registry backed by {MaliciousUSDC} with one funded bill.
  function _deployWithEvilToken()
    private
    returns (MaliciousUSDC evil, BillSplitRegistry reg, uint256 billId)
  {
    evil = new MaliciousUSDC();
    reg = new BillSplitRegistry(address(evil));

    evil.mint(alice, 100e6);
    evil.mint(stranger, 100e6);

    vm.prank(alice);
    evil.approve(address(reg), type(uint256).max);
    vm.prank(stranger);
    evil.approve(address(reg), type(uint256).max);

    vm.prank(splitter);
    billId = reg.createBill(bytes32("evil"), _participants(), _amounts(), _due(), false);
  }

  /// @dev Asserts the reentrant call happened and was stopped by the guard
  ///      specifically. Without the guard the inner {payDebt} would have
  ///      reverted with {NotParticipant} instead (the token is not a
  ///      participant), so pinning the selector is the proof.
  function _assertGuardBlockedReentry(MaliciousUSDC evil) private view {
    assertTrue(evil.reentryAttempted());
    assertTrue(evil.reentryReverted());
    assertTrue(evil.reentryRevertSelector() == ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
  }

  /// @dev A sequence touching every fund-mover: payDebt, payDebtFor,
  ///      collectDebt, claim and settle. Returns both bill ids.
  function _mixedSequence() private returns (uint256 firstBill, uint256 secondBill) {
    uint64 due = _due();
    vm.prank(splitter);
    firstBill = registry.createBill(bytes32("mixed"), _participants(), _amounts(), due, false);

    vm.prank(alice);
    registry.payDebt(firstBill, 10e6);

    vm.prank(stranger);
    registry.payDebtFor(firstBill, alice, 5e6);

    vm.prank(bob);
    registry.authorizeCollect(firstBill);

    vm.warp(block.timestamp + DUE_IN + 1);

    vm.prank(splitter);
    registry.collectDebt(firstBill, bob, BOB_OWED);

    vm.prank(splitter);
    registry.claim(firstBill, 20e6);

    secondBill = _createBillOwedBySplitter(5e6);

    vm.prank(splitter);
    registry.settle(_ids(firstBill), _ids(secondBill), _amountsOf(0));
  }

  function _assertPaidWithinOwed(uint256 billId) private view {
    (,, uint256 totalOwed, uint256 totalPaid,,,, address[] memory members) = registry.getBill(billId);

    assertTrue(totalPaid <= totalOwed);

    uint256 summed = 0;
    for (uint256 i = 0; i < members.length; ++i) {
      (uint256 owed, uint256 paid,) = registry.getParticipant(billId, members[i]);
      assertTrue(paid <= owed);
      summed += paid;
    }

    assertEq(summed, totalPaid, "per-participant paid sums to totalPaid");
  }

  function _assertClaimedWithinPaid(uint256 billId) private view {
    (,,, uint256 totalPaid, uint256 claimed,,,) = registry.getBill(billId);
    assertTrue(claimed <= totalPaid);
  }

  function _unclaimed(uint256 billId) private view returns (uint256) {
    (,,, uint256 totalPaid, uint256 claimed,,,) = registry.getBill(billId);
    return totalPaid - claimed;
  }

  function _participants() private view returns (address[] memory members) {
    members = new address[](2);
    members[0] = alice;
    members[1] = bob;
  }

  function _amounts() private pure returns (uint256[] memory amounts) {
    amounts = new uint256[](2);
    amounts[0] = ALICE_OWED;
    amounts[1] = BOB_OWED;
  }

  function _oneParticipant(address who, uint256) private pure returns (address[] memory members) {
    members = new address[](1);
    members[0] = who;
  }

  function _oneAmount(uint256 amount) private pure returns (uint256[] memory amounts) {
    amounts = new uint256[](1);
    amounts[0] = amount;
  }

  function _ids(uint256 id) private pure returns (uint256[] memory ids) {
    ids = new uint256[](1);
    ids[0] = id;
  }

  function _amountsOf(uint256 amount) private pure returns (uint256[] memory amounts) {
    amounts = new uint256[](1);
    amounts[0] = amount;
  }

  function _noIds() private pure returns (uint256[] memory ids) {
    ids = new uint256[](0);
  }

  function _fundAndApprove(address account, uint256 amount) private {
    usdc.mint(account, amount);

    vm.prank(account);
    usdc.approve(address(registry), type(uint256).max);
  }
}
