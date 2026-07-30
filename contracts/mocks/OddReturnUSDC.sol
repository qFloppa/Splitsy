// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

/// @notice A 6-decimal token whose transfer return *data* is configurable.
/// @dev Exists to pin {SafeERC20._callOptionalReturn}'s handling of the four
///      shapes a real token can produce, plus the hostile fifth:
///      0 = a proper 32-byte `true`, 1 = no return data at all (USDT-style),
///      2 = a truncated 8-byte return, 3 = an explicit `false`, and
///      4 = a "return bomb" — megabytes of data whose first word happens to be
///      `true`. The bomb is the reason the wrapper reads the result out of
///      scratch space with a fixed 32-byte copy instead of decoding a
///      `bytes memory`: copying the whole blob is quadratic memory gas charged
///      to the *caller*, which is a denial-of-service lever a token should not
///      have.
contract OddReturnUSDC {
  string public constant name = "Odd Return USDC";
  string public constant symbol = "USDC";
  uint8 public constant decimals = 6;

  /// @notice Which return shape this token produces; see the contract note.
  uint256 public immutable mode;
  /// @notice Extra 32-byte words appended in bomb mode.
  uint256 public immutable bombWords;

  mapping(address account => uint256 balance) public balanceOf;
  mapping(address owner => mapping(address spender => uint256 amount)) public allowance;

  event Approval(address indexed owner, address indexed spender, uint256 amount);
  event Transfer(address indexed from, address indexed to, uint256 amount);

  constructor(uint256 mode_, uint256 bombWords_) {
    mode = mode_;
    bombWords = bombWords_;
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

  function transfer(address to, uint256 amount) external {
    _move(msg.sender, to, amount);
    _returnConfigured();
  }

  function transferFrom(address from, address to, uint256 amount) external {
    uint256 allowed = allowance[from][msg.sender];
    require(allowed >= amount, "ALLOWANCE");

    if (allowed != type(uint256).max) {
      allowance[from][msg.sender] = allowed - amount;
    }

    _move(from, to, amount);
    _returnConfigured();
  }

  function _move(address from, address to, uint256 amount) private {
    require(balanceOf[from] >= amount, "BALANCE");

    balanceOf[from] -= amount;
    balanceOf[to] += amount;

    emit Transfer(from, to, amount);
  }

  /// @dev Halts with the configured return data. Each branch uses `return` in
  ///      assembly, so it ends the call frame and Solidity's own ABI encoding
  ///      never runs.
  function _returnConfigured() private view {
    uint256 selected = mode;

    if (selected == 1) {
      assembly ("memory-safe") {
        return(0x00, 0x00)
      }
    }

    if (selected == 2) {
      assembly ("memory-safe") {
        mstore(0x00, 1)
        return(0x00, 0x08)
      }
    }

    if (selected == 3) {
      assembly ("memory-safe") {
        mstore(0x00, 0)
        return(0x00, 0x20)
      }
    }

    if (selected == 4) {
      uint256 words = bombWords;

      assembly ("memory-safe") {
        let start := mload(0x40)
        mstore(start, 1)
        return(start, mul(add(words, 1), 0x20))
      }
    }

    assembly ("memory-safe") {
      mstore(0x00, 1)
      return(0x00, 0x20)
    }
  }
}
