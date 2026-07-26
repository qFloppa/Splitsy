// The landing page's agent-economy tiles. These are real money figures on a
// public marketing page, so a missing or half-formed /api/scout/stats response
// must fall back to the scripted demo numbers rather than render NaN, an empty
// tile, or — worst — a real earned figure beside a scripted spent one.

export type LedgerTiles = {
  earnedUsdc: string;
  spentUsdc: string;
  callsServed: string;
  live: boolean;
};

// What the strip shows before the fetch lands, and forever if it never does:
// exactly what the scripted transcript above it spends (two OCR calls at
// $0.005 plus one FX call at $0.001, all paid to Splitsy's own endpoints).
export const SCRIPTED_LEDGER: LedgerTiles = {
  earnedUsdc: "0.011",
  spentUsdc: "0.011",
  callsServed: "3",
  live: false,
};

function usable(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Fold a /api/scout/stats payload into the three tiles. Returns the scripted
 * figures unchanged unless every field is present and sane — all or nothing,
 * because a mixed row would not add up and the "live" dot would be a lie.
 */
export function resolveLedger(payload: unknown): LedgerTiles {
  if (!payload || typeof payload !== "object") return SCRIPTED_LEDGER;
  const stats = payload as Record<string, unknown>;

  const earned = usable(stats.earnedUsd);
  const spent = usable(stats.spentUsd);
  const served = usable(stats.callsServed);
  if (earned === null || spent === null || served === null) return SCRIPTED_LEDGER;

  return {
    earnedUsdc: earned.toFixed(3),
    spentUsdc: spent.toFixed(3),
    callsServed: Math.round(served).toString(),
    live: true,
  };
}
