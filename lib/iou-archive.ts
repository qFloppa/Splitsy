// Turning the IOU journal and the chain into one archive of IOUs that have
// landed. Pure and framework-free (no "use client", no next/*, no @/ aliases) so
// it stays importable by `node --test`, the same rule lib/iou.ts follows.
//
// The journal says what was stated; the chain says whether it happened. This
// module is the join, and the join is the whole reason the table does not carry a
// `landed` boolean: a bill is paid when BillSplitRegistry says it is, never when
// a row in our own database says so. The only thing a stale journal row can cost
// is a row that reads as still open past the moment it settled.
//
// ONE ROW PER STATEMENT, ONE TX SHOWN. An ask may be paid in several partial
// transfers; the archive is a receipt for the IOU, not a bank statement, so it
// reports the newest payment and the total that landed. The first of those is
// findable from the row itself (the archive orders by created_at) and the second
// is the sum — neither needs every leg listed.

/** What one row of the journal holds, as the repo reads it back. */
export type IouJournalRow = {
  id: string;
  signerAddress: string;
  kind: "ask" | "settle";
  counterpartyLabel: string;
  counterpartyAddress: string | null;
  amountUsdc: string;
  note: string;
  status: "open" | "escrowed" | "landed" | "cancelled";
  registryAddress: string | null;
  billId: string | null;
  escrowAddress: string | null;
  escrowDepositId: string | null;
  txHash: string | null;
  createdAt: string; // ISO 8601
};

/** A journal write, as lib/iou-journal-repo.ts inserts it. */
export type IouJournalInsert = Omit<IouJournalRow, "id" | "createdAt">;

/** What the chain says about a bill the journal named. Absent means unreadable. */
export type BillStanding = { totalOwed: bigint; totalPaid: bigint };

/** The settlement legs for one bill: what landed, when, and in which tx. */
export type BillPayments = { total: bigint; lastTxHash: string; lastAt: number | null };

export type ArchiveInput = {
  journal: IouJournalRow[];
  /** billId → standing, for every ask the journal names that the chain answered for. */
  bills: Map<string, BillStanding>;
  /** billId → payment legs, for the bills that were paid. */
  payments: Map<string, BillPayments>;
  /** Keyed `${escrow_address}:${deposit_id}` — see depositKey. Both sides lowercase. */
  deposits: Map<string, { status: string; releaseTxHash: string | null }>;
  /**
   * address → the social identity that owns it, keyed lowercase.
   *
   * The journal stores the counterparty as a FINISHED STRING ("@dani", or a
   * shortened address) because that is what the composer had in hand, and a
   * string cannot say which platform it came from — so an archived row could
   * never be tagged from the journal alone. The address can: resolved against
   * the users table it yields the handle, the provider and the avatar. A row
   * whose counterparty never signed in simply keeps its stored label.
   */
  people: Map<string, { handle: string; provider: string; avatarUrl: string | null }>;
};

// An archived IOU, as the client renders it. Strings and numbers only — bigint
// never crosses Response.json (the same rule lib/dashboard-types.ts states).
export type ArchiveRow = {
  id: string;
  direction: "i-owe" | "owes-me";
  label: string;
  /**
   * The counterparty as the parts of an identity, when they could be resolved:
   * a bare handle, the raw provider, the avatar. All null for a row we can only
   * name by its stored label — `label` is then the only name it has.
   */
  handle: string | null;
  provider: string | null;
  avatarUrl: string | null;
  address: string | null;
  note: string;
  amountUsd: number;
  /** Unix seconds, 0 when the journal row's timestamp could not be parsed. */
  at: number;
  /** The transaction to link, or null when there is nothing to link yet. */
  txHash: string | null;
  /** What the row's money actually did, which is not always "settled". */
  outcome: "settled" | "claimed" | "escrowed" | "in-flight";
};

/**
 * The key a deposit is joined on, matching escrow_deposits' own primary key.
 *
 * Deposit ids restart at 1 in every deployment, so a bare id names nothing on its
 * own — the same reasoning that made that table composite, and the same one that
 * made the journal carry escrow_address beside escrow_deposit_id.
 */
export const depositKey = (escrowAddress: string | null, depositId: string | null) =>
  escrowAddress && depositId ? `${escrowAddress.toLowerCase()}:${depositId}` : "";

/** Parse an ISO timestamp to Unix seconds, or 0 — never NaN into a sort. */
function seconds(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
}

/** Units to a display number. The journal's numeric(20,6) is already USDC, not base units. */
function usd(v: string): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * The archive: every journal row that has actually landed, newest first.
 *
 * A row that has NOT landed is dropped, and that is the point of the section —
 * the live ledger above is where an open IOU lives, in its netted form, so
 * repeating it here would be two lists of the same debts. Only a settled IOU
 * leaves the ledger, and only then does the archive pick it up.
 */
