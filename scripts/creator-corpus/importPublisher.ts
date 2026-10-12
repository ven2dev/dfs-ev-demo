import { Client, type ClientBase } from "pg";
import {
  CorpusImportPlanError,
  planCorpusImport,
  type CorpusApiVideoProjection,
  type CorpusImportPlan,
  type CorpusImportSource,
  type CorpusStoredState,
} from "./importPlanner.ts";
import type { CorpusDatabaseConfig } from "./importTarget.ts";

const LOCK_NAMESPACE = 606090;
const LOCK_KEY = 1;

export class CorpusImportDatabaseError extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

const fail = (code: string): never => {
  throw new CorpusImportDatabaseError(code);
};

const assertConnectedTarget = async (client: ClientBase, config: CorpusDatabaseConfig): Promise<void> => {
  const { rows: [identity] } = await client.query(`SELECT current_database() AS database,current_user AS role,
    current_setting('server_version_num')::integer AS version,
    (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser`);
  if (
    identity.database !== config.database ||
    identity.role !== "corpus_importer" ||
    identity.superuser !== false ||
    identity.version < 180000 ||
    identity.version >= 190000
  ) {
    return fail("connected-corpus-target-refused");
  }
  const { rows } = await client.query(`SELECT name,to_regclass('public.' || name) IS NOT NULL AS present,
      has_table_privilege(current_user,'public.' || name,'SELECT') AS can_select,
      has_table_privilege(current_user,'public.' || name,'INSERT') AS can_insert,
      has_table_privilege(current_user,'public.' || name,'UPDATE') AS can_update,
      has_table_privilege(current_user,'public.' || name,'DELETE') AS can_delete
    FROM unnest(ARRAY['corpus_imports','corpus_capture_events','corpus_decision_events',
      'corpus_gate_registrations','corpus_api_videos']) AS name`);
  if (rows.length !== 5 || rows.some((row) => !row.present || !row.can_select || !row.can_insert || row.can_update ||
      (row.name === "corpus_api_videos" ? !row.can_delete : row.can_delete))) {
    return fail("corpus-import-privileges-refused");
  }
};

export const readCorpusStoredState = async (client: ClientBase): Promise<CorpusStoredState> => {
  const captureEvents = (await client.query(`SELECT creator_key AS "creatorKey",log_position AS "logPosition",
    event_fingerprint AS "eventFingerprint" FROM corpus_capture_events ORDER BY creator_key,log_position`)).rows;
  const decisionEvents = (await client.query(`SELECT creator_key AS "creatorKey",file_position AS "filePosition",
    event_fingerprint AS "eventFingerprint" FROM corpus_decision_events ORDER BY creator_key,file_position`)).rows;
  const gateRegistrations = (await client.query(`SELECT commitment_digest AS "commitmentDigest",
    commitment_algorithm AS "commitmentAlgorithm",commitment_version AS "commitmentVersion",
    eligible_creator_count AS "eligibleCreatorCount",
    minimum_reviewed_gradable_picks_overall AS "minimumReviewedGradablePicksOverall",
    minimum_reviewed_gradable_picks_per_creator AS "minimumReviewedGradablePicksPerCreator",
    maximum_feature_count AS "maximumFeatureCount",start_season AS "startSeason",start_week AS "startWeek",
    end_season AS "endSeason",end_week AS "endWeek",collection_season_type AS "collectionSeasonType",
    rule_version AS "ruleVersion",to_char(registered_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "registeredAt"
    FROM corpus_gate_registrations ORDER BY commitment_digest`)).rows;
  const apiVideos = (await client.query(`SELECT creator_key AS "creatorKey",video_id AS "videoId",
    to_char(published_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "publishedAt",duration_seconds AS "durationSeconds",
    live_broadcast_content AS "liveBroadcastContent",to_char(api_fetched_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "apiFetchedAt",
    season,week,season_week_provenance AS "seasonWeekProvenance",classification_status AS "classificationStatus",
    classification_reasons AS "classificationReasons",classification_rule_version AS "classificationRuleVersion",
    review_status AS "reviewStatus" FROM corpus_api_videos ORDER BY creator_key,video_id`)).rows;
  const imports = (await client.query(`SELECT import_id::text AS "importId",importer_version AS "importerVersion",
    rule_version AS "ruleVersion",registration_fingerprint AS "registrationFingerprint",
    gate_fingerprint AS "gateFingerprint",capture_input_fingerprint AS "captureInputFingerprint",
    decision_input_fingerprint AS "decisionInputFingerprint",discovery_input_fingerprint AS "discoveryInputFingerprint",
    capture_event_count AS "captureEventCount",decision_event_count AS "decisionEventCount",api_video_count AS "apiVideoCount"
    FROM corpus_imports ORDER BY import_id`)).rows;
  return { captureEvents, decisionEvents, gateRegistrations, apiVideos, imports };
};

