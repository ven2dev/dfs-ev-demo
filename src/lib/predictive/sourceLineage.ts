import type { SourceStatsRequest } from "./sourceClaims.ts";
import { SOURCE_PROFILE_VERSION } from "./sourceAdapters.ts";
import { SOURCE_NORMALIZATION_VERSION, type SourceNormalizationPlan } from "./sourceNormalization.ts";
import { SOURCE_STATS_VERSION } from "./sourceStats.ts";
import type { Revision } from "./types.ts";
import { canonical, compareText, digest, entityKey, exact, instant, playerIdentity, refuse, TEAM_IDS, validateRevision } from "./validation.ts";

export const SOURCE_LINEAGE_VERSION = "source-normalization-lineage-v1";
const MAX_EVENTS = 8192;
type StatsRevision = Revision<"player-game-stats"> | Revision<"team-game-stats">;

// Pure lineage validation is independent of the database recorder. The
// recorder assigns binding IDs/clocks; these functions authorize no writes.
// A plan's digest is an integrity check, never proof of source authorization.
export type SourceBindingEvent = {
  version: typeof SOURCE_LINEAGE_VERSION; id: string; predecessorId: string | null; recordedAt: string;
  plan: SourceNormalizationPlan; revision: StatsRevision | null;
};
const identity = (value: unknown) => {
  if (typeof value !== "string" || !value.trim() || value.length > 256 || /[\u0000-\u001f\u007f|]/.test(value))
    refuse("source-lineage-identity-refused");
};
export const sourceStatsRawKey = (request: SourceStatsRequest) => {
  exact(request, ["profileId", "rawGameId", "rawTeam", "rawPlayerId", "cutoff"]);
  identity(request.profileId); instant(request.cutoff);
  if (typeof request.rawGameId !== "string" || !/^2026_\d{2}_[A-Z]{2,3}_[A-Z]{2,3}$/.test(request.rawGameId) ||
      !TEAM_IDS.includes("nfl:team:" + request.rawTeam)) refuse("source-lineage-identity-refused");
  const [, week, away, home] = request.rawGameId.split("_");
  if (Number(week) < 1 || Number(week) > 22 || away === home || ![away, home].includes(request.rawTeam) ||
      !TEAM_IDS.includes("nfl:team:" + away) || !TEAM_IDS.includes("nfl:team:" + home)) refuse("source-lineage-identity-refused");
  if (request.rawPlayerId !== null) playerIdentity(request.rawPlayerId);
  return digest(canonical([request.rawGameId, request.rawTeam, ...(request.rawPlayerId === null ? [] : [request.rawPlayerId])]));
};
export const sourceStatsLineageKey = (request: SourceStatsRequest) =>
  "source-stats:" + digest(canonical([request.profileId, sourceStatsRawKey(request)]));

