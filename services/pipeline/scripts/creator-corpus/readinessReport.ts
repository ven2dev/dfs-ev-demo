import { Client, type ClientBase } from "pg";
import { API_DATA_MAX_AGE_DAYS, isApiDataStale } from "../../../../apps/web/src/lib/creatorCorpusManifest.ts";
import { listWindowWeeks } from "../../../../apps/web/src/lib/creatorVideoRule.ts";
import { assertConnectedCorpusTarget, CorpusImportDatabaseError } from "./importPublisher.ts";
import type {
  CorpusApiVideoProjection,
  CorpusCaptureProjection,
  CorpusDecisionProjection,
  CorpusGateProjection,
} from "./importPlanner.ts";
import type { CorpusDatabaseConfig } from "./importTarget.ts";
import { computeGateCommitment, ReadinessGateError, type PrivateGateRecord } from "./readinessGate.ts";

export const PICK_METRICS_PENDING = "not available: extraction/grading pending (#35/#36)";
export const GATE_SCOPE_NOTICE =
  "Meeting the registered counts permits the next evaluation step only; it does not establish model validity, and picks from the same videos or games may be correlated.";

export class CorpusReadinessError extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

const fail = (code: string): never => {
  throw new CorpusReadinessError(code);
};

type CaptureRow = Pick<CorpusCaptureProjection, "creatorKey" | "logPosition" | "videoId" | "eventKind" | "usageStatus">;
type DecisionRow = Pick<CorpusDecisionProjection, "creatorKey" | "filePosition" | "videoId" | "decisionKind" | "decidedAt">;
type ImportRow = { importId: string; importedAt: string; apiVideoCount: number };
type UnappliedDecision = {
  creatorKey: string;
  videoId: string;
  why: "video-not-in-current-api-evidence" | "video-outside-registered-window";
};

export type CorpusReadinessSource = {
  gate: CorpusGateProjection;
  apiVideos: CorpusApiVideoProjection[];
  captureEvents: CaptureRow[];
  decisionEvents: DecisionRow[];
  latestImport: ImportRow;
  eligibleCreatorKeys: string[];
  now: Date;
};
type CorpusReadinessDatabaseSource = Omit<CorpusReadinessSource, "eligibleCreatorKeys">;

const percentage = (numerator: number, denominator: number) =>
  denominator === 0 ? null : Math.round((numerator / denominator) * 10_000) / 100;

const latestCaptureEvents = (events: readonly CaptureRow[]) => {
  const latest = new Map<string, CaptureRow>();
  for (const event of events) {
    const key = `${event.creatorKey}\0${event.videoId}`;
    const prior = latest.get(key);
    if (!prior || event.logPosition > prior.logPosition) latest.set(key, event);
  }
  return latest;
};

const activeDecisions = (events: readonly DecisionRow[]) => {
  const latest = new Map<string, DecisionRow>();
  for (const event of events) {
    const key = `${event.creatorKey}\0${event.videoId}`;
    const prior = latest.get(key);
    const time = Date.parse(event.decidedAt);
    const priorTime = prior ? Date.parse(prior.decidedAt) : Number.NEGATIVE_INFINITY;
    if (!prior || time > priorTime || (time === priorTime && event.filePosition > prior.filePosition)) latest.set(key, event);
  }
  return [...latest.values()].filter((event) => event.decisionKind !== "clear");
};

const freshness = (videos: readonly CorpusApiVideoProjection[], now: Date) => {
  if (videos.length === 0) return "unknown" as const;
  const stale = videos.filter((video) => isApiDataStale(video.apiFetchedAt, now)).length;
  return stale === 0 ? "fresh" as const : stale === videos.length ? "stale" as const : "mixed" as const;
};

