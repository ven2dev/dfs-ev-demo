import { equalMassSupport, probabilityAt as empiricalProbabilityAt, type SupportPoint, type Triple } from "./empirical.ts";
export { priceSide, validateTriple } from "./empirical.ts";
export type { Triple } from "./empirical.ts";

/** Pure research baseline: callers supply qualified, versioned observations. */
export const MODEL_VERSION = "empirical-integer-v1";
export const MARKETS = ["player_pass_yds", "player_pass_attempts", "player_pass_completions", "player_pass_tds", "player_pass_interceptions", "player_rush_yds", "player_rush_attempts", "player_reception_yds", "player_receptions"] as const;
export type Market = typeof MARKETS[number];
export interface Observation {
  id: string;
  eventId: string;
  eventTime: string;
  featureAvailableAt: string;
  identityAvailableAt: string;
  labelAvailableAt: string;
  featureVersion: string;
  labelVersion: string;
  value: number;
  participation: "offensive" | "absent" | "unresolved";
}
export interface Input {
  market: Market;
  targetEventId: string;
  targetEventTime: string;
  cutoff: string;
  featureVersion: string;
  labelVersion: string;
  history: readonly Observation[];
  minimumSamples: number;
}
export type Projection = { status: "unavailable"; reason: string } | {
  status: "available";
  modelVersion: typeof MODEL_VERSION;
  market: Market;
  cutoff: string;
  featureVersion: string;
  labelVersion: string;
  sampleCount: number;
  minimumSamples: number;
  trainingIds: string[];
  support: SupportPoint[];
  quality: "exploratory";
};
export function instant(value: string): number {
  // Require an explicit timezone; machine-local interpretation is not reproducible.
  if (!/(Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error("invalid timestamp");
  return Date.parse(value);
}
export function fitBaseline(input: Input): Projection {
  const unavailable = (reason: string): Projection => ({ status: "unavailable", reason });
  if (!MARKETS.includes(input.market)) return unavailable("unsupported-market");
  if (!input.featureVersion || !input.labelVersion || !input.targetEventId) return unavailable("missing-identity-or-version");
  if (!Number.isSafeInteger(input.minimumSamples) || input.minimumSamples < 2) return unavailable("invalid-sample-policy");
  try {
    const cutoff = instant(input.cutoff);
    if (cutoff >= instant(input.targetEventTime)) return unavailable("cutoff-not-pregame");
    const ids = new Set<string>();
    const events = new Set<string>();
    for (const row of input.history) {
      if (!row.id || !row.eventId || ids.has(row.id) || events.has(row.eventId)) return unavailable("duplicate-or-missing-identity");
      ids.add(row.id); events.add(row.eventId);
      if (row.eventId === input.targetEventId || instant(row.eventTime) >= cutoff) return unavailable("target-or-future-event");
      if ([row.featureAvailableAt, row.identityAvailableAt, row.labelAvailableAt].some(time => instant(time) > cutoff)) return unavailable("dependency-after-cutoff");
      if (row.featureVersion !== input.featureVersion || row.labelVersion !== input.labelVersion) return unavailable("version-mismatch");
      if (row.participation !== "offensive") return unavailable("ineligible-or-unresolved-participation");
      if (!Number.isSafeInteger(row.value) || (!input.market.endsWith("_yds") && row.value < 0)) return unavailable("invalid-outcome");
    }
    if (input.history.length < input.minimumSamples) return unavailable("insufficient-samples");
    return { status: "available", modelVersion: MODEL_VERSION, market: input.market, cutoff: input.cutoff,
      featureVersion: input.featureVersion, labelVersion: input.labelVersion, sampleCount: input.history.length, minimumSamples: input.minimumSamples,
      trainingIds: input.history.map(row => row.id).sort(), quality: "exploratory",
      support: equalMassSupport(input.history.map(row => row.value)) };
  } catch { return unavailable("invalid-timestamp"); }
}
/** Preserve the strict fitter's public API; all arithmetic lives in the kernel. */
export function probabilityAt(model: Projection, line: number): Triple | null {
  return empiricalProbabilityAt(model.status === "available" ? model.support : null, line);
}
