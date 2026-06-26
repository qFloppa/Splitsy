// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

contract MockUSDC {
  string public constant name = "Mock USDC";
  string public constant symbol = "USDC";
  uint8 public constant decimals = 6;

  mapping(address account => uint256 balance) public balanceOf;
  mapping(address owner => mapping(address spender => uint256 amount)) public allowance;

  event Approval(address indexed owner, address indexed spender, uint256 amount);
  event Transfer(address indexed from, address indexed to, uint256 amount);

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

    balanceOf[from] -= amount;
    balanceOf[to] += amount;

    emit Transfer(from, to, amount);
  }
}
