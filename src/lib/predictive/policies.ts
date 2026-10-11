import type { Availability, MarkerType, Observation, PlayerGameStats } from "./types.ts";
import type { Replay } from "./replay.ts";
import { instant } from "./validation.ts";

// event-completion-v1: completion is a decision over registered markers, never
// an appearance in a file or elapsed scheduled time. A final status needs an
// independent confirming marker. completionObservedAt is the first capture at
// which that qualified evidence existed, not physical end time.
export type CompletionState = "scheduled" | "in-progress" | "completed" | "suspended" | "postponed" | "conflicting";
export type CompletionDecision = { state: CompletionState; completionObservedAt: string | null; inputs: Observation[] };
const MARKERS: MarkerType[] = ["provider-final-status", "terminal-play", "final-team-totals", "suspension-notice", "postponement-notice"];

export const completionDecision = (replay: Replay, gameId: string): CompletionDecision => {
  const selections = new Map(MARKERS.map((type) => [type, replay.select("event-state-marker", "event-state-marker:" + gameId + ":" + type)]));
  const inputs = [...selections.values()].flatMap((selection) => selection.dependencies);
  const marker = (type: MarkerType) => selections.get(type)!.observation;
  const decision = (state: CompletionState, observed: string | null = null) => ({ state, completionObservedAt: observed, inputs });
  if ([...selections.values()].some((selection) => selection.state === "ambiguous")) return decision("conflicting");
  const final = marker("provider-final-status");
  const confirmers = [marker("terminal-play"), marker("final-team-totals")].filter((row): row is NonNullable<typeof row> => row !== null);
  const stopped = marker("suspension-notice") ?? marker("postponement-notice");
  if (stopped && (final || confirmers.length)) return decision("conflicting");
  if (marker("suspension-notice") && marker("postponement-notice")) return decision("conflicting");
  if (marker("suspension-notice")) return decision("suspended");
  if (marker("postponement-notice")) return decision("postponed");
  if (final && confirmers.length) {
    const confirmed = Math.min(...confirmers.map((row) => instant(row.capture.capturedAt)));
    return decision("completed", new Date(Math.max(instant(final.capture.capturedAt), confirmed)).toISOString());
  }
  return decision(final || confirmers.length ? "in-progress" : "scheduled");
};

// participation-v1: positive usage (an attempt, carry or target) or explicit
// evidence supports one individual label. Missing evidence stays unresolved;
// nothing here establishes a complete eligible population.
export type ParticipationState = "offensive-participant" | "zero-offensive-participation" | "inactive-or-dnp" | "unresolved" | "conflicting";
export type ParticipationDecision = { state: ParticipationState; inputs: Observation[] };
const EVIDENCE = ["participation-feed", "official-inactive-list", "provider-snap-count"] as const;

export const participationDecision = (replay: Replay, gameId: string, playerId: string, stats: PlayerGameStats | null, statsRow: Observation | null): ParticipationDecision => {
  const selections = EVIDENCE.map((kind) => replay.select("participation-evidence", "participation-evidence:" + gameId + ":" + playerId + ":" + kind));
  const inputs = selections.flatMap((selection) => selection.dependencies);
  if (selections.some((selection) => selection.state === "ambiguous")) return { state: "conflicting", inputs };
  const claims = new Set(selections.flatMap((selection) => selection.observation ? [selection.observation.revision.data.claim] : []));
  if (stats && [stats.attempts, stats.carries, stats.targets].some((value) => value !== null && value > 0)) {
    claims.add("offensive-participant");
    if (statsRow) inputs.push(statsRow);
  }
  if (claims.size > 1) return { state: "conflicting", inputs };
  const [claim] = claims;
  return { state: claim ?? "unresolved", inputs };
};

// availability-v1: only an explicit "Out" report withholds. Blank, missing or
// removed reports are unknown, never healthy.
export const availabilityState = (data: Availability | null) => ({
  injury: data?.rawReportStatus === "Out" ? "excluded" as const : "unknown" as const,
  depth: data && data.rawDepthRank !== null ? "observed" as const : "unknown" as const,
});
