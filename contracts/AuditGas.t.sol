// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

import {BillSplitRegistry} from "./BillSplitRegistry.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {Test} from "./test/Test.sol";

contract AuditGasTest is Test {
  MockUSDC private usdc;
  BillSplitRegistry private registry;
  address private splitter = address(0x5157);
  address private payer = address(0xBEEF);

  function setUp() public {
    usdc = new MockUSDC();
    registry = new BillSplitRegistry(address(usdc));
    usdc.mint(splitter, 1_000_000e6);
    vm.prank(splitter);
    usdc.approve(address(registry), type(uint256).max);
  }

  /// MAX_BATCH=64 claim legs: the docstring calls this "comfortably inside a block".
  function testGasSettleAtMaxBatch() public {
    uint256 n = registry.MAX_BATCH(); // 64
    uint256[] memory claimIds = new uint256[](n);
    uint256[] memory none = new uint256[](0);

    // 64 bills where `splitter` is the creator, each with one funded participant.
    for (uint256 i = 0; i < n; ++i) {
      address[] memory p = new address[](1);
      uint256[] memory a = new uint256[](1);
      p[0] = address(uint160(0x2000 + i));
      a[0] = 1e6;
      vm.prank(splitter);
      uint256 id = registry.createBill(bytes32("b"), p, a, 0, false);
      claimIds[i] = id;
      // fund it so there is something to claim
      usdc.mint(p[0], 1e6);
      vm.prank(p[0]);
      usdc.approve(address(registry), type(uint256).max);
      vm.prank(p[0]);
      registry.payDebt(id, 1e6);
    }

    vm.prank(splitter);
    uint256 before = gasleft();
    registry.settle(claimIds, none, none);
    uint256 used = before - gasleft();

    // Measured at ~2.03M for 64 claim legs — a fifteenth of a 30M block, which
    // is what the MAX_BATCH docstring's "comfortably inside a block" claims.
    // A regression tripwire, not a target: only move it with a fresh number.
    require(used < 4_000_000, "settle(64 claims) gas regressed");
  }
}
