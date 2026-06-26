// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface Vm {
  function expectEmit(bool checkTopic1, bool checkTopic2, bool checkTopic3, bool checkData, address emitter)
    external;

  function expectRevert(bytes4 revertData) external;

  function expectRevert(bytes calldata revertData) external;

  function prank(address caller) external;

  function warp(uint256 timestamp) external;
}

contract Test {
  Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

  function assertEq(address actual, address expected) internal pure {
    require(actual == expected, "assertEq(address)");
  }

  function assertEq(uint256 actual, uint256 expected) internal pure {
    require(actual == expected, "assertEq(uint256)");
  }

  function assertEq(uint256 actual, uint256 expected, string memory message) internal pure {
    require(actual == expected, message);
  }

  function assertTrue(bool actual) internal pure {
    require(actual, "assertTrue");
  }

  function assertFalse(bool actual) internal pure {
    require(!actual, "assertFalse");
  }
}
