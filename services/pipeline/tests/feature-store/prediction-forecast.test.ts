import { describe, expect, it } from "vitest";
import { buildPredictionResponse, computePredictionForecast, validateModelDescriptor,
  type PredictionValidationCode, PredictionValidationError } from "../../src/featureStore/predictionHelpers.ts";
import { predictionDeliveryFixture, predictionFixture } from "./prediction-helpers-fixture.ts";

const freeze = (value: unknown): void => {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
};
const refuses = (operation: () => unknown, code: PredictionValidationCode) => {
  try { operation(); expect.fail("expected private validation refusal"); }
  catch (error) {
    expect(error).toBeInstanceOf(PredictionValidationError);
    expect(error).toMatchObject({ code, message: code });
  }
};
const forecast = (yards: number[], line: number) => computePredictionForecast({
  history: yards.map(yards => ({ yards })), sampleSize: yards.length, line,
});

describe("#235 pure forecast arithmetic", () => {
  it.each([
    { yards: [100, 200, 200, 300], line: 200, under: .25, push: .5, over: .25 },
    { yards: [100, 200, 200, 300], line: 200.5, under: .75, push: 0, over: .25 },
    { yards: [200, 200], line: 200, under: 0, push: 1, over: 0 },
    { yards: [-2, 0, 0, 2], line: 0, under: .25, push: .5, over: .25 },
    { yards: [0, 1, 2], line: 1, under: 1 / 3, push: 1 / 3, over: 1 - 1 / 3 - 1 / 3 },
    { yards: [100, 300], line: 99.5, under: 0, push: 0, over: 1 },
    { yards: [100, 300], line: 300.5, under: 1, push: 0, over: 0 },
  ])("preserves equal mass and hand-calculated probabilities: %j", ({ yards, line, under, push, over }) => {
    expect(forecast(yards, line)).toEqual({ line, sampleCount: yards.length,
      probabilities: { underProbability: under, pushProbability: push, overProbability: over } });
  });
  it.each(Array.from({ length: 15 }, (_, i) => i + 2))("reads only one yard value per example at n=%i", n => {
    let yardReads = 0;
    const history = Array.from({ length: n }, (_, i) => new Proxy({ yards: i % 2 ? 1 : -1 }, {
      get: (row, key) => {
        if (key !== "yards") throw new Error("per-example-verification-or-target-read");
        yardReads++; return row.yards;
      },
    }));
    const result = computePredictionForecast({ history, sampleSize: n, line: 0 });
    expect(yardReads).toBe(n);
    expect(result.sampleCount).toBe(n);
    expect(result.probabilities.underProbability).toBeCloseTo(Math.ceil(n / 2) / n, 14);
    expect(result.probabilities.overProbability).toBeCloseTo(Math.floor(n / 2) / n, 14);
    expect(result.probabilities.pushProbability).toBe(0);
    const values = Object.values(result.probabilities);
    expect(values.every(p => Number.isFinite(p) && p >= 0 && p <= 1)).toBe(true);
    expect(values.reduce((a, b) => a + b)).toBeCloseTo(1, 14);
  });
  it.each([NaN, Infinity, -Infinity, "200", null, undefined])("refuses a non-finite/non-numeric line %j", line => {
    refuses(() => forecast([100, 200], line as number), "invalid-request");
  });
  it.each([0, 1, 17, -1, 2.5, NaN, Infinity])("refuses an invalid declared sample size %j", sampleSize => {
    refuses(() => computePredictionForecast({ history: [{ yards: 100 }, { yards: 200 }], sampleSize, line: 150 }), "materialization-refused");
  });
  it.each([undefined, null, {}, "history", [], [{ yards: 100 }], Array.from({ length: 17 }, () => ({ yards: 100 }))])(
    "refuses malformed or count-mismatched materialization %j", history => {
      refuses(() => computePredictionForecast({ history: history as Parameters<typeof computePredictionForecast>[0]["history"],
        sampleSize: 2, line: 150 }), "materialization-refused");
    });
  it.each([NaN, Infinity, -Infinity, undefined, null, "200"])("refuses invalid numeric support %j without dropping it", yards => {
    refuses(() => computePredictionForecast({ history: [{ yards: 100 }, { yards: yards as number }], sampleSize: 2, line: 150 }), "materialization-refused");
  });
  it("refuses holes or missing rows instead of silently repairing the history", () => {
    for (const history of [Array(2), [{ yards: 100 }, null], [{ yards: 100 }, {}]])
      refuses(() => computePredictionForecast({ history: history as { yards: number }[], sampleSize: 2, line: 150 }), "materialization-refused");
  });
  it("does not mutate or retain frozen history and returns owned probability values", () => {
    const history = [{ yards: 300 }, { yards: 100 }, { yards: 100 }], before = structuredClone(history); freeze(history);
    const first = computePredictionForecast({ history, sampleSize: 3, line: 100 });
    first.probabilities.pushProbability = 0;
    expect(history).toEqual(before);
    expect(computePredictionForecast({ history, sampleSize: 3, line: 100 }).probabilities.pushProbability).toBe(2 / 3);
  });
});

