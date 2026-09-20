// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

interface Vm {
  function addr(uint256 privateKey) external returns (address);

  function chainId(uint256 newChainId) external;

  function clearMockedCalls() external;

  function expectEmit(bool checkTopic1, bool checkTopic2, bool checkTopic3, bool checkData, address emitter)
    external;

  function expectRevert(bytes4 revertData) external;

  function expectRevert(bytes calldata revertData) external;

  function mockCall(address target, bytes calldata data, bytes calldata returnData) external;

  function prank(address caller) external;

  function sign(uint256 privateKey, bytes32 digest) external pure returns (uint8 v, bytes32 r, bytes32 s);

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

  function assertTrue(bool actual, string memory message) internal pure {
    require(actual, message);
  }

  function assertFalse(bool actual) internal pure {
    require(!actual, "assertFalse");
  }
}
