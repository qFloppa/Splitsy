# On-chain autopay mandate — design

Date: 2026-07-30
Status: approved, ready for an implementation plan

## Problem

Autopay v2 gave the agent its own wallet and paid with `payDebtFor`, which
spends `msg.sender`'s USDC. That makes the agent a **sponsor** — a corporate
card that fronts your money — so it has to be pre-funded with a float, and the
spending ceilings the user sets live only in Postgres. Two consequences:

1. A user who already has a funded DCW is asked to fund a *second* wallet for
   no reason they can see.
2. "The agent respects a 3 USDC/day cap" is a claim about our server, not a
   fact anyone can verify. For an agentic-economy submission that is the whole
   point, and it is exactly the claim a judge will probe.

The mandate must be a thing the chain enforces, and the money must come from
the user's own wallet.

## Decisions

| Question | Decision | Why |
|---|---|---|
| Where does the mandate live? | A standalone `AutopayMandate` contract in front of the existing registry | No registry redeploy: bills 1–7 survive, the SCP monitors stay valid, no reputation re-key, no `_V1` env dance |
| Daily ceiling semantics | Token bucket refilling at `maxPerDay` per 24h | A true rate limit with no midnight-boundary exploit; 2 slots and ~10 lines, versus an unbounded timestamp queue |
| Score floor + verified hash | Stay off chain as an agent pre-flight | ERC-8004 stores individual feedback, not an aggregate; the contract cannot see the off-chain preimage |
| USDC approval bound | `maxPerDay × 7`, derived, set atomically with the mandate | Bounds total exposure without adding a third number to explain in a demo |
| Agent gas | Circle Gas Station | Arc Testnet is supported with a preconfigured testnet policy; removes the last reason to fund the agent |

## Architecture

```
Someone creates a bill
   └─> BillCreated  ──(Circle SCP monitor)──> /api/webhooks/circle
                                                 └─> POST /api/agents/autopay
                                                        │
                            ┌───────────────────────────┴───────────────────┐
                            │ Layer 1 — agent judgment (off chain)          │
                            │ lib/autopay.ts: score floor, verified hash,   │
                            │ and a pre-flight of the on-chain caps so a    │
                            │ doomed pull never costs gas. Every decline is │
                            │ logged in autopay_log with its reason.        │
                            └───────────────────────────┬───────────────────┘
                                                        │ survives?
                                                        ▼
                                    AutopayMandate.payFor(billId, debtor)
                            ┌───────────────────────────┴───────────────────┐
                            │ Layer 2 — contract enforcement (on chain)     │
                            │ agent identity, creator allowlist, per-bill   │
                            │ cap, token bucket. Reverts regardless of what │
                            │ the server believes.                          │
                            └───────────────────────────┬───────────────────┘
                                                        ▼
                              usdc.transferFrom(debtor → mandate)   ← debtor's own USDC
                              usdc.approve(registry, amount)        ← exact, fully consumed
                              registry.payDebtFor(billId, debtor, amount)
                                        └─> DebtPaid(billId, debtor, …)  ← unchanged indexer key
```

The registry address is `immutable` on `AutopayMandate`, never a call parameter.
A registry passed in by the caller would let a compromised agent point the
mandate at a contract of its own and drain the approval.

`payDebtFor` emits `DebtPaid` naming the **debtor** as payer
(`BillSplitRegistry.sol:369-370`), so the existing reputation scoring path
through the SCP webhook keeps working untouched. `DebtFunded` will name the
mandate contract as the funder, which is cosmetic.

## Contract — `contracts/AutopayMandate.sol`

Follows the vendored-dependency style already in `contracts/`: local
`SafeERC20`, `ReentrancyGuard`, `IERC20`, Solidity 0.8.36, `cancun`.

