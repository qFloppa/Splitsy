// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title ReentrancyGuard
/// @notice Module that helps prevent reentrant calls to a function.
/// @dev Inheriting from `ReentrancyGuard` makes the {nonReentrant} modifier
///      available, which can be applied to functions to ensure there are no
///      nested (reentrant) calls to them. A single storage slot is toggled
///      between two non-zero values to keep the runtime gas overhead low while
///      still refunding cleanly after each call.
abstract contract ReentrancyGuard {
  /// @dev Sentinel value for "not currently executing a guarded call".
  uint256 private constant _NOT_ENTERED = 1;
  /// @dev Sentinel value for "currently executing a guarded call".
  uint256 private constant _ENTERED = 2;

  /// @dev Tracks whether a `nonReentrant` call is in progress.
  uint256 private _status = _NOT_ENTERED;

  /// @notice Thrown when a `nonReentrant` function is re-entered.
  error ReentrancyGuardReentrantCall();

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
