import { describe, expect, it } from "vitest";
import { fitBaseline, probabilityAt, priceSide, MARKETS, type Input, type Observation } from "../../src/projection/baseline";
import { serializeReport } from "../../src/projection/report";
import { evaluate, score } from "../../src/projection/evaluation";
const row = (value: number, index: number): Observation => ({ id: `r${index}`, eventId: `e${index}`, eventTime: `2026-09-0${index + 1}T00:00:00Z`, featureAvailableAt: "2026-09-10T00:00:00Z", identityAvailableAt: "2026-09-10T00:00:00Z", labelAvailableAt: "2026-09-10T00:00:00Z", featureVersion: "f1", labelVersion: "l1", value, participation: "offensive" });
const input = (values = [-2, 0, 2, 2]): Input => ({ market: "player_pass_yds", targetEventId: "target", targetEventTime: "2026-10-02T00:00:00Z", cutoff: "2026-10-01T00:00:00Z", featureVersion: "f1", labelVersion: "l1", minimumSamples: 2, history: values.map(row) });
describe("independent empirical projection", () => {
  it("preserves signed values, zeros and exact equality", () => {
    const model = fitBaseline(input());
    expect(probabilityAt(model, 0)).toEqual({ overProbability: .5, underProbability: .25, pushProbability: .25 });
    expect(probabilityAt(model, .5)).toEqual({ overProbability: .5, underProbability: .5, pushProbability: 0 });
    for (const line of [-1e10, -2, -.5, 0, 2, 2.5, 1e10]) {
      const p = probabilityAt(model, line)!;
      expect(p.overProbability + p.underProbability + p.pushProbability).toBeCloseTo(1, 14);
    }
  });
  it("handles all-push and refund settlement", () => {
    const p = probabilityAt(fitBaseline(input([0, 0])), 0)!;
    expect(priceSide(p, "over", 2)).toEqual({ noPushConditionalProbability: null, fairDecimalPrice: null, expectedProfit: 0 });
    expect(priceSide({ overProbability: .4, underProbability: .4, pushProbability: .2 }, "over", 2)).toEqual({ noPushConditionalProbability: .5, fairDecimalPrice: 2, expectedProfit: 0 });
  });
  it("is deterministic and versions are explicit", () => {
    const a = input();
    expect(fitBaseline({ ...a, history: [...a.history].reverse() })).toEqual(fitBaseline(a));
    expect(fitBaseline({ ...a, featureVersion: "f2" })).toEqual({ status: "unavailable", reason: "version-mismatch" });
  });
  it.each(["featureAvailableAt", "identityAvailableAt", "labelAvailableAt"] as const)("refuses future %s", field => {
    const a = input();
    expect(fitBaseline({ ...a, history: a.history.map(r => ({ ...r, [field]: "2026-10-01T00:00:00.001Z" })) })).toEqual({ status: "unavailable", reason: "dependency-after-cutoff" });
    expect(fitBaseline({ ...a, history: a.history.map(r => ({ ...r, [field]: a.cutoff })) }).status).toBe("available");
  });
  it("fails closed on insufficient, unresolved, duplicate and target data", () => {
    expect(fitBaseline(input([])).status).toBe("unavailable");
    for (const patch of [{ participation: "unresolved" as const }, { eventId: "target" }, { value: NaN }, { eventTime: "2026-10-01T00:00:00Z" }]) {
      const a = input();
      expect(fitBaseline({ ...a, history: a.history.map(r => ({ ...r, ...patch })) }).status).toBe("unavailable");
    }
    const a = input();
    expect(fitBaseline({ ...a, history: [a.history[0], a.history[0]] }).status).toBe("unavailable");
    expect(() => probabilityAt(fitBaseline(a), Infinity)).toThrow();
  });
  it.each(MARKETS)("supports integer empirical baseline for %s", market => {
    expect(fitBaseline({ ...input([0, 1]), market }).status).toBe("available");
    if (!market.endsWith("_yds")) expect(fitBaseline({ ...input(), market }).status).toBe("unavailable");
  });
  it("uses three-class Brier and unclipped log loss", () => {
    expect(score({ overProbability: .5, underProbability: .25, pushProbability: .25 }, "push")).toEqual({ brier: .875, logLoss: -Math.log(.25) });
    expect(score({ overProbability: 1, underProbability: 0, pushProbability: 0 }, "push").logLoss).toBe(Infinity);
  });
  it("records walk-forward metrics, calibration and unresolved coverage", () => {
    const a = input();
    const label = { ...row(0, 0), eventId: "target", eventTime: a.targetEventTime, labelAvailableAt: "2026-10-03T00:00:00Z" };
    const options = { evaluatedAt: "2026-10-04T00:00:00Z", codeArtifactId: "fixture-code-v1", coverage: { training: { covered: 4, excluded: 0, unresolved: 1 }, evaluation: { covered: 1, excluded: 0, unresolved: 0 }, featureHistory: { covered: 4, excluded: 0, unresolved: 1 }, qualifiedLedgerVersion: null } };
    const report = evaluate([{ input: a, label, line: 0 }], options);
    expect(report.groups[0].brier).toBe(.875);
    expect(report.groups[0].calibration.filter(b => b.side === "push" && b.count)[0].outcomeRate).toBe(1);
    expect(report.quality).toBe("exploratory");
    expect(() => evaluate([{ input: a, label, line: 0 }], { ...options, evaluatedAt: a.cutoff })).toThrow();
    expect(() => evaluate([{ input: a, label, line: 0, comparison: { version: "closing", availableAt: label.labelAvailableAt, probabilities: { overProbability: .5, underProbability: .5, pushProbability: 0 } } }], options)).toThrow();
  });
});