```solidity
struct Mandate {
  address agent;        // address(0) = autopay off
  uint96  maxPerBill;   // packs with agent into one slot
  uint128 maxPerDay;
  uint128 spent;        // token bucket, decays toward 0
  uint64  lastSpendAt;
}

mapping(address => Mandate) public mandates;             // debtor => mandate
mapping(address => address[]) private _allowedCreators;  // empty = anyone

uint256 public constant MAX_ALLOWED_CREATORS = 10;

IERC20  public immutable usdc;
IBillSplitRegistry public immutable registry;
```

### Functions

| Function | Caller | Behaviour |
|---|---|---|
| `setMandate(address agent, uint96 maxPerBill, uint128 maxPerDay, address[] creators)` | debtor, for themselves | Writes the mandate and replaces the allowlist. Leaves `spent`/`lastSpendAt` alone. `creators.length > MAX_ALLOWED_CREATORS` reverts |
| `revokeMandate()` | debtor | Zeroes `agent` **and** `spent`. Autopay off, immediately |
| `allowedCreators(address debtor) view` | anyone | The allowlist, so the UI reads it from chain rather than a mirror |
| `spendable(uint256 billId, address debtor) view` | anyone | What `payFor` would move right now; `0` when any rule blocks it. Mirrors the existing `collectible()` precedent at `BillSplitRegistry.sol:621` |
| `dailyHeadroom(address debtor) view` | anyone | The token bucket's current room, after refill. The agent's pre-flight passes `maxPerDay - dailyHeadroom` as `spentTodayUsdc`, which is what keeps `lib/autopay.ts` unchanged |
| `payFor(uint256 billId, address debtor)` | `mandates[debtor].agent` only | The pull |

### `payFor` order of operations

1. `m = mandates[debtor]`; `m.agent == address(0)` → `NoMandate`; `msg.sender != m.agent` → `NotAgent`.
2. `(owed, paid, exists) = registry.getParticipant(billId, debtor)`; `!exists` → `NotParticipant`; `amount = owed - paid`; `0` → `NothingOwed`.
3. Creator allowlist: if non-empty, destructure `registry.getBill(billId)` for
   its first return value (`splitter`) and reject an absent one with
   `CreatorNotAllowed`. Linear scan, bounded by `MAX_ALLOWED_CREATORS`.
4. `amount > m.maxPerBill` → `OverBillCap`.
5. Token bucket:
   ```solidity
   uint256 refill = (block.timestamp - m.lastSpendAt) * m.maxPerDay / 1 days;
   uint256 spent  = refill >= m.spent ? 0 : m.spent - refill;
   if (spent + amount > m.maxPerDay) revert OverDailyCap();
   ```
   Intermediates in `uint256`. `lastSpendAt == 0` (first ever spend) yields a
   refill large enough to zero the bucket, which is correct.
6. **Effects before interactions**: `m.spent = spent + amount`, `m.lastSpendAt = block.timestamp`.
7. `usdc.safeTransferFrom(debtor, address(this), amount)` — bounded by the
   debtor's approval and balance; a short allowance reverts here.
8. `registry.payDebtFor(billId, debtor, amount)`, which pulls that same amount
   straight back out under the constructor-time approval (below).
9. `emit MandateSpent(billId, debtor, msg.sender, amount)`.

### The mandate→registry approval

The constructor approves the registry for `type(uint256).max` once, so `payFor`
never spends gas on an approval. This is safe because of how the registry
pulls: every `_payDebt` path takes its funder from `msg.sender`
(`payDebt`, `payDebtFor`), and the one path that names a different funder —
`collectDebt` — requires that funder to have set `collectMandate` themselves.
This contract never sets one. So the approval is only ever exercisable by this
contract's own call, and the contract holds no idle balance to take in any case.

The vendored `contracts/interfaces/IERC20.sol` declares no `approve`, and
`SafeERC20` has only `safeTransfer`/`safeTransferFrom`. Add `approve` to the
interface — a one-line additive change that the registry does not use and is
therefore unaffected by. Do not add a `safeApprove` to `SafeERC20` for a single
constructor call.

