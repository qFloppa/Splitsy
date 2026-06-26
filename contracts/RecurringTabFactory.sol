// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {RecurringTab} from "./RecurringTab.sol";
import {ReentrancyGuard} from "./security/ReentrancyGuard.sol";

/// @title RecurringTabFactory
/// @notice Deploys isolated {RecurringTab} contracts and indexes them by id.
/// @dev Holds no funds and grants itself no privileges over the tabs it creates;
///      each tab custodies and releases its own USDC. State-changing entrypoints
///      are {ReentrancyGuard}-protected as defense-in-depth, even though the
///      factory itself custodies nothing.
contract RecurringTabFactory is ReentrancyGuard {
  /// @notice Thrown when the USDC address supplied at construction is zero.
  error InvalidConfiguration();
  /// @notice Thrown when a tab id has no deployed tab.
  error UnknownTab(uint256 tabId);

  /// @notice Emitted when a new tab is deployed.
  event TabCreated(
    uint256 indexed tabId,
    address indexed tab,
    address indexed recipient,
    uint256 settlementInterval,
    uint256 maxSettlements
  );

  /// @notice USDC token every deployed tab will collect and pay out.
  address public immutable usdc;
  /// @notice Identifier that will be assigned to the next created tab.
  uint256 public nextTabId = 1;

  /// @notice Maps a tab id to its deployed tab address.
  mapping(uint256 tabId => address tab) public tabs;

  /// @param usdc_ Address of the USDC token contract; must be non-zero.
  constructor(address usdc_) {
    if (usdc_ == address(0)) {
      revert InvalidConfiguration();
    }

    usdc = usdc_;
  }

  /// @notice Deploys a new recurring tab.
  /// @param recipient Address entitled to claim the tab's collected funds.
  /// @param settlementInterval Seconds between settlement cycles.
  /// @param maxSettlements Maximum number of cycles that can be settled.
  /// @param members Member addresses (validated by the tab's constructor).
  /// @param fixedShares Per-cycle amount owed by each member.
  /// @return tabId Identifier of the new tab.
  /// @return tab Address of the deployed tab.
  function createTab(
    address recipient,
    uint256 settlementInterval,
    uint256 maxSettlements,
    address[] calldata members,
    uint256[] calldata fixedShares
  ) external nonReentrant returns (uint256 tabId, address tab) {
    tabId = nextTabId++;
    tab = address(new RecurringTab(tabId, usdc, recipient, settlementInterval, maxSettlements, members, fixedShares));
    tabs[tabId] = tab;

    emit TabCreated(tabId, tab, recipient, settlementInterval, maxSettlements);
  }

  /// @notice Triggers settlement on the tab identified by `tabId`.
  /// @param tabId Identifier of the tab to settle.
  function settleTab(uint256 tabId) external nonReentrant {
    RecurringTab(_tabOrRevert(tabId)).settleTab();
  }

  /// @dev Resolves a tab address, reverting with {UnknownTab} if none is registered.
  /// @param tabId Identifier of the tab to resolve.
  /// @return tab Address of the registered tab.
  function _tabOrRevert(uint256 tabId) private view returns (address tab) {
    tab = tabs[tabId];

    if (tab == address(0)) {
      revert UnknownTab(tabId);
    }
  }
}