export const buildCorpusReadinessReport = (source: CorpusReadinessSource) => {
  if (!Number.isFinite(source.now.getTime())) return fail("invalid-readiness-time");
  const captures = latestCaptureEvents(source.captureEvents);
  const creatorKeys = [...source.eligibleCreatorKeys].sort();
  if (new Set(creatorKeys).size !== creatorKeys.length || creatorKeys.length !== source.gate.eligibleCreatorCount) {
    return fail("corpus-readiness-creator-set-invalid");
  }
  const dataCreatorKeys = [...new Set([
    ...source.apiVideos.map((row) => row.creatorKey),
    ...source.captureEvents.map((row) => row.creatorKey),
    ...source.decisionEvents.map((row) => row.creatorKey),
  ])].sort();
  const unexpectedCreatorKeys = dataCreatorKeys.filter((key) => !creatorKeys.includes(key));
  const weeks = listWindowWeeks({ endSeason: source.gate.endSeason, endWeek: source.gate.endWeek })
    .filter(({ season, week }) => season > source.gate.startSeason ||
      (season === source.gate.startSeason && week >= source.gate.startWeek));
  const currentDecisions = activeDecisions(source.decisionEvents);
  const decisionsNotApplied = currentDecisions.flatMap<UnappliedDecision>((decision) => {
    const video = source.apiVideos.find((row) => row.creatorKey === decision.creatorKey && row.videoId === decision.videoId);
    if (!video) return [{ creatorKey: decision.creatorKey, videoId: decision.videoId,
      why: "video-not-in-current-api-evidence" as const }];
    if (video.season === null || video.week === null || video.classificationReasons.some((reason) =>
      reason === "outside-registered-regular-season" || reason === "after-registered-end-week")) {
      return [{ creatorKey: decision.creatorKey, videoId: decision.videoId,
        why: "video-outside-registered-window" as const }];
    }
    return [];
  }).sort((left, right) => left.creatorKey.localeCompare(right.creatorKey) || left.videoId.localeCompare(right.videoId));

  const creators = creatorKeys.map((creatorKey) => {
    const apiVideos = source.apiVideos.filter((row) => row.creatorKey === creatorKey);
    const videoIds = [...new Set([
      ...apiVideos.map((video) => video.videoId),
      ...source.captureEvents.filter((event) => event.creatorKey === creatorKey).map((event) => event.videoId),
      ...currentDecisions.filter((event) => event.creatorKey === creatorKey).map((event) => event.videoId),
    ])].sort();
    const videos = videoIds.map((videoId) => {
      const video = apiVideos.find((row) => row.videoId === videoId);
      const capture = captures.get(`${creatorKey}\0${videoId}`);
      return {
        videoId,
        season: video?.season ?? null,
        week: video?.week ?? null,
        inclusion: video?.reviewStatus ?? "unknown" as const,
        captureAvailability: capture?.eventKind ?? "missing",
        apiFreshness: video ? (isApiDataStale(video.apiFetchedAt, source.now) ? "stale" as const : "fresh" as const) : "unknown" as const,
        publicUseClearance: "not-cleared" as const,
      };
    });
    const included = videos.filter((video) => video.inclusion === "present");
    const captured = included.filter((video) =>
      video.captureAvailability === "captured" || video.captureAvailability === "replaced").length;
    const slots = weeks.map(({ season, week }) => {
      const inWeek = videos.filter((video) => video.season === season && video.week === week);
      const videoIds = inWeek.filter((video) => video.inclusion === "present").map((video) => video.videoId);
      const reviewVideoIds = inWeek.filter((video) => video.inclusion === "needs-review").map((video) => video.videoId);
      return {
        season,
        week,
        status: videoIds.length ? "present" as const : reviewVideoIds.length ? "needs-review" as const : "missing" as const,
        apiFreshness: freshness(inWeek.map((video) => apiVideos.find((row) => row.videoId === video.videoId)!), source.now),
        videoIds,
        reviewVideoIds,
      };
    });
    return {
      creatorKey,
      apiEvidence: freshness(apiVideos, source.now),
      captureRate: {
        capturedIncludedVideos: captured,
        includedVideos: included.length,
        percentage: percentage(captured, included.length),
      },
      slots,
      videos,
      unappliedDecisions: decisionsNotApplied.filter((row) => row.creatorKey === creatorKey),
    };
  });

  const allVideos = creators.flatMap((creator) => creator.videos);
  const included = allVideos.filter((video) => video.inclusion === "present");
  const captured = included.filter((video) =>
    video.captureAvailability === "captured" || video.captureAvailability === "replaced").length;
  return {
    formatVersion: 1 as const,
    generatedAt: source.now.toISOString(),
    source: {
      kind: "local-postgres-projection" as const,
      latestImportId: source.latestImport.importId,
      latestImportedAt: source.latestImport.importedAt,
      latestImportedApiVideoCount: source.latestImport.apiVideoCount,
      apiDataMaximumAgeDays: API_DATA_MAX_AGE_DAYS,
    },
    corpus: {
      registeredCreatorCount: source.gate.eligibleCreatorCount,
      identifiedCreatorCount: creators.length,
      unidentifiedCreatorCount: 0,
      unexpectedCreatorCount: unexpectedCreatorKeys.length,
      creatorCoverage: unexpectedCreatorKeys.length === 0 ? "complete" as const : "invalid" as const,
      videos: {
        total: allVideos.length,
        included: included.length,
        needsReview: allVideos.filter((video) => video.inclusion === "needs-review").length,
        excluded: allVideos.filter((video) => video.inclusion === "excluded").length,
        unknown: allVideos.filter((video) => video.inclusion === "unknown").length,
      },
      slots: {
        total: creators.length * weeks.length,
        present: creators.flatMap((creator) => creator.slots).filter((slot) => slot.status === "present").length,
        needsReview: creators.flatMap((creator) => creator.slots).filter((slot) => slot.status === "needs-review").length,
        missing: creators.flatMap((creator) => creator.slots).filter((slot) => slot.status === "missing").length,
      },
      captureRate: {
        capturedIncludedVideos: captured,
        includedVideos: included.length,
        percentage: percentage(captured, included.length),
      },
      publicUseClearance: allVideos.length === 0 ? {
        status: "unavailable" as const, clearedVideos: 0, corpusVideos: 0, percentage: null,
      } : {
        status: "not-cleared" as const, clearedVideos: 0, corpusVideos: allVideos.length, percentage: 0,
      },
    },
    creators,
    unexpectedCreatorKeys,
    unappliedDecisions: decisionsNotApplied,
    gate: {
      commitmentDigest: source.gate.commitmentDigest,
      maximumFeatureCount: source.gate.maximumFeatureCount,
      reviewedGradablePicksOverall: {
        required: source.gate.minimumReviewedGradablePicksOverall,
        observed: null,
        status: "not-available" as const,
      },
      reviewedGradablePicksPerCreator: {
        required: source.gate.minimumReviewedGradablePicksPerCreator,
        observed: null,
        status: "not-available" as const,
      },
      nextEvaluationPermitted: false,
      status: "blocked" as const,
      notice: GATE_SCOPE_NOTICE,
    },
    pickLevelMetrics: {
      market: PICK_METRICS_PENDING,
      missingLineRate: PICK_METRICS_PENDING,
      unresolvedPlayerRate: PICK_METRICS_PENDING,
      outcomeClass: PICK_METRICS_PENDING,
    },
    downstream: {
      extraction: "blocked" as const,
      grading: "blocked" as const,
      modelReadiness: "blocked" as const,
    },
  };
};

