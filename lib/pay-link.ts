// A share token is a bill's only public handle: /pay/<token> is reachable by
// anyone, so the token itself is the access control. 22 base62 characters is
// ~131 bits — not guessable, and short enough to paste into a chat message.
//
// Deliberately NOT the bill id. Ids are sequential, so a link built from one
// would let anyone walk every bill on the registry by counting.
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

export const SHARE_TOKEN_LENGTH = 22;

export function newShareToken(): string {
  // 256 is not a multiple of 62, so `byte % 62` would make the first 8 letters
  // slightly likelier than the rest. 248 is (62 * 4), so rejecting the 248–255
  // tail and redrawing keeps every character uniform.
  const bytes = new Uint8Array(SHARE_TOKEN_LENGTH * 2);
  crypto.getRandomValues(bytes);
  let out = "";
  let i = 0;
  while (out.length < SHARE_TOKEN_LENGTH) {
    if (i >= bytes.length) {
      crypto.getRandomValues(bytes);
      i = 0;
    }
    const byte = bytes[i];
    i += 1;
    if (byte < 248) out += ALPHABET[byte % 62];
  }
  return out;
}

// Base62 only, matching the generator. Narrow on purpose: this value reaches a
// database lookup and a URL segment, so anything that isn't a token we could
// have minted is rejected before it gets near either.
export function isShareToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9]{16,64}$/.test(value);
}

// Base units (6 dp), summed as bigint. Every amount stays an integer from the
// chain read to the transaction — a float round trip is exactly how a cent goes
// missing on a three-row selection.
export function selectionTotalUnits(
  rows: ReadonlyArray<{ address: string; remainingUnits: string }>,
  selected: Iterable<string>,
): bigint {
  const want = new Set([...selected].map((address) => address.toLowerCase()));
  return rows.reduce(
    (sum, row) => (want.has(row.address.toLowerCase()) ? sum + BigInt(row.remainingUnits) : sum),
    0n,
  );
}

// A settled participant is not selectable: payDebtFor caps at their remaining
// debt and reverts on a zero amount, so offering the row at all would be a
// button that can only fail.
export function payableRows<T extends { remainingUnits: string }>(rows: readonly T[]): T[] {
  return rows.filter((row) => BigInt(row.remainingUnits) > 0n);
}
