// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

import {AutopayMandate} from "./AutopayMandate.sol";
import {BillSplitRegistry} from "./BillSplitRegistry.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {SafeERC20} from "./libraries/SafeERC20.sol";
import {Test} from "./test/Test.sol";

/// @dev The mandate is a spending permission, so every test here is really one
///      question: can the agent move more of the debtor's money than the debtor
///      authorised? The caps, the bucket, the allowlist and the revoke each get
///      their own answer, and each answer has to come from the chain rather than
///      from the server that calls it.
contract AutopayMandateTest is Test {
  uint96 private constant MAX_PER_BILL = 25e6;
  uint128 private constant MAX_PER_DAY = 30e6;

  address private splitter = address(0x5157);
  address private otherSplitter = address(0x5158);
  address private alice = address(0xA11CE);
  address private agent = address(0xA6E27);
  address private stranger = address(0xBAD);

  MockUSDC private usdc;
  BillSplitRegistry private registry;
  AutopayMandate private mandate;

  event MandateSpent(uint256 indexed billId, address indexed debtor, address indexed agent, uint256 amount);

  function setUp() public {
    usdc = new MockUSDC();
    registry = new BillSplitRegistry(address(usdc));
    mandate = new AutopayMandate(address(registry), address(usdc));

    usdc.mint(alice, 1000e6);

    // The debtor's own approval to the mandate: the outermost bound on
    // everything below, and the one the debtor can withdraw unilaterally.
    vm.prank(alice);
    usdc.approve(address(mandate), type(uint256).max);
  }

  // --- the happy path -------------------------------------------------------

  function testAgentPaysFullShareFromDebtorsWallet() public {
    uint256 billId = _createBill(splitter, 20e6);
    _setMandate(MAX_PER_BILL, MAX_PER_DAY, _noCreators());

    uint256 before = usdc.balanceOf(alice);

    vm.expectEmit(true, true, true, true, address(mandate));
    emit MandateSpent(billId, alice, agent, 20e6);

    vm.prank(agent);
    mandate.payFor(billId, alice);

    (uint256 owed, uint256 paid,) = registry.getParticipant(billId, alice);
    assertEq(paid, owed, "debtor credited in full");
    assertEq(before - usdc.balanceOf(alice), 20e6, "the debtor's own USDC paid it");
    assertEq(usdc.balanceOf(address(registry)), 20e6, "funds landed on the registry");
  }

  /// @dev The contract custodies money only inside one call. A residue here
  ///      would mean an unowned, unsweepable balance — this contract has no
  ///      withdrawal path at all, so anything stranded is stranded forever.
  function testNoUsdcRemainsOnTheMandateContract() public {
    uint256 billId = _createBill(splitter, 20e6);
    _setMandate(MAX_PER_BILL, MAX_PER_DAY, _noCreators());

    vm.prank(agent);
    mandate.payFor(billId, alice);

    assertEq(usdc.balanceOf(address(mandate)), 0, "no residue");
  }

  // --- the caps -------------------------------------------------------------

  function testShareAboveThePerBillCapReverts() public {
    uint256 billId = _createBill(splitter, uint256(MAX_PER_BILL) + 1);
    _setMandate(MAX_PER_BILL, MAX_PER_DAY, _noCreators());

    assertEq(mandate.spendable(billId, alice), 0, "priced as unpayable first");

    vm.prank(agent);
    vm.expectRevert(AutopayMandate.OverBillCap.selector);
    mandate.payFor(billId, alice);
  }

  function testTwoSpendsInOneDayBreachingTheDailyCapRevert() public {
    uint256 first = _createBill(splitter, 20e6);
    uint256 second = _createBill(splitter, 20e6);
    _setMandate(MAX_PER_BILL, MAX_PER_DAY, _noCreators());

    vm.prank(agent);
    mandate.payFor(first, alice);

    // 20 + 20 > 30, and only a sliver of the bucket has refilled.
    vm.prank(agent);
    vm.expectRevert(AutopayMandate.OverDailyCap.selector);
    mandate.payFor(second, alice);
  }

  /// @dev The bucket is what makes the ceiling a rate limit rather than a
  ///      calendar-day counter with an exploitable boundary.
  function testTheBucketRefillsOverTime() public {
    uint256 first = _createBill(splitter, 20e6);
    uint256 second = _createBill(splitter, 20e6);
    _setMandate(MAX_PER_BILL, MAX_PER_DAY, _noCreators());

    vm.prank(agent);
    mandate.payFor(first, alice);

    // Half a day refills half of a 30/day cap: 20 spent decays to 5, leaving
    // room for the second 20.
    vm.warp(block.timestamp + 12 hours);

    assertEq(mandate.dailyHeadroom(alice), 25e6, "headroom after a half-day refill");
    assertEq(mandate.spendable(second, alice), 20e6, "priced as payable");

    vm.prank(agent);
    mandate.payFor(second, alice);

    (, uint256 paid,) = registry.getParticipant(second, alice);
    assertEq(paid, 20e6, "second share settled after the refill");
  }

  // --- the allowlist --------------------------------------------------------

  function testAllowlistRejectsAnUnlistedCreator() public {
    uint256 billId = _createBill(otherSplitter, 10e6);

    address[] memory creators = new address[](1);
    creators[0] = splitter;
    _setMandate(MAX_PER_BILL, MAX_PER_DAY, creators);

    vm.prank(agent);
    vm.expectRevert(AutopayMandate.CreatorNotAllowed.selector);
    mandate.payFor(billId, alice);
  }

  function testAllowlistAdmitsAListedCreator() public {
    uint256 billId = _createBill(splitter, 10e6);

    address[] memory creators = new address[](2);
    creators[0] = otherSplitter;
    creators[1] = splitter;
    _setMandate(MAX_PER_BILL, MAX_PER_DAY, creators);

    assertEq(mandate.allowedCreators(alice).length, 2, "allowlist readable from chain");

    vm.prank(agent);
    mandate.payFor(billId, alice);

    (, uint256 paid,) = registry.getParticipant(billId, alice);
    assertEq(paid, 10e6, "listed creator's bill settled");
  }

  function testAnAllowlistLongerThanTheCapReverts() public {
    address[] memory creators = new address[](11);

    vm.prank(alice);
    vm.expectRevert(AutopayMandate.TooManyCreators.selector);
    mandate.setMandate(agent, MAX_PER_BILL, MAX_PER_DAY, creators);
  }

  // --- who may call ---------------------------------------------------------

  /// @dev The demo's closing move: the caps belong to the chain, not the server,
  ///      so a wallet that is not the named agent cannot spend under them.
  function testACallerThatIsNotTheAgentReverts() public {
    uint256 billId = _createBill(splitter, 10e6);
    _setMandate(MAX_PER_BILL, MAX_PER_DAY, _noCreators());

    vm.prank(stranger);
    vm.expectRevert(AutopayMandate.NotAgent.selector);
    mandate.payFor(billId, alice);
  }

  function testWithoutAMandateThereIsNothingToCall() public {
    uint256 billId = _createBill(splitter, 10e6);

    vm.prank(agent);
    vm.expectRevert(AutopayMandate.NoMandate.selector);
    mandate.payFor(billId, alice);
  }

  function testRevokeMakesTheNextPullRevert() public {
    uint256 billId = _createBill(splitter, 10e6);
    _setMandate(MAX_PER_BILL, MAX_PER_DAY, _noCreators());

    vm.prank(alice);
    mandate.revokeMandate();

    assertEq(mandate.spendable(billId, alice), 0, "priced at zero once revoked");

    vm.prank(agent);
    vm.expectRevert(AutopayMandate.NoMandate.selector);
    mandate.payFor(billId, alice);
  }

  // --- the bucket survives a settings change --------------------------------

  /// @dev The first thing worth probing about this design: if re-saving the
  ///      settings panel reset the day's spend, the daily cap would only hold
  ///      until the user pressed Save.
  function testResavingTheMandateDoesNotClearTheDaysSpend() public {
    uint256 first = _createBill(splitter, 20e6);
    uint256 second = _createBill(splitter, 20e6);
    _setMandate(MAX_PER_BILL, MAX_PER_DAY, _noCreators());

    vm.prank(agent);
    mandate.payFor(first, alice);

    // Same numbers, saved again — the settings-panel round trip.
    _setMandate(MAX_PER_BILL, MAX_PER_DAY, _noCreators());

    vm.prank(agent);
    vm.expectRevert(AutopayMandate.OverDailyCap.selector);
    mandate.payFor(second, alice);
  }

  /// @dev Lowering a ceiling below what is already spent must bind immediately
  ///      rather than reverting the settings change: the user is tightening a
  ///      permission, and that can never be the operation that fails.
  function testLoweringTheDailyCapBlocksTheNextPullRatherThanReverting() public {
    uint256 first = _createBill(splitter, 20e6);
    uint256 second = _createBill(splitter, 5e6);
    _setMandate(MAX_PER_BILL, MAX_PER_DAY, _noCreators());

    vm.prank(agent);
    mandate.payFor(first, alice);

    _setMandate(MAX_PER_BILL, 10e6, _noCreators());

    assertEq(mandate.dailyHeadroom(alice), 0, "no room under the lowered ceiling");

    vm.prank(agent);
    vm.expectRevert(AutopayMandate.OverDailyCap.selector);
    mandate.payFor(second, alice);
  }

  // --- the debtor's own approval is still the outer bound -------------------

  function testAShortApprovalRevertsAndIsPricedAtZeroFirst() public {
    uint256 billId = _createBill(splitter, 20e6);
    _setMandate(MAX_PER_BILL, MAX_PER_DAY, _noCreators());

    vm.prank(alice);
    usdc.approve(address(mandate), 1e6);

    assertEq(mandate.spendable(billId, alice), 0, "pre-flight catches the short allowance");

    vm.prank(agent);
    vm.expectRevert(abi.encodeWithSelector(SafeERC20.SafeERC20FailedOperation.selector, address(usdc)));
    mandate.payFor(billId, alice);
  }

  function testAnAlreadySettledShareReverts() public {
    uint256 billId = _createBill(splitter, 10e6);
    _setMandate(MAX_PER_BILL, MAX_PER_DAY, _noCreators());

    vm.prank(alice);
    usdc.approve(address(registry), type(uint256).max);
    vm.prank(alice);
    registry.payDebt(billId, 10e6);

    vm.prank(agent);
    vm.expectRevert(AutopayMandate.NothingOwed.selector);
    mandate.payFor(billId, alice);
  }

  function testANonParticipantReverts() public {
    uint256 billId = _createBill(splitter, 10e6);

    vm.prank(stranger);
    mandate.setMandate(agent, MAX_PER_BILL, MAX_PER_DAY, _noCreators());

    vm.prank(agent);
    vm.expectRevert(AutopayMandate.NotParticipant.selector);
    mandate.payFor(billId, stranger);
  }

  // --- helpers --------------------------------------------------------------

  function _createBill(address creator, uint256 aliceOwes) private returns (uint256 billId) {
    address[] memory participants = new address[](1);
    participants[0] = alice;

    uint256[] memory amounts = new uint256[](1);
    amounts[0] = aliceOwes;

    vm.prank(creator);
    billId = registry.createBill(bytes32("dinner"), participants, amounts, 0, false);
  }

  function _setMandate(uint96 maxPerBill, uint128 maxPerDay, address[] memory creators) private {
    vm.prank(alice);
    mandate.setMandate(agent, maxPerBill, maxPerDay, creators);
  }

  function _noCreators() private pure returns (address[] memory creators) {
    creators = new address[](0);
  }
}
