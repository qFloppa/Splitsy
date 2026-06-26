// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {RecurringTab} from "./RecurringTab.sol";

contract RecurringTabFactory {
  error UnknownTab(uint256 tabId);

  event TabCreated(
    uint256 indexed tabId,
    address indexed tab,
    address indexed recipient,
    uint256 settlementInterval,
    uint256 maxSettlements
  );

  address public immutable usdc;
  uint256 public nextTabId = 1;

  mapping(uint256 tabId => address tab) public tabs;

  constructor(address usdc_) {
    usdc = usdc_;
  }

  function createTab(
    address recipient,
    uint256 settlementInterval,
    uint256 maxSettlements,
    address[] calldata members,
    uint256[] calldata fixedShares
  ) external returns (uint256 tabId, address tab) {
    tabId = nextTabId++;
    tab = address(new RecurringTab(tabId, usdc, recipient, settlementInterval, maxSettlements, members, fixedShares));
    tabs[tabId] = tab;

    emit TabCreated(tabId, tab, recipient, settlementInterval, maxSettlements);
  }

  function settleTab(uint256 tabId) external {
    RecurringTab(_tabOrRevert(tabId)).settleTab();
  }

  function _tabOrRevert(uint256 tabId) private view returns (address tab) {
    tab = tabs[tabId];

    if (tab == address(0)) {
      revert UnknownTab(tabId);
    }
  }
}
