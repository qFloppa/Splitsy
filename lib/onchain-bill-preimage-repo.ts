import { hashReceiptBytes, type BillPreimage, verifyBillPreimage } from "@/lib/bill-metadata";
import { createSupabaseServerClient } from "@/lib/supabase";

const RECEIPT_BUCKET = "onchain-bill-receipts";

// The preimage of one on-chain bill, plus the keys that locate it on Arc.
export type OnchainBillPreimage = BillPreimage & {
  registryAddress: string;
  billId: string;
};

// What a payer's browser reads back: the preimage plus a public URL to the
// receipt image (null when the bill was entered by hand with no photo).
export type PublishedBillPreimage = BillPreimage & { receiptUrl: string | null };

function key(registryAddress: string, billId: string) {
  return { registry_address: registryAddress.toLowerCase(), bill_id: billId };
}

// Storage object key — one image per bill, namespaced by registry.
function receiptPath(registryAddress: string, billId: string) {
  return `${registryAddress.toLowerCase()}/${billId}`;
}

// Publish the plaintext details of an on-chain bill, but ONLY if they actually
// hash to the commitment recorded on-chain. Storing a non-matching preimage
// would let a "Declined" appear for an honest bill, so the check is a hard gate:
// a bad preimage is rejected here, not surfaced to payers later.
// Idempotent + first-write-wins (ignoreDuplicates) — the bill id is assigned by
// the contract at creation and is unknowable beforehand, so nobody can front-run
// a false record into this table.
//
// `receiptBytes` is the compressed receipt image (null for hand-entered bills).
// The server re-hashes it here rather than trusting input.receiptHash, so the
// stored image is provably the one committed on-chain.
export async function publishOnchainBillPreimage(
  input: OnchainBillPreimage,
  onchainHash: `0x${string}`,
  receiptBytes: Uint8Array | null,
): Promise<void> {
  if (!verifyBillPreimage(input, onchainHash)) {
    throw new Error("Preimage does not match the on-chain bill hash");
  }
  // The receipt bytes must hash to the receiptHash that's baked into the
  // (already verified) commitment — otherwise we'd store an image the chain
  // never committed to.
  if (receiptBytes) {
    if (hashReceiptBytes(receiptBytes).toLowerCase() !== input.receiptHash.toLowerCase()) {
      throw new Error("Receipt image does not match the on-chain bill hash");
    }
  } else if (input.receiptHash) {
    throw new Error("Missing receipt image for a bill that committed one");
  }

  const client = createSupabaseServerClient();
  if (!client) throw new Error("Supabase is not configured");

  const { error } = await client.from("onchain_bill_preimages").upsert(
    {
      ...key(input.registryAddress, input.billId),
      merchant: input.merchant,
      currency: input.currency,
      total_usd: input.total,
      participant_labels: input.participantLabels,
      receipt_hash: input.receiptHash,
    },
    { onConflict: "registry_address,bill_id", ignoreDuplicates: true },
  );
  if (error) throw new Error(`Failed to publish bill preimage: ${error.message}`);

  if (receiptBytes) {
    // upsert:false — first write wins, matching the row's ignoreDuplicates.
    const { error: uploadError } = await client.storage
      .from(RECEIPT_BUCKET)
      .upload(receiptPath(input.registryAddress, input.billId), receiptBytes, {
        contentType: "image/jpeg",
        upsert: false,
      });
    // A duplicate object (same bill re-published) is fine; anything else is not.
    if (uploadError && !/exists/i.test(uploadError.message)) {
      throw new Error(`Failed to store receipt image: ${uploadError.message}`);
    }
  }
}

// Fetch the published preimage for one on-chain bill, or null if none. The
// caller (a payer's browser) re-hashes it against the chain — this table is
// merely a convenience transport, never a source of truth.
export async function getOnchainBillPreimage(
  registryAddress: string,
  billId: string,
): Promise<PublishedBillPreimage | null> {
  const client = createSupabaseServerClient();
  if (!client) return null;

  const { data, error } = await client
    .from("onchain_bill_preimages")
    .select("merchant, currency, total_usd, participant_labels, receipt_hash")
    .match(key(registryAddress, billId))
    .maybeSingle();
  if (error) throw new Error(`Failed to read bill preimage: ${error.message}`);
  if (!data) return null;

  const receiptHash = data.receipt_hash ?? "";
  const receiptUrl = receiptHash
    ? client.storage.from(RECEIPT_BUCKET).getPublicUrl(receiptPath(registryAddress, billId)).data.publicUrl
    : null;

  return {
    merchant: data.merchant,
    currency: data.currency,
    total: Number(data.total_usd),
    participantLabels: data.participant_labels ?? [],
    receiptHash,
    receiptUrl,
  };
}
