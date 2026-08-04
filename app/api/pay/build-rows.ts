export type PayRow = {
  address: string;
  label: string;
  provider: string | null;
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
  liveHandles: Map<string, { handle: string; provider: string }>;
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
    const remaining = read.owed > read.paid ? read.owed - read.paid : 0n;

    rows.push({
      address,
      label: live ? `@${live.handle}` : snapshotLabel || shorten(address),
      provider: live ? live.provider : (providers[k] ?? null),
      owedUnits: read.owed.toString(),
      paidUnits: read.paid.toString(),
      remainingUnits: remaining.toString(),
    });
  });

  return rows;
}
