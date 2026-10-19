import { createHash } from "node:crypto";
import type { CaptureEvent, CaptionKind } from "../../../../apps/web/src/lib/creatorCaptures.ts";
import type { DecisionEvent, DecisionsFile } from "../../../../apps/web/src/lib/creatorDecisions.ts";
import type { ClassificationStatus, ReasonCode } from "../../../../apps/web/src/lib/creatorVideoRule.ts";
import { CommandError, rebuildDiscovery } from "./commands.ts";
import type { Registration } from "./creatorInputs.ts";
import type { DecisionNotApplied, DiscoveryFile } from "./discoveryFile.ts";
import type { ReadinessGate } from "./readinessGate.ts";

export const CORPUS_IMPORTER_VERSION = "corpus-import-v1";
export const CORPUS_SEASON_WEEK_PROVENANCE = "youtube-api-published-at.nfl-calendar-v1";

const SHA256 = /^[a-f0-9]{64}$/;

export class CorpusImportPlanError extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

const fail = (code: string): never => {
  throw new CorpusImportPlanError(code);
};

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) return fail("unfingerprintable-corpus-input");
  return encoded;
};

export const corpusFingerprint = (value: unknown): string =>
  createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");

export type CorpusInputFingerprints = {
  registration: string;
  gate: string;
  captures: string;
  decisions: string;
  discovery: string;
};

export type CorpusCaptureProjection = {
  creatorKey: string;
  logPosition: number;
  eventFingerprint: string;
  videoId: string;
  eventKind: CaptureEvent["event"];
  publishedDate: string;
  publishedDatePrecision: "day";
  publishedDateProvenance: "owner-confirmed-video-page-pacific-date";
  transcriptSource: CaptureEvent["source"];
  usageStatus: CaptureEvent["usageStatus"];
  captionKind: CaptionKind | null;
  transcriptSha256: string | null;
  transcriptCharacters: number | null;
  capturedAt: string;
};

export type CorpusDecisionProjection = {
  creatorKey: string;
  filePosition: number;
  eventFingerprint: string;
  videoId: string;
  decisionKind: DecisionEvent["decision"];
  reason: string;
  ruleVersion: string;
  decidedAt: string;
};

export type CorpusGateProjection = {
  commitmentDigest: string;
  commitmentAlgorithm: ReadinessGate["commitment"]["algorithm"];
  commitmentVersion: number;
  eligibleCreatorCount: number;
  minimumReviewedGradablePicksOverall: number;
  minimumReviewedGradablePicksPerCreator: number;
  maximumFeatureCount: number;
  startSeason: number;
  startWeek: number;
  endSeason: number;
  endWeek: number;
  collectionSeasonType: "regular";
  ruleVersion: string;
  registeredAt: string;
};

export type CorpusApiVideoProjection = {
  creatorKey: string;
  videoId: string;
  publishedAt: string;
  durationSeconds: number | null;
  liveBroadcastContent: "none" | "upcoming" | "live";
  apiFetchedAt: string;
  season: number | null;
  week: number | null;
  seasonWeekProvenance: typeof CORPUS_SEASON_WEEK_PROVENANCE;
  classificationStatus: ClassificationStatus;
  classificationReasons: ReasonCode[];
  classificationRuleVersion: string;
  reviewStatus: "present" | "needs-review" | "excluded";
};

export type CorpusStoredImport = {
  importId: string;
  importerVersion: string;
  ruleVersion: string;
  registrationFingerprint: string;
  gateFingerprint: string;
  captureInputFingerprint: string;
  decisionInputFingerprint: string;
  discoveryInputFingerprint: string;
  captureEventCount: number;
  decisionEventCount: number;
  apiVideoCount: number;
};

export type CorpusStoredState = {
  captureEvents: Pick<CorpusCaptureProjection, "creatorKey" | "logPosition" | "eventFingerprint">[];
  decisionEvents: Pick<CorpusDecisionProjection, "creatorKey" | "filePosition" | "eventFingerprint">[];
  gateRegistrations: CorpusGateProjection[];
  apiVideos: CorpusApiVideoProjection[];
  imports: CorpusStoredImport[];
};

export type CorpusImportSource = {
  captures: readonly CaptureEvent[];
  decisions: DecisionsFile;
  discovery: DiscoveryFile;
  registration: Registration;
  gate: ReadinessGate;
  fingerprints: CorpusInputFingerprints;
  now: Date;
};

