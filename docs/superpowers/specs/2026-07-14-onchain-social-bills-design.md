# On-chain (registry) bills with social participants

**Date:** 2026-07-14
**Status:** Approved design

## Goal

Let the deployed `BillSplitRegistry` escrow accept **social participants** (X / Discord / email), in both directions:

- A **non-custodial wallet creator** (Rabby/MetaMask) writes an on-chain bill whose participants may be raw `0x…` addresses, `@x` handles, Discord usernames, or emails — in any mix.
- A **social creator** (signed-in Splitsy user with a Circle developer-controlled wallet, DCW) writes the same kind of on-chain bill, executed from their DCW — including raw-address participants ("vice versa").
- A **social payer** settles their escrow debt with one click (server triggers `approve` + `payDebt` from their DCW).
- The **creator claims** explicitly: non-custodial via the existing in-wallet `claimBillFunds`, social via a server-triggered `claim` from their DCW.

No contract changes. The deployed registry (`createBill` / `payDebt` / `claim`) is used as-is.

## Decisions (user-confirmed)

1. **Unregistered tagged users → pre-mint a wallet at tag time.** The server provisions a Circle DCW for the handle immediately, so `createBill` always has a real address. The person adopts that wallet when they sign in.
2. **One-click pay, creator claims.** Escrow semantics stay explicit — payers pay into the contract, the creator sees "Claimable" and claims. No auto-claim.
3. **Both directions in scope** (non-custodial creator and social creator).
4. **Approach A — chain-native + tiny bridge table.** The chain is the only ledger for these bills; no `bills`/`bill_debts` mirror rows. The only new persistent state is a `pending_wallets` bridge table. Handles travel as participant labels inside the existing on-chain-verified preimage. (Rejected: B — mirror bills into Supabase: two sources of truth, drift risk. Rejected: C — counterfactual addresses: rebuilds the wallet layer, fights the DCW model.)

## Architecture

### Address resolution (the bridge)

New server module `lib/wallet-resolve.ts`:

```
resolveParticipantAddress(provider, handle):
  1. users lookup by (provider, handle)          → wallet_address if present
  2. pending_wallets lookup by (provider, handle) → address if present
  3. else pre-mint a DCW with refId "prem:<provider>:<handle>"
     (namespaced so it can never collide with signin refIds "<provider>:<id>"),
     insert a pending_wallets row, return its address
```

Handles are normalized exactly as `bills-repo` does today: strip leading `@`, lowercase.

New table `schema-pending-wallets.sql`:

```sql
pending_wallets (
  provider          text not null,
  handle            text not null,
  wallet_address    text not null,
  circle_wallet_id  text not null,
  primary key (provider, handle)
)
```

**Adoption at sign-in:** in `finishProviderLogin` (`lib/oauth-callback.ts`), for a user with **no** `wallet_address`: check `pending_wallets` for `(provider, handle)` first — if found, `setUserWallet` with the pending address/wallet-id and delete the pending row; else `getOrCreateArcWallet` as today. Existing users keep their wallet (resolution step 1 already used it, so their on-chain escrow position matches the wallet they hold).

**Accepted edge:** an X/Discord handle rename between tag and sign-in orphans the pre-minted wallet — the same limitation the off-chain handle-tagging path already has. No recovery flow.

### Creation flows

**Non-custodial creator** (extends `submitBillOnchain` in `app/HomeClient.tsx`):

1. UI allows social rows in the on-chain form (participant rows already carry a per-row provider from the off-chain work; the select gains a "Wallet address" option).
2. Client calls `POST /api/onchain-bills/resolve` with the social rows → `[{provider, handle, address}]` (pre-minting as needed).
3. Client calls the existing `createBillSplit` with resolved addresses. `participantLabels` (hashed into the commitment, so the format is pinned): social rows use the normalized handle with the provider's display prefix — `@alice` (x), `alice` (discord), `alice@example.com` (email) — address rows keep their existing label (e.g. "Payer 1"). Both creation paths compute labels identically. Provider recovery from a label for avatar display is best-effort (`@…` → x, contains `@` mid-string → email, else plain); a wrong guess only affects the avatar, never verification.
4. Preimage publish unchanged (`POST /api/onchain-bills/preimage`) — it now carries handles as labels, so verification and display both work with zero new plumbing.

