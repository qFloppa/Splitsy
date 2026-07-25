// Money compared in atomic units to dodge float drift at the cap boundary.
const atom = (usd: number) => Math.round(usd * 1_000_000);

export function canSpend(spentTodayUsd: number, nextUsd: number, dailyCapUsd: number): boolean {
  return atom(spentTodayUsd) + atom(nextUsd) <= atom(dailyCapUsd);
}

export function remainingBudget(spentTodayUsd: number, dailyCapUsd: number): number {
  return Math.max(0, (atom(dailyCapUsd) - atom(spentTodayUsd)) / 1_000_000);
}