export type CorpusImportAudit = Omit<CorpusStoredImport, "importId">;

export type CorpusHistoryRefusal = {
  stream: "captures" | "decisions" | "gate" | "projection";
  code: "stored-history-invalid" | "history-truncated" | "history-changed" | "import-projection-drift";
  creatorKey?: string;
  position?: number;
};

export type CorpusApiSnapshotPlan = {
  creatorKey: string;
  action: "no-op" | "replace";
  rows: CorpusApiVideoProjection[];
};

type PlanContext = { decisionsNotApplied: DecisionNotApplied[] };

export type CorpusImportPlan =
  | (PlanContext & { outcome: "refuse"; refusals: CorpusHistoryRefusal[] })
  | (PlanContext & { outcome: "no-op"; existingImportId: string })
  | (PlanContext & {
      outcome: "append";
      audit: CorpusImportAudit;
      captureEvents: CorpusCaptureProjection[];
      decisionEvents: CorpusDecisionProjection[];
      gateRegistration: CorpusGateProjection | null;
      apiSnapshots: CorpusApiSnapshotPlan[];
    });

const captureProjections = (events: readonly CaptureEvent[]): CorpusCaptureProjection[] => {
  const positions = new Map<string, number>();
  return events.map((event) => {
    const logPosition = (positions.get(event.creatorKey) ?? 0) + 1;
    positions.set(event.creatorKey, logPosition);
    return {
      creatorKey: event.creatorKey,
      logPosition,
      eventFingerprint: corpusFingerprint(event),
      videoId: event.videoId,
      eventKind: event.event,
      publishedDate: event.publishedDate,
      publishedDatePrecision: "day",
      publishedDateProvenance: "owner-confirmed-video-page-pacific-date",
      transcriptSource: event.source,
      usageStatus: event.usageStatus,
      captionKind: event.captionKind,
      transcriptSha256: event.sha256,
      transcriptCharacters: event.characters,
      capturedAt: new Date(event.capturedAt).toISOString(),
    };
  });
};

const decisionProjections = (file: DecisionsFile): CorpusDecisionProjection[] =>
  Object.keys(file).sort().flatMap((creatorKey) =>
    file[creatorKey].map((event, index) => ({
      creatorKey,
      filePosition: index + 1,
      eventFingerprint: corpusFingerprint(event),
      videoId: event.videoId,
      decisionKind: event.decision,
      reason: event.reason,
      ruleVersion: event.ruleVersion,
      decidedAt: new Date(event.decidedAt).toISOString(),
    }))
  );

const gateProjection = (gate: ReadinessGate): CorpusGateProjection => ({
  commitmentDigest: gate.commitment.digest,
  commitmentAlgorithm: gate.commitment.algorithm,
  commitmentVersion: gate.commitment.version,
  eligibleCreatorCount: gate.eligibleCreatorCount,
  minimumReviewedGradablePicksOverall: gate.minimumReviewedGradablePicksOverall,
  minimumReviewedGradablePicksPerCreator: gate.minimumReviewedGradablePicksPerCreator,
  maximumFeatureCount: gate.maximumFeatureCount,
  startSeason: gate.collectionWindow.startSeason,
  startWeek: gate.collectionWindow.startWeek,
  endSeason: gate.collectionWindow.endSeason,
  endWeek: gate.collectionWindow.endWeek,
  collectionSeasonType: gate.collectionWindow.seasonType,
  ruleVersion: gate.ruleVersion,
  registeredAt: new Date(gate.registeredAt).toISOString(),
});

