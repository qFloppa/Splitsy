// Bill metadata commitment — the plaintext "preimage" of an on-chain bill and
// the keccak256 fingerprint stored in the BillSplitRegistry's BillCreated event.
//
// Only the 32-byte hash lives on-chain; the preimage below is published
// off-chain (Supabase) so a payer can recompute the hash in their own browser
// and confirm the merchant/total/split they're shown are exactly what the
// creator committed to Arc. Nothing here touches the DOM, so it is safe to
// import from both client components and server routes (the viem primitives are
// isomorphic).
import { type ByteArray, encodeAbiParameters, keccak256, parseAbiParameters } from "viem";

// The exact set of fields that go into the on-chain commitment. Changing this
// shape (or the field order below) changes every hash, so it must stay in lock
// step with how bills were created.
//
// `receiptHash` is the keccak256 of the (compressed) receipt image bytes, or ""
// for bills entered by hand with no photo. Committing it on-chain is what lets a
// payer confirm the receipt they're shown is the exact one the creator committed
// — closing the gap where a creator could scan a receipt but commit a different
// total. See `hashReceiptBytes`.
export type BillPreimage = {
  merchant: string;
  currency: string;
  total: number;
  participantLabels: string[];
  receiptHash: string;
};

// keccak256 of the ABI-encoded (merchant, currency, cents, "label|label|…",
// receiptHash). receiptHash is a plain string (not bytes32) so the "no photo"
// case can encode as "" without a special sentinel.
export function billMetadataHash({ merchant, currency, total, participantLabels, receiptHash }: BillPreimage) {
  return keccak256(
    encodeAbiParameters(
      parseAbiParameters("string merchant, string currency, uint256 cents, string labels, string receiptHash"),
      [merchant, currency, BigInt(Math.round(total * 100)), participantLabels.join("|"), receiptHash ?? ""],
    ),
  );
}

// keccak256 of raw receipt-image bytes. Isomorphic (viem only, no DOM), so the
// creator's browser, the payer's browser, and the publish route all compute the
// same fingerprint from the same bytes.
export function hashReceiptBytes(bytes: ByteArray): `0x${string}` {
  return keccak256(bytes);
}

// True when `preimage` hashes to the exact commitment recorded on-chain. A
// single altered character (merchant, currency, cent, a label, or the receipt
// hash) flips this to false — which is the whole point: the chain is the
// tamper-proof anchor.
export function verifyBillPreimage(preimage: BillPreimage, onchainHash: `0x${string}`): boolean {
  return billMetadataHash(preimage).toLowerCase() === onchainHash.toLowerCase();
}