const readSource = async (client: ClientBase, now: Date): Promise<CorpusReadinessDatabaseSource> => {
  const gates = (await client.query(`SELECT commitment_digest AS "commitmentDigest",
    commitment_algorithm AS "commitmentAlgorithm",commitment_version AS "commitmentVersion",
    eligible_creator_count AS "eligibleCreatorCount",
    minimum_reviewed_gradable_picks_overall AS "minimumReviewedGradablePicksOverall",
    minimum_reviewed_gradable_picks_per_creator AS "minimumReviewedGradablePicksPerCreator",
    maximum_feature_count AS "maximumFeatureCount",start_season AS "startSeason",start_week AS "startWeek",
    end_season AS "endSeason",end_week AS "endWeek",collection_season_type AS "collectionSeasonType",
    rule_version AS "ruleVersion",to_char(registered_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "registeredAt"
    FROM corpus_gate_registrations ORDER BY imported_at DESC`)).rows;
  if (gates.length === 0) return fail("corpus-readiness-gate-missing");
  if (gates.length !== 1) return fail("corpus-readiness-gate-ambiguous");
  const apiVideos = (await client.query(`SELECT creator_key AS "creatorKey",video_id AS "videoId",
    to_char(published_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "publishedAt",
    duration_seconds AS "durationSeconds",live_broadcast_content AS "liveBroadcastContent",
    to_char(api_fetched_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "apiFetchedAt",
    season,week,season_week_provenance AS "seasonWeekProvenance",classification_status AS "classificationStatus",
    classification_reasons AS "classificationReasons",classification_rule_version AS "classificationRuleVersion",
    review_status AS "reviewStatus" FROM corpus_api_videos ORDER BY creator_key,video_id`)).rows;
  const captureEvents = (await client.query(`SELECT creator_key AS "creatorKey",log_position AS "logPosition",
    video_id AS "videoId",event_kind AS "eventKind",usage_status AS "usageStatus"
    FROM corpus_capture_events ORDER BY creator_key,log_position`)).rows;
  const decisionEvents = (await client.query(`SELECT creator_key AS "creatorKey",file_position AS "filePosition",
    video_id AS "videoId",decision_kind AS "decisionKind",
    to_char(decided_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "decidedAt"
    FROM corpus_decision_events ORDER BY creator_key,file_position`)).rows;
  const imports = (await client.query(`SELECT import_id::text AS "importId",
    to_char(imported_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "importedAt",
    api_video_count AS "apiVideoCount" FROM corpus_imports ORDER BY import_id DESC LIMIT 1`)).rows;
  if (imports.length !== 1) return fail("corpus-readiness-import-missing");
  return { gate: gates[0], apiVideos, captureEvents, decisionEvents, latestImport: imports[0], now };
};

