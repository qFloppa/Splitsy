// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "./test/Test.sol";
import {RecurringTab} from "./RecurringTab.sol";
import {RecurringTabFactory} from "./RecurringTabFactory.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

contract RecurringTabTest is Test {
  uint256 private constant TAB_ID = 1;
  uint256 private constant INTERVAL = 30 days;
  uint256 private constant ALICE_SHARE = 100e6;
  uint256 private constant BOB_SHARE = 75e6;
  uint256 private constant CARLA_SHARE = 50e6;
  uint256 private constant MAX_SETTLEMENTS = 3;

  address private owner = address(0x1001);
  address private alice = address(0xA11CE);
  address private bob = address(0xB0B);
  address private carla = address(0xCA41A);
  address private randomCaller = address(0x5150);
  address private stranger = address(0xBAD);

  MockUSDC private usdc;
  RecurringTabFactory private factory;
  RecurringTab private tab;

  function setUp() public {
    usdc = new MockUSDC();
    factory = new RecurringTabFactory(address(usdc));

    address[] memory members = new address[](3);
    members[0] = alice;
    members[1] = bob;
    members[2] = carla;

    uint256[] memory shares = new uint256[](3);
    shares[0] = ALICE_SHARE;
    shares[1] = BOB_SHARE;
    shares[2] = CARLA_SHARE;

    (, address tabAddress) = factory.createTab(owner, INTERVAL, MAX_SETTLEMENTS, members, shares);
    tab = RecurringTab(tabAddress);

    _fundAndApprove(alice, 1_000e6);
    _fundAndApprove(bob, 1_000e6);
    _fundAndApprove(carla, 1_000e6);
    _fundAndApprove(stranger, 1_000e6);
  }

  function testFactoryCreatesIsolatedTabWithFixedRules() public view {
    assertEq(factory.tabs(TAB_ID), address(tab));
    assertEq(tab.tabId(), TAB_ID);
    assertEq(tab.recipient(), owner);
    assertEq(tab.settlementInterval(), INTERVAL);
    assertEq(tab.maxSettlements(), MAX_SETTLEMENTS);
    assertEq(tab.settlementCount(), 0);
    assertEq(tab.lastSettledAt(), tab.createdAt());
    assertEq(tab.nextSettlementAt(), tab.createdAt() + INTERVAL);
    assertEq(tab.fixedShare(alice), ALICE_SHARE);
    assertEq(tab.fixedShare(bob), BOB_SHARE);
    assertEq(tab.fixedShare(carla), CARLA_SHARE);
    assertTrue(tab.isMember(alice));
    assertFalse(tab.isMember(stranger));
    assertEq(tab.memberCount(), 3);
  }

  function testApprovalDoesNotMoveFundsBeforeCycle() public view {
    assertEq(usdc.balanceOf(alice), 1_000e6);
    assertEq(usdc.balanceOf(address(tab)), 0);
    assertEq(usdc.allowance(alice, address(tab)), type(uint256).max);
  }

  function testSettleTabRevertsBeforeInterval() public {
    vm.prank(randomCaller);
    vm.expectRevert(RecurringTab.AlreadySettledForPeriod.selector);
    factory.settleTab(TAB_ID);
  }

  function testNextSettlementUsesCreationScheduleEvenWhenUnsettled() public {
    uint256 createdAt = tab.createdAt();

    vm.warp(createdAt + INTERVAL + 1);
    assertEq(tab.nextSettlementAt(), createdAt + INTERVAL * 2);

    vm.warp(createdAt + INTERVAL * 2 + 1);
    assertEq(tab.nextSettlementAt(), createdAt + INTERVAL * 3);

    vm.warp(createdAt + INTERVAL * 3 + 1);
    assertEq(tab.nextSettlementAt(), 0);
  }

  function testAnyoneCanSettleAfterIntervalAndPaysRecipient() public {
    vm.warp(block.timestamp + INTERVAL);
    uint256 expectedLastSettledAt = block.timestamp;

    uint256 recipientBefore = usdc.balanceOf(owner);

    vm.prank(randomCaller);
    factory.settleTab(TAB_ID);

    assertEq(usdc.balanceOf(owner), recipientBefore);
    assertEq(usdc.balanceOf(address(tab)), ALICE_SHARE + BOB_SHARE + CARLA_SHARE);
    assertEq(tab.claimable(), ALICE_SHARE + BOB_SHARE + CARLA_SHARE);
    assertEq(tab.totalSettledByMember(alice), ALICE_SHARE);
    assertEq(tab.totalSettledByMember(bob), BOB_SHARE);
    assertEq(tab.totalSettledByMember(carla), CARLA_SHARE);
    assertEq(tab.lastSettledAt(), expectedLastSettledAt);
    assertEq(tab.settlementCount(), 1);
  }

  function testDirectContractSettleIsAlsoPublic() public {
    vm.warp(block.timestamp + INTERVAL);

    vm.prank(stranger);
    tab.settleTab();

    assertEq(usdc.balanceOf(address(tab)), ALICE_SHARE + BOB_SHARE + CARLA_SHARE);
  }

  function testCannotSettleTwiceInSamePeriod() public {
    vm.warp(block.timestamp + INTERVAL);

    vm.prank(randomCaller);
    factory.settleTab(TAB_ID);

    vm.prank(randomCaller);
    vm.expectRevert(RecurringTab.AlreadySettledForPeriod.selector);
    factory.settleTab(TAB_ID);
  }

  function testStopsAfterConfiguredSettlementCount() public {
    vm.warp(block.timestamp + INTERVAL * MAX_SETTLEMENTS);
    vm.prank(randomCaller);
    factory.settleTab(TAB_ID);

    assertEq(tab.settlementCount(), MAX_SETTLEMENTS);
    assertEq(tab.nextSettlementAt(), 0);

    vm.warp(block.timestamp + INTERVAL);
    vm.prank(randomCaller);
    vm.expectRevert(RecurringTab.TabComplete.selector);
    factory.settleTab(TAB_ID);
  }

  function testCanCollectLateShortfallAfterScheduleCompletes() public {
    vm.prank(bob);
    usdc.approve(address(tab), BOB_SHARE);

    vm.warp(block.timestamp + INTERVAL * MAX_SETTLEMENTS);
    vm.prank(randomCaller);
    factory.settleTab(TAB_ID);

    assertEq(tab.settlementCount(), MAX_SETTLEMENTS);
    assertEq(tab.totalSettledByMember(bob), BOB_SHARE);

    vm.prank(bob);
    usdc.approve(address(tab), BOB_SHARE * 2);
    vm.warp(block.timestamp + INTERVAL);

    vm.prank(randomCaller);
    factory.settleTab(TAB_ID);

    assertEq(tab.settlementCount(), MAX_SETTLEMENTS);
    assertEq(tab.totalSettledByMember(bob), BOB_SHARE * MAX_SETTLEMENTS);
    assertEq(tab.claimable(), (ALICE_SHARE + CARLA_SHARE + BOB_SHARE) * MAX_SETTLEMENTS);
  }

  function testSettleCatchesUpAllOverdueCycles() public {
    uint256 createdAt = block.timestamp;
    vm.warp(createdAt + INTERVAL * 3 + 11);

    vm.prank(randomCaller);
    factory.settleTab(TAB_ID);

    uint256 totalPerCycle = ALICE_SHARE + BOB_SHARE + CARLA_SHARE;
    assertEq(tab.settlementCount(), 3);
    assertEq(tab.claimable(), totalPerCycle * 3);
    assertEq(usdc.balanceOf(address(tab)), totalPerCycle * 3);
    assertEq(tab.totalSettledByMember(alice), ALICE_SHARE * 3);
    assertEq(tab.totalSettledByMember(bob), BOB_SHARE * 3);
    assertEq(tab.totalSettledByMember(carla), CARLA_SHARE * 3);
    assertEq(tab.lastSettledAt(), createdAt + INTERVAL * 3);
    assertEq(tab.nextSettlementAt(), 0);
  }

  function testSettleCapsCatchUpAtRemainingCycles() public {
    vm.warp(block.timestamp + INTERVAL);
    vm.prank(randomCaller);
    factory.settleTab(TAB_ID);

    uint256 lastSettledAfterFirst = tab.lastSettledAt();
    vm.warp(block.timestamp + INTERVAL * 5);
    vm.prank(randomCaller);
    factory.settleTab(TAB_ID);

    uint256 totalPerCycle = ALICE_SHARE + BOB_SHARE + CARLA_SHARE;
    assertEq(tab.settlementCount(), MAX_SETTLEMENTS);
    assertEq(tab.claimable(), totalPerCycle * MAX_SETTLEMENTS);
    assertEq(tab.lastSettledAt(), lastSettledAfterFirst + INTERVAL * 2);
    assertEq(tab.nextSettlementAt(), 0);
  }

  function testShortfallCollectsAvailableAllowance() public {
    uint256 bobApproval = (BOB_SHARE * 2) - 1;

    vm.prank(bob);
    usdc.approve(address(tab), bobApproval);

    vm.warp(block.timestamp + INTERVAL * 2);
    vm.prank(randomCaller);
    factory.settleTab(TAB_ID);

    assertEq(usdc.balanceOf(owner), 0);
    assertEq(usdc.balanceOf(address(tab)), ((ALICE_SHARE + CARLA_SHARE) * 2) + bobApproval);
    assertEq(usdc.balanceOf(bob), 1_000e6 - bobApproval);
    assertEq(tab.totalSettledByMember(alice), ALICE_SHARE * 2);
    assertEq(tab.totalSettledByMember(bob), bobApproval);
    assertEq(tab.totalSettledByMember(carla), CARLA_SHARE * 2);
    assertEq(tab.settlementCount(), 2);
  }

  function testShortfallCollectsAvailableBalance() public {
    uint256 bobBalance = BOB_SHARE - 1;
    vm.prank(bob);
    usdc.transfer(stranger, 1_000e6 - bobBalance);

    vm.warp(block.timestamp + INTERVAL);
    vm.prank(randomCaller);
    factory.settleTab(TAB_ID);

    assertEq(usdc.balanceOf(address(tab)), ALICE_SHARE + bobBalance + CARLA_SHARE);
    assertEq(usdc.balanceOf(bob), 0);
    assertEq(tab.totalSettledByMember(bob), bobBalance);
    assertEq(tab.settlementCount(), 1);
  }

  function testShortfallEmitsTransparentEvents() public {
    vm.prank(bob);
    usdc.approve(address(tab), 0);

    vm.prank(carla);
    usdc.approve(address(tab), 0);

    vm.warp(block.timestamp + INTERVAL);

    vm.expectEmit(true, true, false, true, address(tab));
    emit RecurringTab.MemberSettled(TAB_ID, alice, ALICE_SHARE, true);
    vm.expectEmit(true, true, false, true, address(tab));
    emit RecurringTab.SettlementShortfall(TAB_ID, bob);
    vm.expectEmit(true, true, false, true, address(tab));
    emit RecurringTab.MemberSettled(TAB_ID, bob, 0, false);
    vm.expectEmit(true, true, false, true, address(tab));
    emit RecurringTab.SettlementShortfall(TAB_ID, carla);
    vm.expectEmit(true, true, false, true, address(tab));
    emit RecurringTab.MemberSettled(TAB_ID, carla, 0, false);
    vm.expectEmit(true, false, false, true, address(tab));
    emit RecurringTab.TabSettled(TAB_ID, ALICE_SHARE, block.timestamp);

    vm.prank(randomCaller);
    factory.settleTab(TAB_ID);
  }

  function testApprovalCanBeRevokedBeforeCycle() public {
    vm.prank(alice);
    usdc.approve(address(tab), 0);

    vm.warp(block.timestamp + INTERVAL);
    vm.prank(randomCaller);
    factory.settleTab(TAB_ID);

    assertEq(usdc.balanceOf(owner), 0);
    assertEq(usdc.balanceOf(address(tab)), BOB_SHARE + CARLA_SHARE);
    assertEq(usdc.balanceOf(alice), 1_000e6);
    assertEq(tab.totalSettledByMember(alice), 0);
  }

  function testRecipientClaimsCollectedFunds() public {
    vm.warp(block.timestamp + INTERVAL);
    vm.prank(randomCaller);
    factory.settleTab(TAB_ID);

    uint256 amount = ALICE_SHARE + BOB_SHARE + CARLA_SHARE;
    assertEq(tab.claimable(), amount);
    assertEq(usdc.balanceOf(owner), 0);

    vm.prank(owner);
    tab.claim();

    assertEq(tab.claimable(), 0);
    assertEq(usdc.balanceOf(owner), amount);
  }

  function testOnlyRecipientCanClaimCollectedFunds() public {
    vm.warp(block.timestamp + INTERVAL);
    vm.prank(randomCaller);
    factory.settleTab(TAB_ID);

    vm.prank(randomCaller);
    vm.expectRevert(RecurringTab.OnlyRecipient.selector);
    tab.claim();
  }

  function testSettlementRevertsWhenNoMembersAreCollectible() public {
    uint256 createdAt = tab.createdAt();

    vm.prank(alice);
    usdc.approve(address(tab), 0);
    vm.prank(bob);
    usdc.approve(address(tab), 0);
    vm.prank(carla);
    usdc.approve(address(tab), 0);

    vm.warp(block.timestamp + INTERVAL);
    vm.prank(randomCaller);
    vm.expectRevert(RecurringTab.NoCollectibleMembers.selector);
    factory.settleTab(TAB_ID);

    assertEq(tab.settlementCount(), 0);
    assertEq(tab.nextSettlementAt(), createdAt + INTERVAL * 2);
  }

  function testRecipientCannotBeChangedAfterCreation() public view {
    assertEq(tab.recipient(), owner);
  }

  function testFactoryRejectsDuplicateMembers() public {
    address[] memory members = new address[](2);
    members[0] = alice;
    members[1] = alice;

    uint256[] memory shares = new uint256[](2);
    shares[0] = ALICE_SHARE;
    shares[1] = BOB_SHARE;

    vm.expectRevert(abi.encodeWithSelector(RecurringTab.DuplicateMember.selector, alice));
    factory.createTab(owner, INTERVAL, MAX_SETTLEMENTS, members, shares);
  }

  function testFactoryRejectsInvalidConfiguration() public {
    address[] memory members = new address[](1);
    members[0] = alice;

    uint256[] memory shares = new uint256[](1);
    shares[0] = 0;

    vm.expectRevert(RecurringTab.InvalidConfiguration.selector);
    factory.createTab(owner, INTERVAL, MAX_SETTLEMENTS, members, shares);
  }

  function _fundAndApprove(address account, uint256 amount) private {
    usdc.mint(account, amount);

    vm.prank(account);
    usdc.approve(address(tab), type(uint256).max);
  }
}
