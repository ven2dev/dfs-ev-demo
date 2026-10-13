import { fitBaseline, instant, probabilityAt, validateTriple, type Input, type Market, type Observation, type Triple, MODEL_VERSION } from "./baseline";
export type Outcome = "over" | "under" | "push";
const keys = { over: "overProbability", under: "underProbability", push: "pushProbability" } as const;
export function score(p: Triple, outcome: Outcome) {
  validateTriple(p);
  if (!(outcome in keys)) throw new Error("invalid outcome class");
  return {
    brier: (Object.keys(keys) as Outcome[]).reduce((sum, side) => sum + (p[keys[side]] - Number(side === outcome)) ** 2, 0),
    logLoss: -Math.log(p[keys[outcome]]),
  };
}
export interface EvaluationCase {
  input: Input;
  line: number;
  label: Observation;
  comparison?: { version: string; availableAt: string; probabilities: Triple };
}
export interface Coverage {
  training: { covered: number; excluded: number; unresolved: number };
  evaluation: { covered: number; excluded: number; unresolved: number };
  featureHistory: { covered: number; excluded: number; unresolved: number };
  qualifiedLedgerVersion: string | null;
}
/** Each case fits anew using only its supplied history at its own prediction cutoff. */
export function evaluate(cases: readonly EvaluationCase[], options: { evaluatedAt: string; codeArtifactId: string; coverage: Coverage }) {
  const evaluatedAt = instant(options.evaluatedAt);
  if (!options.codeArtifactId) throw new Error("missing code artifact identity");
  for (const partition of [options.coverage.training, options.coverage.evaluation, options.coverage.featureHistory]) {
    if (Object.values(partition).some(n => !Number.isSafeInteger(n) || n < 0)) throw new Error("invalid coverage counts");
  }
  const seen = new Set<string>();
  const rows = cases.map(item => {
    const { input, label } = item;
    if (!label.id) throw new Error("missing evaluation label identity");
    const key = JSON.stringify([input.market, input.targetEventId, item.line]);
    if (seen.has(key)) throw new Error("duplicate evaluation case");
    seen.add(key);
    if (label.eventId !== input.targetEventId || instant(label.eventTime) !== instant(input.targetEventTime) || label.labelVersion !== input.labelVersion) throw new Error("evaluation label mismatch");
    if (instant(label.labelAvailableAt) > evaluatedAt || instant(label.identityAvailableAt) > evaluatedAt || instant(label.eventTime) > evaluatedAt) throw new Error("evaluation label unavailable");
    if (label.participation !== "offensive" || !Number.isSafeInteger(label.value) || (!input.market.endsWith("_yds") && label.value < 0)) throw new Error("ineligible evaluation outcome");
    if (item.comparison) {
      if (!item.comparison.version || instant(item.comparison.availableAt) > instant(input.cutoff)) throw new Error("comparison unavailable at cutoff");
      validateTriple(item.comparison.probabilities);
    }
    const manifest = { eventId: input.targetEventId, eventTime: input.targetEventTime, line: item.line, labelId: label.id, labelVersion: label.labelVersion, labelAvailableAt: label.labelAvailableAt };
    const model = fitBaseline(input);
    const p = probabilityAt(model, item.line);
    if (!p) return { ...manifest, market: input.market, model, scores: null, outcome: null, probabilities: null, comparison: null, cutoff: input.cutoff };
    const outcome: Outcome = label.value > item.line ? "over" : label.value < item.line ? "under" : "push";
    return { ...manifest, market: input.market, model, scores: score(p, outcome), outcome, probabilities: p,
      comparison: item.comparison ? { version: item.comparison.version, ...score(item.comparison.probabilities, outcome) } : null, cutoff: input.cutoff };
  });
  const groups = [...new Set(rows.map(row => row.market))].map((market: Market) => {
    const selected = rows.filter(row => row.market === market);
    const scored = selected.filter(row => row.scores !== null);
    const calibration = (Object.keys(keys) as Outcome[]).flatMap(side => Array.from({ length: 10 }, (_, bin) => {
      const members = scored.filter(row => Math.min(9, Math.floor(row.probabilities![keys[side]] * 10)) === bin);
      return { side, lower: bin / 10, upper: (bin + 1) / 10, count: members.length,
        meanProbability: members.length ? members.reduce((sum, row) => sum + row.probabilities![keys[side]], 0) / members.length : null,
        outcomeRate: members.length ? members.filter(row => row.outcome === side).length / members.length : null };
    }));
    const comparisons = [...new Set(scored.flatMap(row => row.comparison ? [row.comparison.version] : []))].map(version => {
      const members = scored.filter(row => row.comparison?.version === version);
      return { version, count: members.length,
        brier: members.reduce((sum, row) => sum + row.comparison!.brier, 0) / members.length,
        logLoss: members.reduce((sum, row) => sum + row.comparison!.logLoss, 0) / members.length };
    });
    return { comparisons, market, count: scored.length, unavailableCount: selected.length - scored.length,
      brier: scored.length ? scored.reduce((sum, row) => sum + row.scores!.brier, 0) / scored.length : null,
      logLoss: scored.length ? scored.reduce((sum, row) => sum + row.scores!.logLoss, 0) / scored.length : null, calibration };
  });
  return { modelVersion: MODEL_VERSION, quality: "exploratory", evaluatedAt: options.evaluatedAt,
    codeArtifactId: options.codeArtifactId, coverage: options.coverage, rows, groups };
}
