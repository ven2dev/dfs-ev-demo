import { devigTwoWay } from "./devig";

export const CONSENSUS_DEVIG_METHOD = "exact-line-median" as const;
export const CONSENSUS_DEVIG_VERSION = 1 as const;

type BookmakerLine = {
  bookmakerKey: string;
  overPrice: number;
  underPrice: number;
  point: number;
};

export type ConsensusDevigResult = {
  line: number;
  impliedProbOver: number;
  impliedProbUnder: number;
  contributingBookCount: number;
  method: typeof CONSENSUS_DEVIG_METHOD;
  version: typeof CONSENSUS_DEVIG_VERSION;
};

const median = (values: readonly number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const midpoint = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 1
    ? sorted[midpoint]
    : (sorted[midpoint - 1] + sorted[midpoint]) / 2;
};

// Build a market probability only from complete, structurally valid
// Over/Under pairs quoted at the selected sportsbook's exact point. Each
// bookmaker gets one equal vote after its own margin is removed.
export function consensusDevigAtLine(
  lines: readonly BookmakerLine[],
  targetLine: number
): ConsensusDevigResult | null {
  if (!Number.isFinite(targetLine)) return null;

  const overProbabilities = lines
    .filter(
      (line) =>
        line.point === targetLine &&
        Number.isFinite(line.overPrice) &&
        line.overPrice > 1 &&
        Number.isFinite(line.underPrice) &&
        line.underPrice > 1
    )
    .map((line) => devigTwoWay(line.overPrice, line.underPrice).impliedProbOver);

  if (overProbabilities.length === 0) return null;

  const impliedProbOver = median(overProbabilities);
  return {
    line: targetLine,
    impliedProbOver,
    impliedProbUnder: 1 - impliedProbOver,
    contributingBookCount: overProbabilities.length,
    method: CONSENSUS_DEVIG_METHOD,
    version: CONSENSUS_DEVIG_VERSION,
  };
}
