import { describe, expect, it } from "vitest";
import { evaluateQbBaseline, integerRps, QB_THRESHOLDS, serializeQbEvaluation,
  type QbCoverage, type QbEvaluationOptions, type QbExample } from "@dfs-ev/domain/qb-evaluation";

const example = (patch: Partial<QbExample> = {}): QbExample => ({ playerId: "qb-a", gameId: "2022-target", season: 2022,
  cutoff: "2022-09-01T17:00:00Z", sampleSize: 2,
  history: [{ gameId: "prior-a", kickoff: "2021-09-01T18:00:00Z", yards: 200 },
    { gameId: "prior-b", kickoff: "2021-09-08T18:00:00Z", yards: 250 }],
  label: 250, flags: ["historical-availability-unverified"], ...patch });
const coverage = (e: QbExample, patch: Partial<QbCoverage> = {}): QbCoverage => ({
  playerId: e.playerId, gameId: e.gameId, season: e.season, sampleSize: e.sampleSize,
  featureAvailable: true, labelAvailable: true, featureReasons: [], labelReasons: [], historyGaps: [],
  flags: e.flags, zeroAttempts: null, policyExclusions: [], ...patch });
const options = (examples: QbExample[], patch: Partial<QbEvaluationOptions> = {}): QbEvaluationOptions => ({
  mode: "retrospective-reconstruction-v1", historyPolicy: "registered-max16-min2-cutoff1h-v1",
  coverage: examples.map(e => coverage(e)), ...patch });
type Report = ReturnType<typeof evaluateQbBaseline>;
const group = (r: Report, season: number | null = null, sampleStratum = "all") => r.groups.find(g => g.season === season && g.sampleStratum === sampleStratum)!;

// Independent integer-CDF oracle: bounded hand fixtures, no production yard cap.
const cdfRps = (values: number[], observed: number) => {
  let result = 0;
  for (let k = Math.min(...values, observed); k < Math.max(...values, observed); k++) {
    const cdf = values.filter(x => x <= k).length / values.length;
    result += (cdf - Number(observed <= k)) ** 2;
  }
  return result;
};

describe("registered integer RPS", () => {
  it.each([
    { values: [0, 2], observed: 1, expected: .5 },
    { values: [0, 2], observed: 3, expected: 1.5 },
    { values: [-3, -1], observed: -2, expected: .5 },
    { values: [-2, 0, 2, 2], observed: 0, expected: .625 },
    { values: [-2, -2], observed: -2, expected: 0 },
    { values: [-2, -2], observed: 1, expected: 3 },
  ])("agrees with hand score $expected and the CDF sum: $values, y=$observed", ({ values, observed, expected }) => {
    expect(cdfRps(values, observed)).toBe(expected);
    expect(integerRps(values, observed)).toBe(expected);
    expect(integerRps([...values].reverse(), observed)).toBe(expected);
  });
  it("checks CDF/pairwise parity across signed outcomes and duplicate supports", () => {
    for (const values of [[-5, 0, 5], [-2, -2, 1, 4], [0, 0, 0], [3]])
      for (let y = -7; y <= 7; y++) expect(integerRps(values, y)).toBeCloseTo(cdfRps(values, y), 12);
  });
  it("has no arbitrary yard cap or distribution-size normalization", () => {
    expect(integerRps([-1_000_000, -1_000_000], 1_000_000)).toBe(2_000_000);
    expect(integerRps([0, 2, 0, 2], 1)).toBe(integerRps([0, 2], 1));
    for (const [values, outcome] of [[[], 0], [[.5], 0], [[1], NaN], [[Infinity], 0]] as [number[], number][])
      expect(() => integerRps(values, outcome)).toThrow("invalid-rps-input");
  });
});

