// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

/// @title IERC20
/// @author Splitsy
/// @notice Minimal ERC-20 surface used by {BillSplitRegistry}.
/// @dev Only the four methods the registry actually calls are declared. The
///      mutating methods are declared as returning `bool` so {SafeERC20} can
///      ABI-encode the calls; {SafeERC20} then tolerates tokens that return no
///      data at all, so this declaration is an encoding aid rather than a claim
///      about the token's real signature.
interface IERC20 {
  /// @notice Remaining amount `spender` may pull from `owner`.
  /// @dev Read by {BillSplitRegistry} to bound a mandated collection.
  /// @param owner Account whose tokens would be spent.
  /// @param spender Account permitted to spend them.
  /// @return remaining Amount still approved.
  function allowance(address owner, address spender) external view returns (uint256 remaining);

  /// @notice Token balance of `account`.
  /// @dev Read by {BillSplitRegistry} to bound a mandated collection.
  /// @param account Account to query.
  /// @return balance Token balance held.
  function balanceOf(address account) external view returns (uint256 balance);

  /// @notice Moves `amount` tokens from the caller to `to`.
  /// @dev Always invoked through {SafeERC20.safeTransfer}.
  /// @param to Recipient of the tokens.
  /// @param amount Amount to move.
  /// @return success Whether the transfer succeeded.
  function transfer(address to, uint256 amount) external returns (bool success);

  /// @notice Moves `amount` tokens from `from` to `to` using the caller's allowance.
  /// @dev Always invoked through {SafeERC20.safeTransferFrom}.
  /// @param from Account the tokens are pulled from.
  /// @param to Recipient of the tokens.
  /// @param amount Amount to move.
  /// @return success Whether the transfer succeeded.
  function transferFrom(address from, address to, uint256 amount) external returns (bool success);
}
