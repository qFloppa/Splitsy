// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

/// @title ReentrancyGuard
/// @author Splitsy
/// @notice Module that helps prevent reentrant calls to a function.
/// @dev Inheriting from `ReentrancyGuard` makes the {nonReentrant} modifier
///      available, which can be applied to functions to ensure there are no
///      nested (reentrant) calls to them. A single storage slot is toggled
///      between two non-zero values to keep the runtime gas overhead low while
///      still refunding cleanly after each call.
///
///      The slot is deliberately regular storage rather than transient storage
///      (EIP-1153). Transient storage would be cheaper, but it depends on the
///      target chain having the Cancun opcodes enabled; regular storage is
///      correct everywhere. Swap it only after confirming chain support.
///
///      {_status} is never emitted as an event: it is an internal execution
///      latch, not a state change any observer can act on.
abstract contract ReentrancyGuard {
  /// @dev Sentinel value for "not currently executing a guarded call".
  uint256 private constant _NOT_ENTERED = 1;
  /// @dev Sentinel value for "currently executing a guarded call".
  uint256 private constant _ENTERED = 2;

  /// @dev Tracks whether a `nonReentrant` call is in progress.
  uint256 private _status = _NOT_ENTERED;

  /// @notice Thrown when a `nonReentrant` function is re-entered.
  error ReentrancyGuardReentrantCall();

  /// @notice Blocks a guarded function from being re-entered while it runs.
  /// @dev Blocks a contract from calling itself, directly or indirectly. A
  ///      `nonReentrant` function cannot be re-entered while it is executing,
  ///      including via an external call that calls back into this contract.
  modifier nonReentrant() {
    if (_status == _ENTERED) {
      revert ReentrancyGuardReentrantCall();
    }

    _status = _ENTERED;
    _;
    _status = _NOT_ENTERED;
  }
}
