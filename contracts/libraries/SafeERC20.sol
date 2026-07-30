// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {IERC20} from "../interfaces/IERC20.sol";

/// @title SafeERC20
/// @author Splitsy
/// @notice Wrappers around ERC-20 transfer operations that revert on failure.
/// @dev Tokens are not assumed to return a boolean: some widely used tokens
///      (e.g. USDT) return no data on success. A call is therefore treated as
///      successful only when the target has contract code, the low-level call
///      succeeds, and the call either returned no data or returned exactly
///      `true`. Any other outcome reverts with {SafeERC20FailedOperation},
///      closing the silent-failure gap left by checking a raw boolean return.
///
///      Two hardening details worth naming:
///      - The code-length check runs *before* the call, not after. A call to an
///        account with no code succeeds and returns no data, which this wrapper
///        would otherwise read as a successful transfer.
///      - The return value is read out of the 32-byte scratch space with a
///        fixed-size copy instead of being decoded into a `bytes memory`. A
///        hostile token can return megabytes of data; copying it into memory
///        costs the *caller* quadratic memory gas and can strand a transaction
///        (a "return bomb"). Bounding the copy at one word removes that lever.
///        Revert data is likewise never bubbled — it is discarded in favour of
///        {SafeERC20FailedOperation}, which is what this library already did.
library SafeERC20 {
  /// @notice Thrown when an ERC-20 operation does not succeed.
  /// @param token The token whose operation failed.
  error SafeERC20FailedOperation(address token);

  /// @notice Transfers `value` tokens to `to`, reverting on failure.
  /// @dev Delegates to {_callOptionalReturn}, so a token that returns no data
  ///      on success is accepted and one that returns `false` reverts.
  /// @param token The ERC-20 token to transfer.
  /// @param to The recipient of the tokens.
  /// @param value The amount of tokens to transfer.
  function safeTransfer(IERC20 token, address to, uint256 value) internal {
    _callOptionalReturn(token, abi.encodeCall(IERC20.transfer, (to, value)));
  }

  /// @notice Transfers `value` tokens from `from` to `to`, reverting on failure.
  /// @dev Delegates to {_callOptionalReturn}; `from` must have approved the
  ///      calling contract for at least `value`.
  /// @param token The ERC-20 token to transfer.
  /// @param from The account tokens are pulled from.
  /// @param to The recipient of the tokens.
  /// @param value The amount of tokens to transfer.
  function safeTransferFrom(IERC20 token, address from, address to, uint256 value) internal {
    _callOptionalReturn(token, abi.encodeCall(IERC20.transferFrom, (from, to, value)));
  }

  /// @notice Performs a token call and validates its status and return value.
  /// @dev Requires the target to have contract code *before* calling, bounds the
  ///      returndata copy to one word, and accepts either an empty return or a
  ///      32-byte `true`.
  /// @param token The token the call targets.
  /// @param data The ABI-encoded call payload.
  function _callOptionalReturn(IERC20 token, bytes memory data) private {
    address target = address(token);

    // A call to a codeless account always "succeeds" with empty returndata,
    // which is exactly the shape of a successful no-return-value token.
    if (target.code.length == 0) {
      revert SafeERC20FailedOperation(target);
    }

    bool success;
    uint256 returnSize;
    uint256 returnValue;

    // Output is bounded to the 32-byte scratch space at 0x00, so the token
    // cannot force an unbounded returndata copy on us.
    assembly ("memory-safe") {
      success := call(gas(), target, 0, add(data, 0x20), mload(data), 0x00, 0x20)
      returnSize := returndatasize()
      returnValue := mload(0x00)
    }

    if (!success) {
      revert SafeERC20FailedOperation(target);
    }

    // USDT-style token: no return data at all on success.
    if (returnSize == 0) {
      return;
    }

    // Anything shorter than a word is not an ABI-encoded bool; the scratch
    // space would be only partially overwritten and the read would be garbage.
    if (returnSize < 32) {
      revert SafeERC20FailedOperation(target);
    }

    if (returnValue != 1) {
      revert SafeERC20FailedOperation(target);
    }
  }
}
