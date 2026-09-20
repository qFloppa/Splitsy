// Unwinding a failed all-or-nothing bill for a derived slot.
//
// WHY THIS NEEDS AN ATTESTED RELAY AT ALL. {BillSplitRegistry.refund} pays
// `msg.sender` and only accepts the bill's own participant. For a slot there is
// no `msg.sender` to be: the address is a pure function of a handle
// (lib/handle-slot.ts), so no key exists for it now or ever. {refundSlot} is the
// contract's answer — permissionless to CALL, authorized by an EIP-712 signature
// over (billId, slot, to, deadline), and it pays `to` directly instead of the
// slot. Same shape as HandleEscrow.release, and the same key signs both.
//
// WHAT THIS REPLACED, AND WHY IT IS WORTH SAYING. The old path minted a wallet
// under Splitsy's key quorum and unwound it in three legs: top up the slot's gas
// out of the operator's own USDC, call refund from the slot, then sweep the
// proceeds to the user's real wallet. Every leg was a transaction the operator
// paid for, the sweep had to leave a gas reserve behind (so each refund leaked
// ~0.05 USDC of operator money), and the whole thing existed to work around
// custody the design no longer takes on. One signed call now, funded by whoever
// relays it, and nothing is left at the slot because nothing is ever sent to it.
//
// THE ATTESER KEY IS THE SAME KEY AS ESCROW_ATTESTER_PRIVATE_KEY. That is
// deliberate — one key to guard rather than two — and what it concedes is
// unchanged: a stolen key can misdirect a refund, but the signature binds `to`
// at signing time, so it cannot pay a non-participant and cannot invent an
// amount. The contract pays what the slot actually holds. Unlike HandleEscrow,
// there is no {reclaim} to come back for it: a slot's money has no other exit,
// which is exactly the property that makes the refund path necessary.
import { encodeRefundSlot, refundSlotDomain, REFUND_SLOT_TYPES } from "./handle-slot.ts";
import { ARC } from "./arc-chain.ts";

// Long enough to survive a slow block on Arc, short enough that a signature
// leaked from a log dies quickly. The contract enforces the deadline, so a
// clock-skewed server fails refunds rather than minting ones that never expire.
const REFUND_WINDOW_SECONDS = 600n;

// Injection seam, same pattern and same reason as ReleaseDeps in
// lib/escrow-release.ts: the side-effecting calls are stubbed so the decision
// layer can be tested under `node --test` with no database, no Privy and no chain.
export type RefundSlotDeps = {
  signRefund: (registryAddress: string, billId: bigint, slot: string, to: string, deadline: bigint) => Promise<string>;
  relay: (registryAddress: string, data: `0x${string}`) => Promise<{ txHash: string | null }>;
};

async function signRefund(
  registryAddress: string,
  billId: bigint,
  slot: string,
  to: string,
  deadline: bigint,
): Promise<string> {
  const { privateKeyToAccount } = await import("viem/accounts");
  const key = process.env.REFUND_SLOT_ATTESTER_PRIVATE_KEY ?? "";
  // Read at call time, never at module load: an unset key must fail the one
  // refund that needs it, not crash every route that imports this file. Gated on
  // the shape rather than truthiness, so a truncated key is this message instead
  // of a raw viem parse error naming nothing.
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error("Missing or malformed REFUND_SLOT_ATTESTER_PRIVATE_KEY");
  }
  const account = privateKeyToAccount(key as `0x${string}`);
  return account.signTypedData({
    // The domain is built from the address the CALL will go to, so a signature
    // can never be made against one deployment and submitted to another.
    domain: refundSlotDomain(ARC.chainId, registryAddress as `0x${string}`),
    types: REFUND_SLOT_TYPES,
    primaryType: "RefundSlot",
    message: { billId, slot: slot as `0x${string}`, to: to as `0x${string}`, deadline },
  });
}

const realDeps: RefundSlotDeps = {
  signRefund,
  relay: async (registryAddress, data) => {
    // Lazy for the same reason as escrow-release's: wallet-provider.ts reaches for
    // whichever wallet SDK this deployment runs, and a refund should only load
    // that when there is actually a refund to send.
    const { executeContract, getOrCreateWallet } = await import("./wallet-provider.ts");

    // The same server-wallet identity the escrow release uses, so the one address
    // an operator has to keep funded is the one named here. This wallet pays the
    // gas; the money it moves is the slot's, out of the registry.
    const wallet = await getOrCreateWallet("splitsy", "escrow-releaser");
    if (!wallet) throw new Error("No escrow-releaser wallet — the wallet provider is not configured");
    const tx = await executeContract(wallet.walletId, registryAddress as `0x${string}`, data);
    return { txHash: tx.txHash };
  },
};

/**
 * Refund a derived slot's contribution to a failed bill, straight to `to`.
 *
 * Unlike {releaseEscrowForHandle} this does NOT swallow failures. It answers an
 * HTTP request the user is waiting on, so an error is something to report to
 * them, not something to log and move past — the caller turns it into a 502.
 * Re-running is safe: the contract's {NothingToRefund} guard means a second
 * attempt on an already-refunded bill reverts rather than paying twice.
 */
export async function refundSlotToOwner(args: {
  registryAddress: string;
  billId: bigint;
  slot: string;
  to: string;
  deps?: RefundSlotDeps;
}): Promise<{ txHash: string | null }> {
  const deps = args.deps ?? realDeps;

  const deadline = BigInt(Math.floor(Date.now() / 1000)) + REFUND_WINDOW_SECONDS;
  const signature = await deps.signRefund(args.registryAddress, args.billId, args.slot, args.to, deadline);
  const data = encodeRefundSlot(args.billId, args.slot as `0x${string}`, args.to as `0x${string}`, deadline, signature as `0x${string}`);

  return deps.relay(args.registryAddress, data);
}