describe("adherence QC: independent boundaries and evaluation accounting", () => {
  const options = { evaluatedAt: "2026-10-06T00:00:00Z", codeArtifactId: "qc-code", coverage: { training: { covered: 4, excluded: 0, unresolved: 0 }, evaluation: { covered: 2, excluded: 1, unresolved: 1 }, featureHistory: { covered: 4, excluded: 0, unresolved: 0 }, qualifiedLedgerVersion: "synthetic-ledger" } };
  const testCase = (a = input(), value = 0) => ({ input: a, line: 0, label: { ...row(value, 0), id: `label-${a.targetEventId}`, eventId: a.targetEventId, eventTime: a.targetEventTime, labelAvailableAt: "2026-10-05T00:00:00Z" } });
  it("requires the specific refusal, with a valid control", () => {
    const a = input();
    expect(fitBaseline(a).status).toBe("available");
    const variants: [Partial<Input>, string][] = [
      { history: [] }, { minimumSamples: 1 }, { featureVersion: "" }, { cutoff: a.targetEventTime },
    ].map((patch, i) => [patch, ["insufficient-samples", "invalid-sample-policy", "missing-identity-or-version", "cutoff-not-pregame"][i]]);
    for (const [patch, reason] of variants) expect(fitBaseline({ ...a, ...patch })).toEqual({ status: "unavailable", reason });
    const patches: [Partial<Observation>, string][] = [[{ participation: "absent" }, "ineligible-or-unresolved-participation"], [{ value: .5 }, "invalid-outcome"], [{ labelVersion: "l2" }, "version-mismatch"], [{ eventTime: a.cutoff }, "target-or-future-event"], [{ id: "" }, "duplicate-or-missing-identity"], [{ eventTime: "invalid" }, "invalid-timestamp"]];
    for (const [patch, reason] of patches) expect(fitBaseline({ ...a, history: [{ ...a.history[0], ...patch }, ...a.history.slice(1)] })).toEqual({ status: "unavailable", reason });
  });
  it("preserves the complete legacy model envelope and validation precedence", () => {
    expect(fitBaseline(input())).toEqual({
      status: "available", modelVersion: "empirical-integer-v1", market: "player_pass_yds",
      cutoff: "2026-10-01T00:00:00Z", featureVersion: "f1", labelVersion: "l1", sampleCount: 4,
      minimumSamples: 2, trainingIds: ["r0", "r1", "r2", "r3"], quality: "exploratory",
      support: [{ value: -2, mass: .25 }, { value: 0, mass: .25 }, { value: 2, mass: .5 }],
    });
    const a = input();
    const history = a.history.map(row => ({ ...row, eventId: a.targetEventId, eventTime: "invalid" }));
    expect(fitBaseline({ ...a, history })).toEqual({ status: "unavailable", reason: "target-or-future-event" });
    expect(fitBaseline({ ...a, history, minimumSamples: 1, cutoff: "invalid" })).toEqual({ status: "unavailable", reason: "invalid-sample-policy" });
    expect(fitBaseline({ ...a, history, featureVersion: "", minimumSamples: 1 })).toEqual({ status: "unavailable", reason: "missing-identity-or-version" });
    const unavailable = fitBaseline({ ...a, history: [] });
    expect(probabilityAt(unavailable, 0)).toBeNull();
    expect(() => probabilityAt(unavailable, Infinity)).toThrow("line must be finite");
  });
  it("matches direct integer counting across fractional, negative and tail lines", () => {
    const values = Array.from({ length: 37 }, (_, i) => i - 18);
    const a = input();
    const history = values.map((value, i) => ({ ...row(value, 0), id: `r${i}`, eventId: `e${i}` }));
    const model = fitBaseline({ ...a, history });
    for (let line = -20; line <= 20; line += .5) {
      const p = probabilityAt(model, line)!;
      expect(p.overProbability).toBeCloseTo(values.filter(v => v > line).length / 37, 14);
      expect(p.underProbability).toBeCloseTo(values.filter(v => v < line).length / 37, 14);
      expect(p.pushProbability).toBeCloseTo(values.filter(v => v === line).length / 37, 14);
    }
  });
  it("refits at two cutoffs and accounts for unavailable cases and comparisons", () => {
    const first = testCase();
    const nextInput = { ...input([0, 0, 2, 2]), cutoff: "2026-10-03T00:00:00Z", targetEventTime: "2026-10-04T00:00:00Z", targetEventId: "target2" };
    const second = testCase(nextInput, 2);
    const comparison = { version: "uniform-v1", availableAt: first.input.cutoff, probabilities: { overProbability: 1 / 3, underProbability: 1 / 3, pushProbability: 1 / 3 } };
    const missing = testCase({ ...nextInput, targetEventId: "missing", history: [] });
    const report = evaluate([{ ...first, comparison }, second, missing], options);
    // First push: .5² + .25² + (.25-1)² = .875.
    // Second over: (.5-1)² + 0² + .5² = .5.
    expect(report.groups[0].brier).toBe(.6875);
    expect(report.groups[0].logLoss).toBeCloseTo((-Math.log(.25) - Math.log(.5)) / 2);
    expect(report.groups[0].count).toBe(2);
    expect(report.groups[0].unavailableCount).toBe(1);
    expect(report.groups[0].comparisons[0].count).toBe(1);
    expect(report.groups[0].comparisons[0].brier).toBeCloseTo(2 / 3);
    expect(report.rows[0].model).toMatchObject({ trainingIds: ["r0", "r1", "r2", "r3"], minimumSamples: 2 });
    expect(report.rows[1].cutoff).toBe(nextInput.cutoff);
    expect(report.rows[2].model).toEqual({ status: "unavailable", reason: "insufficient-samples" });
    expect(report.quality).toBe("exploratory");
    expect(report.coverage).toEqual(options.coverage);
    const pushBins = report.groups[0].calibration.filter(b => b.side === "push" && b.count);
    expect(pushBins).toMatchObject([{ count: 1, meanProbability: .25, outcomeRate: 1 }, { count: 1, meanProbability: .5, outcomeRate: 0 }]);
  });
  it("exports impossible outcomes explicitly and deterministically", () => {
    const c = testCase(input([2, 2]), 0);
    const report = evaluate([c], options);
    const text = serializeReport(report);
    expect(text).toBe(serializeReport(report));
    const saved = JSON.parse(text);
    expect(saved.encodingVersion).toBe("projection-report-json-v1");
    expect(saved.report.rows[0].scores).toEqual({ brier: 2, logLoss: "positive-infinity" });
    expect(saved.report.groups[0].logLoss).toBe("positive-infinity");
    expect(saved.report.groups[0].count).toBe(1);
    expect(() => serializeReport({ ...report, groups: [{ ...report.groups[0], brier: NaN }] })).toThrow("invalid nonfinite report value");
  });
  it("refuses duplicate evaluation with a different label revision", () => {
    const c = testCase();
    expect(() => evaluate([c, { ...c, label: { ...c.label, id: "correction" } }], options)).toThrow("duplicate evaluation case");
  });
  it("refuses mismatched label identity, time, version and coverage", () => {
    const c = testCase();
    for (const patch of [{ eventId: "wrong" }, { eventTime: "2026-10-03T00:00:00Z" }, { labelVersion: "l2" }]) {
      expect(() => evaluate([{ ...c, label: { ...c.label, ...patch } }], options)).toThrow("evaluation label mismatch");
    }
    expect(() => evaluate([{ ...c, label: { ...c.label, id: "" } }], options)).toThrow("missing evaluation label identity");
    expect(() => evaluate([c], { ...options, coverage: { ...options.coverage, training: { covered: -1, excluded: 0, unresolved: 0 } } })).toThrow("invalid coverage counts");
  });
  it("validates comparison availability even when the model is unavailable", () => {
    const c = testCase({ ...input(), history: [] });
    expect(() => evaluate([{ ...c, comparison: { version: "late", availableAt: "2026-10-05T00:00:00Z", probabilities: { overProbability: 1, underProbability: 0, pushProbability: 0 } } }], options)).toThrow("comparison unavailable at cutoff");
  });
  it("keeps impossible log loss and rejects malformed probabilities", () => {
    expect(score({ overProbability: 1, underProbability: 0, pushProbability: 0 }, "under")).toEqual({ brier: 2, logLoss: Infinity });
    for (const p of [{ overProbability: .5, underProbability: .5, pushProbability: .1 }, { overProbability: NaN, underProbability: 0, pushProbability: 1 }]) expect(() => score(p, "over")).toThrow("invalid probability triple");
    expect(priceSide({ overProbability: .4, underProbability: .4, pushProbability: .2 }, "under", 3).expectedProfit).toBe(.4);
  });
});