const apiProjections = (discovery: DiscoveryFile): CorpusApiVideoProjection[] => {
  const seenVideoIds = new Set<string>();
  return discovery.creators.flatMap((creator) => {
    const byId = new Map(creator.manifest.videos.map((video) => [video.videoId, video]));
    if (byId.size !== creator.videos.length) return fail("duplicate-api-video");
    return creator.videos.map((video): CorpusApiVideoProjection => {
      if (seenVideoIds.has(video.videoId)) return fail("video-assigned-to-multiple-creators");
      seenVideoIds.add(video.videoId);
      const classified = byId.get(video.videoId);
      if (!classified) return fail("discovery-manifest-mismatch");
      const publishedAt = Date.parse(video.publishedAt);
      const fetchedAt = Date.parse(video.apiFetchedAt);
      if (
        !Number.isFinite(publishedAt) ||
        !Number.isFinite(fetchedAt) ||
        fetchedAt < publishedAt ||
        (video.durationSeconds !== null && (!Number.isInteger(video.durationSeconds) || video.durationSeconds < 0))
      ) {
        return fail("invalid-api-video-projection");
      }
      return {
        creatorKey: creator.key,
        videoId: video.videoId,
        publishedAt: new Date(publishedAt).toISOString(),
        durationSeconds: video.durationSeconds,
        liveBroadcastContent: video.liveBroadcastContent,
        apiFetchedAt: new Date(fetchedAt).toISOString(),
        season: classified.season,
        week: classified.week,
        seasonWeekProvenance: CORPUS_SEASON_WEEK_PROVENANCE,
        classificationStatus: classified.classification.status,
        classificationReasons: [...classified.classification.reasons],
        classificationRuleVersion: classified.classification.ruleVersion,
        reviewStatus: classified.status,
      };
    });
  }).sort((left, right) => left.creatorKey.localeCompare(right.creatorKey) || left.videoId.localeCompare(right.videoId));
};

const historyTail = <T extends { creatorKey: string }, S extends { creatorKey: string }>(
  incoming: readonly T[],
  stored: readonly S[],
  position: (row: T | S) => number,
  fingerprint: (row: T | S) => string,
  stream: "captures" | "decisions"
): { append: T[]; refusals: CorpusHistoryRefusal[] } => {
  const creators = [...new Set([...incoming.map((row) => row.creatorKey), ...stored.map((row) => row.creatorKey)])].sort();
  const append: T[] = [];
  const refusals: CorpusHistoryRefusal[] = [];
  for (const creatorKey of creators) {
    const next = incoming.filter((row) => row.creatorKey === creatorKey).sort((a, b) => position(a) - position(b));
    const prior = stored.filter((row) => row.creatorKey === creatorKey).sort((a, b) => position(a) - position(b));
    if (prior.some((row, index) => position(row) !== index + 1)) {
      refusals.push({ stream, code: "stored-history-invalid", creatorKey });
      continue;
    }
    if (next.length < prior.length) {
      refusals.push({ stream, code: "history-truncated", creatorKey, position: next.length + 1 });
      continue;
    }
    const changed = prior.findIndex((row, index) => fingerprint(row) !== fingerprint(next[index]));
    if (changed !== -1) {
      refusals.push({ stream, code: "history-changed", creatorKey, position: changed + 1 });
      continue;
    }
    append.push(...next.slice(prior.length));
  }
  return { append, refusals };
};

const same = (left: unknown, right: unknown): boolean => canonicalJson(left) === canonicalJson(right);

const assertInputsCoherent = ({
  registration,
  gate,
  discovery,
  fingerprints,
}: {
  registration: Registration;
  gate: ReadinessGate;
  discovery: DiscoveryFile;
  fingerprints: CorpusInputFingerprints;
}) => {
  if (Object.values(fingerprints).some((value) => !SHA256.test(value))) fail("invalid-input-fingerprint");
  if (!same(registration, discovery.registration)) fail("registration-discovery-mismatch");
  if (
    gate.ruleVersion !== registration.ruleVersion ||
    gate.collectionWindow.endSeason !== registration.window.endSeason ||
    gate.collectionWindow.endWeek !== registration.window.endWeek
  ) {
    fail("registration-gate-mismatch");
  }
  if (gate.eligibleCreatorCount !== discovery.creators.length) fail("eligible-creator-count-mismatch");
};

