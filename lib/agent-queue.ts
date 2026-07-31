// Shapes the payable-bill feed a self-run agent reads.
//
// `spendable` is AutopayMandate.spendable() — the contract pricing its own pull,
// including the debtor's USDC approval and balance. Filtering on it means the
// feed only ever offers work that would actually succeed, so an agent that pays
// everything in the list never burns gas discovering a revert.
import type { BillPreimage } from "./bill-metadata.ts";

export type QueueCandidate = {
  billId: string;
  spendable: bigint;
  creator: string;
  creatorScore: number | null;
  verified: boolean;
  preimage: BillPreimage | null;
};

export type QueueEntry = {
  billId: string;
  amountUsdc: number;
  creator: string;
  creatorScore: number | null;
  verified: boolean;
  preimage: BillPreimage | null;
};

export function shapeQueue(candidates: QueueCandidate[]): QueueEntry[] {
  return candidates
    .filter((c) => c.spendable > 0n)
    .map(({ spendable, ...rest }) => ({
      ...rest,
      // Display figure only. The agent never passes an amount — payFor reads the
      // full remaining share from the contract itself.
      amountUsdc: Number(spendable) / 1_000_000,
    }));
}
