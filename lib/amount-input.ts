// A USDC amount as the user types it.
//
// Its own module because it is PURE and every other home for it is not: the
// panels that need it are client components importing framer-motion and the
// chain, so a copy living in one of those cannot be unit-tested — and this is a
// parser on a money path, which is exactly the kind of small thing that earns a
// test rather than a careful read.
//
// app/XAuthControl.tsx's send field is the first caller. Four other decimal
// inputs (SettleDeck ×2, IouClient, bills/page) still take any string at all and
// could use this; they are deliberately left alone until someone asks, because
// changing what those fields accept is a visible change to screens nobody
// reported a problem with.

// Digits, at most one dot, at most six decimals, nothing else.
//
// SIX because that is USDC's precision: a seventh digit is dropped on chain, so
// accepting it would show a figure that is not the one being sent. The whole part
// is capped too — an unbounded paste is not a payment, and it reaches Number() as
// NaN somewhere far from the field that accepted it.
//
// Shapes as it TYPES rather than validating on submit, so the field can never
// hold something the rest of the flow has to defend against.
export function sanitizeAmount(raw: string): string {
  const cleaned = raw.replace(/[^\d.]/g, "");
  const [whole = "", ...rest] = cleaned.split(".");
  const head = whole.slice(0, 9);
  // Tested on the CLEANED string, not the raw one: "1,5" loses its comma above
  // and must then read as "15", not gain a decimal point it never had.
  if (rest.length === 0) return head;
  // Everything after the FIRST dot is joined, so a second dot is swallowed rather
  // than truncating the number at it — typing "1..5" or "1.2.3" keeps the digits.
  return `${head}.${rest.join("").slice(0, 6)}`;
}