export const planCorpusImport = ({
  captures,
  decisions,
  discovery,
  registration,
  gate,
  fingerprints,
  stored,
  now,
}: CorpusImportSource & { stored: CorpusStoredState }): CorpusImportPlan => {
  assertInputsCoherent({ registration, gate, discovery, fingerprints });
  if (!Number.isFinite(now.getTime())) fail("invalid-import-time");
  const creatorKeys = new Set(discovery.creators.map((creator) => creator.key));
  if (captures.some((event) => !creatorKeys.has(event.creatorKey))) fail("unknown-capture-creator");
  let rebuilt: DiscoveryFile;
  try {
    rebuilt = rebuildDiscovery({ discovery, decisions, now });
  } catch (error) {
    if (error instanceof CommandError) return fail(error.code);
    throw error;
  }
  const decisionsNotApplied = rebuilt.decisionsNotApplied ?? [];
  const captureRows = captureProjections(captures);
  const decisionRows = decisionProjections(decisions);
  const apiRows = apiProjections(rebuilt);
  const gateRow = gateProjection(gate);

  const captureHistory = historyTail(
    captureRows,
    stored.captureEvents,
    (row) => (row as CorpusCaptureProjection).logPosition,
    (row) => (row as CorpusCaptureProjection).eventFingerprint,
    "captures"
  );
  const decisionHistory = historyTail(
    decisionRows,
    stored.decisionEvents,
    (row) => (row as CorpusDecisionProjection).filePosition,
    (row) => (row as CorpusDecisionProjection).eventFingerprint,
    "decisions"
  );
  const refusals = [...captureHistory.refusals, ...decisionHistory.refusals];

  const matchingGate = stored.gateRegistrations.find((row) => row.commitmentDigest === gateRow.commitmentDigest);
  if (matchingGate && !same(matchingGate, gateRow)) refusals.push({ stream: "gate", code: "history-changed" });

  const audit: CorpusImportAudit = {
    importerVersion: CORPUS_IMPORTER_VERSION,
    ruleVersion: registration.ruleVersion,
    registrationFingerprint: fingerprints.registration,
    gateFingerprint: fingerprints.gate,
    captureInputFingerprint: fingerprints.captures,
    decisionInputFingerprint: fingerprints.decisions,
    discoveryInputFingerprint: fingerprints.discovery,
    captureEventCount: captureRows.length,
    decisionEventCount: decisionRows.length,
    apiVideoCount: apiRows.length,
  };
  const matchingImports = stored.imports.filter((row) =>
    row.importerVersion === audit.importerVersion &&
    row.ruleVersion === audit.ruleVersion &&
    row.registrationFingerprint === audit.registrationFingerprint &&
    row.gateFingerprint === audit.gateFingerprint &&
    row.captureInputFingerprint === audit.captureInputFingerprint &&
    row.decisionInputFingerprint === audit.decisionInputFingerprint &&
    row.discoveryInputFingerprint === audit.discoveryInputFingerprint
  );
  if (matchingImports.length > 1) refusals.push({ stream: "projection", code: "stored-history-invalid" });

  const incomingCreators = new Set(rebuilt.creators.map((creator) => creator.key));
  if (stored.apiVideos.some((row) => !incomingCreators.has(row.creatorKey))) {
    refusals.push({ stream: "projection", code: "stored-history-invalid" });
  }
  const apiSnapshots = rebuilt.creators.map((creator): CorpusApiSnapshotPlan => {
    const rows = apiRows.filter((row) => row.creatorKey === creator.key);
    const prior = stored.apiVideos
      .filter((row) => row.creatorKey === creator.key)
      .sort((left, right) => left.videoId.localeCompare(right.videoId));
    return { creatorKey: creator.key, action: same(prior, rows) ? "no-op" : "replace", rows };
  });

  const existing = matchingImports[0];
  if (existing) {
    if (
      !same({
        captureEventCount: existing.captureEventCount,
        decisionEventCount: existing.decisionEventCount,
        apiVideoCount: existing.apiVideoCount,
      }, {
        captureEventCount: audit.captureEventCount,
        decisionEventCount: audit.decisionEventCount,
        apiVideoCount: audit.apiVideoCount,
      }) ||
      captureHistory.append.length > 0 ||
      decisionHistory.append.length > 0 ||
      !matchingGate ||
      apiSnapshots.some((snapshot) => snapshot.action !== "no-op")
    ) {
      refusals.push({ stream: "projection", code: "import-projection-drift" });
    }
  }

  if (refusals.length > 0) return { outcome: "refuse", refusals, decisionsNotApplied };
  if (existing) return { outcome: "no-op", existingImportId: existing.importId, decisionsNotApplied };
  return {
    outcome: "append",
    audit,
    captureEvents: captureHistory.append,
    decisionEvents: decisionHistory.append,
    gateRegistration: matchingGate ? null : gateRow,
    apiSnapshots,
    decisionsNotApplied,
  };
};
