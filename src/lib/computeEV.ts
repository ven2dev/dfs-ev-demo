import type { EVScore } from "@/types";

export type EVPipelineInput = {
  recentGameStats: number[];
  line: number;
  sampleWindow: 3 | 5 | 7;
  windSpeedMph: number;
  precipitationMm: number;
  shadowCoverageRate: number;
  impliedProb: number; // already devigged from the real Odds API line
};

export type EVPipelineResult = {
  baseRate: number;
  afterEnvironment: number;
  afterCoverage: number;
  evScore: EVScore;
};

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

// Pure function — the actual API calls (real odds, real weather) happen
// upstream in the SSE route; this just does the math against already-
// fetched values, so it's trivially testable without network access.
export function computeEV(input: EVPipelineInput): EVPipelineResult {
  const window = input.recentGameStats.slice(-input.sampleWindow);
  const hits = window.filter((stat) => stat > input.line).length;
  const baseRate = window.length > 0 ? hits / window.length : 0;

  // Environment adjustment: illustrative, not a real predictive model —
  // wind and precipitation modestly suppress passing-yardage outcomes.
  const windPenalty = Math.max(0, input.windSpeedMph - 10) * 0.004;
  const precipPenalty = input.precipitationMm > 0 ? 0.03 : 0;
  const afterEnvironment = clamp01(baseRate - windPenalty - precipPenalty);

  // Coverage adjustment: mocked (no free alignment/coverage data source
  // exists) — visibly labeled "sample data" in the UI, per the brief.
  const coveragePenalty = input.shadowCoverageRate * 0.1;
  const afterCoverage = clamp01(afterEnvironment - coveragePenalty);

  const modelProb = afterCoverage;
  const edge = modelProb - input.impliedProb;

  return {
    baseRate,
    afterEnvironment,
    afterCoverage,
    evScore: {
      modelProb,
      impliedProb: input.impliedProb,
      edge,
    },
  };
}