export function archiveRows(input: ArchiveInput): ArchiveRow[] {
  const rows: ArchiveRow[] = [];

  // Who a row names, as far as it can be resolved. The stored label stays the
  // fallback — it is the only name a counterparty who never signed in has, and
  // guessing a provider for it would put an "@" on Discord names and emails.
  const who = (j: IouJournalRow) => {
    const person = j.counterpartyAddress ? input.people.get(j.counterpartyAddress.toLowerCase()) : undefined;
    return {
      label: j.counterpartyLabel,
      handle: person?.handle ?? null,
      provider: person?.provider ?? null,
      avatarUrl: person?.avatarUrl ?? null,
      address: j.counterpartyAddress,
    };
  };

  for (const j of input.journal) {
    const at = seconds(j.createdAt);

    // An ask is settled when the registry says this bill is fully funded. The
    // payment's hash is what makes the row checkable, so a bill the chain says is
    // paid but whose legs we could not read still lands — with the creation tx
    // instead of the payment tx, which is honest but not the receipt you want.
    if (j.kind === "ask") {
      const standing = j.billId ? input.bills.get(j.billId) : undefined;
      if (!standing || standing.totalPaid < standing.totalOwed) continue;
      const paid = j.billId ? input.payments.get(j.billId) : undefined;
      const settled = paid && paid.total > 0n;
      rows.push({
        id: j.id,
        direction: "owes-me",
        ...who(j),
        note: j.note,
        amountUsd: usd(j.amountUsdc),
        // The payment is the more useful date, and the fallback is the claim:
        // by then the money is in the creator's wallet either way.
        at: settled && paid.lastAt ? paid.lastAt : at,
        txHash: (settled ? paid.lastTxHash : null) ?? j.txHash,
        outcome: "settled",
      });
      continue;
    }

    // An escrowed settle: the money landed when the deposit was released, which
    // is a fact about our own index of it, not about the chain we are reading.
    // In-flight until then — it is genuinely neither settled nor open.
    if (j.status === "escrowed") {
      const deposit = input.deposits.get(depositKey(j.escrowAddress, j.escrowDepositId));
      if (!deposit) continue; // no record of the deposit: nothing landed, so nothing to show
      rows.push({
        id: j.id,
        direction: "i-owe",
        ...who(j),
        note: j.note,
        amountUsd: usd(j.amountUsdc),
        at,
        txHash: deposit.releaseTxHash,
        outcome: deposit.status === "released" ? "settled" : "in-flight",
      });
      continue;
    }

    // A settle that went straight to a wallet. The transfer either succeeded or
    // commit would have restored the composer, so a written row IS a landed IOU —
    // only one with no hash ever written (a Circle transfer whose hash never
    // surfaced inside waitForCircleTxUrl's window) has nothing to link.
    if (j.status === "open") {
      rows.push({
        id: j.id,
        direction: "i-owe",
        ...who(j),
        note: j.note,
        amountUsd: usd(j.amountUsdc),
        at,
        txHash: j.txHash,
        outcome: "settled",
      });
    }

    // 'landed' and 'cancelled' produce nothing: one is the state a settle reaches
    // by being written above, the other is a row that was withdrawn.
  }

  // Newest first, id breaking ties so the order is stable across reloads — the
  // same trick buildTreasury uses for equal magnitudes.
  rows.sort((a, b) => (b.at === a.at ? (a.id < b.id ? 1 : -1) : b.at - a.at));
  return rows;
}

/**
 * What the archive is worth, and how much of it has actually arrived.
 *
 * THREE NUMBERS, NOT ONE, because "landed" is a claim and an escrowed deposit has
 * not landed — its money has left the sender and reached nobody. Counting one as
 * landed is the same mistake the ledger refuses to make when it words an escrow
 * row "waiting for @dani" rather than "settled", so the archive's own headline
 * cannot make it either.
 */
export function archiveTotals(rows: ArchiveRow[]): {
  settledUsd: number;
  settledCount: number;
  inFlight: number;
  count: number;
} {
  const settled = rows.filter((r) => r.outcome !== "in-flight");
  // Money sitting in escrow is excluded from the figure for the same reason it is
  // excluded from the count: quoting it would make this disagree with the ledger's
  // net, the one number on this page that is meant to be exact.
  const settledUsd = settled.reduce((sum, r) => sum + r.amountUsd, 0);
  return {
    settledUsd: Number(settledUsd.toFixed(2)),
    settledCount: settled.length,
    inFlight: rows.length - settled.length,
    count: rows.length,
  };
}