**Social creator:** `POST /api/onchain-bills/create` (session required) with `{merchant, currency, total, participants: [{provider?, handle?, address?, amountUsd}], receiptHash?, receiptImageBase64?}` (same receipt fields the preimage route accepts today). Server:

1. Resolve all participants to addresses.
2. Build `metadataHash` via the existing isomorphic `billMetadataHash`.
3. Execute `createBill` from the creator's DCW (see below), parse `BillCreated` from the receipt.
4. Publish the preimage server-side (reuse `publishOnchainBillPreimage`).
5. Return `billId`.

### DCW contract execution

`lib/circle-dcw.ts` gains one generic function:

```
executeContractOnArc(walletId, contractAddress, callData) → { id, state, txHash }
```

Circle `createTransaction` with `contractAddress` + `callData` (same SDK-cast pattern as `transferUsdcOnArc`), then poll `getTransaction` until `CONFIRMED`/failed, bounded (~60s) — callers need the receipt (billId, payment success). Call data is encoded server-side with viem `encodeFunctionData` against the existing `billSplitRegistryAbi`.

Used three ways: `createBill` (social creator), `approve` + `payDebt` (social payer, two sequential txs), `claim` (social creator).

### Settlement + claim

- **Social payer:** `POST /api/onchain-bills/[billId]/pay` (session required). Server reads the debt from chain (`getParticipant(billId, user.wallet_address)`) — never trusts a client amount — requires remaining > 0, then DCW-executes `approve(registry, remaining)` + `payDebt(billId, remaining)`. Full remaining amount only (matches the off-chain Pay button).
- **Non-custodial payer:** unchanged — these are ordinary registry bills; the existing in-wallet `payBillDebtWithMemo` path works.
- **Claim:** non-custodial creator unchanged (`claimBillFunds`). Social creator: `POST /api/onchain-bills/[billId]/claim` → server checks `getBill().splitter === user.wallet_address`, DCW-executes `claim(billId, claimable)`.
- **Funding reality (unchanged):** a DCW needs USDC for its share plus a little for gas. Reuse the existing insufficient-funds detection → funding prompt. Gas Station stays deferred (existing `ponytail:` note in `circle-dcw.ts`).

### UI (`app/HomeClient.tsx`, minimal deltas)

- The mode selector where **Wallet / Tag people** sits today becomes **On-chain (escrow)** vs **Off-chain (direct)**. The on-chain form's participant rows accept either an address or a provider+handle (per-row provider select + "Wallet address" option). The existing off-chain path (Mode A, direct transfer) is untouched — this adds the on-chain option, it does not delete Mode A.
- **Payer side:** after sign-in, a social user's adopted wallet address surfaces their on-chain debts through the existing `readDebtsForWallet`. The unpaid-bill card for a DCW-held debt shows one-click Pay (posting to the new route) instead of the connect-wallet flow. Participant/splitter handles are displayed by zipping on-chain `participantList` order with preimage `participantLabels` (both order-preserved from creation).
- **Creator side:** history/claim cards work as today (chain reads); labels from the preimage show `@handles` instead of "Payer 1". A social creator's card wires Claim to the new claim route when the bill's splitter is their DCW.
- `BillVerification` works unchanged — same hash, same preimage route.

## Errors & edges

- **Resolve route abuse surface** (it mints wallets and requires no session, because the non-custodial creator is wallet-connected, not signed in): validate handles per-provider (reuse the `HandleField` regexes), only mint for valid handles, cap participants per request at 20, and pre-mint is idempotent per `(provider, handle)`.
- DCW execution failures surface Circle's real error body (pattern already in `transferUsdcOnArc`).
- Overpay is impossible (server computes remaining from chain). Double-click is safe: second read shows remaining 0 → 409.
- Chain is the source of truth for paid/claimed — no DB status to drift.

## Testing

- Unit (`node --test --experimental-strip-types`, repo convention):
  - `wallet-resolve` resolution ordering (user → pending → mint) with stubbed repos; handle normalization.
  - Calldata encoding for `createBill` / `payDebt` / `claim` against known vectors.
  - One `bill-metadata` vector with `@handle` labels (hash already pinned by existing tests).
- Manual round-trip (needs Circle config + funded wallets): non-custodial creator tags an email user → email user signs in → sees debt → Pay → creator claims. Reverse with a social creator tagging a raw address.

## Out of scope (deliberate)

No contract changes. No `bill_debts` mirror for on-chain bills. No Gas Station / gasless. No handle-rename recovery. No partial payments from DCWs. No auto-claim.
