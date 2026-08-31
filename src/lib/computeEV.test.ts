import assert from "node:assert/strict";
import { test } from "node:test";
import { computeEV } from "./computeEV.ts";

test("computeEV: base rate is the sample-window hit rate with no adjustments", () => {
  const result = computeEV({
    recentGameStats: [100, 200, 100, 200, 200],
    line: 150,
    sampleWindow: 5,
    windSpeedMph: 5,
    precipitationMm: 0,
    shadowCoverageRate: 0,
    impliedProb: 0.5,
  });

  assert.equal(result.baseRate, 0.6);
  assert.equal(result.afterEnvironment, 0.6);
  assert.equal(result.afterCoverage, 0.6);
  assert.ok(Math.abs(result.evScore.edge - 0.1) < 1e-9);
});

test("computeEV: only the most recent sampleWindow games count", () => {
  const result = computeEV({
    recentGameStats: [999, 999, 100, 100, 100, 100, 100],
    line: 150,
    sampleWindow: 3,
    windSpeedMph: 0,
    precipitationMm: 0,
    shadowCoverageRate: 0,
    impliedProb: 0,
  });

  assert.equal(result.baseRate, 0);
});

test("computeEV: high wind suppresses the environment-adjusted probability", () => {
  const input = {
    recentGameStats: [200, 200, 200, 200, 200] as number[],
    line: 100,
    sampleWindow: 5 as const,
    precipitationMm: 0,
    shadowCoverageRate: 0,
    impliedProb: 0.5,
  };

  const calm = computeEV({ ...input, windSpeedMph: 5 });
  const windy = computeEV({ ...input, windSpeedMph: 25 });

  assert.equal(calm.afterEnvironment, 1);
  assert.ok(windy.afterEnvironment < calm.afterEnvironment);
});

test("computeEV: coverage adjustment scales with shadowCoverageRate", () => {
  const input = {
    recentGameStats: [200, 200, 200, 200, 200] as number[],
    line: 100,
    sampleWindow: 5 as const,
    windSpeedMph: 0,
    precipitationMm: 0,
    impliedProb: 0.5,
  };

  const noCoverage = computeEV({ ...input, shadowCoverageRate: 0 });
  const heavyCoverage = computeEV({ ...input, shadowCoverageRate: 1 });

  assert.equal(noCoverage.afterCoverage, 1);
  assert.ok(heavyCoverage.afterCoverage < noCoverage.afterCoverage);
});

test("computeEV: result never goes negative even with extreme penalties", () => {
  const result = computeEV({
    recentGameStats: [0, 0, 0, 0, 0],
    line: 100,
    sampleWindow: 5,
    windSpeedMph: 100,
    precipitationMm: 10,
    shadowCoverageRate: 1,
    impliedProb: 0,
  });

  assert.equal(result.baseRate, 0);
  assert.equal(result.afterCoverage, 0);
});