const verifyPlan = (plan: SourceNormalizationPlan, recordedAt: string) => {
  const binding = plan.binding; const request = binding.sourceRequest;
  const rawKey = sourceStatsRawKey(request);
  const now = instant(recordedAt); const cutoff = instant(binding.cutoff);
  if (binding.version !== SOURCE_NORMALIZATION_VERSION || binding.parserVersion !== SOURCE_PROFILE_VERSION || binding.projectionVersion !== SOURCE_STATS_VERSION ||
      request.profileId !== binding.sourceProfileId || request.cutoff !== binding.cutoff ||
      cutoff > now || (binding.rawSourceKey !== null && binding.rawSourceKey !== rawKey) ||
      plan.observationsPublished !== false || plan.featuresPublished !== false || plan.labelsFinalized !== false || plan.populationCoverage !== "unqualified" ||
      plan.planDigest !== digest(canonical({ reason: plan.reason, candidate: plan.candidate, binding }))) refuse("source-lineage-plan-refused");
  for (const capture of binding.sourceCaptures) {
    if (instant(capture.capturedAt) > instant(capture.availableAt) || instant(capture.availableAt) > instant(capture.ingestedAt) ||
        instant(capture.ingestedAt) > cutoff) refuse("source-lineage-plan-time-refused");
  }
  if (binding.dependencies.some((row) => instant(row.availableAt) > instant(row.ingestedAt) || instant(row.ingestedAt) > cutoff) ||
      binding.identityLinks.some((row) => instant(row.decidedAt) > cutoff) || binding.decisions.some((row) => instant(row.decidedAt) > cutoff))
    refuse("source-lineage-plan-time-refused");
  if (plan.candidate === null) {
    if (plan.status !== "unavailable-source-normalization" || typeof plan.reason !== "string" || !plan.reason.trim() || plan.dataDigest !== null)
      refuse("source-lineage-plan-refused");
  } else {
    if (!["player-game-stats", "team-game-stats"].includes(plan.candidate.kind) || plan.status !== "planned-source-normalization" ||
        plan.reason !== null || plan.dataDigest !== digest(canonical(plan.candidate)) ||
        binding.sourceCaptures.length !== 1 || !binding.sourceRows.length || binding.rawSourceKey !== rawKey)
      refuse("source-lineage-plan-refused");
    validateRevision({ id: "lineage-plan", sourceRecordId: rawKey, predecessorId: null, correctionReason: null, ...plan.candidate });
    const { kind, data } = plan.candidate;
    if (data.rawGameId !== request.rawGameId || data.rawTeam !== request.rawTeam ||
        (kind === "player-game-stats" ? data.rawPlayerId !== request.rawPlayerId : request.rawPlayerId !== null)) refuse("source-lineage-plan-refused");
  }
  return { rawKey, lineageKey: sourceStatsLineageKey(request) };
};

