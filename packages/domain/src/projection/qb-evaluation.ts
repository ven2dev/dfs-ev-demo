import { equalMassSupport, probabilityAt } from "./empirical.ts";
import { MODEL_VERSION } from "./baseline.ts";
import { empiricalCalibrationBins, score } from "./evaluation.ts";

export const QB_THRESHOLDS = [199.5, 224.5, 249.5, 274.5, 299.5] as const;
export const QB_EVALUATOR_VERSION = "qb-empirical-evaluation-v1";
export type QbEvidenceMode = "strict-point-in-time-v1" | "retrospective-reconstruction-v1";
export type QbHistory = { gameId: string; kickoff: string; yards: number };
export type QbExample = { playerId: string; gameId: string; season: number; cutoff: string;
  sampleSize: number; history: readonly QbHistory[]; label: number; flags: readonly string[] };
export type QbCoverage = { playerId: string; gameId: string; season: number; sampleSize: number;
  featureAvailable: boolean; labelAvailable: boolean; featureReasons: readonly string[]; labelReasons: readonly string[];
  historyGaps: readonly { gameId: string; reasons: readonly string[] }[]; flags: readonly string[];
  zeroAttempts: boolean | null; policyExclusions: readonly string[] };
export type QbEvaluationOptions = { mode: QbEvidenceMode; historyPolicy: string; coverage: readonly QbCoverage[] };
type Stratum = "2-4" | "5-8" | "9-16" | "unassigned";
const strata: Stratum[] = ["2-4", "5-8", "9-16", "unassigned"];
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const unique = (values: readonly string[]) => [...new Set(values)].sort(compare);
const stratum = (n: number): Stratum => n >= 9 ? "9-16" : n >= 5 ? "5-8" : n >= 2 ? "2-4" : "unassigned";
const identity = (playerId: string, gameId: string, policy: string) => JSON.stringify([playerId, gameId, policy]);
const required = (condition: unknown, reason: string): void => { if (!condition) throw new Error(reason); };
const named = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const validInteger = (value: number) => Number.isSafeInteger(value);
const mean = (values: readonly number[]) => values.length ? values.reduce((sum, n) => sum + n, 0) / values.length : null;
const counts = (values: readonly string[]) => Object.fromEntries(unique(values).map(value => [value, values.filter(v => v === value).length]));
const marketComparison = () => ({ status: "unavailable" as const, reason: "no-genuine-captured-market-lines", count: 0 });

// Preserve event-time microseconds while normalizing equivalent zone spellings.
// Knowledge-clock eligibility stays with the materialization/adapter, not math.
const timestamp = (value: string) => {
  const match = typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.(\d{1,6}))?(?:Z|[+-]\d{2}:?\d{2})$/.exec(value);
  const milliseconds = Date.parse(value);
  const calendar = typeof value === "string" ? Date.parse(value.slice(0, 19) + "Z") : NaN;
  if (!match || !Number.isFinite(milliseconds) || !Number.isFinite(calendar)
    || new Date(calendar).toISOString().slice(0, 19) !== value.slice(0, 19)) throw new Error("invalid-event-time");
  const fraction = (match[1] ?? "").padEnd(6, "0");
  return { micros: BigInt(milliseconds) * BigInt(1000) + BigInt(fraction.slice(3)),
    text: new Date(milliseconds).toISOString().replace(/\.\d{3}Z$/, `.${fraction}Z`) };
};

/** Unnormalized integer RPS, via the empirical pairwise CRPS identity. */
export const integerRps = (values: readonly number[], observed: number): number => {
  required(values.length > 0 && values.every(validInteger) && validInteger(observed), "invalid-rps-input");
  const absoluteError = values.reduce((sum, x) => sum + Math.abs(x - observed), 0) / values.length;
  const pairwise = values.reduce((sum, x) => sum + values.reduce((inner, y) => inner + Math.abs(x - y), 0), 0);
  return absoluteError - pairwise / (2 * values.length ** 2);
};

