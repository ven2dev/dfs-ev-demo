import type { Availability, Observation, PlayerGameStats, Reconciliation } from "./types.ts";
import type { Replay } from "./replay.ts";
import { canonical, compareText } from "./validation.ts";

// event-completion-v1 lives in completion.ts and is shared with decision
// validation; replay applies it to the current marker heads.
export type { CompletionState } from "./completion.ts";
export const completionDecision = (replay: Replay, gameId: string) => replay.completion(gameId);

// participation-v1 lives in participation.ts and is shared with decision
// validation; replay applies it to the current evidence and stats heads.

// availability-v1: only an explicit "Out" report withholds. Blank, missing or
// removed reports are unknown, never healthy.
export const availabilityState = (data: Availability | null) => ({
  injury: data?.rawReportStatus === "Out" ? "excluded" as const : "unknown" as const,
  depth: data && data.rawDepthRank !== null ? "observed" as const : "unknown" as const,
});

// reconciliation-v1: one provider head is selected as-is; identical claims are
// selected deterministically (lowest source key); any material difference is a
// conflict. No provider authority order is assumed.
export const reconcileFact = (id: string, fact: string, candidates: Observation[], decidedAt: string,
  mode: Reconciliation["mode"], predecessorId: string | null = null): Reconciliation => {
  const ordered = [...candidates].sort((a, b) => compareText(a.sourceKey, b.sourceKey));
  const same = ordered.length > 1 && ordered.every((row) => canonical(row.revision.data) === canonical(ordered[0].revision.data));
  const selected = ordered.length === 1 || same ? ordered[0].revision.id : null;
  const outcome: Reconciliation["outcome"] = !ordered.length ? { result: "insufficient-sources", selectedObservationId: null, rule: "no-candidates" } :
    selected ? { result: "selected", selectedObservationId: selected, rule: ordered.length === 1 ? "single-source" : "sources-agree" } :
    { result: "conflict", selectedObservationId: null, rule: "material-discrepancy" };
  return { id, kind: "reconciliation", entityKey: "reconciliation:" + fact, policyId: "reconciliation-v1", mode, decidedAt, predecessorId, outcome,
    inputs: ordered.map((row) => ({ observationId: row.revision.id, role: row.revision.id === selected ? "selected" : "candidate" })) };
};
