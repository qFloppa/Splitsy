// Bill metadata commitment — the plaintext "preimage" of an on-chain bill and
// the keccak256 fingerprint stored in the BillSplitRegistry's BillCreated event.
//
// Only the 32-byte hash lives on-chain; the preimage below is published
// off-chain (Supabase) so a payer can recompute the hash in their own browser
// and confirm the merchant/total/split they're shown are exactly what the
// creator committed to Arc. Nothing here touches the DOM, so it is safe to
// import from both client components and server routes (the viem primitives are
// isomorphic).
import { encodeAbiParameters, keccak256, parseAbiParameters } from "viem";

// The exact set of fields that go into the on-chain commitment. Changing this
// shape (or the field order below) changes every hash, so it must stay in lock
// step with how bills were created.
export type BillPreimage = {
  merchant: string;
  currency: string;
  total: number;
  participantLabels: string[];
};

// keccak256 of the ABI-encoded (merchant, currency, cents, "label|label|…").
export function billMetadataHash({ merchant, currency, total, participantLabels }: BillPreimage) {
  return keccak256(
    encodeAbiParameters(parseAbiParameters("string merchant, string currency, uint256 cents, string labels"), [
      merchant,
      currency,
      BigInt(Math.round(total * 100)),
      participantLabels.join("|"),
    ]),
  );
}

// True when `preimage` hashes to the exact commitment recorded on-chain. A
// single altered character (merchant, currency, cent, or a label) flips this to
// false — which is the whole point: the chain is the tamper-proof anchor.
export function verifyBillPreimage(preimage: BillPreimage, onchainHash: `0x${string}`): boolean {
  return billMetadataHash(preimage).toLowerCase() === onchainHash.toLowerCase();
}