`nonReentrant` on `payFor` even though the registry is immutable and trusted —
the contract touches USDC, and the guard is already vendored.

### Events and errors

Events: `MandateSet(debtor, agent, maxPerBill, maxPerDay, creatorCount)`,
`MandateRevoked(debtor)`, `MandateSpent(billId, debtor, agent, amount)`.

Errors: `NoMandate`, `NotAgent`, `NotParticipant`, `NothingOwed`,
`CreatorNotAllowed`, `OverBillCap`, `OverDailyCap`, `TooManyCreators`.

### Invariants

- No path moves USDC except `payFor`, and only from `debtor` to the registry.
- The contract holds a non-zero USDC balance only *within* one `payFor` call.
- No owner, no admin, no upgrade hook. Nothing to seize and nobody to trust.
- `revokeMandate` is always available and never reverts for a live mandate — a
  consent that cannot be withdrawn is not consent (the same rule
  `revokeCollect` already follows).

### The bucket survives a settings change

`setMandate` deliberately does **not** touch `spent` or `lastSpendAt`. Zeroing
them would make re-saving the settings panel a cap reset: pay 3 of a 3/day
ceiling, hit Save, pay 3 more. Only the debtor can call `setMandate`, so that
was never an agent-exploitable hole — but "the daily cap holds unless you press
Save" is not a cap, and it is the first thing worth probing about this design.

Carrying the bucket costs nothing and needs no special cases. Refill always
uses the *current* `maxPerDay`, so lowering a cap mid-day binds immediately:
`spent` may temporarily exceed the new ceiling, and `spent + amount >
maxPerDay` simply declines every pull until it decays. Raising a cap takes
effect at once. A stale mandate re-enabled after a long gap refills to zero on
its first evaluation, so nothing needs clearing on the way back in.

`revokeMandate` still zeroes `spent`, because that path also zeroes `agent`:
there is no mandate left for a budget to belong to. Re-enabling after a revoke
therefore starts fresh, which is the one reset path — and it costs a revoke
transaction plus a new approval, not a click on Save.

## Off-chain changes

| File | Change |
|---|---|
| `contracts/AutopayMandate.sol` | New |
| `contracts/interfaces/IBillSplitRegistry.sol` | New, minimal: `getBill`, `getParticipant`, `payDebtFor` |
| `contracts/interfaces/IERC20.sol` | One line: add `approve` |
| `contracts/AutopayMandate.t.sol` | New |
| `scripts/deploy-autopay-mandate.ts` | New, mirroring `deploy-bill-split-registry.ts`, printing the env line to set |
| `package.json` | `deploy:arc:autopay-mandate`, and `AutopayMandate.t.sol` rides the existing `test:contracts` |
| `lib/registry-calldata.ts` | `encodeSetMandate`, `encodeRevokeMandate`, `encodePayFor` + the ABI fragment |
| `lib/arc-read.ts` | `MANDATE_ADDRESS`, `getAutopayMandateOnchain(debtor)`, `getMandateSpendableOnchain(billId, debtor)` |
| `lib/autopay.ts` | **Unchanged.** Its inputs get sourced differently; the decision core and `lib/autopay.test.ts` stand as they are |
| `app/api/agents/autopay/route.ts` | Grant fields read from chain; `spentTodayUsdc` derived from the on-chain bucket; the send becomes one `payFor` from the agent wallet. `autopay_log` claim/finalize stays — it is the idempotency key and the explainability record |
| `app/api/agents/grants/route.ts` | POST signs `executeBatch([approve, setMandate])` (or `revokeMandate`) from the user's DCW; GET reads caps and allowlist from chain |
| `app/SettlementAgentsPanel.tsx` | Copy: the agent spends *your* wallet under an on-chain mandate. Show the approved allowance and link the mandate tx |
| `schema-agents.sql` | Comment update. `max_per_*` and `trusted_creators` become a display mirror; no migration, no column drops |