describe("#235 response data after Q2", () => {
  const values = () => {
    const input = predictionDeliveryFixture(), model = validateModelDescriptor(input);
    const forecast = computePredictionForecast({ history: input.history, sampleSize: input.context.feature.sampleSize, line: 200 });
    return { request: input.request, model, forecast, context: input.finalContext,
      authorization: input.authorization, delivery: input.delivery };
  };
  it("preserves Q2 clocks, last-valid reasons, flags, lineage and both rights receipts verbatim", () => {
    const input = values(), result = buildPredictionResponse(input);
    expect(result).toEqual({ status: "available", playerId: input.request.playerId, gameId: input.request.gameId,
      model: input.model, forecast: input.forecast, context: input.context,
      authorization: input.authorization, delivery: input.delivery });
    expect(result.context.freshness).not.toEqual(predictionFixture().context.freshness);
    expect(result.context.feature.flags).toContain("historical-availability-unverified");
    expect(result.context.selection).toMatchObject({ lastValid: true, reasons: ["insufficient-history"] });
    expect(result.context.freshness).toMatchObject({ stale: true, superseded: true });
    expect(result.context.request.knownAsOf).toBe("2026-10-31T00:00:00.123456+00:00");
    expect(result.context.feature.cutoff).toBe("2026-11-01T12:00:00.000001+00:00");
    expect(result.authorization.checkedAt).not.toBe(result.delivery.checkedAt);
  });
  it("keeps same-game QBs distinct without making target outcomes part of the forecast", () => {
    const first = values(), second = values();
    second.request = { ...second.request, playerId: "QB-B" };
    second.context.request.playerId = second.context.feature.playerId = "QB-B";
    second.context.feature.featureId = "dddddddd-dddd-dddd-dddd-dddddddddddd";
    const a = buildPredictionResponse(first), b = buildPredictionResponse(second);
    expect(a.gameId).toBe(b.gameId); expect(a.playerId).not.toBe(b.playerId);
    expect(a.context.feature.featureId).not.toBe(b.context.feature.featureId);
    expect(a.forecast).toEqual(b.forecast);
  });
  it("whitelists response fields and never reads private target labels, bytes or callbacks", () => {
    const input = values(), poison = () => { throw new Error("private-or-target-read"); };
    const expected = buildPredictionResponse(input);
    for (const value of [input, input.request, input.model, input.forecast, input.forecast.probabilities,
      input.context, input.context.request, input.context.feature, input.context.selection, input.context.freshness,
      input.authorization, input.authorization.decisions[0], input.delivery])
      for (const key of ["targetLabel", "outcome", "history", "bytes", "calculate", "client", "store"])
        Object.defineProperty(value, key, { enumerable: true, get: poison });
    expect(buildPredictionResponse(input)).toEqual(expected);
  });
  it("owns every returned container and leaves deeply frozen Q2/request inputs unchanged", () => {
    const input = values(), before = structuredClone(input); freeze(input);
    const result = buildPredictionResponse(input);
    const changed = (output: unknown, source: unknown): void => {
      if (!output || typeof output !== "object") return;
      expect(output).not.toBe(source);
      for (const [key, value] of Object.entries(output)) changed(value, source && typeof source === "object" ? Reflect.get(source, key) : undefined);
      if (Array.isArray(output)) output.length = 0;
      else Object.assign(output, { mutated: true });
    };
    changed(result.model, input.model); changed(result.forecast, input.forecast); changed(result.context, input.context);
    changed(result.authorization, input.authorization); changed(result.delivery, input.delivery);
    expect(input).toEqual(before); expect(buildPredictionResponse(input).context).toEqual(before.context);
  });
});