const coverageSummary = (rows: readonly QbCoverage[], scored: number, warmup = false) => ({
  candidates: rows.length, availableForecasts: rows.filter(r => r.featureAvailable).length,
  usableLabels: rows.filter(r => r.labelAvailable).length, scoredFolds: scored, excludedFolds: rows.length - scored,
  missingFeatures: rows.filter(r => !r.featureAvailable).length, missingLabels: rows.filter(r => !r.labelAvailable).length,
  distinctPlayers: new Set(rows.map(r => r.playerId)).size, distinctGames: new Set(rows.map(r => r.gameId)).size,
  exclusions: warmup ? { "warm-up-only": rows.length } : counts(rows.flatMap(r => !r.featureAvailable ? ["feature-unavailable"] : !r.labelAvailable ? ["label-unavailable"] : r.policyExclusions.length ? ["policy-excluded"] : [])),
  policyExclusionReasons: counts(rows.flatMap(r => unique(r.policyExclusions))),
  reasons: counts(rows.flatMap(r => [...unique(r.featureReasons).map(reason => "feature:" + reason), ...unique(r.labelReasons).map(reason => "label:" + reason)])),
  flagCounts: counts(rows.flatMap(r => unique(r.flags))),
  historyGaps: { candidates: rows.filter(r => r.historyGaps.length > 0).length,
    records: rows.reduce((sum, r) => sum + r.historyGaps.length, 0),
    reasons: counts(rows.flatMap(r => r.historyGaps.flatMap(g => unique(g.reasons)))) },
  zeroOpportunity: { zeroAttemptGames: rows.filter(r => r.zeroAttempts === true).length,
    unknownAttemptStatus: rows.filter(r => r.zeroAttempts === null).length },
});

// No target label is passed into distribution construction. The adapter supplies
// qualified lagged features; strict and reconstructed eligibility is never faked.
const qualifyExample = (example: QbExample, options: QbEvaluationOptions) => {
  required(named(example.playerId) && named(example.gameId), "missing-player-game-identity");
  required(Number.isInteger(example.season) && example.season >= 2022 && example.season <= 2025, "outside-evaluation-seasons");
  required(validInteger(example.label), "invalid-target-label");
  required(validInteger(example.sampleSize) && example.sampleSize >= 2 && example.sampleSize <= 16
    && example.sampleSize === example.history.length, "invalid-sample-policy");
  const cutoff = timestamp(example.cutoff);
  const seen = new Set<string>();
  const history = example.history.map(h => {
    required(named(h.gameId) && !seen.has(h.gameId), "duplicate-or-missing-history-game"); seen.add(h.gameId);
    const kickoff = timestamp(h.kickoff);
    required(h.gameId !== example.gameId && kickoff.micros < cutoff.micros, "target-or-post-cutoff-history");
    required(validInteger(h.yards), "invalid-history-yards");
    return { gameId: h.gameId, kickoff: kickoff.text, yards: h.yards };
  }).sort((a, b) => compare(b.kickoff, a.kickoff) || compare(a.gameId, b.gameId));
  const retrospective = example.flags.includes("historical-availability-unverified");
  required(retrospective === (options.mode === "retrospective-reconstruction-v1"), "evidence-mode-flags-mismatch");
  return { playerId: example.playerId, gameId: example.gameId, season: example.season, cutoff: cutoff.text,
    sampleSize: example.sampleSize, history, label: example.label, flags: unique(example.flags) };
};