const insertApiRow = (client: ClientBase, row: CorpusApiVideoProjection, importId: string) => client.query(
  `INSERT INTO corpus_api_videos (creator_key,video_id,published_at,duration_seconds,live_broadcast_content,
    api_fetched_at,season,week,season_week_provenance,classification_status,classification_reasons,
    classification_rule_version,review_status,snapshot_import_id)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
  [row.creatorKey,row.videoId,row.publishedAt,row.durationSeconds,row.liveBroadcastContent,row.apiFetchedAt,row.season,
    row.week,row.seasonWeekProvenance,row.classificationStatus,row.classificationReasons,row.classificationRuleVersion,
    row.reviewStatus,importId]
);

const publishAppend = async (
  client: ClientBase,
  plan: Extract<CorpusImportPlan, { outcome: "append" }>
): Promise<string> => {
  const { rows: [created] } = await client.query(`INSERT INTO corpus_imports
    (importer_version,rule_version,registration_fingerprint,gate_fingerprint,capture_input_fingerprint,
      decision_input_fingerprint,discovery_input_fingerprint,capture_event_count,decision_event_count,api_video_count)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING import_id::text AS id`,
  [plan.audit.importerVersion,plan.audit.ruleVersion,plan.audit.registrationFingerprint,plan.audit.gateFingerprint,
    plan.audit.captureInputFingerprint,plan.audit.decisionInputFingerprint,plan.audit.discoveryInputFingerprint,
    plan.audit.captureEventCount,plan.audit.decisionEventCount,plan.audit.apiVideoCount]);
  const importId = created.id as string;
  if (plan.gateRegistration) {
    const row = plan.gateRegistration;
    await client.query(`INSERT INTO corpus_gate_registrations
      (commitment_digest,commitment_algorithm,commitment_version,eligible_creator_count,
        minimum_reviewed_gradable_picks_overall,minimum_reviewed_gradable_picks_per_creator,maximum_feature_count,
        start_season,start_week,end_season,end_week,collection_season_type,rule_version,registered_at,first_import_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [row.commitmentDigest,row.commitmentAlgorithm,row.commitmentVersion,row.eligibleCreatorCount,
      row.minimumReviewedGradablePicksOverall,row.minimumReviewedGradablePicksPerCreator,row.maximumFeatureCount,
      row.startSeason,row.startWeek,row.endSeason,row.endWeek,row.collectionSeasonType,row.ruleVersion,row.registeredAt,importId]);
  }
  for (const row of plan.captureEvents) await client.query(`INSERT INTO corpus_capture_events
    (creator_key,log_position,event_fingerprint,video_id,event_kind,published_date,published_date_precision,
      published_date_provenance,transcript_source,usage_status,caption_kind,transcript_sha256,transcript_characters,
      captured_at,first_import_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
  [row.creatorKey,row.logPosition,row.eventFingerprint,row.videoId,row.eventKind,row.publishedDate,
    row.publishedDatePrecision,row.publishedDateProvenance,row.transcriptSource,row.usageStatus,row.captionKind,
    row.transcriptSha256,row.transcriptCharacters,row.capturedAt,importId]);
  for (const row of plan.decisionEvents) await client.query(`INSERT INTO corpus_decision_events
    (creator_key,file_position,event_fingerprint,video_id,decision_kind,reason,rule_version,decided_at,first_import_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
  [row.creatorKey,row.filePosition,row.eventFingerprint,row.videoId,row.decisionKind,row.reason,row.ruleVersion,row.decidedAt,importId]);
  for (const snapshot of plan.apiSnapshots) {
    if (snapshot.action === "no-op") continue;
    await client.query("DELETE FROM corpus_api_videos WHERE creator_key=$1", [snapshot.creatorKey]);
    for (const row of snapshot.rows) await insertApiRow(client, row, importId);
  }
  return importId;
};

export type CorpusImportResult =
  | { outcome: "refuse"; plan: Extract<CorpusImportPlan, { outcome: "refuse" }> }
  | { outcome: "no-op"; importId: string; decisionsNotApplied: number }
  | { outcome: "append"; importId: string; capturesAppended: number; decisionsAppended: number;
      apiSnapshotsReplaced: number; decisionsNotApplied: number };

export const publishCorpusImport = async ({
  config,
  loadSource,
}: {
  config: CorpusDatabaseConfig;
  loadSource: () => Promise<CorpusImportSource>;
}): Promise<CorpusImportResult> => {
  const client = new Client(config);
  try {
    try { await client.connect(); } catch { return fail("corpus-import-database-failure"); }
    // Establish the actual database, role, version and grants before the
    // callback is allowed to open any private corpus source.
    try { await assertConnectedTarget(client, config); }
    catch (error) {
      if (error instanceof CorpusImportDatabaseError) throw error;
      return fail("corpus-import-database-failure");
    }
    // Source and gate failures keep their fixed owner-facing codes. They are
    // intentionally outside the database-error boundary, but still occur only
    // after the connected target has been proven.
    const source = await loadSource();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      await client.query("SET LOCAL lock_timeout='3s'");
      await client.query("SET LOCAL statement_timeout='20s'");
      await client.query("SET LOCAL idle_in_transaction_session_timeout='20s'");
      await client.query("SET LOCAL search_path=public");
      const { rows: [lock] } = await client.query("SELECT pg_try_advisory_xact_lock($1,$2) AS acquired", [LOCK_NAMESPACE, LOCK_KEY]);
      if (!lock.acquired) return fail("corpus-import-lock-busy");
      const plan = planCorpusImport({ ...source, stored: await readCorpusStoredState(client) });
      if (plan.outcome === "refuse") {
        await client.query("ROLLBACK");
        return { outcome: "refuse", plan };
      }
      if (plan.outcome === "no-op") {
        await client.query("COMMIT");
        return { outcome: "no-op", importId: plan.existingImportId, decisionsNotApplied: plan.decisionsNotApplied.length };
      }
      const importId = await publishAppend(client, plan);
      await client.query("COMMIT");
      return {
        outcome: "append",
        importId,
        capturesAppended: plan.captureEvents.length,
        decisionsAppended: plan.decisionEvents.length,
        apiSnapshotsReplaced: plan.apiSnapshots.filter((snapshot) => snapshot.action === "replace").length,
        decisionsNotApplied: plan.decisionsNotApplied.length,
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (error instanceof CorpusImportDatabaseError || error instanceof CorpusImportPlanError) throw error;
      return fail("corpus-import-database-failure");
    }
  } finally {
    await client.end().catch(() => undefined);
  }
};
