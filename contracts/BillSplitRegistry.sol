// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "./interfaces/IERC20.sol";

contract BillSplitRegistry {
  error AlreadyParticipant(uint256 billId, address participant);
  error ClaimExceedsBalance();
  error InvalidAmount();
  error InvalidConfiguration();
  error NotParticipant(uint256 billId, address participant);
  error NotSplitter(uint256 billId, address caller);
  error TransferFailed();
  error UnknownBill(uint256 billId);

  event BillCreated(uint256 indexed billId, address indexed splitter, bytes32 indexed metadataHash, uint256 totalOwed);
  event DebtPaid(uint256 indexed billId, address indexed payer, uint256 amount, uint256 paidTotal, uint256 owedTotal);
  event FundsClaimed(uint256 indexed billId, address indexed splitter, uint256 amount);

  struct Participant {
    uint256 owed;
    uint256 paid;
    bool exists;
  }

  struct Bill {
    address splitter;
    bytes32 metadataHash;
    uint256 totalOwed;
    uint256 totalPaid;
    uint256 claimed;
    bool exists;
    address[] participantList;
  }

  IERC20 public immutable usdc;
  uint256 public nextBillId = 1;

  mapping(uint256 billId => Bill bill) private bills;
  mapping(uint256 billId => mapping(address participantAddress => Participant participantData)) private participants;
  mapping(address participant => uint256[] billIds) private billsByParticipant;
  mapping(address splitter => uint256[] billIds) private billsBySplitter;

  constructor(address usdc_) {
    if (usdc_ == address(0)) {
      revert InvalidConfiguration();
    }

    usdc = IERC20(usdc_);
  }

  function createBill(
    bytes32 metadataHash,
    address[] calldata participantAddresses,
    uint256[] calldata owedAmounts
  ) external returns (uint256 billId) {
    if (participantAddresses.length == 0 || participantAddresses.length != owedAmounts.length) {
      revert InvalidConfiguration();
    }

    billId = nextBillId++;
    Bill storage bill = bills[billId];
    bill.splitter = msg.sender;
    bill.metadataHash = metadataHash;
    bill.exists = true;

    for (uint256 i = 0; i < participantAddresses.length; i++) {
      address participantAddress = participantAddresses[i];
      uint256 owedAmount = owedAmounts[i];

      if (participantAddress == address(0) || owedAmount == 0) {
        revert InvalidConfiguration();
      }

      if (participants[billId][participantAddress].exists) {
        revert AlreadyParticipant(billId, participantAddress);
      }

      participants[billId][participantAddress] = Participant({
        owed: owedAmount,
        paid: 0,
        exists: true
      });
      bill.participantList.push(participantAddress);
      bill.totalOwed += owedAmount;
      billsByParticipant[participantAddress].push(billId);
    }

    billsBySplitter[msg.sender].push(billId);

    emit BillCreated(billId, msg.sender, metadataHash, bill.totalOwed);
  }

  function payDebt(uint256 billId, uint256 amount) external {
    Bill storage bill = _billOrRevert(billId);
    Participant storage participant = participants[billId][msg.sender];

    if (!participant.exists) {
      revert NotParticipant(billId, msg.sender);
    }

    uint256 remaining = participant.owed - participant.paid;

    if (amount == 0 || amount > remaining) {
      revert InvalidAmount();
    }

    participant.paid += amount;
    bill.totalPaid += amount;

    if (!usdc.transferFrom(msg.sender, address(this), amount)) {
      revert TransferFailed();
    }

    emit DebtPaid(billId, msg.sender, amount, participant.paid, participant.owed);
  }

  function claim(uint256 billId, uint256 amount) external {
    Bill storage bill = _billOrRevert(billId);

    if (msg.sender != bill.splitter) {
      revert NotSplitter(billId, msg.sender);
    }

    uint256 claimableAmount = bill.totalPaid - bill.claimed;

    if (amount == 0 || amount > claimableAmount) {
      revert ClaimExceedsBalance();
    }

    bill.claimed += amount;

    if (!usdc.transfer(msg.sender, amount)) {
      revert TransferFailed();
    }

    emit FundsClaimed(billId, msg.sender, amount);
  }

  function claimable(uint256 billId) external view returns (uint256) {
    Bill storage bill = _billOrRevert(billId);
    return bill.totalPaid - bill.claimed;
  }

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

  function getParticipant(uint256 billId, address participantAddress)
    external
    view
    returns (uint256 owed, uint256 paid, bool exists)
  {
    Participant storage participant = participants[billId][participantAddress];
    return (participant.owed, participant.paid, participant.exists);
  }

  function billIdsForParticipant(address participantAddress) external view returns (uint256[] memory) {
    return billsByParticipant[participantAddress];
  }

  function billIdsForSplitter(address splitter) external view returns (uint256[] memory) {
    return billsBySplitter[splitter];
  }

  function _billOrRevert(uint256 billId) private view returns (Bill storage bill) {
    bill = bills[billId];

    if (!bill.exists) {
      revert UnknownBill(billId);
    }
  }
}
