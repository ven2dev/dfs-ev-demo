import type { CompletionRecord, Decision, Observation, Profile } from "./types.ts";
import { canonical, compareText, instant, refuse } from "./validation.ts";

// event-completion-v1, shared by replay and decision validation, and mirrored by
// predictive_decision_check() in migration 0003. Completion is decided from the
// marker heads for one game, never from a file appearance or elapsed time. A
// final status needs an independent confirming marker. completionObservedAt is
// the first capture at which that evidence existed, not physical end time.
export type CompletionState = "scheduled" | "in-progress" | "completed" | "suspended" | "postponed" | "conflicting";
export type CompletionOutcome = { state: CompletionState; completionObservedAt: string | null; actualEnd: null };

const markerType = (row: Observation) => row.revision.kind === "event-state-marker" ? row.revision.data.markerType : row.entityKey.split(":")[2];

export const completionFromHeads = (heads: Observation[]): CompletionOutcome => {
  const outcome = (state: CompletionState, observed: string | null = null): CompletionOutcome => ({ state, completionObservedAt: observed, actualEnd: null });
  const byType = new Map<string, Observation[]>();
  for (const row of heads) byType.set(markerType(row), [...(byType.get(markerType(row)) ?? []), row]);
  // Several provider heads for one marker, or a marker that disappeared, is a conflict.
  if ([...byType.values()].some((rows) => rows.length > 1 || rows.some((row) => row.revision.kind === "source-row-absent"))) return outcome("conflicting");
  const marker = (type: string) => byType.get(type)?.[0] ?? null;
  const final = marker("provider-final-status");
  const confirmers = [marker("terminal-play"), marker("final-team-totals")].filter((row): row is Observation => row !== null);
  const suspended = marker("suspension-notice"), postponed = marker("postponement-notice");
  if ((suspended || postponed) && (final || confirmers.length)) return outcome("conflicting");
  if (suspended && postponed) return outcome("conflicting");
  if (suspended) return outcome("suspended");
  if (postponed) return outcome("postponed");
  if (final && confirmers.length) {
    const confirmed = Math.min(...confirmers.map((row) => instant(row.capture.capturedAt)));
    return outcome("completed", new Date(Math.max(instant(final.capture.capturedAt), confirmed)).toISOString());
  }
  return outcome(final || confirmers.length ? "in-progress" : "scheduled");
};

// Marker heads for one game as known at instant t: revisions usable by t that
// have no successor usable by t. Absences are heads too.
export const markerHeadsAt = (observations: Iterable<Observation>, gameId: string, t: number) => {
  const prefix = "event-state-marker:" + gameId + ":";
  const visible = [...observations].filter((row) => row.entityKey.startsWith(prefix) &&
    instant(row.capture.availableAt) <= t && instant(row.capture.ingestedAt) <= t);
  const superseded = new Set(visible.map((row) => row.revision.predecessorId));
  return visible.filter((row) => !superseded.has(row.revision.id));
};

// A completion record must cite exactly the marker heads known at its decision
// time (no cherry-picking) and state what the policy computes from them.
export const validateCompletionDecisions = (decisions: Decision[], observations: Map<string, Observation>, profiles: Map<string, Profile>) => {
  for (const decision of decisions) {
    if (decision.kind !== "completion") continue;
    const gameId = decision.entityKey.slice("completion:".length);
    const inputs = decision.inputs.map((input) => observations.get(input.observationId) ?? refuse("decision-input-missing"));
    const heads = markerHeadsAt(observations.values(), gameId, instant(decision.decidedAt));
    const ids = (rows: Observation[]) => rows.map((row) => row.revision.id).sort(compareText).join("\n");
    if (ids(inputs) !== ids(heads)) refuse("completion-inputs-not-heads");
    if (canonical(completionFromHeads(heads)) !== canonical(decision.outcome)) refuse("decision-rule-mismatch");
    const synthetic = heads.some((row) => profiles.get(row.artifact.profileId)?.purpose === "synthetic-test");
    if (heads.length && synthetic !== (decision.mode === "synthetic-proof")) refuse("decision-mode-mismatch");
  }
};

export const recordCompletion = (id: string, gameId: string, heads: Observation[], decidedAt: string,
  mode: CompletionRecord["mode"], predecessorId: string | null = null): CompletionRecord => ({
  id, kind: "completion", entityKey: "completion:" + gameId, policyId: "event-completion-v1", mode, decidedAt, predecessorId,
  outcome: completionFromHeads(heads), inputs: [...heads].sort((a, b) => compareText(a.revision.id, b.revision.id)).map((row) => ({ observationId: row.revision.id, role: "marker" })),
});
