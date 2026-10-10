// The naming rule lives in lib/dashboard-aggregate.ts, next to the treasury
// view's copy of the same question — relative, with the extension, because this
// file is run directly by `node --test`.
import { personHandle } from "../../../lib/dashboard-aggregate.ts";

export type PayRow = {
  address: string;
  // The name for a row that has no social identity: the creation-time snapshot
  // label ("Payer 3") or the shortened address. For a row that HAS one, `handle`
  // is set and the client composes the name from it — see the note on `handle`.
  label: string;
  provider: string | null;
  // The social handle, bare — no leading "@", whatever the provider.
  //
  // THE PREFIX IS NOT PART OF THE NAME. This field used to arrive as the
  // finished string `"@" + handle`, which put an "@" on every Discord username
  // and every email address on the pay page. Which providers wear one is
  // lib/provider-display.ts's single rule, and it can only apply it to a bare
  // handle. Null means "no social identity here" — render `label`.
  handle: string | null;
  avatarUrl: string | null;
  // Base units (6 dp) as decimal-integer strings. Never numbers: a bill split
  // three ways lands on thirds of a cent, and JSON floats lose them.
  owedUnits: string;
  paidUnits: string;
  remainingUnits: string;
};

type ParticipantRead = { owed: bigint; paid: bigint; exists: boolean };

function shorten(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

// Pair the chain's participant list with the off-chain preimage's labels.
//
// The pairing is POSITIONAL: participantLabels[k] describes participantList[k],
// because createBill received both arrays in the same order. app/api/dashboard
// builds its counterparty identities the same way, including the tolerance for
// pre-migration rows whose label array is shorter than the participant list —
// a missing label falls back to the shortened address rather than shifting
// every later label onto the wrong person.
//
// `liveHandles` (keyed lowercase) wins over the label: a preimage label is a
// snapshot taken at creation, while the users table holds the handle as it is
// now. Same precedence the dashboard applies.
export function buildPayRows({
  participantList,
  participants,
  labels,
  providers,
  liveHandles,
}: {
  participantList: readonly string[];
  participants: readonly (ParticipantRead | null)[];
  labels: readonly string[];
  providers: readonly string[];
  liveHandles: Map<string, { handle: string; provider: string; avatarUrl: string | null }>;
}): PayRow[] {
  const rows: PayRow[] = [];

  participantList.forEach((address, k) => {
    const read = participants[k];
    // A null read is a failed multicall leg; !exists is a slot the registry
    // doesn't know. Either way we cannot state what this person owes, and a row
    // showing $0 would read as "already settled" — which is a different and
    // wrong claim. Drop it.
    if (!read || !read.exists) return;

    const live = liveHandles.get(address.toLowerCase());
    const snapshotLabel = labels[k];
    const snapshotProvider = providers[k] ?? null;
    const remaining = read.owed > read.paid ? read.owed - read.paid : 0n;

    // A snapshot label is the only name a participant who has never signed in
    // has, so it still has to produce a tag — stripped back to a bare handle
    // (the snapshot stored the prefixed form) and only for the providers that
    // name a person. See personHandle.
    const snapshotHandle = personHandle(snapshotLabel, snapshotProvider);

    rows.push({
      address,
      label: snapshotLabel || shorten(address),
      provider: live ? live.provider : snapshotProvider,
      handle: live ? live.handle : snapshotHandle,
      avatarUrl: live ? live.avatarUrl : null,
      owedUnits: read.owed.toString(),
      paidUnits: read.paid.toString(),
      remainingUnits: remaining.toString(),
    });
  });

  return rows;
}
