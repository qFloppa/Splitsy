// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

/// @title IBillSplitRegistry
/// @author Splitsy
/// @notice The three {BillSplitRegistry} entrypoints {AutopayMandate} needs.
/// @dev Deliberately minimal. The mandate contract is a thin, permissioned front
///      door to an *already deployed* registry, so this interface exists to let
///      it call one without importing — or being able to redeploy — the whole
///      thing. The registry address is `immutable` on the mandate, so this
///      interface is never pointed at a caller-supplied contract.
interface IBillSplitRegistry {
  /// @notice Returns the stored details of `billId`.
  /// @dev Only `splitter` is read by {AutopayMandate}, for its creator
  ///      allowlist, but the full tuple has to be declared to decode the return.
  /// @param billId Identifier of the bill to query.
  /// @return splitter Creator entitled to claim funds.
  /// @return metadataHash Opaque off-chain metadata hash.
  /// @return totalOwed Sum of all participants' owed amounts.
  /// @return totalPaid Sum of all payments received.
  /// @return claimed Amount already withdrawn by the splitter.
  /// @return dueDate Unix seconds after which the bill is collectible; 0 for none.
  /// @return escrowUntilFull Whether claims are withheld until the bill is fully paid.
  /// @return participantList Ordered list of participant addresses.
  function getBill(uint256 billId)
    external
    view
    returns (
      address splitter,
      bytes32 metadataHash,
      uint256 totalOwed,
      uint256 totalPaid,
      uint256 claimed,
      uint64 dueDate,
      bool escrowUntilFull,
      address[] memory participantList
    );

  /// @notice Returns one participant's position on `billId`.
  /// @param billId Identifier of the bill to query.
  /// @param participantAddress Participant to look up.
  /// @return owed That participant's share.
  /// @return paid How much of it they have settled.
  /// @return exists Whether they are a participant at all.
  function getParticipant(uint256 billId, address participantAddress)
    external
    view
    returns (uint256 owed, uint256 paid, bool exists);

  /// @notice Pays `amount` toward `debtor`'s debt on `billId`, funded by the caller.
  /// @dev Pulls the caller's own USDC under the caller's approval, and emits
  ///      `DebtPaid` naming `debtor` as the payer — which is what keeps the
  ///      existing reputation indexer working when the mandate is the funder.
  /// @param billId Identifier of the bill being paid.
  /// @param debtor Participant whose debt is credited.
  /// @param amount USDC amount to pay.
  function payDebtFor(uint256 billId, address debtor, uint256 amount) external;
}
