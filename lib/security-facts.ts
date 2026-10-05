import { formatUnits } from "viem";

/**
 * The two HandleEscrow bounds, as a sentence on /security can print them.
 *
 * Both are immutable constructor arguments with no setter, so the page reads them
 * off the live contract rather than repeating the deploy script's defaults — the
 * rule lib/site-contracts.ts already follows for addresses, and for the same
 * reason: a trust page that quietly drifts from the deployment is worse than one
 * that prints no number at all.
 *
 * Which is why every function here returns `null` rather than a fallback. A
 * failed RPC, an unconfigured escrow and a zero bound all mean "this page does
 * not know", and the sentence drops its figure instead of inventing one.
 */

/**
 * `2592000n` → `"30 days"`. Seconds, because that is the unit the contract holds.
 *
 * Rounded UP when it is not a whole number of days. The page's claim is that past
 * this window the only exit is back to the depositor, so a window printed shorter
 * than the real one would promise the release path closes earlier than it does —
 * the direction of error that flatters Splitsy. Hours rather than a rounded-up
 * day because "2 days" for 25 hours is not a sentence a reader trusts either.
 *
 * Mirrors the floors in scripts/deploy-handle-escrow.ts: a window below one day
 * is the "typed days where seconds were meant" mistake that once shipped, so the
 * page drops the figure rather than printing "1 hour" for a 30-second contract
 * and sounding either broken or dishonest.
 */
export function describeHoldWindow(seconds: bigint | null): string | null {
  if (!seconds || seconds <= 0n) return null;
  if (seconds < 86_400n) return null;

  if (seconds % 86_400n === 0n) {
    const days = seconds / 86_400n;
    return `${days} ${days === 1n ? "day" : "days"}`;
  }

  const hours = (seconds + 3_599n) / 3_600n;
  return `${hours} ${hours === 1n ? "hour" : "hours"}`;
}

/**
 * `10000000000n` → `"10,000 USDC"`. The token's own base units in, the number a
 * reader thinks in out.
 *
 * Grouped off the exact decimal string rather than via `Number`, so a large
 * ceiling cannot be rounded by a float on its way to the page.
 *
 * A fraction is padded to cents and never truncated: `formatUnits` drops trailing
 * zeros, which would print a ceiling of 2,500.50 as "2,500.5", and sub-cent
 * precision is exactly what the base-units mistake looks like, so the digits that
 * reveal it have to survive. A whole number keeps no decimals at all — "10,000
 * USDC" is the sentence, not "10,000.00 USDC".
 */
export function describeDailyCeiling(units: bigint | null): string | null {
  if (!units || units <= 0n) return null;

  const [whole, fraction] = formatUnits(units, 6).split(".");
  const grouped = new Intl.NumberFormat("en-US").format(BigInt(whole!));

  return `${grouped}${fraction ? `.${fraction.padEnd(2, "0")}` : ""} USDC`;
}
