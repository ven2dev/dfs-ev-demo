// Pure math, no I/O, no secrets — deliberately kept separate from
// oddsApi.ts (which is server-only-guarded) so this stays independently
// testable and reusable without pulling in a network-fetching, secret-
// reading module.

// Two-way devigging: decimal odds -> raw implied prob (1/price), then
// normalize so the pair sums to 1 (removing the bookmaker's built-in margin).
export function devigTwoWay(overPrice: number, underPrice: number) {
  const rawOver = 1 / overPrice;
  const rawUnder = 1 / underPrice;
  const sum = rawOver + rawUnder;
  return {
    impliedProbOver: rawOver / sum,
    impliedProbUnder: rawUnder / sum,
  };
}