export const generateCorpusReadinessReport = async ({
  config,
  now,
  loadPrivateGateRecord,
}: {
  config: CorpusDatabaseConfig;
  now: Date;
  loadPrivateGateRecord: () => Promise<PrivateGateRecord>;
}) => {
  const client = new Client(config);
  try {
    try { await client.connect(); } catch { return fail("corpus-readiness-database-failure"); }
    try { await assertConnectedCorpusTarget(client, config); }
    catch (error) {
      if (error instanceof CorpusImportDatabaseError) throw error;
      return fail("corpus-readiness-database-failure");
    }
    // The private eligible-key record is opened only after the actual local
    // target and dedicated role have been proven.
    const privateRecord = await loadPrivateGateRecord();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const { rows: [mode] } = await client.query("SHOW transaction_read_only");
      if (mode.transaction_read_only !== "on") return fail("corpus-readiness-read-only-refused");
      const source = await readSource(client, now);
      // The report must not turn expired API-derived classification or week
      // placement into current evidence. Cleanup remains a separate explicit
      // owner operation so this transaction can stay read-only.
      if (source.apiVideos.some((video) => isApiDataStale(video.apiFetchedAt, now))) {
        return fail("corpus-readiness-api-expiry-required");
      }
      if (
        privateRecord.eligibleCreatorKeys.length !== source.gate.eligibleCreatorCount ||
        computeGateCommitment(privateRecord.eligibleCreatorKeys, privateRecord.saltHex) !== source.gate.commitmentDigest
      ) {
        return fail("readiness-gate-verification-failed");
      }
      const report = buildCorpusReadinessReport({ ...source, eligibleCreatorKeys: privateRecord.eligibleCreatorKeys });
      await client.query("COMMIT");
      return report;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (error instanceof CorpusReadinessError || error instanceof CorpusImportDatabaseError ||
        error instanceof ReadinessGateError) throw error;
      return fail("corpus-readiness-database-failure");
    }
  } finally {
    await client.end().catch(() => undefined);
  }
};
