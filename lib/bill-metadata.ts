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
//
// `dueDate` is an optional Unix timestamp (seconds) by which participants are
// expected to pay. It's committed on-chain so the payment-reputation score can
// grade timeliness against a deadline the creator can't later change. Absent
// (undefined or 0) means "no due date" and MUST hash byte-identically to a bill
// created before due dates existed — see the versioning note in billMetadataHash.
export type BillPreimage = {
  merchant: string;
  currency: string;
  total: number;
  participantLabels: string[];
  receiptHash: string;
  dueDate?: number;
};

// keccak256 of the ABI-encoded (merchant, currency, cents, "label|label|…",
// receiptHash). receiptHash is a plain string (not bytes32) so the "no photo"
// case can encode as "" without a special sentinel.
//
// Versioning: a bill with no due date encodes EXACTLY as it did before due
// dates existed (same param tuple, same order), so every previously created
// bill still verifies byte-for-byte. A due date, when present, is appended as an
// extra `uint256 dueDate` param — a strictly additive commitment that only
// affects bills that opt in. The payer recomputes with the same published
// preimage, so the branch is symmetric on both sides.
export function billMetadataHash({
  merchant,
  currency,
  total,
  participantLabels,
  receiptHash,
  dueDate,
}: BillPreimage) {
  const cents = BigInt(Math.round(total * 100));
  const labels = participantLabels.join("|");
  if (dueDate && dueDate > 0) {
    return keccak256(
      encodeAbiParameters(
        parseAbiParameters(
          "string merchant, string currency, uint256 cents, string labels, string receiptHash, uint256 dueDate",
        ),
        [merchant, currency, cents, labels, receiptHash ?? "", BigInt(dueDate)],
      ),
    );
  }
  return keccak256(
    encodeAbiParameters(
      parseAbiParameters("string merchant, string currency, uint256 cents, string labels, string receiptHash"),
      [merchant, currency, cents, labels, receiptHash ?? ""],
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
