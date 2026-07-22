import { hashReceiptBytes, type BillPreimage, verifyBillPreimage } from "./bill-metadata.ts";
import { createSupabaseServerClient } from "./supabase.ts";

const RECEIPT_BUCKET = "onchain-bill-receipts";

// The preimage of one on-chain bill, plus the keys that locate it on Arc.
export type OnchainBillPreimage = BillPreimage & {
  registryAddress: string;
  billId: string;
  // Per-participant identity provider, index-aligned with participantLabels.
  // Display/analytics only — NOT part of billMetadataHash.
  participantProviders?: string[];
};

// What a payer's browser reads back: the preimage plus a public URL to the
// receipt image (null when the bill was entered by hand with no photo).
export type PublishedBillPreimage = BillPreimage & {
  receiptUrl: string | null;
  participantProviders: string[];
  // Row insert time as Unix seconds (0 if unparseable) — the dashboard's only
  // creation timestamp for on-chain bills, since getBill exposes none.
  createdAtSeconds: number;
};

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
      participant_providers: input.participantProviders ?? null,
      receipt_hash: input.receiptHash,
      // 0 = no due date, matching the column default and the billMetadataHash
      // convention (absent/0 hashes byte-identically to a pre-due-date bill).
      due_date: input.dueDate && input.dueDate > 0 ? input.dueDate : 0,
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

// Fetch preimages for multiple bills in one query. Returns a Map keyed by
// billId string; missing bills are absent from the map (not null entries).
// The dashboard calls this instead of N individual getOnchainBillPreimage calls.
export async function getOnchainBillPreimages(
  registryAddress: string,
  billIds: string[],
): Promise<Map<string, PublishedBillPreimage>> {
  const result = new Map<string, PublishedBillPreimage>();
  if (billIds.length === 0) return result;
  const client = createSupabaseServerClient();
  if (!client) return result;

  const reg = registryAddress.toLowerCase();
  const { data, error } = await client
    .from("onchain_bill_preimages")
    .select("bill_id, merchant, currency, total_usd, participant_labels, participant_providers, receipt_hash, due_date, created_at")
    .eq("registry_address", reg)
    .in("bill_id", billIds);
  if (error) throw new Error(`Failed to read bill preimages: ${error.message}`);

  for (const row of data ?? []) {
    const receiptHash = row.receipt_hash ?? "";
    const receiptUrl = receiptHash
      ? client.storage.from(RECEIPT_BUCKET).getPublicUrl(receiptPath(reg, row.bill_id)).data.publicUrl
      : null;
    const dueDateRaw = Number(row.due_date ?? 0);
    const parsedAt = row.created_at ? Date.parse(row.created_at) : NaN;
    result.set(row.bill_id, {
      merchant: row.merchant,
      currency: row.currency,
      total: Number(row.total_usd),
      participantLabels: row.participant_labels ?? [],
      participantProviders: row.participant_providers ?? [],
      receiptHash,
      receiptUrl,
      dueDate: dueDateRaw > 0 ? dueDateRaw : undefined,
      createdAtSeconds: Number.isNaN(parsedAt) ? 0 : Math.floor(parsedAt / 1000),
    });
  }
  return result;
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
    .select("merchant, currency, total_usd, participant_labels, participant_providers, receipt_hash, due_date, created_at")
    .match(key(registryAddress, billId))
    .maybeSingle();
  if (error) throw new Error(`Failed to read bill preimage: ${error.message}`);
  if (!data) return null;

  const receiptHash = data.receipt_hash ?? "";
  const receiptUrl = receiptHash
    ? client.storage.from(RECEIPT_BUCKET).getPublicUrl(receiptPath(registryAddress, billId)).data.publicUrl
    : null;

  // 0 (the column default) means "no due date" — surface it as undefined so the
  // preimage hashes byte-identically to a pre-due-date bill on the payer's side.
  const dueDateRaw = Number(data.due_date ?? 0);
  const dueDate = dueDateRaw > 0 ? dueDateRaw : undefined;

  const parsedAt = data.created_at ? Date.parse(data.created_at) : NaN;
  const createdAtSeconds = Number.isNaN(parsedAt) ? 0 : Math.floor(parsedAt / 1000);

  return {
    merchant: data.merchant,
    currency: data.currency,
    total: Number(data.total_usd),
    participantLabels: data.participant_labels ?? [],
    participantProviders: data.participant_providers ?? [],
    receiptHash,
    receiptUrl,
    dueDate,
    createdAtSeconds,
  };
}
