// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "./interfaces/IERC20.sol";
import {SafeERC20} from "./libraries/SafeERC20.sol";
import {ReentrancyGuard} from "./security/ReentrancyGuard.sol";

/// @title BillSplitRegistry
/// @notice Registry for splitting a bill across participants who each repay
///         their share in USDC, while the bill's creator (the "splitter")
///         claims the collected funds.
/// @dev Accounting is tracked per bill and the contract custodies USDC only
///      between payment and claim. Security properties:
///      - All fund-moving entrypoints follow checks-effects-interactions and are
///        additionally protected by {ReentrancyGuard}.
///      - Token movements go through {SafeERC20}, so a token that returns no
///        data or `false` can never be mistaken for a successful transfer.
///      - The contract holds no privileged owner and exposes no upgrade,
///        pause, sweep, or `selfdestruct` path; funds can only ever leave via
///        {claim} to the bill's own splitter.
contract BillSplitRegistry is ReentrancyGuard {
  using SafeERC20 for IERC20;

  /// @notice Thrown when the same participant is added to a bill twice.
  error AlreadyParticipant(uint256 billId, address participant);
  /// @notice Thrown when a splitter tries to claim more than is available.
  error ClaimExceedsBalance();
  /// @notice Thrown when a payment is zero or exceeds the caller's remaining debt.
  error InvalidAmount();
  /// @notice Thrown when bill inputs (arrays, addresses or amounts) are invalid.
  error InvalidConfiguration();
  /// @notice Thrown when a non-participant attempts to pay a bill.
  error NotParticipant(uint256 billId, address participant);
  /// @notice Thrown when a non-splitter attempts to claim a bill's funds.
  error NotSplitter(uint256 billId, address caller);
  /// @notice Thrown when a bill's participant count would exceed {MAX_PARTICIPANTS}.
  error TooManyParticipants(uint256 provided, uint256 maximum);
  /// @notice Thrown when an action references a bill that does not exist.
  error UnknownBill(uint256 billId);

  /// @notice Emitted when a new bill is created.
  event BillCreated(uint256 indexed billId, address indexed splitter, bytes32 indexed metadataHash, uint256 totalOwed);
  /// @notice Emitted when a participant pays toward their debt.
  event DebtPaid(uint256 indexed billId, address indexed payer, uint256 amount, uint256 paidTotal, uint256 owedTotal);
  /// @notice Emitted when a splitter claims collected funds.
  event FundsClaimed(uint256 indexed billId, address indexed splitter, uint256 amount);

  /// @notice Per-participant debt accounting within a bill.
  /// @param owed Total amount the participant must repay.
  /// @param paid Amount the participant has repaid so far.
  /// @param exists Whether the participant belongs to the bill.
  struct Participant {
    uint256 owed;
    uint256 paid;
    bool exists;
  }

  /// @notice Aggregate state for a single bill.
  /// @param splitter Creator entitled to claim collected funds.
  /// @param metadataHash Opaque hash describing the bill off-chain.
  /// @param totalOwed Sum of all participants' owed amounts.
  /// @param totalPaid Sum of all participants' payments.
  /// @param claimed Amount already withdrawn by the splitter.
  /// @param exists Whether the bill has been created.
  /// @param participantList Ordered list of participant addresses.
  struct Bill {
    address splitter;
    bytes32 metadataHash;
    uint256 totalOwed;
    uint256 totalPaid;
    uint256 claimed;
    bool exists;
    address[] participantList;
  }

  /// @notice Maximum number of participants permitted in a single bill.
  /// @dev Bounds the `createBill` loop so creation can never be pushed past the
  ///      block gas limit, and keeps each bill's `participantList` enumerable.
  uint256 public constant MAX_PARTICIPANTS = 256;

  /// @notice The USDC token used for every payment and claim.
  IERC20 public immutable usdc;

  /// @notice Identifier that will be assigned to the next created bill.
  uint256 public nextBillId = 1;

  mapping(uint256 billId => Bill bill) private bills;
  mapping(uint256 billId => mapping(address participantAddress => Participant participantData)) private participants;
  mapping(address participant => uint256[] billIds) private billsByParticipant;
  mapping(address splitter => uint256[] billIds) private billsBySplitter;

  /// @param usdc_ Address of the USDC token contract; must be non-zero.
  constructor(address usdc_) {
    if (usdc_ == address(0)) {
      revert InvalidConfiguration();
    }

    usdc = IERC20(usdc_);
  }

  /// @notice Creates a bill and records each participant's owed amount.
  /// @dev Participant addresses must be non-zero and unique within the bill, and
  ///      every owed amount must be non-zero. Reverts if more than
  ///      {MAX_PARTICIPANTS} are supplied.
  /// @param metadataHash Opaque hash describing the bill off-chain.
  /// @param participantAddresses Participant addresses, aligned 1:1 with `owedAmounts`.
  /// @param owedAmounts Amount owed by each participant.
  /// @return billId Identifier of the newly created bill.
  function createBill(
    bytes32 metadataHash,
    address[] calldata participantAddresses,
    uint256[] calldata owedAmounts
  ) external returns (uint256 billId) {
    uint256 count = participantAddresses.length;

    if (count == 0 || count != owedAmounts.length) {
      revert InvalidConfiguration();
    }

    if (count > MAX_PARTICIPANTS) {
      revert TooManyParticipants(count, MAX_PARTICIPANTS);
    }

    billId = nextBillId++;
    Bill storage bill = bills[billId];
    bill.splitter = msg.sender;
    bill.metadataHash = metadataHash;
    bill.exists = true;

    uint256 runningTotal = 0;

    for (uint256 i = 0; i < count;) {
      address participantAddress = participantAddresses[i];
      uint256 owedAmount = owedAmounts[i];

      if (participantAddress == address(0) || owedAmount == 0) {
        revert InvalidConfiguration();
      }

      if (participants[billId][participantAddress].exists) {
        revert AlreadyParticipant(billId, participantAddress);
      }

      participants[billId][participantAddress] = Participant({owed: owedAmount, paid: 0, exists: true});
      bill.participantList.push(participantAddress);
      billsByParticipant[participantAddress].push(billId);
      runningTotal += owedAmount;

      unchecked {
        ++i;
      }
    }

    bill.totalOwed = runningTotal;
    billsBySplitter[msg.sender].push(billId);

    emit BillCreated(billId, msg.sender, metadataHash, runningTotal);
  }

  /// @notice Pays `amount` toward the caller's debt on `billId`.
  /// @dev The caller must have approved this contract for at least `amount` of
  ///      USDC. State is updated before the token transfer and the call is
  ///      guarded against reentrancy.
  /// @param billId Identifier of the bill being paid.
  /// @param amount USDC amount to pay; non-zero and at most the remaining debt.
  function payDebt(uint256 billId, uint256 amount) external nonReentrant {
    Bill storage bill = _billOrRevert(billId);
    Participant storage participant = participants[billId][msg.sender];

    if (!participant.exists) {
      revert NotParticipant(billId, msg.sender);
    }

    uint256 remaining = participant.owed - participant.paid;

    if (amount == 0 || amount > remaining) {
      revert InvalidAmount();
    }

    // Effects (including the event) precede the interaction; a failed transfer
    // reverts the whole call, so the log can never describe an unpaid debt.
    participant.paid += amount;
    bill.totalPaid += amount;
    emit DebtPaid(billId, msg.sender, amount, participant.paid, participant.owed);

    usdc.safeTransferFrom(msg.sender, address(this), amount);
  }

  /// @notice Claims `amount` of collected funds from `billId` to the splitter.
  /// @dev Only the bill's splitter may claim, and never more than the amount
  ///      paid in but not yet withdrawn. Guarded against reentrancy.
  /// @param billId Identifier of the bill to claim from.
  /// @param amount USDC amount to claim; non-zero and at most {claimable}.
  function claim(uint256 billId, uint256 amount) external nonReentrant {
    Bill storage bill = _billOrRevert(billId);

    if (msg.sender != bill.splitter) {
      revert NotSplitter(billId, msg.sender);
    }

    uint256 claimableAmount = bill.totalPaid - bill.claimed;

    if (amount == 0 || amount > claimableAmount) {
      revert ClaimExceedsBalance();
    }

    // Effects (including the event) precede the interaction; a failed transfer
    // reverts the whole call, so the log can never describe an unfunded claim.
    bill.claimed += amount;
    emit FundsClaimed(billId, msg.sender, amount);

    usdc.safeTransfer(msg.sender, amount);
  }

  /// @notice Returns the amount paid into `billId` that the splitter has not yet claimed.
  /// @param billId Identifier of the bill to query.
  /// @return amount Claimable USDC balance for the bill.
  function claimable(uint256 billId) external view returns (uint256 amount) {
    Bill storage bill = _billOrRevert(billId);
    return bill.totalPaid - bill.claimed;
  }

  /// @notice Returns the stored details of `billId`.
  /// @param billId Identifier of the bill to query.
  /// @return splitter Creator entitled to claim funds.
  /// @return metadataHash Opaque off-chain metadata hash.
  /// @return totalOwed Sum of all participants' owed amounts.
  /// @return totalPaid Sum of all payments received.
  /// @return claimed Amount already withdrawn by the splitter.
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
      address[] memory participantList
    )
  {
    Bill storage bill = _billOrRevert(billId);
    return (
      bill.splitter,
      bill.metadataHash,
      bill.totalOwed,
      bill.totalPaid,
      bill.claimed,
      bill.participantList
    );
  }

  /// @notice Returns the debt record for `participantAddress` on `billId`.
  /// @param billId Identifier of the bill to query.
  /// @param participantAddress Participant whose record is requested.
  /// @return owed Total amount the participant must repay.
  /// @return paid Amount the participant has repaid so far.
  /// @return exists Whether the participant belongs to the bill.
  function getParticipant(uint256 billId, address participantAddress)
    external
    view
    returns (uint256 owed, uint256 paid, bool exists)
  {
    Participant storage participant = participants[billId][participantAddress];
    return (participant.owed, participant.paid, participant.exists);
  }

  /// @notice Lists every bill `participantAddress` owes a share of.
  /// @param participantAddress Address to look up.
  /// @return billIds Identifiers of bills the address participates in.
  function billIdsForParticipant(address participantAddress) external view returns (uint256[] memory billIds) {
    return billsByParticipant[participantAddress];
  }

  /// @notice Lists every bill created by `splitter`.
  /// @param splitter Address to look up.
  /// @return billIds Identifiers of bills the address created.
  function billIdsForSplitter(address splitter) external view returns (uint256[] memory billIds) {
    return billsBySplitter[splitter];
  }

  /// @dev Loads `billId` from storage, reverting with {UnknownBill} if absent.
  /// @param billId Identifier of the bill to load.
  /// @return bill Storage reference to the bill.
  function _billOrRevert(uint256 billId) private view returns (Bill storage bill) {
    bill = bills[billId];

    if (!bill.exists) {
      revert UnknownBill(billId);
    }
  }
}
