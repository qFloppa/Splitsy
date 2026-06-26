// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "./interfaces/IERC20.sol";

contract RecurringTab {
  error AlreadySettledForPeriod();
  error DuplicateMember(address member);
  error InvalidConfiguration();
  error MemberPaymentFailed(address member);
  error NoCollectibleMembers();
  error NothingToClaim();
  error OnlyRecipient();
  error TabComplete();

  event MemberSettled(uint256 indexed tabId, address indexed member, uint256 amount, bool success);
  event FundsClaimed(uint256 indexed tabId, address indexed recipient, uint256 amount);
  event SettlementShortfall(uint256 indexed tabId, address indexed member);
  event TabSettled(uint256 indexed tabId, uint256 totalAmount, uint256 timestamp);

  IERC20 public immutable usdc;
  address public immutable factory;
  uint256 public immutable tabId;
  address public immutable recipient;
  uint256 public immutable settlementInterval;
  uint256 public immutable maxSettlements;
  uint256 public immutable createdAt;

  uint256 public lastSettledAt;
  uint256 public settlementCount;
  uint256 public claimable;
  address[] private memberList;
  bool private locked;

  mapping(address member => bool memberStatus) public isMember;
  mapping(address member => uint256 share) public fixedShare;
  mapping(address member => uint256 amount) public totalSettledByMember;

  modifier nonReentrant() {
    require(!locked, "REENTRANT");
    locked = true;
    _;
    locked = false;
  }

  constructor(
    uint256 tabId_,
    address usdc_,
    address recipient_,
    uint256 settlementInterval_,
    uint256 maxSettlements_,
    address[] memory members_,
    uint256[] memory fixedShares_
  ) {
    if (
      usdc_ == address(0) ||
      recipient_ == address(0) ||
      settlementInterval_ == 0 ||
      maxSettlements_ == 0 ||
      members_.length == 0 ||
      members_.length != fixedShares_.length
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
    lastSettledAt = createdAt;

    for (uint256 i = 0; i < members_.length; i++) {
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
    }
  }

  function members() external view returns (address[] memory) {
    return memberList;
  }

  function memberCount() external view returns (uint256) {
    return memberList.length;
  }

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

  function settleTab() public nonReentrant {
    uint256 scheduledCycles = (block.timestamp - createdAt) / settlementInterval;
    uint256 accruedCycles = scheduledCycles > maxSettlements ? maxSettlements : scheduledCycles;

    if (accruedCycles == 0) {
      revert AlreadySettledForPeriod();
    }

    uint256 totalSettled = 0;
    bool hasDueMember = false;

    for (uint256 i = 0; i < memberList.length; i++) {
      address member = memberList[i];
      uint256 accruedDue = fixedShare[member] * accruedCycles;

      if (totalSettledByMember[member] >= accruedDue) {
        continue;
      }

      uint256 amountDue = accruedDue - totalSettledByMember[member];
      uint256 collectibleAmount = _min(amountDue, _min(usdc.allowance(member, address(this)), usdc.balanceOf(member)));
      hasDueMember = true;

      if (collectibleAmount == 0) {
        emit SettlementShortfall(tabId, member);
        emit MemberSettled(tabId, member, 0, false);
        continue;
      }

      if (collectibleAmount < amountDue) {
        emit SettlementShortfall(tabId, member);
      }

      totalSettled += collectibleAmount;

      if (!usdc.transferFrom(member, address(this), collectibleAmount)) {
        revert MemberPaymentFailed(member);
      }

      totalSettledByMember[member] += collectibleAmount;
      emit MemberSettled(tabId, member, collectibleAmount, true);
    }

    if (!hasDueMember) {
      if (settlementCount >= maxSettlements) {
        revert TabComplete();
      }

      revert AlreadySettledForPeriod();
    }

    if (totalSettled == 0) {
      revert NoCollectibleMembers();
    }

    if (accruedCycles > settlementCount) {
      settlementCount = accruedCycles;
      lastSettledAt = createdAt + settlementInterval * accruedCycles;
    }

    claimable += totalSettled;
    emit TabSettled(tabId, totalSettled, block.timestamp);
  }

  function _min(uint256 a, uint256 b) private pure returns (uint256) {
    return a < b ? a : b;
  }

  function claim() external nonReentrant {
    if (msg.sender != recipient) {
      revert OnlyRecipient();
    }

    uint256 amount = claimable;
    if (amount == 0) {
      revert NothingToClaim();
    }

    claimable = 0;
    if (!usdc.transfer(recipient, amount)) {
      revert MemberPaymentFailed(recipient);
    }

    emit FundsClaimed(tabId, recipient, amount);
  }
}
