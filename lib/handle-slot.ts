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

/// The registry's handle-binding and refund entrypoints.
///
/// TWO CALLS, ONE SIGNATURE BETWEEN THEM. `bind` carries the attester's
/// signature and is WRITE-ONCE per handle; `refundSlot` carries none at all and
/// takes no destination, reading the binding instead. That split is the security
/// property — see {bind} in BillSplitRegistry.sol. The old shape
/// (`refundSlot(billId, slot, to, deadline, signature)`) let a valid signature
/// name any destination on every call, so a leaked key could redirect a refund
/// for anyone, at any time.
export const BIND_ABI = parseAbi([
  "function bind(bytes32 handleHash, address wallet, uint256 deadline, bytes signature)",
  "function refundSlot(uint256 billId, bytes32 handleHash)",
  "function boundWallet(bytes32 handleHash) view returns (address)",
]);

export const encodeBind = (
  handleHash: `0x${string}`,
  wallet: `0x${string}`,
  deadline: bigint,
  signature: `0x${string}`,
) => encodeFunctionData({ abi: BIND_ABI, functionName: "bind", args: [handleHash, wallet, deadline, signature] });

/// No destination and no signature: the binding already said where this goes.
export const encodeRefundSlot = (billId: bigint, handleHash: `0x${string}`) =>
  encodeFunctionData({ abi: BIND_ABI, functionName: "refundSlot", args: [billId, handleHash] });

// The EIP-712 shape, mirroring BIND_TYPEHASH in BillSplitRegistry.sol. Field
// names and order are part of the hash: rename or reorder one and every
// signature stops verifying — silently, since the failure surfaces as the
// contract's own InvalidSignature on a real binding rather than here.
export const BIND_TYPES = {
  Bind: [
    { name: "handleHash", type: "bytes32" },
    { name: "wallet", type: "address" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

// Chain id and contract address are in the domain, so a signature made for one
// deployment cannot be replayed against another. Deliberately NOT the same name
// as HandleEscrow's domain — the two must not share a separator, or a release
// signature would verify as a binding.
export const bindDomain = (chainId: number, verifyingContract: `0x${string}`) =>
  ({ name: "Splitsy BillSplit", version: "1", chainId, verifyingContract }) as const;