// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {IBillSplitRegistry} from "./interfaces/IBillSplitRegistry.sol";
import {IERC20} from "./interfaces/IERC20.sol";
import {SafeERC20} from "./libraries/SafeERC20.sol";
import {ReentrancyGuard} from "./security/ReentrancyGuard.sol";

/// @title AutopayMandate
/// @author Splitsy
/// @notice A standing, on-chain permission for one named agent to settle the
///         grantor's bills out of the grantor's own USDC, inside caps the chain
///         enforces.
/// @dev The point of this contract is where the spending rules live. An agent
///      that is merely *told* to respect a 3 USDC/day ceiling is making a claim
///      about a server; an agent bound by {payFor} is making a claim anyone can
///      falsify in one `eth_call`. Concretely:
///
///      - The money is the debtor's. {payFor} pulls from `debtor` under the
///        debtor's own ERC-20 approval and hands it straight to the registry, so
///        the agent never needs a float and never custodies bill money. The
///        contract holds a non-zero balance only *within* one {payFor} call.
///      - `registry` is `immutable` and never a call parameter. A registry
///        passed in by the caller would let a compromised agent aim this
///        contract at a lookalike of its own and drain the standing allowance.
///      - There is no owner, no admin, no pause, no upgrade hook and no sweep.
///        There is nothing to seize and nobody to trust.
///      - {revokeMandate} is always available and cannot revert for a live
///        mandate: a consent that cannot be withdrawn is not consent. This is
///        the same rule `BillSplitRegistry.revokeCollect` already follows.
///
///      The daily ceiling is a token bucket refilling at `maxPerDay` per 24h
///      rather than a calendar-day counter. A calendar day has a boundary, and a
///      boundary is an exploit: two full-cap spends five minutes apart, one
///      either side of midnight, would be twice the ceiling the user agreed to.
///
///      Two rules deliberately stay off chain, as an agent pre-flight rather
///      than a check here: the creator's reputation floor (ERC-8004 stores
///      individual feedback, not the aggregate this would need) and the
///      verified-metadata check (the contract cannot see the off-chain
///      preimage). Both fail closed in `lib/autopay.ts` before an agent ever
///      calls {payFor}, and both are recorded with a reason in `autopay_log`.
contract AutopayMandate is ReentrancyGuard {
  using SafeERC20 for IERC20;

  /// @notice One debtor's standing autopay permission.
  /// @dev Packed into two slots: `agent` (20 bytes) + `maxPerBill` (12) fill the
  ///      first exactly; `maxPerDay` + `spent` + `lastSpendAt` fill the second.
  ///      `maxPerBill` as `uint96` still covers ~79 trillion USDC.
  /// @param agent The one address allowed to call {payFor} for this debtor.
  ///        `address(0)` means autopay is off — it is the entire kill switch.
  /// @param maxPerBill Largest single share this mandate will settle, in USDC
  ///        base units.
  /// @param maxPerDay Token-bucket capacity, in USDC base units per 24h.
  /// @param spent The bucket's fill level as of `lastSpendAt`; decays toward 0.
  /// @param lastSpendAt Unix seconds of the last successful {payFor}.
  struct Mandate {
    address agent;
    uint96 maxPerBill;
    uint128 maxPerDay;
    uint128 spent;
    uint64 lastSpendAt;
  }

  /// @notice Upper bound on a debtor's creator allowlist.
  /// @dev {payFor} scans the list linearly, so it has to be bounded or a debtor
  ///      could set a list long enough that their own autopay always runs out of
  ///      gas — a self-inflicted denial of service, but a real one.
  uint256 public constant MAX_ALLOWED_CREATORS = 10;

  /// @notice The USDC token this mandate spends.
  IERC20 public immutable usdc;

  /// @notice The bill registry every payment is routed through.
  IBillSplitRegistry public immutable registry;

  /// @notice Each debtor's standing mandate. `agent == address(0)` means off.
  mapping(address debtor => Mandate mandate) public mandates;

  /// @dev Creators a debtor will autopay. An EMPTY list means "any creator",
  ///      matching the off-chain rule in schema-agents.sql — an empty allowlist
  ///      is "no creator restriction", never "trust nobody".
  mapping(address debtor => address[] creators) private _allowedCreators;

  /// @notice Emitted when a debtor writes or rewrites their mandate.
  /// @param debtor The account whose money the mandate governs.
  /// @param agent The address newly permitted to spend it.
  /// @param maxPerBill Per-bill ceiling in USDC base units.
  /// @param maxPerDay Daily ceiling in USDC base units.
  /// @param creatorCount Length of the replacement allowlist; 0 means anyone.
  event MandateSet(
    address indexed debtor,
    address indexed agent,
    uint96 maxPerBill,
    uint128 maxPerDay,
    uint256 creatorCount
  );

  /// @notice Emitted when a debtor turns autopay off.
  /// @param debtor The account that withdrew the permission.
  event MandateRevoked(address indexed debtor);

  /// @notice Emitted on every successful pull.
  /// @param billId Bill that was settled.
  /// @param debtor Whose share was paid, and whose USDC paid it.
  /// @param agent Who triggered the pull.
  /// @param amount USDC moved, in base units.
  event MandateSpent(uint256 indexed billId, address indexed debtor, address indexed agent, uint256 amount);

  /// @notice Thrown when a constructor argument or a mandate agent is the zero address.
  error InvalidConfiguration();
  /// @notice Thrown when the debtor has no live mandate.
  error NoMandate();
  /// @notice Thrown when the caller is not the debtor's named agent.
  error NotAgent();
  /// @notice Thrown when the debtor is not a participant on that bill.
  error NotParticipant();
  /// @notice Thrown when the debtor's share is already settled.
  error NothingOwed();
  /// @notice Thrown when the bill's creator is absent from a non-empty allowlist.
  error CreatorNotAllowed();
  /// @notice Thrown when the share exceeds the per-bill ceiling.
  error OverBillCap();
  /// @notice Thrown when the share would breach the daily token bucket.
  error OverDailyCap();
  /// @notice Thrown when an allowlist is longer than {MAX_ALLOWED_CREATORS}.
  error TooManyCreators();

  /// @notice Binds this contract to one registry and one token, permanently.
  /// @dev The single standing approval to the registry is set here so {payFor}
  ///      never spends gas on one. That is safe because of *how* the registry
  ///      pulls: every `_payDebt` path takes its funder from `msg.sender`
  ///      (`payDebt`, `payDebtFor`), and the one path naming a different funder,
  ///      `collectDebt`, requires that funder to have set a `collectMandate`
  ///      themselves. This contract never sets one. So the allowance is only
  ///      ever exercisable by this contract's own call inside {payFor}, against
  ///      a balance it holds only for the duration of that call.
  /// @param registryAddress Deployed {BillSplitRegistry}.
  /// @param usdcAddress The USDC ERC-20 both contracts settle in.
  constructor(address registryAddress, address usdcAddress) {
    if (registryAddress == address(0) || usdcAddress == address(0)) {
      revert InvalidConfiguration();
    }

    registry = IBillSplitRegistry(registryAddress);
    usdc = IERC20(usdcAddress);

    // Checked rather than ignored. A token whose approve returns false here
    // would leave a contract that reverts on every payment; failing at deploy
    // time is the cheaper discovery. Not routed through SafeERC20, which has no
    // approve wrapper and should not grow one for a single constructor call.
    if (!IERC20(usdcAddress).approve(registryAddress, type(uint256).max)) {
      revert InvalidConfiguration();
    }
  }

  /// @notice Grants `agent` a standing permission to settle the caller's bills.
  /// @dev Writes the mandate and *replaces* the allowlist wholesale. It
  ///      deliberately leaves `spent` and `lastSpendAt` alone: zeroing them
  ///      would turn re-saving the settings panel into a cap reset — pay 3 of a
  ///      3/day ceiling, press Save, pay 3 more. Only the debtor can call this,
  ///      so that was never an agent-exploitable hole, but "the daily cap holds
  ///      unless you press Save" is not a daily cap. Carrying the bucket needs
  ///      no special cases: refill always uses the *current* `maxPerDay`, so
  ///      lowering a ceiling mid-day binds immediately, raising one takes effect
  ///      at once, and a long-dormant mandate refills to zero on its first
  ///      evaluation.
  /// @param agent Address permitted to call {payFor}; may not be zero. Use
  ///        {revokeMandate} to turn autopay off.
  /// @param maxPerBill Per-bill ceiling in USDC base units.
  /// @param maxPerDay Daily ceiling in USDC base units.
  /// @param creators Creators to autopay; EMPTY means any creator.
  function setMandate(address agent, uint96 maxPerBill, uint128 maxPerDay, address[] calldata creators) external {
    if (agent == address(0)) {
      revert InvalidConfiguration();
    }
    if (creators.length > MAX_ALLOWED_CREATORS) {
      revert TooManyCreators();
    }

    Mandate storage mandate = mandates[msg.sender];
    mandate.agent = agent;
    mandate.maxPerBill = maxPerBill;
    mandate.maxPerDay = maxPerDay;

    address[] storage allowed = _allowedCreators[msg.sender];
    // Replace, never append: the caller's list is the whole truth about who they
    // will autopay, and a stale entry surviving a "save" is a permission the
    // user believes they removed.
    delete _allowedCreators[msg.sender];
    for (uint256 i; i < creators.length; ++i) {
      allowed.push(creators[i]);
    }

    emit MandateSet(msg.sender, agent, maxPerBill, maxPerDay, creators.length);
  }

  /// @notice Turns the caller's autopay off, immediately and unconditionally.
  /// @dev Zeroes `agent` — the kill switch — and `spent` with it, because a
  ///      budget belongs to a mandate and there is no longer a mandate for it to
  ///      belong to. Re-enabling after a revoke therefore starts from a fresh
  ///      bucket; that is the one reset path, and it costs a revoke transaction
  ///      rather than a click on Save. Idempotent: revoking twice is not an
  ///      error, and this function has no revert path at all.
  function revokeMandate() external {
    Mandate storage mandate = mandates[msg.sender];
    mandate.agent = address(0);
    mandate.spent = 0;

    emit MandateRevoked(msg.sender);
  }

  /// @notice Settles `debtor`'s remaining share of `billId` from their own USDC.
  /// @dev Callable only by `mandates[debtor].agent`. Effects land before
  ///      interactions and the call is additionally guarded, even though the
  ///      registry is immutable and trusted: this function touches a token, and
  ///      the guard is already vendored.
  ///
  ///      The amount is never caller-supplied. It is read from the registry as
  ///      the debtor's full remaining share, so an agent cannot choose a figure,
  ///      cannot split one share across several sub-cap pulls, and cannot pay a
  ///      stranger's bill with this debtor's money.
  /// @param billId Bill to settle.
  /// @param debtor Participant whose share is paid, and whose USDC pays it.
  function payFor(uint256 billId, address debtor) external nonReentrant {
    Mandate storage mandate = mandates[debtor];

    address agent = mandate.agent;
    if (agent == address(0)) {
      revert NoMandate();
    }
    if (msg.sender != agent) {
      revert NotAgent();
    }

    (uint256 owed, uint256 paid, bool exists) = registry.getParticipant(billId, debtor);
    if (!exists) {
      revert NotParticipant();
    }

    uint256 amount = owed - paid;
    if (amount == 0) {
      revert NothingOwed();
    }

    if (!_creatorAllowed(billId, debtor)) {
      revert CreatorNotAllowed();
    }

    if (amount > mandate.maxPerBill) {
      revert OverBillCap();
    }

    uint256 spent = _bucket(mandate);
    if (spent + amount > mandate.maxPerDay) {
      revert OverDailyCap();
    }

    // Effects first. A ceiling checked after the money moves is not a ceiling.
    // The sum is bounded by `maxPerDay` above, so the narrowing cast cannot
    // truncate.
    mandate.spent = uint128(spent + amount);
    // Wall-clock refill; a validator nudging the timestamp by seconds moves the
    // bucket by a proportional fraction of a daily cap, which is not an attack.
    // slither-disable-next-line timestamp
    mandate.lastSpendAt = uint64(block.timestamp);

    // Bounded by the debtor's own approval and balance — a short allowance
    // reverts here, which is the debtor retaining the final say.
    usdc.safeTransferFrom(debtor, address(this), amount);
    registry.payDebtFor(billId, debtor, amount);

    emit MandateSpent(billId, debtor, agent, amount);
  }

  /// @notice The creators `debtor` will autopay; empty means any creator.
  /// @dev Exposed so the settings UI reads consent off the chain rather than off
  ///      a database mirror that could disagree with it.
  /// @param debtor Account to query.
  /// @return creators The allowlist, in the order it was set.
  function allowedCreators(address debtor) external view returns (address[] memory creators) {
    creators = _allowedCreators[debtor];
  }

  /// @notice What {payFor} would move for `debtor` on `billId` right now.
  /// @dev 0 whenever any rule blocks it, including the debtor's USDC approval
  ///      and balance. This lets the agent pre-flight a pull instead of paying
  ///      gas to discover a revert — the same job `BillSplitRegistry.collectible`
  ///      does for the creditor-side pull. Reverts only if the bill itself does
  ///      not exist, which is the registry's own behaviour.
  /// @param billId Bill to price.
  /// @param debtor Participant to price it for.
  /// @return amount USDC base units a pull would move; 0 if it would not.
  function spendable(uint256 billId, address debtor) external view returns (uint256 amount) {
    Mandate storage mandate = mandates[debtor];
    if (mandate.agent == address(0)) {
      return 0;
    }

    (uint256 owed, uint256 paid, bool exists) = registry.getParticipant(billId, debtor);
    if (!exists) {
      return 0;
    }

    uint256 remaining = owed - paid;
    if (remaining == 0 || remaining > mandate.maxPerBill) {
      return 0;
    }
    if (!_creatorAllowed(billId, debtor)) {
      return 0;
    }
    if (_bucket(mandate) + remaining > mandate.maxPerDay) {
      return 0;
    }
    if (usdc.allowance(debtor, address(this)) < remaining || usdc.balanceOf(debtor) < remaining) {
      return 0;
    }

    amount = remaining;
  }

  /// @notice Room left in `debtor`'s daily token bucket, after refill.
  /// @dev The agent's off-chain pre-flight derives its `spentToday` from this as
  ///      `maxPerDay - dailyHeadroom`, which is what lets the pure decision core
  ///      in `lib/autopay.ts` stay unchanged by this contract's existence.
  ///      Returns 0 when a lowered ceiling sits below the current fill level.
  /// @param debtor Account to query.
  /// @return headroom USDC base units still spendable in the current window.
  function dailyHeadroom(address debtor) external view returns (uint256 headroom) {
    Mandate storage mandate = mandates[debtor];
    uint256 cap = mandate.maxPerDay;
    uint256 spent = _bucket(mandate);

    if (spent < cap) {
      headroom = cap - spent;
    }
  }

  /// @dev The token bucket's fill level right now: `spent` decayed by a linear
  ///      refill of `maxPerDay` per 24h since `lastSpendAt`. Intermediates are
  ///      `uint256`, so the multiply cannot overflow a `uint128` cap. A mandate
  ///      that has never spent has `lastSpendAt == 0`, which yields a refill far
  ///      larger than any `spent` and correctly reports an empty bucket.
  /// @param mandate The debtor's stored mandate.
  /// @return spent Current fill level in USDC base units.
  function _bucket(Mandate storage mandate) private view returns (uint256 spent) {
    spent = mandate.spent;

    // slither-disable-next-line timestamp
    uint256 refill = ((block.timestamp - mandate.lastSpendAt) * uint256(mandate.maxPerDay)) / 1 days;

    spent = refill >= spent ? 0 : spent - refill;
  }

  /// @dev Whether `billId`'s creator passes `debtor`'s allowlist. An empty list
  ///      means any creator, and short-circuits before the registry read so the
  ///      common case costs nothing. The scan is bounded by
  ///      {MAX_ALLOWED_CREATORS}.
  /// @param billId Bill whose splitter is checked.
  /// @param debtor Owner of the allowlist.
  /// @return allowed Whether the pull may proceed.
  function _creatorAllowed(uint256 billId, address debtor) private view returns (bool allowed) {
    address[] storage list = _allowedCreators[debtor];
    uint256 length = list.length;
    if (length == 0) {
      return true;
    }

    (address splitter,,,,,,,) = registry.getBill(billId);

    for (uint256 i; i < length; ++i) {
      if (list[i] == splitter) {
        return true;
      }
    }
  }
}
