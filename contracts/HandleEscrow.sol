// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

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
///      unconditional. Recovery is a race: a malicious release may confirm
///      before the depositor's reclaim. There is no pause or key rotation.
///
///      TWO BOUNDS EXIST BECAUSE THE KEY CANNOT BE ROTATED. Neither is a
///      permission check — both cap what a *valid* signature can achieve, so
///      they bind the real attester and a stolen one identically:
///
///      - `holdWindow` expires every deposit. Past `expiresAt` the only exit is
///        {reclaim}, so the balance a leaked key can ever reach is bounded by
///        one window's inflow rather than by every deposit ever made. This is
///        the bound that matters: it stops the attack surface accumulating.
///      - `maxReleasePerDay` is a token bucket over releases, the same shape
///        {AutopayMandate} uses for spending. A leaked key gets one day's
///        ceiling, in public, while depositors reclaim the rest.
///
///      {reclaim} is exempt from both. It is the escape hatch, and an escape
///      hatch with a rate limit is not one — a capped reclaim would let a
///      leaked key outrun the people trying to get out.
///
///      Deposits above `maxReleasePerDay` are refused at {deposit} rather than
///      accepted and left unreleasable, which is the same failure arriving
///      later and with the money already in.
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
  /// @dev `depositor` and `expiresAt` share a slot (20 + 8 of 32 bytes), so the
  ///      expiry costs no extra storage over the two-exit version of this struct.
  /// @param depositor Who paid in, and the only address that may {reclaim}.
  /// @param expiresAt Unix seconds after which {release} is refused and
  ///        {reclaim} is the only exit. `uint64` outlives the chain.
  /// @param handleHash Opaque identifier of the intended recipient.
  /// @param amount USDC held, in the token's own units.
  struct Deposit {
    address depositor;
    uint64 expiresAt;
    bytes32 handleHash;
    uint256 amount;
  }

  /// @notice Thrown when a deposit is zero.
  error InvalidAmount();
  /// @notice Thrown when a single deposit exceeds what one day could ever release.
  /// @dev Refused at {deposit}: accepting it would mint a deposit {release} can
  ///      never satisfy, and a deposit only {reclaim} can exit is not escrow.
  /// @param amount The deposit that was attempted.
  /// @param maximum The contract's `maxReleasePerDay`.
  error AmountExceedsDailyLimit(uint256 amount, uint256 maximum);
  /// @notice Thrown when a constructor argument is the zero address.
  error InvalidConfiguration();
  /// @notice Thrown when a release names the zero address.
  error InvalidRecipient();
  /// @notice Thrown when a deposit does not exist, or has already left.
  /// @param id The deposit identifier that was asked for.
  error NoSuchDeposit(uint256 id);
  /// @notice Thrown when a release is attempted past the deposit's hold window.
  /// @param id The deposit identifier.
  /// @param expiresAt When releasing it stopped being possible.
  error DepositExpired(uint256 id, uint64 expiresAt);
  /// @notice Thrown when a release would exceed the rolling daily ceiling.
  /// @param requested Amount the release would have moved.
  /// @param available What the bucket has room for right now.
  error DailyLimitExceeded(uint256 requested, uint256 available);
  /// @notice Thrown when someone other than the depositor tries to reclaim.
  /// @param id The deposit identifier.
  /// @param caller The address that tried.
  error NotDepositor(uint256 id, address caller);
  /// @notice Thrown when the signature was not made by the attester.
  error BadSignature();
  /// @notice Thrown when the signature's deadline has passed.
  error SignatureExpired();

  /// @notice Emitted when money is put in for a handle.
  event Deposited(
    uint256 indexed id, address indexed depositor, bytes32 indexed handleHash, uint256 amount, uint64 expiresAt
  );
  /// @notice Emitted when money is paid out to a recipient's wallet.
  event Released(uint256 indexed id, address indexed to, uint256 amount);
  /// @notice Emitted when a depositor takes their money back.
  event Reclaimed(uint256 indexed id, address indexed depositor, uint256 amount);

  /// @notice The USDC token this escrow holds.
  IERC20 public immutable usdc;
  /// @notice The key whose signature authorises a release. Immutable by design.
  address public immutable attester;
  /// @notice How long after a deposit {release} stays possible, in seconds.
  /// @dev Deliberately generous. This is the floor under the operational policy,
  ///      not the policy: the off-chain sweep reclaims far sooner and can be
  ///      retuned, where this cannot be changed without a redeploy. It exists so
  ///      the bound holds even if Splitsy stops running the sweep entirely.
  uint256 public immutable holdWindow;
  /// @notice Rolling 24h ceiling on released USDC, in the token's own units.
  uint128 public immutable maxReleasePerDay;

  /// @notice EIP-712 type hash for a release authorisation.
  bytes32 public constant RELEASE_TYPEHASH = keccak256("Release(uint256 id,address to,uint256 deadline)");

  /// @dev Half the secp256k1 curve order. A signature with `s` above this is the
  ///      second, equally valid form of the same signature — accepting both
  ///      would make one authorisation look like two.
  uint256 private constant _HALF_CURVE_ORDER =
    0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

  /// @notice Identifier the next deposit will take.
  uint256 public nextDepositId = 1;

  /// @dev Release bucket fill level as of `_lastReleaseAt`; decays toward 0.
  ///      Shares a slot with `_lastReleaseAt` (16 + 8 of 32 bytes).
  uint128 private _released;
  /// @dev Unix seconds of the last successful {release}.
  uint64 private _lastReleaseAt;

  /// @notice Deposits by identifier; a zero `amount` means "gone".
  mapping(uint256 id => Deposit deposit) public deposits;

  /// @notice Binds this escrow to its token, its attester and its two bounds.
  /// @param usdc_ The USDC token address; must be non-zero.
  /// @param attester_ The key that signs releases; must be non-zero.
  /// @param holdWindow_ Seconds a deposit stays releasable; must be non-zero.
  /// @param maxReleasePerDay_ Rolling 24h release ceiling; must be non-zero.
  constructor(address usdc_, address attester_, uint256 holdWindow_, uint128 maxReleasePerDay_) {
    if (usdc_ == address(0) || attester_ == address(0) || holdWindow_ == 0 || maxReleasePerDay_ == 0) {
      revert InvalidConfiguration();
    }
    usdc = IERC20(usdc_);
    attester = attester_;
    holdWindow = holdWindow_;
    maxReleasePerDay = maxReleasePerDay_;
  }

  /// @notice The EIP-712 domain separator for this deployment and current chain.
  /// @dev Rebuilt from the current chain ID so a chain-ID change invalidates
  ///      authorizations from the old chain, including on a fork.
  function DOMAIN_SEPARATOR() public view returns (bytes32) {
    return keccak256(
      abi.encode(
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
        keccak256("Splitsy HandleEscrow"),
        keccak256("1"),
        block.chainid,
        address(this)
      )
    );
  }

  /// @notice Puts USDC aside for whoever proves they own `handleHash`.
  /// @dev Refuses anything `maxReleasePerDay` could never release — see the
  ///      contract note. The expiry is computed here rather than passed in, so
  ///      every deposit carries the same window and a caller cannot ask for a
  ///      longer one.
  /// @param handleHash Opaque identifier of the intended recipient.
  /// @param amount USDC to hold, in the token's own units; must be non-zero.
  /// @return id The identifier of the new deposit.
  function deposit(bytes32 handleHash, uint256 amount) external nonReentrant returns (uint256 id) {
    if (amount == 0) {
      revert InvalidAmount();
    }
    if (amount > maxReleasePerDay) {
      revert AmountExceedsDailyLimit(amount, maxReleasePerDay);
    }

    // Bounded by `holdWindow`, which the constructor fixes; no caller input
    // reaches this sum, so it cannot be pushed past the cast.
    uint64 expiresAt = uint64(block.timestamp + holdWindow);

    id = nextDepositId++;
    deposits[id] =
      Deposit({depositor: msg.sender, expiresAt: expiresAt, handleHash: handleHash, amount: amount});

    emit Deposited(id, msg.sender, handleHash, amount, expiresAt);

    usdc.safeTransferFrom(msg.sender, address(this), amount);
  }

  /// @notice Pays a deposit out to the wallet the attester names.
  /// @dev Callable by anyone holding a valid signature — the signature is the
  ///      authorisation, not the caller. That is deliberate: the recipient's
  ///      wallet is empty, so someone else has to pay the gas, and a permission
  ///      check on msg.sender would mean Splitsy going quiet could strand a
  ///      deposit that is already authorised.
  ///
  ///      The expiry and the bucket are checked here, on the only path a
  ///      signature can move money, so a valid signature and a stolen one meet
  ///      the same two walls. Both are checked BEFORE the signature so a probe
  ///      cannot use the revert reason to learn whether a signature was good.
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
    if (block.timestamp > held.expiresAt) {
      revert DepositExpired(id, held.expiresAt);
    }

    uint256 released = _releaseBucket();
    if (released + held.amount > maxReleasePerDay) {
      revert DailyLimitExceeded(held.amount, maxReleasePerDay - released);
    }

    bytes32 structHash = keccak256(abi.encode(RELEASE_TYPEHASH, id, to, deadline));
    bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), structHash));
    if (_recover(digest, signature) != attester) {
      revert BadSignature();
    }

    // The sum is bounded by `maxReleasePerDay` above, so the cast cannot narrow.
    _released = uint128(released + held.amount);
    _lastReleaseAt = uint64(block.timestamp);

    delete deposits[id];

    emit Released(id, to, held.amount);

    usdc.safeTransfer(to, held.amount);
  }

  /// @notice Takes a deposit back. Available any time before it is released.
  /// @dev Unconditional on purpose, and exempt from both the expiry and the
  ///      daily ceiling. Nothing is ever locked here, and this is available
  ///      while the deposit is held — including after it has expired, which is
  ///      what makes the expiry a redirection of the exit rather than a freeze.
  ///      It cannot recover money already paid out by a compromised attester.
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

  /// @notice How much more USDC {release} can move right now.
  /// @dev The off-chain releaser reads this before signing, so a release that
  ///      would bounce off the ceiling is never relayed and never costs gas.
  /// @return available Remaining room in the rolling 24h bucket.
  function releasableNow() external view returns (uint256 available) {
    available = maxReleasePerDay - _releaseBucket();
  }

  /// @dev The release bucket's fill level right now: `_released` decayed by a
  ///      linear refill of `maxReleasePerDay` per 24h since `_lastReleaseAt`.
  ///      Same shape as {AutopayMandate._bucket}, and the same reason for a
  ///      bucket over a calendar day: a day boundary is an exploit, because two
  ///      full-ceiling drains five minutes apart either side of midnight would
  ///      be twice the ceiling. Intermediates are `uint256`, so the multiply
  ///      cannot overflow the `uint128` cap. Before the first release
  ///      `_lastReleaseAt` is 0, which yields a refill far larger than
  ///      `_released` and correctly reports an empty bucket.
  /// @return released Current fill level in USDC base units.
  // A ceiling measured in days cannot care about proposer drift.
  // slither-disable-next-line timestamp
  function _releaseBucket() private view returns (uint256 released) {
    released = _released;

    uint256 refill = ((block.timestamp - _lastReleaseAt) * uint256(maxReleasePerDay)) / 1 days;

    released = refill >= released ? 0 : released - refill;
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
