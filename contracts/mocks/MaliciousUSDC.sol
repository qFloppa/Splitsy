// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

/// @notice A 6-decimal token that re-enters a configured target once, from
///         inside `transfer` or `transferFrom`.
/// @dev Exists to prove the v2 reentrancy story. The real risk in v2 is not USDC
///      itself but that {BillSplitRegistry.settle} and
///      {BillSplitRegistry.collectDebt} call the shared internals in a loop, so a
///      token with a callback gets N chances rather than one. The reentrant call
///      records its revert reason instead of bubbling it: {SafeERC20} converts
///      any failed token call into `SafeERC20FailedOperation`, which would hide
///      *why* the reentry failed. Recording the selector lets a test assert the
///      reentrancy guard specifically fired, rather than merely observing that
///      nothing bad happened.
contract MaliciousUSDC {
  string public constant name = "Malicious USDC";
  string public constant symbol = "USDC";
  uint8 public constant decimals = 6;

  mapping(address account => uint256 balance) public balanceOf;
  mapping(address owner => mapping(address spender => uint256 amount)) public allowance;

  event Approval(address indexed owner, address indexed spender, uint256 amount);
  event Transfer(address indexed from, address indexed to, uint256 amount);

  address private attackTarget;
  bytes private attackData;
  bool private armed;

  /// @notice Whether the re-entrant call has been attempted yet.
  bool public reentryAttempted;
  /// @notice Whether the re-entrant call reverted.
  bool public reentryReverted;
  /// @notice Error selector the re-entrant call reverted with, if any.
  bytes4 public reentryRevertSelector;

  /// @notice Arms a single re-entrant call into `target` with `data`.
  function arm(address target, bytes calldata data) external {
    attackTarget = target;
    attackData = data;
    armed = true;
  }

  function mint(address to, uint256 amount) external {
    balanceOf[to] += amount;
    emit Transfer(address(0), to, amount);
  }

  function approve(address spender, uint256 amount) external returns (bool) {
    allowance[msg.sender][spender] = amount;
    emit Approval(msg.sender, spender, amount);
    return true;
  }

  function transfer(address to, uint256 amount) external returns (bool) {
    _transfer(msg.sender, to, amount);
    _fire();
    return true;
  }

  function transferFrom(address from, address to, uint256 amount) external returns (bool) {
    uint256 allowed = allowance[from][msg.sender];
    require(allowed >= amount, "ALLOWANCE");

    if (allowed != type(uint256).max) {
      allowance[from][msg.sender] = allowed - amount;
    }

    _transfer(from, to, amount);
    _fire();
    return true;
  }

  function _transfer(address from, address to, uint256 amount) private {
    require(to != address(0), "ZERO_TO");
    require(balanceOf[from] >= amount, "BALANCE");

    balanceOf[from] -= amount;
    balanceOf[to] += amount;

    emit Transfer(from, to, amount);
  }

  /// @dev Fires the armed callback exactly once, recording the outcome rather
  ///      than bubbling it. A reverting reentry must not fail the outer call, or
  ///      the test could not tell "the guard blocked it" apart from "the token
  ///      transfer failed".
  function _fire() private {
    if (!armed) {
      return;
    }

    armed = false;
    reentryAttempted = true;

    (bool ok, bytes memory reason) = attackTarget.call(attackData);

    reentryReverted = !ok;

    if (!ok && reason.length >= 4) {
      reentryRevertSelector = bytes4(reason);
    }
  }
}
