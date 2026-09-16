// Unwinding a failed all-or-nothing bill for someone who was tagged before they
// joined.
//
// WHY THIS NEEDS A RELAY AT ALL. BillSplitRegistry.refund pays `msg.sender` and
// only accepts the bill's own participant, and for this person the participant is
// their SLOT — the address a bill named while they had no wallet. They cannot sign
// for it, so the only party that can call refund on their behalf is the server,
// which mints slots under Splitsy's key quorum precisely so this path exists (see
// lib/wallet-resolve.ts for what that concedes).
//
// THREE LEGS, AND THE FIRST ONE IS GAS. Arc charges gas in USDC, so a slot that
// holds nothing cannot send the refund that would give it something — the money
// arrives only after the transaction it cannot afford. So the operator tops it up
// first, out of the same escrow-releaser wallet lib/escrow-release.ts already
// requires an operator to keep funded. One address to fund, not one per slot.
//
// Ordered so a crash is never worse than a retry: the top-up is idempotent by
// balance (a slot that can already pay gets nothing), refund reverts harmlessly if
// it already ran, and the sweep moves whatever is actually there. Re-running the
// whole thing after any failure is safe.
import { REGISTRY_ADDRESS } from "./arc-read.ts";
import { encodeRefund } from "./registry-calldata.ts";
import type { PendingWallet } from "./pending-wallets-repo.ts";

/**
 * How much USDC to send a slot so it can pay for one transaction, or 0 when it
 * already can.
 *
 * Pure and separate because both ways of getting it wrong are silent: send nothing
 * to a slot that cannot transact and the refund reverts for want of gas, send on
 * every refund and the operator leaks a reserve each time.
 *
 * `reserve` is passed in rather than imported so this stays testable without
 * loading a wallet SDK — the caller supplies privy-wallet's GAS_RESERVE_USDC, the
 * same figure the sweep leaves behind.
 *
 * Done in whole micro-USDC, the token's own units, because dollars do not subtract
 * cleanly: `0.05 - 0.02` is `0.030000000000000002`, and scaling that up and
 * rounding away from zero asked for a micro-USDC more than intended. The balance is
 * FLOORED so a float artifact can never overstate what the slot holds and leave it
 * a micro short of being able to transact.
 */
export function gasTopUpUsdc(balanceUsdc: number, reserve: number): number {
  const reserveMicros = Math.round(reserve * 1e6);
  if (!Number.isFinite(balanceUsdc) || balanceUsdc < 0) return reserveMicros / 1e6;
  const heldMicros = Math.floor(balanceUsdc * 1e6);
  if (heldMicros >= reserveMicros) return 0;
  return (reserveMicros - heldMicros) / 1e6;
}

export type SlotRefund = {
  refundTxHash: string | null;
  /** What actually reached the owner's wallet. 0 when only the reserve was left. */
  sweptUsdc: number;
  sweepTxHash: string | null;
};

/**
 * Refund a slot's contribution to a failed bill and forward it to the wallet the
 * person actually signed in with.
 *
 * Throws on any leg. The caller reports it rather than retrying here: every leg is
 * safe to repeat, so the honest answer to a failure is to say so and let the user
 * press again.
 */
export async function refundSlotToOwner(args: {
  slot: PendingWallet;
  billId: bigint;
  to: string;
}): Promise<SlotRefund> {
  // Lazy, for the reason every other wallet caller in this repo is: it reaches for
  // whichever wallet SDK this deployment runs, and nothing should load that at
  // import time.
  const { executeContract, getOrCreateWallet, transferUsdc } = await import("./wallet-provider.ts");
  const { GAS_RESERVE_USDC, sweepAmountUsdc, usdcBalanceOf } = await import("./privy-wallet.ts");

  const slotAddress = args.slot.wallet_address;

  // 1. Gas. Skipped entirely when the slot can already pay, which is the common
  //    case on a retry.
  const topUp = gasTopUpUsdc(await usdcBalanceOf(slotAddress), GAS_RESERVE_USDC);
  if (topUp > 0) {
    const operator = await getOrCreateWallet("splitsy", "escrow-releaser");
    if (!operator) throw new Error("No escrow-releaser wallet — the wallet provider is not configured");
    await transferUsdc(operator.walletId, slotAddress, topUp.toFixed(6));
  }

  // 2. The refund. Both backends throw on a reverted receipt rather than returning
  //    a hash, so reaching the next line means the money is at the slot.
  const refundTx = await executeContract(
    args.slot.circle_wallet_id,
    REGISTRY_ADDRESS,
    encodeRefund(args.billId),
  );

  // 3. Forward it. sweepAmountUsdc leaves the gas reserve behind — a full-balance
  //    transfer would revert with nothing left to pay for itself — and answers 0
  //    for dust, which is reported rather than sent.
  //
  //    ponytail: the reserve stays at the slot, so each refund leaves ~0.05 USDC of
  //    operator money there. Sweep it back with the slot's own gas if that ever
  //    adds up to something worth a transaction.
  const sweep = sweepAmountUsdc(await usdcBalanceOf(slotAddress));
  if (sweep <= 0) {
    return { refundTxHash: refundTx.txHash, sweptUsdc: 0, sweepTxHash: null };
  }
  const sweepTx = await transferUsdc(args.slot.circle_wallet_id, args.to, sweep.toFixed(6));
  return { refundTxHash: refundTx.txHash, sweptUsdc: sweep, sweepTxHash: sweepTx.txHash };
}