export const evaluateQbBaseline = (examples: readonly QbExample[], options: QbEvaluationOptions) => {
  required(named(options.historyPolicy), "missing-history-policy");
  required(["strict-point-in-time-v1", "retrospective-reconstruction-v1"].includes(options.mode), "invalid-evidence-mode");
  const ledger = new Map<string, QbCoverage>();
  for (const row of options.coverage) {
    required(named(row.playerId) && named(row.gameId), "missing-player-game-identity");
    required(Number.isInteger(row.season) && row.season >= 2021 && row.season <= 2025, "outside-coverage-seasons");
    required(validInteger(row.sampleSize) && row.sampleSize >= 0 && row.sampleSize <= 16, "invalid-coverage-sample");
    required(typeof row.featureAvailable === "boolean" && typeof row.labelAvailable === "boolean"
      && (row.zeroAttempts === null || typeof row.zeroAttempts === "boolean"), "invalid-coverage-status");
    const key = identity(row.playerId, row.gameId, options.historyPolicy);
    required(!ledger.has(key), "duplicate-coverage-fold"); ledger.set(key, row);
  }
  const seen = new Set<string>();
  const ordered = examples.map(example => {
    const row = qualifyExample(example, options);
    const key = identity(row.playerId, row.gameId, options.historyPolicy);
    required(!seen.has(key), "duplicate-evaluation-fold"); seen.add(key);
    const candidate = ledger.get(key);
    required(candidate && candidate.season === row.season && candidate.sampleSize === row.sampleSize
      && candidate.featureAvailable && candidate.labelAvailable && candidate.policyExclusions.length === 0, "example-coverage-mismatch");
    return row;
  }).sort((a, b) => compare(a.cutoff, b.cutoff) || compare(a.gameId, b.gameId) || compare(a.playerId, b.playerId));
  for (const [key, row] of ledger) {
    if (row.season >= 2022 && row.featureAvailable && row.labelAvailable && row.policyExclusions.length === 0)
      required(seen.has(key), "missing-scored-example");
  }
  const evaluated = new Set<string>(), historyUses = new Map<string, number>();
  const folds = ordered.map(row => {
    const foldId = identity(row.playerId, row.gameId, options.historyPolicy);
    const previouslyEvaluatedGames: string[] = [];
    for (const h of row.history) {
      const key = identity(row.playerId, h.gameId, options.historyPolicy);
      if (evaluated.has(key)) previouslyEvaluatedGames.push(h.gameId);
      historyUses.set(key, (historyUses.get(key) ?? 0) + 1);
    }
    evaluated.add(foldId);
    return { foldId, ...row, stratum: stratum(row.sampleSize), rps: integerRps(row.history.map(h => h.yards), row.label), previouslyEvaluatedGames };
  });
  const calibrationByCase = new Map<string, ReturnType<typeof empiricalCalibrationBins>>();
  const cases = folds.flatMap(fold => {
    const support = equalMassSupport(fold.history.map(h => h.yards));
    return QB_THRESHOLDS.map(threshold => {
      const probabilities = probabilityAt(support, threshold)!;
      const outcome = fold.label > threshold ? "over" as const : "under" as const;
      const scored = score(probabilities, outcome);
      const caseId = JSON.stringify([fold.playerId, fold.gameId, threshold]);
      calibrationByCase.set(caseId, empiricalCalibrationBins(fold.history.map(h => h.yards), threshold));
      return { caseId, foldId: fold.foldId,
        season: fold.season, stratum: fold.stratum, threshold, probabilities, outcome,
        brierThreeClass: scored.brier, brierBinaryOver: (probabilities.overProbability - Number(outcome === "over")) ** 2,
        logLoss: scored.logLoss };
    });
  });
  const groups = ([null, 2022, 2023, 2024, 2025] as const).flatMap(season => (["all", ...strata] as const).map(sampleStratum => {
    const candidates = [...ledger.values()].filter(r => r.season >= 2022 && (season === null || r.season === season)
      && (sampleStratum === "all" || stratum(r.sampleSize) === sampleStratum));
    const members = folds.filter(f => (season === null || f.season === season) && (sampleStratum === "all" || f.stratum === sampleStratum));
    const selected = cases.filter(c => (season === null || c.season === season) && (sampleStratum === "all" || c.stratum === sampleStratum));
    const thresholds = QB_THRESHOLDS.map(threshold => {
      const rows = selected.filter(c => c.threshold === threshold);
      const infinite = rows.filter(c => c.logLoss === Infinity).length;
      return { threshold, count: rows.length, candidateDenominator: candidates.length,
        brierThreeClass: mean(rows.map(r => r.brierThreeClass)), brierBinaryOver: mean(rows.map(r => r.brierBinaryOver)),
        logLoss: mean(rows.map(r => r.logLoss)), infiniteLogLoss: { count: infinite, fraction: rows.length ? infinite / rows.length : null },
        extremeProbabilities: { overZero: rows.filter(r => r.probabilities.overProbability === 0).length,
          overOne: rows.filter(r => r.probabilities.overProbability === 1).length,
          underZero: rows.filter(r => r.probabilities.underProbability === 0).length,
          underOne: rows.filter(r => r.probabilities.underProbability === 1).length },
        calibration: (["over", "under"] as const).flatMap(side => Array.from({ length: 10 }, (_, bin) => {
          const probability = (r: typeof rows[number]) => r.probabilities[side === "over" ? "overProbability" : "underProbability"];
          const members = rows.filter(r => calibrationByCase.get(r.caseId)![side] === bin);
          return { side, lower: bin / 10, upper: (bin + 1) / 10, count: members.length,
            meanProbability: mean(members.map(probability)), outcomeRate: mean(members.map(r => Number(r.outcome === side))) };
        })), marketComparison: marketComparison() };
    });
    return { season, sampleStratum, coverage: coverageSummary(candidates, members.length),
      distinctScoredPlayers: new Set(members.map(f => f.playerId)).size, distinctScoredGames: new Set(members.map(f => f.gameId)).size,
      rps: { count: members.length, mean: mean(members.map(f => f.rps)) }, thresholds,
      combinedThresholdScores: { weighting: "equal-weight-mean-of-five-threshold-means", foldCount: members.length, caseCount: selected.length,
        infiniteLogLoss: { count: selected.filter(c => c.logLoss === Infinity).length,
          fraction: selected.length ? selected.filter(c => c.logLoss === Infinity).length / selected.length : null },
        brierThreeClass: mean(thresholds.flatMap(t => t.brierThreeClass === null ? [] : [t.brierThreeClass])),
        brierBinaryOver: mean(thresholds.flatMap(t => t.brierBinaryOver === null ? [] : [t.brierBinaryOver])),
        logLoss: mean(thresholds.flatMap(t => t.logLoss === null ? [] : [t.logLoss])) }, marketComparison: marketComparison() };
  }));
  return { format: "qb-empirical-evaluation-v1", evaluatorVersion: QB_EVALUATOR_VERSION, modelVersion: MODEL_VERSION,
    designation: "uncalibrated-interim-hit-rate", calibration: "uncalibrated", evidenceMode: options.mode,
    historicalAvailability: options.mode === "retrospective-reconstruction-v1" ? "unverified" : "snapshot-qualified",
    flags: options.mode === "retrospective-reconstruction-v1" ? ["historical-availability-unverified"] : [],
    historyPolicy: options.historyPolicy, thresholds: [...QB_THRESHOLDS], folds, cases, groups,
    warmup: coverageSummary([...ledger.values()].filter(r => r.season === 2021), 0, true), marketComparison: marketComparison(),
    walkForward: { independentFolds: false, historyReferences: [...historyUses.values()].reduce((a, b) => a + b, 0),
      uniqueHistoryPlayerGames: historyUses.size, historyPlayerGamesReusedAcrossFolds: [...historyUses.values()].filter(n => n > 1).length,
      foldsWithPriorEvaluationReuse: folds.filter(f => f.previouslyEvaluatedGames.length > 0).length,
      priorEvaluationHistoryReferences: folds.reduce((sum, f) => sum + f.previouslyEvaluatedGames.length, 0) } };
};

/** Canonical logical report: no run clocks, database UUIDs or file addresses. */
export const serializeQbEvaluation = (report: ReturnType<typeof evaluateQbBaseline>) => JSON.stringify(report, (_key, value: unknown) => {
  if (typeof value !== "number" || Number.isFinite(value)) return value;
  if (value === Infinity) return "positive-infinity";
  throw new Error("invalid-nonfinite-report-value");
});