Enabling autopay becomes one transaction from the user's own wallet:

```js
executeBatch([
  approve(MANDATE_ADDRESS, maxPerDay * 7n),
  setMandate(AGENT_ADDRESS, maxPerBill, maxPerDay, creators),
])
```

## Gas Station

Arc Testnet supports Gas Station for developer-controlled SCA wallets and ships
a **preconfigured testnet policy**, so this is expected to need no code change:
error `177012` ("sca transaction needs feeLevel provided") confirms `feeLevel`
stays in the request even for sponsored transactions, which is what
`lib/circle-dcw.ts:47,87` already sends.

Treat it as a verification step, not an assumption — the existing
`InsufficientFundsError` path and the "needs a little test USDC for gas" copy
suggest sponsorship is not currently reaching these wallets. Confirm a sponsored
transaction appears under the policy in the Circle console. If it does not, the
fallback is unchanged from today: keep a couple of USDC in the agent wallet.
Either way the agent never holds bill money. Update the `ponytail:` note at
`lib/circle-dcw.ts:25-27` with whichever outcome holds.

## Rollout

1. `npm run test:contracts`
2. Deploy `AutopayMandate(registry, usdc)` to Arc Testnet.
3. Set `NEXT_PUBLIC_AUTOPAY_MANDATE_ADDRESS` and
   `NEXT_PUBLIC_AUTOPAY_AGENT_ADDRESS=0x41f79469e443999587cfacbd89ff5e2b6955f3c4`.
4. Re-enable autopay in the UI once, which writes the on-chain mandate.
5. Have a second account bill the user; watch `MandateSpent` and the decision row.

No registry redeploy. No `circle-scp-monitor-setup.ts` re-run — the `BillCreated`
and `DebtPaid` monitors registered on 2026-07-30 for
`0x924Cf4331741401cBc720770937C132A974E1a3b` remain correct.

## Testing

`contracts/AutopayMandate.t.sol`, in the style of `BillSplitRegistry.t.sol`
(vendored `Test.sol`, `MockUSDC`):

- pays the full remaining share and credits the debtor on the registry
- a share above `maxPerBill` reverts `OverBillCap`
- two spends inside one day exceeding `maxPerDay` revert `OverDailyCap`
- the bucket refills: the same second spend succeeds after `warp(12 hours)` for a half-cap amount
- a non-empty allowlist rejects a stranger creator and admits a listed one
- a caller that is not `mandates[debtor].agent` reverts `NotAgent`
- calling `setMandate` again after a spend does **not** clear the day's spend: the next over-cap `payFor` still reverts `OverDailyCap`
- lowering `maxPerDay` below the current `spent` blocks the next pull rather than reverting the settings change
- `revokeMandate` makes the next `payFor` revert `NoMandate`
- a short USDC approval reverts, and `spendable` returns 0 for that case beforehand
- no USDC remains on the mandate contract after a successful `payFor`

Unchanged and still required: `npm run test:agents` (`lib/autopay.test.ts`).

End-to-end: the rollout steps above, confirming the `MandateSpent` log, the
`DebtPaid` event, and a `pay` row in `autopay_log`.

## Demo narrative

1. Show the mandate on a block explorer: caps, agent address, allowance.
2. Have a second account bill the user 2 USDC.
3. The agent pays within seconds, unattended. Show `MandateSpent`.
4. Raise the bill above the cap; show the skip row and the reason.
5. Call `payFor` from a wallet that is not the agent; it reverts. The caps are
   the chain's, not the server's.

## Out of scope

- Moving the creator-score floor on chain (needs an aggregate in the reputation
  registry plus a backfill).
- Mainnet Gas Station policy and billing.
- Any change to `collectMandate` / `collectDebt`, which remain the separate
  creditor-side pull.