// Every raw lineage has one linear head, even if its canonical routing changes
// or becomes unavailable. Per-entity observation chains keep the released v3
// source_key/FK contract. The raw binding head controls which chain contributes.
const transition = (plan: SourceNormalizationPlan, chain: SourceBindingEvent[], latestAtEntity?: Map<string, StatsRevision>) => {
  const previous = chain.at(-1) ?? null;
  const rawKey = sourceStatsRawKey(plan.binding.sourceRequest);
  const candidate = plan.candidate;
  const key = candidate ? entityKey({ id: "lineage-plan", sourceRecordId: rawKey, predecessorId: null, correctionReason: null, ...candidate }) : null;
  const previousAtEntity = key === null ? null : latestAtEntity ? latestAtEntity.get(key) ?? null
    : [...chain].reverse().find((event) => event.revision && entityKey(event.revision) === key)?.revision ?? null;
  const unchanged = candidate && previousAtEntity && canonical({ kind: previousAtEntity.kind, data: previousAtEntity.data }) === canonical(candidate);
  return {
    version: SOURCE_LINEAGE_VERSION, lineageKey: sourceStatsLineageKey(plan.binding.sourceRequest), sourceRecordId: rawKey,
    expectedHeadId: previous?.id ?? null, previousSelectedObservationId: previous?.revision?.id ?? null,
    entityKey: key, action: !candidate ? "withhold" as const : unchanged ? "attach" as const : "append" as const,
    existingObservationId: unchanged ? previousAtEntity.id : null,
    canonicalPredecessorId: candidate && !unchanged ? previousAtEntity?.id ?? null : null,
    candidate,
  };
};
const validateHistory = (events: SourceBindingEvent[]) => {
  if (events.length > MAX_EVENTS) refuse("source-lineage-bounds-refused");
  const byId = new Map<string, SourceBindingEvent>();
  const keys = new Map<string, string>(); const successors = new Map<string, SourceBindingEvent>(); const roots = new Map<string, SourceBindingEvent>();
  for (const event of events) {
    exact(event, ["version", "id", "predecessorId", "recordedAt", "plan", "revision"]);
    identity(event.id); if (event.predecessorId !== null) identity(event.predecessorId);
    if (event.version !== SOURCE_LINEAGE_VERSION || byId.has(event.id) || event.id === event.predecessorId) refuse("source-lineage-history-refused");
    const { lineageKey } = verifyPlan(event.plan, event.recordedAt);
    byId.set(event.id, event); keys.set(event.id, lineageKey);
    if (event.predecessorId !== null) {
      if (successors.has(event.predecessorId)) refuse("source-lineage-branch-refused");
      successors.set(event.predecessorId, event);
    } else {
      if (roots.has(lineageKey)) refuse("source-lineage-branch-refused");
      roots.set(lineageKey, event);
    }
  }
  const chains = new Map<string, SourceBindingEvent[]>();
  const observations = new Map<string, { revision: StatsRevision; lineageKey: string }>();
  for (const event of events) {
    if (event.predecessorId !== null && (!byId.has(event.predecessorId) || keys.get(event.predecessorId) !== keys.get(event.id)))
      refuse("source-lineage-predecessor-refused");
  }
  // Walk explicit successor links, including equal-time events. Input order or
  // an ID tie break cannot decide which event wins. Disconnected cycles refuse.
  let visited = 0;
  for (const [lineageKey, root] of roots) {
    let event: SourceBindingEvent | undefined = root;
    const chain: SourceBindingEvent[] = [];
    const latestAtEntity = new Map<string, StatsRevision>();
    while (event) {
      if (event.predecessorId !== null) {
        const parent = byId.get(event.predecessorId)!;
        if (instant(parent.recordedAt) > instant(event.recordedAt) || instant(parent.plan.binding.cutoff) > instant(event.plan.binding.cutoff))
          refuse("source-lineage-time-refused");
      }
      const expected = transition(event.plan, chain, latestAtEntity);
      if (event.predecessorId !== expected.expectedHeadId) refuse("source-lineage-predecessor-refused");
      const revision = event.revision;
      if (expected.action === "withhold") {
        if (revision !== null) refuse("source-lineage-revision-refused");
      } else {
        if (!revision) refuse("source-lineage-revision-refused");
        validateRevision(revision);
        const known = observations.get(revision.id);
        if (canonical({ kind: revision.kind, data: revision.data }) !== canonical(expected.candidate) || revision.sourceRecordId !== expected.sourceRecordId ||
            (expected.action === "attach" ? revision.id !== expected.existingObservationId || !known || canonical(known.revision) !== canonical(revision)
              : !!known || revision.predecessorId !== expected.canonicalPredecessorId)) refuse("source-lineage-revision-refused");
        if (known && known.lineageKey !== lineageKey) refuse("source-lineage-revision-refused");
        observations.set(revision.id, { revision, lineageKey });
        latestAtEntity.set(entityKey(revision), revision);
      }
      chain.push(event); visited++; event = successors.get(event.id);
    }
    chains.set(lineageKey, chain);
  }
  if (visited !== events.length) refuse("source-lineage-cycle-refused");
  return chains;
};

export const planSourceBindingTransition = (plan: SourceNormalizationPlan, history: SourceBindingEvent[], recordedAt: string) => {
  const { lineageKey } = verifyPlan(plan, recordedAt);
  const chains = validateHistory(history); const chain = chains.get(lineageKey) ?? [];
  const parent = chain.at(-1);
  if (parent && (instant(parent.recordedAt) > instant(recordedAt) || instant(parent.plan.binding.cutoff) > instant(plan.binding.cutoff)))
    refuse("source-lineage-time-refused");
  return transition(plan, chain);
};

// Select raw heads first, then route. Filtering by canonical entity before
// following the raw chain would resurrect the old player's/game's statistics.
// Callers must still verify bytes/current rights; this returns ledger evidence.
export const sourceBindingHeadsAt = (history: SourceBindingEvent[], cutoff: string) => {
  const at = instant(cutoff);
  const visible = history.filter((event) => instant(event.recordedAt) <= at);
  return [...validateHistory(visible).values()].map((chain) => chain.at(-1)!)
    .sort((a, b) => compareText(sourceStatsLineageKey(a.plan.binding.sourceRequest), sourceStatsLineageKey(b.plan.binding.sourceRequest)));
};
