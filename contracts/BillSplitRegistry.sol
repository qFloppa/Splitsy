// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {IERC20} from "./interfaces/IERC20.sol";
import {SafeERC20} from "./libraries/SafeERC20.sol";
import {ReentrancyGuard} from "./security/ReentrancyGuard.sol";

/// @title BillSplitRegistry
/// @author Splitsy
/// @notice Registry for splitting a bill across participants who each repay
///         their share in USDC, while the bill's creator (the "splitter")
///         claims the collected funds.
/// @dev Accounting is tracked per bill and the contract custodies USDC only
///      between payment and claim. Security properties:
///      - All fund-moving entrypoints follow checks-effects-interactions and are
///        additionally protected by {ReentrancyGuard}. The guard sits on the
///        outer entrypoints only; the shared internals ({_payDebt}, {_claim})
///        are `private` and unguarded so that {settle} can compose them within
///        one already-guarded call. They are deliberately not `internal` or
///        `public` — nothing inherits from this contract, and exposing them
///        would re-open an unguarded fund-moving path.
///      - The splitter authorization check lives *inside* {_claim}, adjacent to
///        the transfer it protects, so no present or future caller can move a
///        bill's funds without it. {_claim} also resolves the recipient from
///        storage rather than trusting `msg.sender`.
///      - Token movements go through {SafeERC20}, so a token that returns no
///        data or `false` can never be mistaken for a successful transfer.
///      - The contract holds no privileged owner and exposes no upgrade,
///        pause, sweep, or `selfdestruct` path; funds can only ever leave via
///        {claim} or {settle}'s claim legs, to the bill's own splitter.
///
///      Authorization gates added in v2:
///      - {payDebtFor} has *no* permission check by design. It only ever moves
///        the caller's own USDC and only ever reduces someone's debt, capped at
///        that debtor's `remaining`. Paying a stranger's bill is a gift, not a
///        griefing vector, and the cap means `totalPaid` can never be inflated
///        past `totalOwed`.
///      - {collectDebt} is the one pull-based path and carries four independent
///        bounds, three of which the debtor alone controls: their own USDC
///        approval, their own balance, their own `remaining` on this specific
///        bill, and a per-bill {collectMandate} they set and can revoke at any
///        time. The splitter cannot invent an amount; the {_min} cap in
///        {collectible} is the whole safety story. It is additionally gated on
///        the bill's stored `dueDate` having passed, so a bill with no deadline
///        is never collectible.
///      - {authorizeCollect} is participant-only and always paired with
///        {revokeCollect}: a consent that cannot be withdrawn is not consent.
///      - {settle} is bounded by {MAX_BATCH} so a caller-supplied array can
///        never push the loop past the block gas limit. It needs no deadline,
///        nonce or signature: it moves only `msg.sender`'s own funds to and
///        from bills they are already party to, so there is nothing to replay.
///
///      Escrow composition: {escrowUntilFull} makes a bill all-or-nothing. The
///      splitter's claim is withheld until every participant has paid, and the
///      deadline does *not* release it — a bill still short at `dueDate` has
///      failed, and {refund} lets each payer pull their own contribution back.
///      Funds are therefore never stranded in a contract with no owner, no pause
///      and no sweep: the escape hatch is the payer's own withdrawal rather than
///      a partial payout of a purchase that never happened. A bill may not set
///      `escrowUntilFull` without a `dueDate`, because that pair leaves the
///      refund with no instant at which to become available.
///
///      {collectDebt} still unlocks at `dueDate` on an escrowed bill: pulling
///      from mandated debtors is exactly what can carry it over the line, and
///      anything pulled that does not is refundable to the debtor it came from.
///      A splitter who collects into a bill that stays short has moved money
///      the debtor can immediately withdraw again, at the splitter's own gas
///      expense. That is intended, not an oversight.
///
///      Unbounded reads: a bill's own participant list is capped by
///      {MAX_PARTICIPANTS}, but the per-address indexes behind
///      {billIdsForParticipant} and {billIdsForSplitter} grow without limit —
///      anyone can name any address as a participant, so a determined spammer
///      could make those two whole-array getters too large to return in one
///      `eth_call`. {billCountForParticipant} / {billIdsForParticipantPaged}
///      (and the splitter equivalents) exist so a client always has a bounded
///      way to read the same data. No funds are at risk either way; the
///      unbounded getters are kept for compatibility.
///
///      Known and accepted limitations:
///      - `usdc` is immutable and set once to a known, non-rebasing,
///        non-fee-on-transfer token. A fee-on-transfer token would leave
///        `totalPaid` above the contract's actual balance. This is not defended
///        against with balance-delta accounting, which would add a reentrancy
///        surface for no gain against a token address that cannot change.
///      - {payDebtFor} lets a third party pay down a debt the payer did not
///        fund, which can make a debtor's own exact-amount {payDebt} revert with
///        {InvalidAmount}. The griefer pays the victim's debt to do it, so the
///        attack costs more than it achieves; {settle} with a zero amount is
///        immune because it re-reads the remainder at execution time.
contract BillSplitRegistry is ReentrancyGuard {
  using SafeERC20 for IERC20;

  /// @notice Thrown when the same participant is added to a bill twice.
  error AlreadyParticipant(uint256 billId, address participant);
  /// @notice Thrown when a batch entrypoint is given more legs than {MAX_BATCH}.
  error BatchTooLarge(uint256 provided, uint256 maximum);
  /// @notice Thrown when a splitter tries to claim more than is available.
  error ClaimExceedsBalance();
  /// @notice Thrown when a claim is blocked because the bill is not yet fully paid.
  error Escrowed(uint256 billId, uint256 paid, uint256 owed);
  /// @notice Thrown when a payment is zero or exceeds the debtor's remaining debt.
  error InvalidAmount();
  /// @notice Thrown when bill inputs (arrays, addresses, amounts or dates) are invalid.
  error InvalidConfiguration();
  /// @notice Thrown when a splitter tries to collect without the debtor's mandate.
  error NoCollectMandate(uint256 billId, address debtor);
  /// @notice Thrown when a collection would move nothing.
  error NothingCollectible(uint256 billId, address debtor);
  /// @notice Thrown when a non-participant attempts to pay or authorize a bill.
  error NotParticipant(uint256 billId, address participant);
  /// @notice Thrown when a non-splitter attempts to claim or collect a bill's funds.
  error NotSplitter(uint256 billId, address caller);
  /// @notice Thrown when a refund is attempted on a bill that has not failed.
  /// @dev Either the bill is not escrowed at all, or it reached its `totalOwed`
  ///      — in both cases the funds belong to the splitter, not the payer.
  error NotRefundable(uint256 billId);
  /// @notice Thrown when collection is attempted before the bill's due date.
  error NotYetDue(uint256 billId, uint64 dueDate);
  /// @notice Thrown when a bill's participant count would exceed {MAX_PARTICIPANTS}.
  error TooManyParticipants(uint256 provided, uint256 maximum);
  /// @notice Thrown when an action references a bill that does not exist.
  error UnknownBill(uint256 billId);

  /// @notice Emitted once at deployment, recording the token this registry is bound to.
  /// @dev `usdc` is immutable, so this is the only time it is ever set.
  event RegistryDeployed(address indexed usdc);
  /// @notice Emitted when a new bill is created.
  event BillCreated(
    uint256 indexed billId,
    address indexed splitter,
    bytes32 indexed metadataHash,
    uint256 totalOwed,
    uint64 dueDate,
    bool escrowUntilFull
  );
  /// @notice Emitted when a debtor authorizes the splitter to collect after the due date.
  event CollectAuthorized(uint256 indexed billId, address indexed debtor);
  /// @notice Emitted when a debtor withdraws a previously granted collect mandate.
  event CollectRevoked(uint256 indexed billId, address indexed debtor);
  /// @notice Emitted when the splitter pulls an overdue debt under a mandate.
  event DebtCollected(uint256 indexed billId, address indexed debtor, address indexed splitter, uint256 amount);
  /// @notice Emitted when a third party funds someone else's debt.
  /// @dev {DebtPaid} always credits the debtor, so this is the only place the
  ///      funder is discoverable on chain.
  event DebtFunded(uint256 indexed billId, address indexed debtor, address indexed funder, uint256 amount);
  /// @notice Emitted when a participant's debt is paid down, by anyone.
  /// @dev `payer` is always the *debtor*, never the funder, so indexers and the
  ///      reputation scorer keep matching across v1 and v2.
  event DebtPaid(uint256 indexed billId, address indexed payer, uint256 amount, uint256 paidTotal, uint256 owedTotal);
  /// @notice Emitted when a payer withdraws their contribution from a failed
  ///         escrowed bill.
  /// @dev The mirror image of {DebtPaid} and carries the same fields, so an
  ///      indexer can net the two: `paidTotal` is the payer's share balance
  ///      *after* the withdrawal — always 0, since refunds are all-or-nothing —
  ///      and `owedTotal` is their unchanged share of the bill.
  event DebtRefunded(
    uint256 indexed billId,
    address indexed payer,
    uint256 amount,
    uint256 paidTotal,
    uint256 owedTotal
  );
  /// @notice Emitted when a splitter claims collected funds.
  event FundsClaimed(uint256 indexed billId, address indexed splitter, uint256 amount);

  /// @notice Per-participant debt accounting within a bill.
  /// @param owed Total amount the participant must repay.
  /// @param paid Amount the participant has repaid so far.
  /// @param exists Whether the participant belongs to the bill.
  struct Participant {
    uint256 owed;
    uint256 paid;
    bool exists;
  }

  /// @notice Aggregate state for a single bill.
  /// @dev `splitter` (20) + `dueDate` (8) + `exists` (1) + `escrowUntilFull` (1)
  ///      are declared consecutively so they share one 32-byte storage slot.
  /// @param splitter Creator entitled to claim collected funds.
  /// @param dueDate Unix seconds after which the bill is collectible and escrow
  ///        releases; 0 means the bill has no deadline.
  /// @param exists Whether the bill has been created.
  /// @param escrowUntilFull Whether claims are withheld until every participant has paid.
  /// @param metadataHash Opaque hash describing the bill off-chain.
  /// @param totalOwed Sum of all participants' owed amounts.
  /// @param totalPaid Sum of all participants' payments.
  /// @param claimed Amount already withdrawn by the splitter.
  /// @param participantList Ordered list of participant addresses.
  struct Bill {
    address splitter;
    uint64 dueDate;
    bool exists;
    bool escrowUntilFull;
    bytes32 metadataHash;
    uint256 totalOwed;
    uint256 totalPaid;
    uint256 claimed;
    address[] participantList;
  }

  /// @notice Maximum number of participants permitted in a single bill.
  /// @dev Bounds the `createBill` loop so creation can never be pushed past the
  ///      block gas limit, and keeps each bill's `participantList` enumerable.
  ///      Public because clients validate against it before submitting.
  uint256 public constant MAX_PARTICIPANTS = 256;

  /// @notice Maximum number of legs accepted in either array of {settle}.
  /// @dev An unbounded loop over caller-supplied arrays is a DoS-by-gas footgun.
  ///      64 pay legs is ~64 `transferFrom` calls, comfortably inside a block.
  ///      Do not raise this without measuring. Public because clients chunk
  ///      their batches against it before submitting.
  uint256 public constant MAX_BATCH = 64;

  /// @notice The USDC token used for every payment and claim.
  /// @dev ponytail: assumed non-rebasing and not fee-on-transfer. The address is
  ///      immutable and chosen at deploy, so this holds by construction. If the
  ///      registry ever needs to support a fee-on-transfer token, the upgrade
  ///      path is balance-delta accounting in {_payDebt} — and a fresh audit of
  ///      the reentrancy surface that introduces.
  IERC20 public immutable usdc;

  /// @notice Identifier that will be assigned to the next created bill.
  uint256 public nextBillId = 1;

  /// @notice Whether a debtor has authorized the splitter to pull their overdue share.
  mapping(uint256 billId => mapping(address debtor => bool authorized)) public collectMandate;

  /// @dev Bill state keyed by identifier; read through {_billOrRevert}.
  mapping(uint256 billId => Bill bill) private _bills;
  /// @dev Per-bill debt records; a zero record means "not a participant".
  mapping(uint256 billId => mapping(address participantAddress => Participant participantData)) private _participants;
  /// @dev Reverse index: bills an address owes a share of. Unbounded by design — see the contract note.
  mapping(address participant => uint256[] billIds) private _billsByParticipant;
  /// @dev Reverse index: bills an address created. Unbounded by design — see the contract note.
  mapping(address splitter => uint256[] billIds) private _billsBySplitter;

  /// @notice Binds this registry to the USDC token it will custody.
  /// @dev The token address is immutable; there is no setter and no upgrade path.
  /// @param usdc_ Address of the USDC token contract; must be non-zero.
  constructor(address usdc_) {
    if (usdc_ == address(0)) {
      revert InvalidConfiguration();
    }

    usdc = IERC20(usdc_);

    emit RegistryDeployed(usdc_);
  }

  /// @notice Creates a bill and records each participant's owed amount.
  /// @dev Array lengths are bounded and matched before anything else is read, so
  ///      a malformed batch is rejected before it can touch storage. Participant
  ///      addresses must be non-zero and unique within the bill, and every owed
  ///      amount must be non-zero. Reverts if more than {MAX_PARTICIPANTS} are
  ///      supplied, if a non-zero `dueDate` is already in the past (a bill
  ///      created already-collectible is not a feature), or if `escrowUntilFull`
  ///      is set without a `dueDate` to make its {refund} reachable.
  /// @param metadataHash Opaque hash describing the bill off-chain.
  /// @param participantAddresses Participant addresses, aligned 1:1 with `owedAmounts`.
  /// @param owedAmounts Amount owed by each participant.
  /// @param dueDate Unix seconds after which the bill becomes collectible; 0 for no deadline.
  /// @param escrowUntilFull Make the bill all-or-nothing: claims are withheld until every
  ///        participant has paid, and if it is still short at `dueDate` payers take their
  ///        money back via {refund}. Requires a non-zero `dueDate`.
  /// @return billId Identifier of the newly created bill.
  // A due date is inherently a wall-clock concept and the seconds of drift a
  // proposer could introduce are immaterial to a bill deadline.
  // slither-disable-next-line timestamp
  function createBill(
    bytes32 metadataHash,
    address[] calldata participantAddresses,
    uint256[] calldata owedAmounts,
    uint64 dueDate,
    bool escrowUntilFull
  ) external returns (uint256 billId) {
    uint256 count = participantAddresses.length;

    // Length checks come first: bound the loop, then match the two arrays.
    if (count > MAX_PARTICIPANTS) {
      revert TooManyParticipants(count, MAX_PARTICIPANTS);
    }

    if (count == 0) {
      revert InvalidConfiguration();
    }

    if (count != owedAmounts.length) {
      revert InvalidConfiguration();
    }

    // A bill created already-collectible would be instantly pullable.
    if (dueDate != 0 && dueDate < block.timestamp) {
      revert InvalidConfiguration();
    }

    // Escrow with no deadline is a permanent lock: nothing would ever make the
    // bill claimable or its payments refundable in an ownerless contract.
    if (escrowUntilFull && dueDate == 0) {
      revert InvalidConfiguration();
    }

    billId = nextBillId++;

    Bill storage bill = _bills[billId];
    bill.splitter = msg.sender;
    bill.metadataHash = metadataHash;
    bill.dueDate = dueDate;
    bill.escrowUntilFull = escrowUntilFull;
    bill.exists = true;

    // Left at the zero default on purpose; writing `= 0` costs gas for nothing.
    // slither-disable-next-line uninitialized-local
    uint256 runningTotal;

    for (uint256 i; i < count;) {
      address participantAddress = participantAddresses[i];
      uint256 owedAmount = owedAmounts[i];

      if (participantAddress == address(0)) {
        revert InvalidConfiguration();
      }

      if (owedAmount == 0) {
        revert InvalidConfiguration();
      }

      Participant storage participant = _participants[billId][participantAddress];

      // Duplicates would silently overwrite the earlier share.
      if (participant.exists) {
        revert AlreadyParticipant(billId, participantAddress);
      }

      // Field-wise assignment: `paid` is already zero, so writing it is a
      // wasted store.
      participant.owed = owedAmount;
      participant.exists = true;

      bill.participantList.push(participantAddress);
      _billsByParticipant[participantAddress].push(billId);
      runningTotal += owedAmount;

      unchecked {
        ++i;
      }
    }

    bill.totalOwed = runningTotal;
    _billsBySplitter[msg.sender].push(billId);

    emit BillCreated(billId, msg.sender, metadataHash, runningTotal, dueDate, escrowUntilFull);
  }

  /// @notice Pays `amount` toward the caller's debt on `billId`.
  /// @dev The caller must have approved this contract for at least `amount` of
  ///      USDC. State is updated before the token transfer and the call is
  ///      guarded against reentrancy.
  /// @param billId Identifier of the bill being paid.
  /// @param amount USDC amount to pay; non-zero and at most the remaining debt.
  function payDebt(uint256 billId, uint256 amount) external nonReentrant {
    _payDebt(billId, msg.sender, msg.sender, amount);
  }

  /// @notice Pays `amount` toward `debtor`'s debt on `billId`, funded by the caller.
  /// @dev Deliberately permissionless: it moves only the caller's own USDC and
  ///      only ever reduces `debtor`'s debt, capped at their `remaining`. This is
  ///      what lets an autopay agent settle a debt from its own wallet. The
  ///      {DebtPaid} event still names `debtor` as the payer so existing indexers
  ///      keep matching; {DebtFunded} records who actually paid.
  /// @param billId Identifier of the bill being paid.
  /// @param debtor Participant whose debt is credited.
  /// @param amount USDC amount to pay; non-zero and at most `debtor`'s remaining debt.
  function payDebtFor(uint256 billId, address debtor, uint256 amount) external nonReentrant {
    if (debtor == address(0)) {
      revert InvalidConfiguration();
    }

    _payDebt(billId, debtor, msg.sender, amount);

    emit DebtFunded(billId, debtor, msg.sender, amount);
  }

  /// @notice Authorizes this bill's splitter to pull the caller's remaining
  ///         share once the bill's due date has passed.
  /// @dev Participant-only, per-bill, and revocable via {revokeCollect}. The
  ///      mandate alone grants nothing: collection is still bounded by the
  ///      caller's own USDC approval, their balance and their remaining share.
  /// @param billId Identifier of the bill to authorize collection on.
  function authorizeCollect(uint256 billId) external {
    _billOrRevert(billId);

    // Only someone who actually owes on this bill can consent to a pull.
    if (!_participants[billId][msg.sender].exists) {
      revert NotParticipant(billId, msg.sender);
    }

    collectMandate[billId][msg.sender] = true;

    emit CollectAuthorized(billId, msg.sender);
  }

  /// @notice Withdraws a previously granted collect mandate.
  /// @dev Always available to the debtor: a consent that cannot be withdrawn is
  ///      not consent. Idempotent — revoking twice is not an error.
  /// @param billId Identifier of the bill to revoke collection on.
  function revokeCollect(uint256 billId) external {
    _billOrRevert(billId);

    if (!_participants[billId][msg.sender].exists) {
      revert NotParticipant(billId, msg.sender);
    }

    collectMandate[billId][msg.sender] = false;

    emit CollectRevoked(billId, msg.sender);
  }

  /// @notice Pulls up to `amount` of `debtor`'s overdue share into the bill.
  /// @dev Splitter-only, mandate-gated, and only after the bill's `dueDate`. The
  ///      amount actually moved is `min(amount, remaining, allowance, balance)`,
  ///      so the splitter cannot invent a figure — see the contract-level note.
  ///      Unlike `RecurringTab`'s multi-member sweep there is nothing to salvage
  ///      by continuing when nothing is collectible, so this reverts instead.
  /// @param billId Identifier of the bill to collect on.
  /// @param debtor Participant to pull from.
  /// @param amount Upper bound the splitter is asking for.
  function collectDebt(uint256 billId, address debtor, uint256 amount) external nonReentrant {
    Bill storage bill = _billOrRevert(billId);

    if (msg.sender != bill.splitter) {
      revert NotSplitter(billId, msg.sender);
    }

    // The debtor's standing consent, which they can withdraw at any time.
    if (!collectMandate[billId][debtor]) {
      revert NoCollectMandate(billId, debtor);
    }

    if (!_isDue(bill)) {
      revert NotYetDue(billId, bill.dueDate);
    }

    uint256 collected = _collectible(billId, debtor, amount);

    // Zero-comparison on a computed min() (not a raw token balance) — safe.
    // slither-disable-next-line incorrect-equality
    if (collected == 0) {
      revert NothingCollectible(billId, debtor);
    }

    // `from` is the debtor rather than msg.sender by design: this is the
    // mandated pull. Safe because the debtor set the per-bill mandate, can
    // revoke it, and bounds their own exposure with their approval and balance.
    // slither-disable-next-line arbitrary-send-erc20
    _payDebt(billId, debtor, debtor, collected);

    emit DebtCollected(billId, debtor, msg.sender, collected);
  }

  /// @notice Claims `amount` of collected funds from `billId` to the splitter.
  /// @dev Authorization, the escrow precondition and the balance cap all live in
  ///      {_claim}, next to the transfer they protect.
  /// @param billId Identifier of the bill to claim from.
  /// @param amount USDC amount to claim; non-zero and at most {claimable}.
  function claim(uint256 billId, uint256 amount) external nonReentrant {
    _claim(billId, amount);
  }

  /// @notice Withdraws the caller's contribution to a failed all-or-nothing bill.
  /// @dev The payer-side mirror of {claim}, and the reason {_isEscrowed} has no
  ///      due-date release: an `escrowUntilFull` bill that is past its `dueDate`
  ///      and still short of `totalOwed` has failed, so the money goes back to
  ///      the people who put it in rather than partially to the splitter.
  ///
  ///      Refunds the caller's whole `paid` balance; there is no partial variant
  ///      because a partial withdrawal from a bill that has already failed
  ///      serves nobody. `bill.claimed` is deliberately untouched and cannot be
  ///      non-zero here: {_claim} only succeeds once `totalPaid` has reached
  ///      `totalOwed`, and a bill at that mark is not refundable, so the claim
  ///      and refund paths are mutually exclusive by construction and neither
  ///      can drain the other's funds.
  ///
  ///      A refunded payer's `remaining` goes back up, so the bill can still be
  ///      revived — by them or by a {payDebtFor} funder — and claimed once it is
  ///      whole. Effects precede the single token interaction.
  /// @param billId Identifier of the failed bill to withdraw from.
  // Inherits {_isDue}'s wall-clock comparison; drift of seconds is immaterial.
  // slither-disable-next-line timestamp
  function refund(uint256 billId) external nonReentrant {
    Bill storage bill = _billOrRevert(billId);

    // Only an all-or-nothing bill can fail. On a plain bill a payment is the
    // splitter's the moment it lands, which is what the toggle opts out of.
    if (!bill.escrowUntilFull) {
      revert NotRefundable(billId);
    }

    // Before the deadline the bill can still be completed, so nothing has failed
    // yet and the payer's commitment is exactly what the other payers relied on.
    if (!_isDue(bill)) {
      revert NotYetDue(billId, bill.dueDate);
    }

    // It reached the line: the funds are the splitter's, deadline or not.
    if (bill.totalPaid >= bill.totalOwed) {
      revert NotRefundable(billId);
    }

    Participant storage participant = _participants[billId][msg.sender];
    uint256 amount = participant.paid;

    // Covers both "never on this bill" and "on it but never paid" — in either
    // case there is nothing of the caller's here to return.
    // Zero-comparison on bill accounting, not a raw token balance — safe.
    // slither-disable-next-line incorrect-equality
    if (amount == 0) {
      revert InvalidAmount();
    }

    participant.paid = 0;
    bill.totalPaid -= amount;

    emit DebtRefunded(billId, msg.sender, amount, 0, participant.owed);

    usdc.safeTransfer(msg.sender, amount);
  }

  /// @notice Claims every listed bill then pays every listed debt, in one call.
  /// @dev Claims run first so their proceeds can fund the pay legs within the
  ///      same transaction — that ordering is the contract, not an accident.
  ///      All-or-nothing: one bad leg reverts the batch, including claims that
  ///      already succeeded. No per-leg `try/catch`; a partially settled batch is
  ///      a state that would have to be reported and unwound, and atomicity is
  ///      cheaper than both. Both arrays are length-bounded before either loop
  ///      runs.
  /// @param claimBillIds Bills to claim in full; the caller must be each one's splitter.
  /// @param payBillIds Bills to pay toward, aligned 1:1 with `payAmounts`.
  /// @param payAmounts Amount per pay leg; 0 means "my whole remaining share".
  // Bounded by MAX_BATCH, and the whole call is nonReentrant.
  // slither-disable-next-line calls-loop,reentrancy-no-eth,reentrancy-events
  function settle(
    uint256[] calldata claimBillIds,
    uint256[] calldata payBillIds,
    uint256[] calldata payAmounts
  ) external nonReentrant {
    uint256 claimCount = claimBillIds.length;
    uint256 payCount = payBillIds.length;

    // Bound both loops before anything else, so an oversized batch is rejected
    // without reading a single element.
    if (claimCount > MAX_BATCH) {
      revert BatchTooLarge(claimCount, MAX_BATCH);
    }

    if (payCount > MAX_BATCH) {
      revert BatchTooLarge(payCount, MAX_BATCH);
    }

    if (payCount != payAmounts.length) {
      revert InvalidConfiguration();
    }

    if (claimCount == 0 && payCount == 0) {
      revert InvalidConfiguration();
    }

    for (uint256 i; i < claimCount;) {
      uint256 billId = claimBillIds[i];
      Bill storage bill = _billOrRevert(billId);

      // Read the raw remainder rather than {claimable}: an escrowed bill must
      // surface {Escrowed} from {_claim}, not a zero-amount {ClaimExceedsBalance}.
      // {_claim} re-checks that msg.sender is this bill's splitter.
      _claim(billId, bill.totalPaid - bill.claimed);

      unchecked {
        ++i;
      }
    }

    for (uint256 i; i < payCount;) {
      uint256 billId = payBillIds[i];
      uint256 amount = payAmounts[i];

      // 0 means "whatever I still owe", resolved at execution time so a
      // concurrent payment cannot make this leg revert on a stale figure.
      if (amount == 0) {
        Participant storage participant = _participants[billId][msg.sender];
        amount = participant.owed - participant.paid;
      }

      _payDebt(billId, msg.sender, msg.sender, amount);

      unchecked {
        ++i;
      }
    }
  }

  /// @notice Returns the amount of `billId` the splitter may claim right now.
  /// @dev Returns 0 while the bill is escrowed, so a UI never offers a claim
  ///      that would revert.
  /// @param billId Identifier of the bill to query.
  /// @return amount Claimable USDC balance for the bill.
  function claimable(uint256 billId) external view returns (uint256 amount) {
    Bill storage bill = _billOrRevert(billId);

    if (!_isEscrowed(bill)) {
      amount = bill.totalPaid - bill.claimed;
    }
  }

  /// @notice Returns what {collectDebt} would move for `debtor` right now.
  /// @dev 0 when there is no mandate, the bill is not yet due, or the debtor's
  ///      remaining/allowance/balance leave nothing to pull. Lets the dunning
  ///      agent ask "would this succeed?" without simulating a revert.
  /// @param billId Identifier of the bill to query.
  /// @param debtor Participant to price a collection for.
  /// @return amount USDC amount a collection would move.
  function collectible(uint256 billId, address debtor) external view returns (uint256 amount) {
    Bill storage bill = _billOrRevert(billId);

    // Wall-clock due date; see {_isDue}.
    // slither-disable-next-line timestamp
    if (collectMandate[billId][debtor] && _isDue(bill)) {
      amount = _collectible(billId, debtor, type(uint256).max);
    }
  }

  /// @notice Returns the stored details of `billId`.
  /// @dev `participantList` is bounded by {MAX_PARTICIPANTS}, so this getter is
  ///      always returnable in a single call.
  /// @param billId Identifier of the bill to query.
  /// @return splitter Creator entitled to claim funds.
  /// @return metadataHash Opaque off-chain metadata hash.
  /// @return totalOwed Sum of all participants' owed amounts.
  /// @return totalPaid Sum of all payments received.
  /// @return claimed Amount already withdrawn by the splitter.
  /// @return dueDate Unix seconds after which the bill is collectible; 0 for none.
  /// @return escrowUntilFull Whether claims are withheld until the bill is fully paid.
  /// @return participantList Ordered list of participant addresses.
  function getBill(uint256 billId)
    external
    view
    returns (
      address splitter,
      bytes32 metadataHash,
      uint256 totalOwed,
      uint256 totalPaid,
      uint256 claimed,
      uint64 dueDate,
      bool escrowUntilFull,
      address[] memory participantList
    )
  {
    Bill storage bill = _billOrRevert(billId);

    splitter = bill.splitter;
    metadataHash = bill.metadataHash;
    totalOwed = bill.totalOwed;
    totalPaid = bill.totalPaid;
    claimed = bill.claimed;
    dueDate = bill.dueDate;
    escrowUntilFull = bill.escrowUntilFull;
    participantList = bill.participantList;
  }

  /// @notice Returns the debt record for `participantAddress` on `billId`.
  /// @dev Does not revert on an unknown bill or a non-participant; it reports
  ///      `exists == false` so a client can distinguish "owes nothing" from
  ///      "not on this bill" without handling a revert.
  /// @param billId Identifier of the bill to query.
  /// @param participantAddress Participant whose record is requested.
  /// @return owed Total amount the participant must repay.
  /// @return paid Amount the participant has repaid so far.
  /// @return exists Whether the participant belongs to the bill.
  function getParticipant(uint256 billId, address participantAddress)
    external
    view
    returns (uint256 owed, uint256 paid, bool exists)
  {
    Participant storage participant = _participants[billId][participantAddress];

    owed = participant.owed;
    paid = participant.paid;
    exists = participant.exists;
  }

  /// @notice Lists every bill `participantAddress` owes a share of.
  /// @dev Unbounded: anyone can add anyone to a bill, so this array has no cap.
  ///      Clients that cannot tolerate a failed `eth_call` should page with
  ///      {billCountForParticipant} and {billIdsForParticipantPaged} instead.
  /// @param participantAddress Address to look up.
  /// @return billIds Identifiers of bills the address participates in.
  function billIdsForParticipant(address participantAddress) external view returns (uint256[] memory billIds) {
    billIds = _billsByParticipant[participantAddress];
  }

  /// @notice Lists every bill created by `splitter`.
  /// @dev Unbounded; see {billIdsForSplitterPaged} for the bounded read.
  /// @param splitter Address to look up.
  /// @return billIds Identifiers of bills the address created.
  function billIdsForSplitter(address splitter) external view returns (uint256[] memory billIds) {
    billIds = _billsBySplitter[splitter];
  }

  /// @notice Number of bills `participantAddress` owes a share of.
  /// @dev Pairs with {billIdsForParticipantPaged} to read the index in windows.
  /// @param participantAddress Address to look up.
  /// @return count Length of the address's participant index.
  function billCountForParticipant(address participantAddress) external view returns (uint256 count) {
    count = _billsByParticipant[participantAddress].length;
  }

  /// @notice Number of bills created by `splitter`.
  /// @dev Pairs with {billIdsForSplitterPaged} to read the index in windows.
  /// @param splitter Address to look up.
  /// @return count Length of the address's splitter index.
  function billCountForSplitter(address splitter) external view returns (uint256 count) {
    count = _billsBySplitter[splitter].length;
  }

  /// @notice A bounded window of {billIdsForParticipant}.
  /// @dev Returns an empty array once `offset` runs past the end, and silently
  ///      shortens the last window; it never reverts on an out-of-range read.
  /// @param participantAddress Address to look up.
  /// @param offset Index to start from.
  /// @param limit Maximum number of identifiers to return.
  /// @return billIds Identifiers in `[offset, offset + limit)`, clamped to the end.
  function billIdsForParticipantPaged(address participantAddress, uint256 offset, uint256 limit)
    external
    view
    returns (uint256[] memory billIds)
  {
    billIds = _page(_billsByParticipant[participantAddress], offset, limit);
  }

  /// @notice A bounded window of {billIdsForSplitter}.
  /// @dev Returns an empty array once `offset` runs past the end, and silently
  ///      shortens the last window; it never reverts on an out-of-range read.
  /// @param splitter Address to look up.
  /// @param offset Index to start from.
  /// @param limit Maximum number of identifiers to return.
  /// @return billIds Identifiers in `[offset, offset + limit)`, clamped to the end.
  function billIdsForSplitterPaged(address splitter, uint256 offset, uint256 limit)
    external
    view
    returns (uint256[] memory billIds)
  {
    billIds = _page(_billsBySplitter[splitter], offset, limit);
  }

  /// @notice Credits a payment against a participant's share of a bill.
  /// @dev Credits `amount` against `debtor`'s share of `billId`, funded by
  ///      `funder`. Effects (including the event) precede the single token
  ///      interaction, so a failed transfer reverts the whole call and the log
  ///      can never describe an unpaid debt. Deliberately unguarded: every
  ///      caller is an outer `nonReentrant` entrypoint.
  /// @param billId Identifier of the bill being paid.
  /// @param debtor Participant whose debt is reduced.
  /// @param funder Address the USDC is pulled from.
  /// @param amount USDC amount; non-zero and at most `debtor`'s remaining debt.
  function _payDebt(uint256 billId, address debtor, address funder, uint256 amount) private {
    Bill storage bill = _billOrRevert(billId);
    Participant storage participant = _participants[billId][debtor];

    if (!participant.exists) {
      revert NotParticipant(billId, debtor);
    }

    uint256 owed = participant.owed;
    uint256 paid = participant.paid;

    // Zero-comparison on a caller-supplied argument, not a token balance — safe.
    // slither-disable-next-line incorrect-equality
    if (amount == 0) {
      revert InvalidAmount();
    }

    // The cap is what keeps `totalPaid` from ever exceeding `totalOwed`.
    if (amount > owed - paid) {
      revert InvalidAmount();
    }

    uint256 newPaid = paid + amount;
    participant.paid = newPaid;
    bill.totalPaid += amount;

    emit DebtPaid(billId, debtor, amount, newPaid, owed);

    usdc.safeTransferFrom(funder, address(this), amount);
  }

  /// @notice Sends collected funds from a bill to that bill's splitter.
  /// @dev Authorization lives here, next to the transfer, so {claim} and
  ///      {settle} cannot diverge and a future caller cannot forget it. The
  ///      recipient is read from storage rather than assumed to be `msg.sender`.
  ///      The escrow precondition lives here too, so {settle}'s claim loop
  ///      inherits it and cannot be used to bypass escrow. Effects precede the
  ///      interaction. Deliberately unguarded: every caller is an outer
  ///      `nonReentrant` entrypoint.
  /// @param billId Identifier of the bill to claim from.
  /// @param amount USDC amount to claim; non-zero and at most the unclaimed balance.
  function _claim(uint256 billId, uint256 amount) private {
    Bill storage bill = _billOrRevert(billId);
    address splitter = bill.splitter;

    if (msg.sender != splitter) {
      revert NotSplitter(billId, msg.sender);
    }

    if (_isEscrowed(bill)) {
      revert Escrowed(billId, bill.totalPaid, bill.totalOwed);
    }

    uint256 claimedTotal = bill.claimed;
    uint256 claimableAmount = bill.totalPaid - claimedTotal;

    if (amount == 0) {
      revert ClaimExceedsBalance();
    }

    if (amount > claimableAmount) {
      revert ClaimExceedsBalance();
    }

    bill.claimed = claimedTotal + amount;

    emit FundsClaimed(billId, splitter, amount);

    usdc.safeTransfer(splitter, amount);
  }

  /// @notice Prices what a mandated collection would move, ignoring permissions.
  /// @dev Returns `min(request, remaining, allowance, balance)` for `debtor` on
  ///      `billId`, without checking the mandate or the due date — callers do
  ///      that. Shared by {collectDebt} and {collectible} so the view and the
  ///      state-changing function can never disagree.
  /// @param billId Identifier of the bill to price against.
  /// @param debtor Participant the funds would come from.
  /// @param request Upper bound the caller is asking for.
  /// @return amount The bounded amount a collection would move.
  function _collectible(uint256 billId, address debtor, uint256 request) private view returns (uint256 amount) {
    Participant storage participant = _participants[billId][debtor];

    if (participant.exists) {
      uint256 remaining = participant.owed - participant.paid;

      amount = _min(request, _min(remaining, _min(usdc.allowance(debtor, address(this)), usdc.balanceOf(debtor))));
    }
  }

  /// @notice Whether a bill's deadline has passed.
  /// @dev A bill with no deadline is never due, so the explicit `dueDate != 0`
  ///      guard is what stops every no-deadline bill from being instantly
  ///      collectible.
  /// @param bill Storage reference to the bill.
  /// @return due True once the deadline is reached.
  // A bill deadline is a wall-clock concept; proposer drift of seconds is immaterial.
  // slither-disable-next-line timestamp
  function _isDue(Bill storage bill) private view returns (bool due) {
    due = bill.dueDate != 0 && block.timestamp >= bill.dueDate;
  }

  /// @notice Whether a bill's funds are currently withheld from its splitter.
  /// @dev Escrow releases on one condition only: every participant has paid.
  ///      There is deliberately no due-date release. A deadline that handed the
  ///      splitter a partial pot would make the toggle worthless to the payers
  ///      it exists to protect — the creditor would simply wait it out. Past the
  ///      deadline a short bill has failed, and {refund} is what unlocks it, in
  ///      the payers' direction. That is also why this cannot strand funds
  ///      without an admin: every route out of a failed bill is self-service.
  /// @param bill Storage reference to the bill.
  /// @return escrowed True while claims must be refused.
  function _isEscrowed(Bill storage bill) private view returns (bool escrowed) {
    escrowed = bill.escrowUntilFull && bill.totalPaid < bill.totalOwed;
  }

  /// @notice Loads a bill, rejecting identifiers that were never created.
  /// @dev Every entrypoint routes through this so an unknown bill can never be
  ///      mistaken for an empty one.
  /// @param billId Identifier of the bill to load.
  /// @return bill Storage reference to the bill.
  function _billOrRevert(uint256 billId) private view returns (Bill storage bill) {
    bill = _bills[billId];

    if (!bill.exists) {
      revert UnknownBill(billId);
    }
  }

  /// @notice Copies a bounded window of a storage array into memory.
  /// @dev Clamps rather than reverts, and computes the end without adding
  ///      `offset + limit` so a `type(uint256).max` limit cannot overflow.
  /// @param ids Storage array to read from.
  /// @param offset Index to start from.
  /// @param limit Maximum number of entries to copy.
  /// @return page The clamped window.
  function _page(uint256[] storage ids, uint256 offset, uint256 limit) private view returns (uint256[] memory page) {
    uint256 total = ids.length;
    uint256 available = offset < total ? total - offset : 0;
    uint256 size = limit < available ? limit : available;

    page = new uint256[](size);

    for (uint256 i; i < size;) {
      page[i] = ids[offset + i];

      unchecked {
        ++i;
      }
    }
  }

  /// @notice Returns the smaller of two values.
  /// @dev Used to build the collection cap out of four independent bounds.
  /// @param a First value.
  /// @param b Second value.
  /// @return smaller The lesser of `a` and `b`.
  function _min(uint256 a, uint256 b) private pure returns (uint256 smaller) {
    smaller = a < b ? a : b;
  }
}
