// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "./interfaces/IERC20.sol";
import {SafeERC20} from "./libraries/SafeERC20.sol";
import {ReentrancyGuard} from "./security/ReentrancyGuard.sol";

/// @title RecurringTab
/// @notice A single recurring tab: a fixed group of members each owe a fixed
///         per-cycle share, which anyone may "settle" (pull) into the tab once a
///         cycle has elapsed; the immutable recipient then withdraws the funds.
/// @dev Security model and invariants:
///      - Membership and per-member shares are fixed at construction and can
///        never change, so the `from` address and the amount of every pull are
///        predetermined — they are not attacker-controlled even though anyone
///        may trigger {settleTab}.
///      - A member can never be charged more than `fixedShare * maxSettlements`
///        in total: each settlement is capped to the member's outstanding,
///        schedule-derived due and to their own allowance and balance. Members
///        opt in by approving this contract and bound their exposure with that
///        allowance.
///      - Collected funds are custodied here and can only ever be withdrawn by
///        the immutable `recipient` via {claim}.
///      - {settleTab} and {claim} are {ReentrancyGuard}-protected and follow
///        checks-effects-interactions; all token movement uses {SafeERC20}.
///      - Time is measured in whole `settlementInterval` cycles. With intervals
///        on the order of days, the few seconds of block-timestamp drift a
///        proposer could introduce cannot change the accrued-cycle count.
contract RecurringTab is ReentrancyGuard {
  using SafeERC20 for IERC20;

  /// @notice Thrown when settlement is attempted before a new cycle has accrued.
  error AlreadySettledForPeriod();
  /// @notice Thrown when the same member address is supplied twice at construction.
  error DuplicateMember(address member);
  /// @notice Thrown when construction parameters are invalid.
  error InvalidConfiguration();
  /// @notice Thrown when members are due but nothing could be collected.
  error NoCollectibleMembers();
  /// @notice Thrown when the recipient claims with a zero balance.
  error NothingToClaim();
  /// @notice Thrown when a non-recipient attempts to claim.
  error OnlyRecipient();
  /// @notice Thrown when settlement is attempted after the schedule is complete.
  error TabComplete();

  /// @notice Emitted for each member processed during a settlement (success flags collection).
  event MemberSettled(uint256 indexed tabId, address indexed member, uint256 amount, bool success);
  /// @notice Emitted when the recipient withdraws collected funds.
  event FundsClaimed(uint256 indexed tabId, address indexed recipient, uint256 amount);
  /// @notice Emitted when a member could not fully cover their due for a settlement.
  event SettlementShortfall(uint256 indexed tabId, address indexed member);
  /// @notice Emitted once per settlement with the total amount collected.
  event TabSettled(uint256 indexed tabId, uint256 totalAmount, uint256 timestamp);

  /// @notice USDC token collected from members and paid to the recipient.
  IERC20 public immutable usdc;
  /// @notice Factory that deployed this tab.
  address public immutable factory;
  /// @notice Identifier assigned by the factory.
  uint256 public immutable tabId;
  /// @notice Sole address entitled to claim collected funds.
  address public immutable recipient;
  /// @notice Seconds between settlement cycles.
  uint256 public immutable settlementInterval;
  /// @notice Maximum number of cycles that can ever be settled.
  uint256 public immutable maxSettlements;
  /// @notice Timestamp the tab was created (cycle epoch).
  uint256 public immutable createdAt;

  /// @notice Timestamp of the last fully accrued cycle boundary that was settled.
  uint256 public lastSettledAt;
  /// @notice Number of cycles settled so far.
  uint256 public settlementCount;
  /// @notice Collected funds awaiting withdrawal by the recipient.
  uint256 public claimable;

  address[] private memberList;

  /// @notice Whether an address is a member of this tab.
  mapping(address member => bool memberStatus) public isMember;
  /// @notice Per-cycle amount each member owes.
  mapping(address member => uint256 share) public fixedShare;
  /// @notice Cumulative amount collected from each member across all cycles.
  mapping(address member => uint256 amount) public totalSettledByMember;

  /// @param tabId_ Identifier assigned by the factory.
  /// @param usdc_ USDC token address; must be non-zero.
  /// @param recipient_ Address entitled to claim collected funds; must be non-zero.
  /// @param settlementInterval_ Seconds between cycles; must be non-zero.
  /// @param maxSettlements_ Maximum number of cycles that can be settled; must be non-zero.
  /// @param members_ Member addresses; non-zero, unique, aligned 1:1 with `fixedShares_`.
  /// @param fixedShares_ Per-cycle amount owed by each member; each must be non-zero.
  constructor(
    uint256 tabId_,
    address usdc_,
    address recipient_,
    uint256 settlementInterval_,
    uint256 maxSettlements_,
    address[] memory members_,
    uint256[] memory fixedShares_
  ) {
    uint256 memberTotal = members_.length;

    if (
      usdc_ == address(0) ||
      recipient_ == address(0) ||
      settlementInterval_ == 0 ||
      maxSettlements_ == 0 ||
      memberTotal == 0 ||
      memberTotal != fixedShares_.length
    ) {
      revert InvalidConfiguration();
    }

    tabId = tabId_;
    usdc = IERC20(usdc_);
    factory = msg.sender;
    recipient = recipient_;
    settlementInterval = settlementInterval_;
    maxSettlements = maxSettlements_;
    createdAt = block.timestamp;
    lastSettledAt = block.timestamp;

    for (uint256 i = 0; i < memberTotal;) {
      address member = members_[i];
      uint256 share = fixedShares_[i];

      if (member == address(0) || share == 0) {
        revert InvalidConfiguration();
      }

      if (isMember[member]) {
        revert DuplicateMember(member);
      }

      isMember[member] = true;
      fixedShare[member] = share;
      memberList.push(member);

      unchecked {
        ++i;
      }
    }
  }

  /// @notice Returns the full member list.
  function members() external view returns (address[] memory) {
    return memberList;
  }

  /// @notice Returns the number of members.
  function memberCount() external view returns (uint256) {
    return memberList.length;
  }

  /// @notice Returns the timestamp of the next settleable cycle boundary, or 0
  ///         once the schedule is complete.
  function nextSettlementAt() external view returns (uint256) {
    if (settlementCount >= maxSettlements) {
      return 0;
    }

    uint256 elapsedCycles = (block.timestamp - createdAt) / settlementInterval;
    if (elapsedCycles >= maxSettlements) {
      return 0;
    }

    return createdAt + settlementInterval * (elapsedCycles + 1);
  }

  /// @notice Settles every member for all cycles that have accrued since the last
  ///         settlement, pulling each member's outstanding due (capped by their
  ///         allowance and balance) into the tab. Callable by anyone.
  /// @dev Reverts with {AlreadySettledForPeriod} before a new cycle accrues,
  ///      {TabComplete} once the schedule is exhausted, or {NoCollectibleMembers}
  ///      when members are due but nothing can be collected. The per-member work
  ///      (including the effects-before-interaction token pull) is delegated to
  ///      {_settleMember}; this function only aggregates the results.
  // settleTab is nonReentrant, so reentry is impossible; the only state written
  // after the per-member pulls are an additive accumulator (`claimable`) and the
  // schedule counters, making those orderings benign.
  // slither-disable-next-line reentrancy-benign,reentrancy-balance
  function settleTab() public nonReentrant {
    uint256 scheduledCycles = (block.timestamp - createdAt) / settlementInterval;
    uint256 accruedCycles = scheduledCycles > maxSettlements ? maxSettlements : scheduledCycles;

    // Zero-comparison on a derived whole-cycle count (not a token balance) — safe.
    // slither-disable-next-line incorrect-equality
    if (accruedCycles == 0) {
      revert AlreadySettledForPeriod();
    }

    uint256 memberTotal = memberList.length;
    uint256 totalSettled = 0;
    bool hasDueMember = false;

    for (uint256 i = 0; i < memberTotal;) {
      (uint256 collected, bool wasDue) = _settleMember(memberList[i], accruedCycles);

      if (wasDue) {
        hasDueMember = true;
      }
      totalSettled += collected;

      unchecked {
        ++i;
      }
    }

    if (!hasDueMember) {
      if (settlementCount >= maxSettlements) {
        revert TabComplete();
      }

      revert AlreadySettledForPeriod();
    }

    // Zero-comparison on an internal accumulator (not a token balance) — safe.
    // slither-disable-next-line incorrect-equality
    if (totalSettled == 0) {
      revert NoCollectibleMembers();
    }

    if (accruedCycles > settlementCount) {
      settlementCount = accruedCycles;
      // accruedCycles is an exact whole-cycle count; multiplying it back by the
      // interval reconstructs the cycle boundary, so the prior flooring is intended.
      // slither-disable-next-line divide-before-multiply
      lastSettledAt = createdAt + settlementInterval * accruedCycles;
    }

    claimable += totalSettled;
    emit TabSettled(tabId, totalSettled, block.timestamp);
  }

  /// @notice Withdraws all collected funds to the recipient.
  /// @dev Only the immutable recipient may call. The balance is zeroed before the
  ///      transfer (checks-effects-interactions) and the call is reentrancy-guarded.
  function claim() external nonReentrant {
    if (msg.sender != recipient) {
      revert OnlyRecipient();
    }

    uint256 amount = claimable;
    if (amount == 0) {
      revert NothingToClaim();
    }

    // Effects (including the event) precede the interaction.
    claimable = 0;
    emit FundsClaimed(tabId, recipient, amount);

    usdc.safeTransfer(recipient, amount);
  }

  /// @dev Settles a single member for `accruedCycles`: derives the outstanding
  ///      schedule due, caps it to the member's allowance and balance, records
  ///      the collection (effect) and then pulls the funds (interaction). Routing
  ///      the pull through {SafeERC20} keeps the recorded state and the funds in
  ///      lock-step, since any failed pull reverts the whole settlement.
  /// @param member Member to settle.
  /// @param accruedCycles Number of cycles currently being settled.
  /// @return collected Amount actually pulled from the member.
  /// @return wasDue Whether the member still owed anything for these cycles.
  function _settleMember(address member, uint256 accruedCycles)
    private
    returns (uint256 collected, bool wasDue)
  {
    uint256 accruedDue = fixedShare[member] * accruedCycles;
    uint256 settledSoFar = totalSettledByMember[member];

    if (settledSoFar >= accruedDue) {
      return (0, false);
    }

    uint256 amountDue = accruedDue - settledSoFar;
    uint256 collectibleAmount =
      _min(amountDue, _min(usdc.allowance(member, address(this)), usdc.balanceOf(member)));

    // Zero-comparison on a computed min() (not a raw token balance) — safe.
    // slither-disable-next-line incorrect-equality
    if (collectibleAmount == 0) {
      emit SettlementShortfall(tabId, member);
      emit MemberSettled(tabId, member, 0, false);
      return (0, true);
    }

    if (collectibleAmount < amountDue) {
      emit SettlementShortfall(tabId, member);
    }

    // Effects before interaction: record the collection and log it, then pull.
    totalSettledByMember[member] = settledSoFar + collectibleAmount;
    emit MemberSettled(tabId, member, collectibleAmount, true);

    // `from` is a member rather than msg.sender by design: this is pull-based
    // recurring billing. It is safe because members and shares are immutable,
    // each member opts in via their own approval, the cumulative charge is capped
    // at fixedShare*maxSettlements, and funds can only ever leave to the immutable
    // recipient.
    // slither-disable-next-line arbitrary-send-erc20
    usdc.safeTransferFrom(member, address(this), collectibleAmount);

    return (collectibleAmount, true);
  }

  /// @dev Returns the smaller of two values.
  function _min(uint256 a, uint256 b) private pure returns (uint256) {
    return a < b ? a : b;
  }
}
