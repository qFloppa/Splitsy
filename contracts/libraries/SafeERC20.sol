// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "../interfaces/IERC20.sol";

/// @title SafeERC20
/// @notice Wrappers around ERC-20 transfer operations that revert on failure.
/// @dev Tokens are not assumed to return a boolean: some widely used tokens
///      (e.g. USDT) return no data on success. A call is therefore treated as
///      successful only when the low-level call succeeds, the target has
///      contract code, and the call either returned no data or returned `true`.
///      Any other outcome reverts with {SafeERC20FailedOperation}, closing the
///      silent-failure gap left by checking a raw boolean return value.
library SafeERC20 {
  /// @notice Thrown when an ERC-20 operation does not succeed.
  /// @param token The token whose operation failed.
  error SafeERC20FailedOperation(address token);

  /// @notice Transfers `value` tokens to `to`, reverting on failure.
  /// @param token The ERC-20 token to transfer.
  /// @param to The recipient of the tokens.
  /// @param value The amount of tokens to transfer.
  function safeTransfer(IERC20 token, address to, uint256 value) internal {
    _callOptionalReturn(token, abi.encodeCall(IERC20.transfer, (to, value)));
  }

  /// @notice Transfers `value` tokens from `from` to `to`, reverting on failure.
  /// @param token The ERC-20 token to transfer.
  /// @param from The account tokens are pulled from.
  /// @param to The recipient of the tokens.
  /// @param value The amount of tokens to transfer.
  function safeTransferFrom(IERC20 token, address from, address to, uint256 value) internal {
    _callOptionalReturn(token, abi.encodeCall(IERC20.transferFrom, (from, to, value)));
  }

  /// @dev Performs a low-level call and validates both the call status and any
  ///      returned data, treating an empty return as success. Requires the
  ///      target to have contract code so a call to an account without code
  ///      cannot be mistaken for a successful transfer.
  /// @param token The token the call targets.
  /// @param data The ABI-encoded call payload.
  function _callOptionalReturn(IERC20 token, bytes memory data) private {
    (bool success, bytes memory returndata) = address(token).call(data);

    if (!success || (returndata.length != 0 && !abi.decode(returndata, (bool))) || address(token).code.length == 0) {
      revert SafeERC20FailedOperation(address(token));
    }
  }
}
