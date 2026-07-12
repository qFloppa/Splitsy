import { createSupabaseServerClient } from "@/lib/supabase";
import { type BillPreimage, verifyBillPreimage } from "@/lib/bill-metadata";

// The preimage of one on-chain bill, plus the keys that locate it on Arc.
export type OnchainBillPreimage = BillPreimage & {
  registryAddress: string;
  billId: string;
};

function key(registryAddress: string, billId: string) {
  return { registry_address: registryAddress.toLowerCase(), bill_id: billId };
}

// Publish the plaintext details of an on-chain bill, but ONLY if they actually
// hash to the commitment recorded on-chain. Storing a non-matching preimage
// would let a "Declined" appear for an honest bill, so the check is a hard gate:
// a bad preimage is rejected here, not surfaced to payers later.
// Idempotent + first-write-wins (ignoreDuplicates) — the bill id is assigned by
// the contract at creation and is unknowable beforehand, so nobody can front-run
// a false record into this table.
export async function publishOnchainBillPreimage(
  input: OnchainBillPreimage,
  onchainHash: `0x${string}`,
): Promise<void> {
  if (!verifyBillPreimage(input, onchainHash)) {
    throw new Error("Preimage does not match the on-chain bill hash");
  }
  const client = createSupabaseServerClient();
  if (!client) throw new Error("Supabase is not configured");

  const { error } = await client
    .from("onchain_bill_preimages")
    .upsert(
      {
        ...key(input.registryAddress, input.billId),
        merchant: input.merchant,
        currency: input.currency,
        total_usd: input.total,
        participant_labels: input.participantLabels,
      },
      { onConflict: "registry_address,bill_id", ignoreDuplicates: true },
    );
  if (error) throw new Error(`Failed to publish bill preimage: ${error.message}`);
}

// Fetch the published preimage for one on-chain bill, or null if none. The
// caller (a payer's browser) re-hashes it against the chain — this table is
// merely a convenience transport, never a source of truth.
export async function getOnchainBillPreimage(
  registryAddress: string,
  billId: string,
): Promise<BillPreimage | null> {
  const client = createSupabaseServerClient();
  if (!client) return null;

  const { data, error } = await client
    .from("onchain_bill_preimages")
    .select("merchant, currency, total_usd, participant_labels")
    .match(key(registryAddress, billId))
    .maybeSingle();
  if (error) throw new Error(`Failed to read bill preimage: ${error.message}`);
  if (!data) return null;

  return {
    merchant: data.merchant,
    currency: data.currency,
    total: Number(data.total_usd),
    participantLabels: data.participant_labels ?? [],
  };
}
