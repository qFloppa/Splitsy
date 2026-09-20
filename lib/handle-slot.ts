// The one definition of "which address a handle's slot is", and the EIP-712
// shape the registry's refundSlot verifies.
//
// A tagged stranger's on-chain address becomes a pure function of their handle,
// with no key anywhere — so tagging @dani on two bills files the same address,
// and nothing custodial exists to hold or leak.
//
// Pure and framework-free (no "use client", no next/*, no @/ aliases) so it stays
// importable by `node --test`. Same rule as lib/iou.ts and lib/handle-escrow.ts.
import { encodeFunctionData, parseAbi } from "viem";
import { handleHash } from "./handle-escrow.ts";
import type { IdentityProvider } from "./types.ts";

/// The address a handle's slot lives at.
///
/// Same derivation HandleEscrow deposits use, truncated to an address: the low
/// 160 bits of keccak256 over the normalized "provider:handle" string.
///
/// NOT A SECRET, AND NOT AN ACCOUNT. The input is a short, guessable string, so
/// this address is computable by anyone who can guess the handle — it is a filing
/// key, never a proof of identity. Nobody holds a key to it, which is exactly the
/// point: money cannot rest here, because money that arrived would be stuck.
/// Bills only ever *name* it as a debtor; payments go to the registry, and a
/// refund leaves through {refundSlot} to a real wallet.
///
/// Reuses {handleHash} rather than normalizing again, so the slot and the escrow
/// deposit key cannot drift apart. A second normalizer would be a second thing to
/// get wrong.
export function slotForHandle(provider: IdentityProvider | string, handle: string): `0x${string}` {
  // The low 40 hex characters of the 32-byte hash, which is the low 160 bits.
  return `0x${handleHash(provider, handle).slice(-40)}` as `0x${string}`;
}

/// The registry's refund entrypoints, as a fragment this module can encode.
export const REFUND_SLOT_ABI = parseAbi([
  "function refundSlot(uint256 billId, address slot, address to, uint256 deadline, bytes signature)",
]);

export const encodeRefundSlot = (
  billId: bigint,
  slot: `0x${string}`,
  to: `0x${string}`,
  deadline: bigint,
  signature: `0x${string}`,
) => encodeFunctionData({ abi: REFUND_SLOT_ABI, functionName: "refundSlot", args: [billId, slot, to, deadline, signature] });

// The EIP-712 shape, mirroring REFUND_SLOT_TYPEHASH in BillSplitRegistry.sol.
// Field names and order are part of the hash: rename or reorder one and every
// signature stops verifying — silently, since the failure surfaces as the
// contract's own InvalidSignature on a real refund rather than here.
export const REFUND_SLOT_TYPES = {
  RefundSlot: [
    { name: "billId", type: "uint256" },
    { name: "slot", type: "address" },
    { name: "to", type: "address" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

// Chain id and contract address are in the domain, so a signature made for one
// deployment cannot be replayed against another. Deliberately NOT the same name
// as HandleEscrow's domain — the two must not share a separator, or a release
// signature would verify as a refund.
export const refundSlotDomain = (chainId: number, verifyingContract: `0x${string}`) =>
  ({ name: "Splitsy BillSplit", version: "1", chainId, verifyingContract }) as const;