// Unwinding a failed all-or-nothing bill for a derived slot.
//
// WHY THIS NEEDS AN ATTESTED RELAY AT ALL. {BillSplitRegistry.refund} pays
// `msg.sender` and only accepts the bill's own participant. For a slot there is
// no `msg.sender` to be: the address is a pure function of a handle
// (lib/handle-slot.ts), so no key exists for it now or ever. Something has to
// vouch for which wallet a handle belongs to, and only the login system knows.
//
// TWO CALLS NOW, AND THE SPLIT IS THE POINT. {bind} carries the attester's
// signature and writes `handleHash -> wallet` ONCE, permanently. {refundSlot}
// carries no signature and takes no destination — it reads that binding. The old
// shape signed `(billId, slot, to, deadline)` and paid `to`, so a valid
// signature could name any destination on every call: a leaked key could
// redirect the refund of anyone, any time, repeatedly. Write-once removes that
// for every handle already bound, which is everyone who has signed in even once.
//
// BINDING HAPPENS HERE, LAZILY, rather than at login. Same security either way —
// the mapping is write-once whenever it is written — and this way the gas is
// only spent when a refund actually needs it, and the login path stays untouched.
//
// WHAT A LEAKED KEY CAN STILL DO, stated plainly: claim a handle that has NEVER
// been bound, once, as a public {HandleBound} event it cannot take back. It
// cannot rebind, cannot name a destination at refund time, and cannot touch a
// handle already bound. Unlike HandleEscrow there is no {reclaim} behind this: a
// slot's money has no other exit, which is exactly why the refund path exists.
//
// THE ATTESTER KEY IS THE SAME KEY AS ESCROW_ATTESTER_PRIVATE_KEY. Deliberate —
// one key to guard rather than two.
import { encodeBind, encodeRefundSlot, bindDomain, BIND_TYPES } from "./handle-slot.ts";
import { ARC } from "./arc-chain.ts";

// Long enough to survive a slow block on Arc, short enough that a signature
// leaked from a log dies quickly. The contract enforces the deadline, so a
// clock-skewed server fails bindings rather than minting ones that never expire.
const BIND_WINDOW_SECONDS = 600n;

// Injection seam, same pattern and same reason as ReleaseDeps in
// lib/escrow-release.ts: the side-effecting calls are stubbed so the decision
// layer can be tested under `node --test` with no database, no Privy and no chain.
export type RefundSlotDeps = {
  readBinding: (registryAddress: string, handleHash: `0x${string}`) => Promise<string>;
  signBind: (registryAddress: string, handleHash: `0x${string}`, wallet: string, deadline: bigint) => Promise<string>;
  relay: (registryAddress: string, data: `0x${string}`) => Promise<{ txHash: string | null }>;
};

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

async function signBind(
  registryAddress: string,
  handleHash: `0x${string}`,
  wallet: string,
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
    domain: bindDomain(ARC.chainId, registryAddress as `0x${string}`),
    types: BIND_TYPES,
    primaryType: "Bind",
    message: { handleHash, wallet: wallet as `0x${string}`, deadline },
  });
}

const realDeps: RefundSlotDeps = {
  readBinding: async (registryAddress, handleHash) => {
    const { getBoundWalletOnchain } = await import("./arc-read.ts");
    return getBoundWalletOnchain(handleHash, registryAddress as `0x${string}`);
  },
  signBind,
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
 * Thrown when a handle is already bound to a wallet that is not the caller's.
 *
 * Write-once has a cost and this is it: someone who signed in, got bound, then
 * moved to a different wallet cannot redirect their old slots. Surfaced as its
 * own error so the route can say which address the money is going to instead of
 * reporting a bare revert — the refund is not lost, it is payable to the bound
 * wallet by anyone who calls {refundSlot}.
 */
export class HandleBoundElsewhereError extends Error {
  // A plain field, not a parameter property: node --test runs this file in
  // strip-only mode, which cannot transform `constructor(readonly x)`.
  boundTo: string;

  constructor(boundTo: string) {
    super(`Handle is already bound to ${boundTo}`);
    this.name = "HandleBoundElsewhereError";
    this.boundTo = boundTo;
  }
}

/**
 * Refund a derived slot's contribution to a failed bill, to its bound wallet.
 *
 * Binds the handle first if it has never been bound. Unlike
 * {releaseEscrowForHandle} this does NOT swallow failures: it answers an HTTP
 * request the user is waiting on, so an error is something to report to them,
 * not something to log and move past — the caller turns it into a 502.
 *
 * Re-running is safe on both legs. {AlreadyBound} is avoided by the read, and
 * the contract's {NothingToRefund} guard means a second attempt on an
 * already-refunded bill reverts rather than paying twice.
 */
export async function refundSlotToOwner(args: {
  registryAddress: string;
  billId: bigint;
  handleHash: `0x${string}`;
  to: string;
  deps?: RefundSlotDeps;
}): Promise<{ txHash: string | null; bindTxHash: string | null }> {
  const deps = args.deps ?? realDeps;

  const bound = await deps.readBinding(args.registryAddress, args.handleHash);

  let bindTxHash: string | null = null;
  if (bound.toLowerCase() === ZERO_ADDRESS) {
    const deadline = BigInt(Math.floor(Date.now() / 1000)) + BIND_WINDOW_SECONDS;
    const signature = await deps.signBind(args.registryAddress, args.handleHash, args.to, deadline);
    const bindData = encodeBind(args.handleHash, args.to as `0x${string}`, deadline, signature as `0x${string}`);
    ({ txHash: bindTxHash } = await deps.relay(args.registryAddress, bindData));
  } else if (bound.toLowerCase() !== args.to.toLowerCase()) {
    throw new HandleBoundElsewhereError(bound);
  }

  const { txHash } = await deps.relay(args.registryAddress, encodeRefundSlot(args.billId, args.handleHash));

  return { txHash, bindTxHash };
}