describe("preregistered materialized QB evaluation", () => {
  it("uses the five fixed thresholds and the existing unsmoothed three-class scorer", () => {
    const e = example(), r = evaluateQbBaseline([e], options([e]));
    expect(QB_THRESHOLDS).toEqual([199.5, 224.5, 249.5, 274.5, 299.5]);
    const c = r.cases.find(c => c.threshold === 224.5)!;
    expect(c.probabilities).toEqual({ underProbability: .5, pushProbability: 0, overProbability: .5 });
    expect(c.brierThreeClass).toBe(.5); expect(c.brierBinaryOver).toBe(.25); expect(c.logLoss).toBe(-Math.log(.5));
    for (const c of r.cases) expect(c.brierThreeClass).toBeCloseTo(2 * c.brierBinaryOver, 14);
    expect(r.designation).toBe("uncalibrated-interim-hit-rate"); expect(r.calibration).toBe("uncalibrated");
    expect(r.folds).toHaveLength(1); expect(r.cases).toHaveLength(5); expect(group(r).rps.count).toBe(1);
    expect(group(r).combinedThresholdScores.brierThreeClass).toBe(r.cases.reduce((s, c) => s + c.brierThreeClass, 0) / 5);
  });
  it("keeps opposing QBs distinct and rejects duplicate folds even if labels change", () => {
    const a = example(), b = example({ playerId: "qb-b" });
    const r = evaluateQbBaseline([a, b], options([a, b]));
    expect(new Set(r.folds.map(f => f.foldId)).size).toBe(2);
    expect(new Set(r.cases.map(c => c.caseId)).size).toBe(10);
    expect(group(r).distinctScoredGames).toBe(1); expect(group(r).distinctScoredPlayers).toBe(2);
    expect(() => evaluateQbBaseline([a, { ...a, label: 0 }], options([a]))).toThrow("duplicate-evaluation-fold");
    expect(() => evaluateQbBaseline([a], options([a, a]))).toThrow("duplicate-coverage-fold");
    expect(r.folds[0].foldId).toBe(JSON.stringify([a.playerId, a.gameId, options([a]).historyPolicy]));
    expect(r.cases[0].caseId).toBe(JSON.stringify([a.playerId, a.gameId, 199.5]));
  });
  it("never uses the target label to form probabilities, while retaining valid zero outcomes", () => {
    const a = example({ label: 0 }), b = example({ label: 900 });
    const first = evaluateQbBaseline([a], options([a])), second = evaluateQbBaseline([b], options([b]));
    expect(first.cases.map(c => c.probabilities)).toEqual(second.cases.map(c => c.probabilities));
    expect(first.folds[0].label).toBe(0); expect(first.folds[0].rps).not.toBe(second.folds[0].rps);
    const invalid = example({ label: null as unknown as number });
    expect(() => evaluateQbBaseline([invalid], options([invalid]))).toThrow("invalid-target-label");
  });
  it.each([0, 1, 17])("refuses n=%i without changing the registered floor or cap", sampleSize => {
    const e = example({ sampleSize, history: Array.from({ length: sampleSize }, (_, i) => ({ gameId: `prior-${i}`, kickoff: "2021-09-01T18:00:00Z", yards: 200 })) });
    expect(() => evaluateQbBaseline([e], options([e]))).toThrow(sampleSize === 17 ? "invalid-coverage-sample" : "invalid-sample-policy");
  });
  it("refuses same-game, at-cutoff and post-cutoff history in both evidence modes", () => {
    for (const mode of ["strict-point-in-time-v1", "retrospective-reconstruction-v1"] as const) {
      const e = example({ flags: mode === "strict-point-in-time-v1" ? [] : ["historical-availability-unverified"] });
      for (const patch of [{ gameId: e.gameId }, { kickoff: e.cutoff }, { kickoff: "2022-09-01T17:00:00.000001Z" }]) {
        const wrong = { ...e, history: [{ ...e.history[0], ...patch }, e.history[1]] };
        expect(() => evaluateQbBaseline([wrong], options([wrong], { mode }))).toThrow("target-or-post-cutoff-history");
      }
      const before = { ...e, history: [{ ...e.history[0], kickoff: "2022-09-01T16:59:59.999999Z" }, e.history[1]] };
      expect(evaluateQbBaseline([before], options([before], { mode })).folds).toHaveLength(1);
    }
  });
  it("refuses invalid event dates and duplicate history without normalizing them silently", () => {
    const e = example();
    for (const cutoff of ["2022-02-30T17:00:00Z", "2022-09-01T24:00:00Z", "2022-09-01T17:00:00+05", "invalid"]) {
      const wrong = { ...e, cutoff };
      expect(() => evaluateQbBaseline([wrong], options([wrong]))).toThrow("invalid-event-time");
    }
    const duplicate = { ...e, history: [e.history[0], e.history[0]] };
    expect(() => evaluateQbBaseline([duplicate], options([duplicate]))).toThrow("duplicate-or-missing-history-game");
  });
  it("retains infinity in cases, threshold/combined aggregates and JSON", () => {
    const e = example({ history: example().history.map(h => ({ ...h, yards: 250 })), label: 0 });
    const r = evaluateQbBaseline([e], options([e]));
    const threshold = group(r).thresholds.find(t => t.threshold === 224.5)!;
    expect(threshold.logLoss).toBe(Infinity); expect(threshold.infiniteLogLoss).toEqual({ count: 1, fraction: 1 });
    expect(group(r).combinedThresholdScores.logLoss).toBe(Infinity);
    expect(group(r).combinedThresholdScores.infiniteLogLoss).toEqual({ count: 3, fraction: 3 / 5 });
    expect(group(r, 2022, "2-4").thresholds[1].logLoss).toBe(Infinity);
    const saved = JSON.parse(serializeQbEvaluation(r));
    expect(saved.cases[1].logLoss).toBe("positive-infinity");
    expect(saved.groups[0].combinedThresholdScores.logLoss).toBe("positive-infinity");
    expect(() => serializeQbEvaluation({ ...r, groups: [{ ...r.groups[0], rps: { count: 1, mean: NaN } }] })).toThrow("invalid-nonfinite-report-value");
  });
  it("uses fixed ten-bin Over/Under calibration including exact zero and one", () => {
    const e = example(), r = evaluateQbBaseline([e], options([e]));
    const t = group(r).thresholds[1];
    expect(t.calibration).toHaveLength(20);
    expect(t.calibration.find(b => b.side === "over" && b.lower === .5)).toMatchObject({ count: 1, meanProbability: .5, outcomeRate: 1 });
    expect(t.calibration.find(b => b.side === "under" && b.lower === .5)).toMatchObject({ count: 1, meanProbability: .5, outcomeRate: 0 });
    expect(t.calibration[0]).toMatchObject({ count: 0, meanProbability: null, outcomeRate: null });
    expect(group(r).thresholds[0].extremeProbabilities).toEqual({ overZero: 0, overOne: 1, underZero: 1, underOne: 0 });
    expect(group(r).thresholds[0].calibration.find(b => b.side === "over" && b.lower === .9)?.count).toBe(1);
  });
  it("includes every season/sample cell, empty denominators and explicit unavailable comparisons", () => {
    const r = evaluateQbBaseline([], options([]));
    expect(r.groups).toHaveLength(25);
    for (const g of r.groups) {
      expect(g.coverage.candidates).toBe(0); expect(g.rps).toEqual({ count: 0, mean: null });
      expect(g.combinedThresholdScores).toMatchObject({ caseCount: 0, foldCount: 0, logLoss: null });
      for (const t of g.thresholds) {
        expect(t).toMatchObject({ count: 0, candidateDenominator: 0, brierThreeClass: null, brierBinaryOver: null, logLoss: null });
        expect(t.infiniteLogLoss).toEqual({ count: 0, fraction: null });
        expect(t.calibration.every(b => b.count === 0 && b.meanProbability === null && b.outcomeRate === null)).toBe(true);
        expect(t.marketComparison.status).toBe("unavailable");
      }
    }
    expect(r.marketComparison).toMatchObject({ status: "unavailable", reason: "no-genuine-captured-market-lines" });
  });
  it("accounts for unavailable labels, unresolved histories, policy exclusions and warm-up", () => {
    const e = example();
    const rows = [coverage(e), coverage(example({ gameId: "missing-label" }), { labelAvailable: false, labelReasons: ["participation-missing"], zeroAttempts: true }),
      coverage(example({ gameId: "unknown", sampleSize: 0 }), { sampleSize: 0, featureAvailable: false, featureReasons: ["insufficient-history"],
        historyGaps: [{ gameId: "gap", reasons: ["identity-ambiguous"] }] }),
      coverage(example({ gameId: "excluded" }), { policyExclusions: ["flagged-values-excluded"] }),
      coverage(example({ gameId: "warmup", season: 2021 }))];
    const r = evaluateQbBaseline([e], options([e], { coverage: rows }));
    expect(group(r).coverage).toMatchObject({ candidates: 4, availableForecasts: 3, usableLabels: 3, scoredFolds: 1, excludedFolds: 3,
      exclusions: { "feature-unavailable": 1, "label-unavailable": 1, "policy-excluded": 1 },
      policyExclusionReasons: { "flagged-values-excluded": 1 }, reasons: { "feature:insufficient-history": 1, "label:participation-missing": 1 },
      historyGaps: { candidates: 1, records: 1, reasons: { "identity-ambiguous": 1 } }, zeroOpportunity: { zeroAttemptGames: 1, unknownAttemptStatus: 3 } });
    expect(group(r).thresholds[0]).toMatchObject({ count: 1, candidateDenominator: 4 });
    expect(group(r, null, "unassigned").coverage.candidates).toBe(1);
    expect(r.warmup).toMatchObject({ candidates: 1, scoredFolds: 0, exclusions: { "warm-up-only": 1 } });
    expect(() => evaluateQbBaseline([], options([e]))).toThrow("missing-scored-example");
    expect(() => evaluateQbBaseline([e], options([e], { coverage: [coverage(e, { labelAvailable: false })] }))).toThrow("example-coverage-mismatch");
  });
  it("reports all three prior-sample strata without reusing the five threshold cases as RPS folds", () => {
    const examples = [2, 5, 9, 16].map(n => example({ playerId: `qb-${n}`, sampleSize: n,
      history: Array.from({ length: n }, (_, i) => ({ gameId: `prior-${i}`, kickoff: "2021-09-01T18:00:00Z", yards: 200 + i })) }));
    const r = evaluateQbBaseline(examples, options(examples));
    expect(["2-4", "5-8", "9-16"].map(s => group(r, null, s).rps.count)).toEqual([1, 1, 2]);
    expect(group(r).rps.count).toBe(4); expect(group(r).combinedThresholdScores.caseCount).toBe(20);
  });
  it("sorts chronologically, records walk-forward reuse and reproduces logical JSON after permutations", () => {
    const first = example();
    const next = example({ gameId: "2023-target", season: 2023, cutoff: "2023-09-01T17:00:00Z",
      history: [{ gameId: first.gameId, kickoff: "2022-09-01T18:00:00Z", yards: first.label }, first.history[0]] });
    const r = evaluateQbBaseline([next, first], options([next, first]));
    expect(r.folds.map(f => f.gameId)).toEqual([first.gameId, next.gameId]);
    expect(r.folds[1].previouslyEvaluatedGames).toEqual([first.gameId]);
    expect(r.walkForward).toEqual({ independentFolds: false, historyReferences: 4, uniqueHistoryPlayerGames: 3,
      historyPlayerGamesReusedAcrossFolds: 1, foldsWithPriorEvaluationReuse: 1, priorEvaluationHistoryReferences: 1 });
    const permuted = [first, next].map(e => ({ ...e, history: [...e.history].reverse() }));
    expect(serializeQbEvaluation(evaluateQbBaseline(permuted, options(permuted)))).toBe(serializeQbEvaluation(r));
    const sameInstant = example({ cutoff: "2022-09-01T12:00:00-05:00" });
    expect(serializeQbEvaluation(evaluateQbBaseline([sameInstant], options([sameInstant]))))
      .toBe(serializeQbEvaluation(evaluateQbBaseline([first], options([first]))));
  });
  it("keeps evidence modes separate without changing their probability math", () => {
    const retro = example(), strict = example({ flags: [] });
    const r = evaluateQbBaseline([retro], options([retro]));
    const s = evaluateQbBaseline([strict], options([strict], { mode: "strict-point-in-time-v1" }));
    expect(r.cases.map(c => c.probabilities)).toEqual(s.cases.map(c => c.probabilities));
    expect(r.historicalAvailability).toBe("unverified"); expect(s.historicalAvailability).toBe("snapshot-qualified");
    expect(() => evaluateQbBaseline([retro], options([retro], { mode: "strict-point-in-time-v1" }))).toThrow("evidence-mode-flags-mismatch");
    expect(() => evaluateQbBaseline([strict], options([strict]))).toThrow("evidence-mode-flags-mismatch");
  });
});
