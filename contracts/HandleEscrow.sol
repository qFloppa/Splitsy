// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {IERC20} from "./interfaces/IERC20.sol";
import {SafeERC20} from "./libraries/SafeERC20.sol";
import {ReentrancyGuard} from "./security/ReentrancyGuard.sol";

/// @title HandleEscrow
/// @author Splitsy
/// @notice Holds USDC for someone who has no wallet yet, until they sign in.
/// @dev WHY THIS IS NOT PART OF BillSplitRegistry. That contract's escrow is
///      address-keyed and direction-locked: `bill.splitter = msg.sender`, and
///      {_claim} both requires `msg.sender == splitter` and pays the splitter.
///      This one holds money FOR an address that does not exist at deposit
///      time. Adding that there would break the invariant its header states —
///      "funds can only ever leave via {claim} or {settle}'s claim legs, to the
///      bill's own splitter" — and would force a registry redeploy, which
///      restarts bill ids and leaves a third address to keep readable.
///
///      THE ATTESTER IS IMMUTABLE AND HAS NO SETTER. A settable attester needs
///      an owner, and an owner is the privileged role this avoids. The recovery
///      story is {reclaim}: if the key leaks, depositors withdraw and this
///      contract is redeployed. That only works because reclaim is
///      unconditional — the two decisions hold each other up.
///
///      THE ID IS THE NONCE. Both exits `delete` the deposit, so a replayed
///      signature finds nothing and reverts. One consequence, stated rather
///      than hidden: re-signing the same id for a different `to` (the user
///      changed wallet) leaves both signatures live until one is consumed.
///      `deadline` bounds that; a separate nonce would not change it.
///
///      `handleHash` IS OPAQUE HERE, AND IS NOT A SECRET.
///      keccak256("email:someone at example.com") is brute-forceable in seconds.
///      It is an identifier, not a password, and nothing may treat it as one.
///      Keeping it opaque is what lets a new namespace ship without touching
///      this contract.
///
///      TRUST, PLAINLY: the attester decides which address belongs to a handle.
///      A compromised key can misdirect a release — and, stated rather than
///      softened, it can do that to EVERY deposit this contract currently holds,
///      one signature per id. What it cannot do is take anything this contract
///      was never given, and it cannot stop a depositor calling {reclaim} first,
///      which is the whole recovery story. The intended upgrade is to
///      move the key inside a TEE, which changes only WHERE THE KEY LIVES: same
///      address, same signature, same Solidity. Worth doing once the typical
///      balance held here exceeds about a year of instance cost (~$600 at
///      c6g.large on-demand). Below that the enclave costs more than it
///      protects.
contract HandleEscrow is ReentrancyGuard {
  using SafeERC20 for IERC20;

  /// @notice A deposit waiting for its recipient to sign in.
  /// @param depositor Who paid in, and the only address that may {reclaim}.
  /// @param handleHash Opaque identifier of the intended recipient.
  /// @param amount USDC held, in the token's own units.
  struct Deposit {
    address depositor;
    bytes32 handleHash;
    uint256 amount;
  }

  /// @notice Thrown when a deposit is zero.
  error InvalidAmount();
  /// @notice Thrown when a constructor argument is the zero address.
  error InvalidConfiguration();
  /// @notice Thrown when a release names the zero address.
  error InvalidRecipient();
  /// @notice Thrown when a deposit does not exist, or has already left.
  /// @param id The deposit identifier that was asked for.
  error NoSuchDeposit(uint256 id);
  /// @notice Thrown when someone other than the depositor tries to reclaim.
  /// @param id The deposit identifier.
  /// @param caller The address that tried.
  error NotDepositor(uint256 id, address caller);
  /// @notice Thrown when the signature was not made by the attester.
  error BadSignature();
  /// @notice Thrown when the signature's deadline has passed.
  error SignatureExpired();

  /// @notice Emitted when money is put in for a handle.
  event Deposited(uint256 indexed id, address indexed depositor, bytes32 indexed handleHash, uint256 amount);
  /// @notice Emitted when money is paid out to a recipient's wallet.
  event Released(uint256 indexed id, address indexed to, uint256 amount);
  /// @notice Emitted when a depositor takes their money back.
  event Reclaimed(uint256 indexed id, address indexed depositor, uint256 amount);

  /// @notice The USDC token this escrow holds.
  IERC20 public immutable usdc;
  /// @notice The key whose signature authorises a release. Immutable by design.
  address public immutable attester;

  /// @notice EIP-712 type hash for a release authorisation.
  bytes32 public constant RELEASE_TYPEHASH = keccak256("Release(uint256 id,address to,uint256 deadline)");

  /// @dev Half the secp256k1 curve order. A signature with `s` above this is the
  ///      second, equally valid form of the same signature — accepting both
  ///      would make one authorisation look like two.
  uint256 private constant _HALF_CURVE_ORDER =
    0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

  /// @notice Identifier the next deposit will take.
  uint256 public nextDepositId = 1;

  /// @notice Deposits by identifier; a zero `amount` means "gone".
  mapping(uint256 id => Deposit deposit) public deposits;

  /// @dev Built once at deployment. Binding chainid and this address is what
  ///      stops a signature made for one deployment working on another.
  bytes32 private immutable _domainSeparator;

  /// @notice Binds this escrow to its token and its attester.
  /// @param usdc_ The USDC token address; must be non-zero.
  /// @param attester_ The key that signs releases; must be non-zero.
  constructor(address usdc_, address attester_) {
    if (usdc_ == address(0) || attester_ == address(0)) {
      revert InvalidConfiguration();
    }
    usdc = IERC20(usdc_);
    attester = attester_;
    _domainSeparator = keccak256(
      abi.encode(
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
        keccak256("Splitsy HandleEscrow"),
        keccak256("1"),
        block.chainid,
        address(this)
      )
    );
  }

  /// @notice The EIP-712 domain separator for this deployment.
  function DOMAIN_SEPARATOR() external view returns (bytes32) {
    return _domainSeparator;
  }

  /// @notice Puts USDC aside for whoever proves they own `handleHash`.
  /// @param handleHash Opaque identifier of the intended recipient.
  /// @param amount USDC to hold, in the token's own units; must be non-zero.
  /// @return id The identifier of the new deposit.
  function deposit(bytes32 handleHash, uint256 amount) external nonReentrant returns (uint256 id) {
    if (amount == 0) {
      revert InvalidAmount();
    }

    id = nextDepositId++;
    deposits[id] = Deposit({depositor: msg.sender, handleHash: handleHash, amount: amount});

    emit Deposited(id, msg.sender, handleHash, amount);

    usdc.safeTransferFrom(msg.sender, address(this), amount);
  }

  /// @notice Pays a deposit out to the wallet the attester names.
  /// @dev Callable by anyone holding a valid signature — the signature is the
  ///      authorisation, not the caller. That is deliberate: the recipient's
  ///      wallet is empty, so someone else has to pay the gas, and a permission
  ///      check on msg.sender would mean Splitsy going quiet could strand a
  ///      deposit that is already authorised.
  /// @param id The deposit to pay out.
  /// @param to The recipient's wallet.
  /// @param deadline Unix seconds after which the signature is dead.
  /// @param signature The attester's EIP-712 signature, 65 bytes, r||s||v.
  // The deadline is a wall-clock concept and a few seconds of proposer drift
  // cannot matter to it.
  // slither-disable-next-line timestamp
  function release(uint256 id, address to, uint256 deadline, bytes calldata signature) external nonReentrant {
    if (to == address(0)) {
      revert InvalidRecipient();
    }
    if (block.timestamp > deadline) {
      revert SignatureExpired();
    }

    Deposit memory held = deposits[id];
    if (held.amount == 0) {
      revert NoSuchDeposit(id);
    }

    bytes32 structHash = keccak256(abi.encode(RELEASE_TYPEHASH, id, to, deadline));
    bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparator, structHash));
    if (_recover(digest, signature) != attester) {
      revert BadSignature();
    }

    delete deposits[id];

    emit Released(id, to, held.amount);

    usdc.safeTransfer(to, held.amount);
  }

  /// @notice Takes a deposit back. Available any time before it is released.
  /// @dev Unconditional on purpose. Nothing is ever locked here, and this is
  ///      the backstop if the attester key is ever compromised.
  /// @param id The deposit to take back.
  function reclaim(uint256 id) external nonReentrant {
    Deposit memory held = deposits[id];
    if (held.amount == 0) {
      revert NoSuchDeposit(id);
    }
    if (held.depositor != msg.sender) {
      revert NotDepositor(id, msg.sender);
    }

    delete deposits[id];

    emit Reclaimed(id, msg.sender, held.amount);

    usdc.safeTransfer(msg.sender, held.amount);
  }

  /// @dev ecrecover with the two checks it does not do for you: `s` in the lower
  ///      half of the curve order, so one authorisation has exactly one valid
  ///      encoding, and a zero-address result rejected, which is what ecrecover
  ///      returns for a malformed signature rather than reverting.
  /// @param digest The EIP-712 digest that was signed.
  /// @param signature 65 bytes, r||s||v.
  /// @return signer The recovered address.
  function _recover(bytes32 digest, bytes calldata signature) private pure returns (address signer) {
    if (signature.length != 65) {
      revert BadSignature();
    }

    bytes32 r = bytes32(signature[0:32]);
    bytes32 s = bytes32(signature[32:64]);
    uint8 v = uint8(signature[64]);

    if (uint256(s) > _HALF_CURVE_ORDER) {
      revert BadSignature();
    }
    if (v != 27 && v != 28) {
      revert BadSignature();
    }

    signer = ecrecover(digest, v, r, s);
    if (signer == address(0)) {
      revert BadSignature();
    }
  }
}
