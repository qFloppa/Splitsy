// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

/// @notice A 6-decimal token that delivers `amount - fee` while reporting success.
/// @dev Exists only to pin {BillSplitRegistry}'s known and accepted limitation:
///      the registry credits the *requested* amount, so with a fee-on-transfer
///      token its `totalPaid` drifts above its actual balance and claims
///      eventually revert on the token transfer. The registry is deployed
///      against one immutable, known USDC address, so this cannot happen in
///      practice — the test exists so nobody "fixes" it with balance-delta
///      accounting, which would add a reentrancy surface for no gain.
contract FeeOnTransferUSDC {
  string public constant name = "Fee USDC";
  string public constant symbol = "USDC";
  uint8 public constant decimals = 6;

  /// @notice Flat amount withheld from every transfer, in base units.
  uint256 public immutable fee;

  mapping(address account => uint256 balance) public balanceOf;
  mapping(address owner => mapping(address spender => uint256 amount)) public allowance;

  event Approval(address indexed owner, address indexed spender, uint256 amount);
  event Transfer(address indexed from, address indexed to, uint256 amount);

  constructor(uint256 fee_) {
    fee = fee_;
  }

  function mint(address to, uint256 amount) external {
    balanceOf[to] += amount;
    emit Transfer(address(0), to, amount);
  }

  function approve(address spender, uint256 amount) external returns (bool) {
    allowance[msg.sender][spender] = amount;
    emit Approval(msg.sender, spender, amount);
    return true;
  }

  function transfer(address to, uint256 amount) external returns (bool) {
    _transfer(msg.sender, to, amount);
    return true;
  }

  function transferFrom(address from, address to, uint256 amount) external returns (bool) {
    uint256 allowed = allowance[from][msg.sender];
    require(allowed >= amount, "ALLOWANCE");

    if (allowed != type(uint256).max) {
      allowance[from][msg.sender] = allowed - amount;
    }

    _transfer(from, to, amount);
    return true;
  }

  function _transfer(address from, address to, uint256 amount) private {
    require(to != address(0), "ZERO_TO");
    require(balanceOf[from] >= amount, "BALANCE");

    uint256 delivered = amount > fee ? amount - fee : 0;

    balanceOf[from] -= amount;
    balanceOf[to] += delivered;

    emit Transfer(from, to, delivered);
  }
}
