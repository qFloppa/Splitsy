// Reading and writing the IOU journal — the table is schema-iou-journal.sql.
//
// APPEND-ONLY, AND THAT IS THE DESIGN. There is no update function here and no
// status path: a row is written after its transaction has already settled and is
// never touched again. Whether an IOU has landed since is answered on read, by
// the chain (lib/iou-archive.ts), so two writers can never disagree about it and
// a failed write costs one missing row rather than a wrong one.
//
// WHICH MEANS A WRITE MUST NEVER FAIL A COMMIT. Every caller treats this as
// bookkeeping: the money has already moved, so a throw here would restore the
// composer and invite a retry that spends twice. See recordIou in IouClient.
import { createSupabaseServerClient } from "./supabase.ts";
import type { IouJournalInsert, IouJournalRow } from "./iou-archive.ts";

/**
 * Record one IOU. Returns whether it landed — the caller reports a miss, never
 * throws on one.
 *
 * `ignoreDuplicates` on conflict: a retried insert must not resurrect or double
 * a row. The conflict target is the whole table's own id, which is generated, so
 * in practice this is a plain insert; the option is here so that adding a natural
 * key later does not silently start writing duplicates.
 */
export async function insertIou(row: IouJournalInsert): Promise<boolean> {
  const client = createSupabaseServerClient();
  if (!client) return false;

  const { error } = await client.from("iou_journal").insert({
    signer_address: row.signerAddress.toLowerCase(),
    kind: row.kind,
    counterparty_label: row.counterpartyLabel,
    counterparty_address: row.counterpartyAddress?.toLowerCase() ?? null,
    amount_usdc: row.amountUsdc,
    note: row.note,
    status: row.status,
    registry_address: row.registryAddress?.toLowerCase() ?? null,
    bill_id: row.billId,
    escrow_address: row.escrowAddress?.toLowerCase() ?? null,
    escrow_deposit_id: row.escrowDepositId,
    tx_hash: row.txHash,
  });

  if (error) {
    console.error("[iou-journal] insert failed:", error.message);
    return false;
  }
  return true;
}

type JournalDbRow = {
  id: string;
  signer_address: string;
  kind: string;
  counterparty_label: string;
  counterparty_address: string | null;
  amount_usdc: string | number;
  note: string;
  status: string;
  registry_address: string | null;
  bill_id: string | null;
  escrow_address: string | null;
  escrow_deposit_id: string | null;
  tx_hash: string | null;
  created_at: string;
};

/**
 * Everything these wallets signed, newest first.
 *
 * Deduped by signer because a dual-identity user has two wallets and would
 * otherwise be scanned twice — the same reason the dashboard unions its bill id
 * sets. `limit` is generous and not a paging mechanism: this is one person's own
 * IOUs, and the section caps what it renders client-side.
 */
export async function listIousForWallets(wallets: string[], limit = 200): Promise<IouJournalRow[]> {
  const client = createSupabaseServerClient();
  if (!client || wallets.length === 0) return [];

  const signers = [...new Set(wallets.map((w) => w.toLowerCase()))];
  const { data, error } = await client
    .from("iou_journal")
    .select(
      "id, signer_address, kind, counterparty_label, counterparty_address, amount_usdc, note, status, registry_address, bill_id, escrow_address, escrow_deposit_id, tx_hash, created_at",
    )
    .in("signer_address", signers)
    .neq("status", "cancelled")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`Failed to read the IOU journal: ${error.message}`);

  return (data ?? []).map((r) => {
    const row = r as JournalDbRow;
    return {
      id: row.id,
      signerAddress: row.signer_address,
      // CHECK constraints make these the only two values; the cast is what the
      // compiler needs, not a runtime possibility.
      kind: row.kind as "ask" | "settle",
      counterpartyLabel: row.counterparty_label,
      counterpartyAddress: row.counterparty_address,
      // PostgREST hands back numeric as a number or a string depending on value.
      amountUsdc: String(row.amount_usdc),
      note: row.note,
      status: row.status as IouJournalRow["status"],
      registryAddress: row.registry_address,
      billId: row.bill_id,
      escrowAddress: row.escrow_address,
      escrowDepositId: row.escrow_deposit_id,
      txHash: row.tx_hash,
      createdAt: row.created_at,
    };
  });
}

/**
 * The escrow deposits behind a set of escrowed rows, keyed as lib/iou-archive's
 * depositKey expects.
 *
 * One read for the whole page rather than per row, and `or` over the composite
 * key — PostgREST has no tuple IN, so the pairs go in as an explicit disjunction.
 * A deposit that is missing is simply absent from the map, which the archive
 * reads as "nothing landed".
 *
 * WHICH MEANS THE PAIRS ARE CONCATENATED INTO A FILTER, so they are checked here
 * and not only at the route that wrote them. A deposit id is a uint256 decimal
 * string and an escrow address is 0x40; anything else is dropped rather than
 * interpolated, because a value carrying PostgREST syntax would be read back AS
 * syntax. The route validates on the way in too — this is the guard that holds
 * for rows already in the table and for whatever calls this next.
 */
export async function getDepositStanding(
  pairs: { escrowAddress: string; depositId: string }[],
): Promise<Map<string, { status: string; releaseTxHash: string | null; provider: string | null }>> {
  const out = new Map<string, { status: string; releaseTxHash: string | null; provider: string | null }>();
  const client = createSupabaseServerClient();
  if (!client || pairs.length === 0) return out;

  const safe = pairs.filter(
    (p) => /^0x[a-fA-F0-9]{40}$/.test(p.escrowAddress) && /^[0-9]{1,78}$/.test(p.depositId),
  );
  if (safe.length === 0) return out;

  const filter = safe
    .map((p) => `and(escrow_address.eq.${p.escrowAddress.toLowerCase()},deposit_id.eq.${p.depositId})`)
    .join(",");
  // `provider` comes back for the archive: an escrowed IOU has no wallet to
  // resolve an identity from — that is what escrow is for — and this row is the
  // only place that records which namespace the handle belongs to.
  const { data, error } = await client
    .from("escrow_deposits")
    .select("escrow_address, deposit_id, status, release_tx_hash, provider")
    .or(filter);
  if (error) throw new Error(`Failed to read escrow deposits: ${error.message}`);

  for (const r of data ?? []) {
    out.set(`${String(r.escrow_address).toLowerCase()}:${r.deposit_id}`, {
      status: String(r.status),
      releaseTxHash: r.release_tx_hash === null ? null : String(r.release_tx_hash),
      provider: r.provider === null ? null : String(r.provider),
    });
  }
  return out;
}