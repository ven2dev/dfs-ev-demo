import { describe, it, expect } from "vitest";
import { computeEV } from "./computeEV.ts";

describe("computeEV", () => {
  it("rejects an unavailable model instead of representing empty history as 0%", () => {
    expect(() =>
      computeEV({
        recentGameStats: [],
        line: 150,
        sampleWindow: 5,
        windSpeedMph: 0,
        precipitationMm: 0,
        shadowCoverageRate: 0,
        impliedProb: 0.5,
        direction: "over",
      })
    ).toThrow("computeEV requires historical stats");
  });

  it("base rate is the sample-window hit rate with no adjustments", () => {
    const result = computeEV({
      recentGameStats: [100, 200, 100, 200, 200],
      line: 150,
      sampleWindow: 5,
      windSpeedMph: 5,
      precipitationMm: 0,
      shadowCoverageRate: 0,
      impliedProb: 0.5,
      direction: "over",
    });

    expect(result.baseRate).toBe(0.6);
    expect(result.afterEnvironment).toBe(0.6);
    expect(result.afterCoverage).toBe(0.6);
    expect(result.evScore.edge).toBeCloseTo(0.1, 9);
  });

  it("only the most recent sampleWindow games count", () => {
    const result = computeEV({
      recentGameStats: [999, 999, 100, 100, 100, 100, 100],
      line: 150,
      sampleWindow: 3,
      windSpeedMph: 0,
      precipitationMm: 0,
      shadowCoverageRate: 0,
      impliedProb: 0,
      direction: "over",
    });

    expect(result.baseRate).toBe(0);
  });

  it("high wind suppresses the environment-adjusted probability", () => {
    const input = {
      recentGameStats: [200, 200, 200, 200, 200] as number[],
      line: 100,
      sampleWindow: 5 as const,
      precipitationMm: 0,
      shadowCoverageRate: 0,
      impliedProb: 0.5,
      direction: "over" as const,
    };

    const calm = computeEV({ ...input, windSpeedMph: 5 });
    const windy = computeEV({ ...input, windSpeedMph: 25 });

    expect(calm.afterEnvironment).toBe(1);
    expect(windy.afterEnvironment).toBeLessThan(calm.afterEnvironment);
  });

  it("coverage adjustment scales with shadowCoverageRate", () => {
    const input = {
      recentGameStats: [200, 200, 200, 200, 200] as number[],
      line: 100,
      sampleWindow: 5 as const,
      windSpeedMph: 0,
      precipitationMm: 0,
      impliedProb: 0.5,
      direction: "over" as const,
    };

    const noCoverage = computeEV({ ...input, shadowCoverageRate: 0 });
    const heavyCoverage = computeEV({ ...input, shadowCoverageRate: 1 });

    expect(noCoverage.afterCoverage).toBe(1);
    expect(heavyCoverage.afterCoverage).toBeLessThan(noCoverage.afterCoverage);
  });

  it("result never goes negative even with extreme penalties", () => {
    const result = computeEV({
      recentGameStats: [0, 0, 0, 0, 0],
      line: 100,
      sampleWindow: 5,
      windSpeedMph: 100,
      precipitationMm: 10,
      shadowCoverageRate: 1,
      impliedProb: 0,
      direction: "over",
    });

    expect(result.baseRate).toBe(0);
    expect(result.afterCoverage).toBe(0);
  });

  it("computes an Under hit rate and applies suppressive conditions in the Under direction", () => {
    const result = computeEV({
      recentGameStats: [100, 120, 200, 210, 220],
      line: 150.5,
      sampleWindow: 5,
      windSpeedMph: 20,
      precipitationMm: 1,
      shadowCoverageRate: 0.5,
      impliedProb: 0.45,
      direction: "under",
    });

    expect(result.baseRate).toBe(0.4);
    expect(result.afterEnvironment).toBeGreaterThan(result.baseRate);
    expect(result.afterCoverage).toBeGreaterThan(result.afterEnvironment);
    expect(result.evScore.impliedProb).toBe(0.45);
  });
});
