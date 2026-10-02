import type { EVScore } from "@/types";
import type { PlayerPropDirection } from "./playerPropMarkets";

export type EVPipelineInput = {
  recentGameStats: number[];
  line: number;
  sampleWindow: 3 | 5 | 7;
  windSpeedMph: number;
  precipitationMm: number;
  shadowCoverageRate: number;
  impliedProb: number; // already devigged from the same-line market consensus
  direction: PlayerPropDirection;
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
  if (window.length === 0) {
    throw new Error("computeEV requires historical stats");
  }
  const hits = window.filter((stat) =>
    input.direction === "over" ? stat > input.line : stat < input.line
  ).length;
  const baseRate = hits / window.length;

  // Environment adjustment: illustrative, not a real predictive model —
  // wind and precipitation modestly suppress passing-yardage outcomes.
  const windPenalty = Math.max(0, input.windSpeedMph - 10) * 0.004;
  const precipPenalty = input.precipitationMm > 0 ? 0.03 : 0;
  const environmentAdjustment = windPenalty + precipPenalty;
  const afterEnvironment = clamp01(
    input.direction === "over"
      ? baseRate - environmentAdjustment
      : baseRate + environmentAdjustment
  );

  // Coverage adjustment: mocked (no free alignment/coverage data source
  // exists) — visibly labeled "sample data" in the UI, per the brief.
  const coveragePenalty = input.shadowCoverageRate * 0.1;
  const afterCoverage = clamp01(
    input.direction === "over"
      ? afterEnvironment - coveragePenalty
      : afterEnvironment + coveragePenalty
  );

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
