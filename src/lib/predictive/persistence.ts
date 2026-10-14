import type { Client } from "pg";
import { checkConnectedTarget } from "../../../scripts/db-migrations/core.mjs";
import type { ArtifactMediaType, PrivateArtifactStore } from "./artifacts.ts";
import { createEvidenceBatch } from "./batchEvidence.ts";
import { normalizeFittingRunRequest, selectTrainingRows, TRAINING_BOUNDS, type FittingRunRequest } from "./training.ts";
import { checkTrainingMetadataSelection, TRAINING_SELECTION_SQL, trainingSelectionParameters, type TrainingMetadataSelection } from "./trainingSql.ts";
import { trainingRunPreview, type TrainingKickoffProof } from "./trainingPreview.ts";
import type { TrainingRunInventory } from "./trainingRuns.ts";
import { inspectCompressedSource, COMPRESSED_SOURCE_LIMITS, type CompressedInspectionRequest } from "./compressedSource.ts";
import { runCompressedWorker } from "./compressedWorker.ts";
import { assertTrainingShardUnexpired, normalizeTrainingShardRequest, trainingShardMembership, trainingShardProof, type TrainingShardRequest } from "./trainingShards.ts";
import { prepareSourceClaims, projectSourceClaim, sourceClaimKey, SOURCE_CLAIM_VERSION,
  type SourceClaimRow, type SourceStatsPublication, type SourceStatsRequest, type SourceStatsReplay, type SourceStatsCapture } from "./sourceClaims.ts";
import { parseSourceCsv, SOURCE_PROFILE_VERSION, SOURCE_SAMPLE_SEASON } from "./sourceAdapters.ts";
import type { SourceStatsFeed } from "./sourceStats.ts";
import { SOURCE_LINEAGE_VERSION, sourceBindingHeadsAt, sourceStatsRawKey, type SourceBindingEvent } from "./sourceLineage.ts";
import { planSourceStatsFromReplay as planNormalization, sourceNormalizationBasis, SOURCE_NORMALIZATION_VERSION, type SourceNormalizationPlan } from "./sourceNormalization.ts";
import { SOURCE_FACT_BOUNDS, sourceFactHeadsAt, sourceFactRequest, sourceFactSnapshot, type SourceFactRequest } from "./sourceFacts.ts";
import { sourceFactWitness } from "./sourceWitness.ts";
import { sourceDecisionBasis, sourceDecisionPlan, sourceDecisionRequest, type SourceDecisionPlan, type SourceDecisionRecord, type SourceDecisionRequest } from "./sourceDecisions.ts";
import { buildSourceFinalLabel, buildSourcePassingYards, sourceConsumerExecutionDigest, sourceConsumerInputDigest, type SourceConsumerBody, type SourceConsumerFact, type SourceConsumerRecord } from "./sourceConsumers.ts";
import type { Artifact, Capture, Dataset, Decision, IdentityLink, Label, Observation, Profile, RecordedRetentionEvent, Request, RetentionEvent, RetentionResult,
  Revision, RightsDecision } from "./types.ts";
import { validateCompletionDecisions } from "./completion.ts";
import { validateParticipationDecisions } from "./participation.ts";
import { executionDigest, FEATURE_CODE_VERSION, featureRunRequest } from "./featureRuns.ts";
import { buildPassingYardsFromReplay, validatePassingYardsRequest } from "./passingYards.ts";
import { blockedProfiles, replayObservations } from "./replay.ts";
import { allows, canonical, compareText, digest, entityKey, exact, instant, observation, refuse, rightsInForce, sourceKey, validateDataset, validateDecisions, validateObservations } from "./validation.ts";

// Only evidence changes affect freshness. A later query clock or a renewed
// rights decision must not manufacture a statistical correction. Access is
// checked separately, against the database clock, on every read and retry.
export { sourceNormalizationBasis } from "./sourceNormalization.ts";
export type SourceNormalizationReplay = {
  status: "observed-source-normalization" | "unavailable-source-normalization"; reason: string | null;
  head: SourceBindingEvent | null; currentPlan: SourceNormalizationPlan;
  observationsPublished: false; featuresPublished: false; labelsFinalized: false; populationCoverage: "unqualified";
};
export const PERSISTENCE_BOUNDS = { artifacts: 256, captures: 512, bytes: 8_000_000, rows: 8192 } as const;
const LOCK_NAMESPACE = 520052;
// Per-digest session locks coordinating artifact-store files with blob rows.
// Every writer holds a digest's lock from before writing the file until its
// transaction commits; cleanup holds it from the reference recheck through the
// unlink. Keys are the digest's first 32 bits: a collision only serializes more.
const BLOB_LOCK_NAMESPACE = 520054;
const blobLockKey = (sha256: string) => Number.parseInt(sha256.slice(0, 8), 16) | 0;
type Target = { expected: object; assertTarget: (config: object) => void };
type StoredArtifact = Omit<Artifact, "bytes"> & { byteSize: number; storageRef: string };
type Raw = { revision: Revision; capture: Capture; artifact: StoredArtifact };
type RunResult = { id: string; status: "published" | "incomplete" | "refused"; failureCode: string | null; reused: boolean };
const timestamp = (column: string) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const envelopeSql = `SELECT jsonb_build_object(
  'revision', jsonb_build_object('id',o.id,'kind',o.kind,'sourceRecordId',o.source_record_id,'predecessorId',o.predecessor_id,
    'correctionReason',o.correction_reason,'data',o.data),
  'capture', jsonb_build_object('id',c.id,'artifactId',c.artifact_id,'capturedAt',${timestamp("c.captured_at")},
    'availableAt',${timestamp("c.available_at")},'ingestedAt',${timestamp("c.ingested_at")},'publishedAt',${timestamp("c.published_at")},
    'publicationEvidence',c.publication_evidence,'state',c.state,'bodyComplete',c.body_complete,'headerVerified',c.header_verified,
    'parserSucceeded',c.parser_succeeded,'parsedRows',c.parsed_rows),
  'artifact', jsonb_build_object('id',a.id,'profileId',a.profile_id,'retrievalKind',a.retrieval_kind,'origin',a.origin,
    'providerEtag',a.provider_etag,'providerLastModified',a.provider_last_modified,'releaseUpdatedAt',${timestamp("a.release_updated_at")},
    'scopeKind',a.scope_kind,'scopeSeason',a.scope_season,'scopeWeek',a.scope_week,'scopeGameId',a.scope_game_id,'scopeFilter',a.scope_filter,
    'sha256',b.sha256,'byteSize',b.byte_size,'storageRef',b.storage_ref)) AS envelope
  FROM chosen o JOIN public.predictive_artifact_observations l ON l.observation_id=o.id
  JOIN public.predictive_artifacts a ON a.id=l.artifact_id JOIN public.predictive_blobs b ON b.sha256=a.blob_sha256
  JOIN public.predictive_captures c ON c.artifact_id=a.id JOIN public.predictive_ingestion_runs r ON r.id=c.run_id
  WHERE c.state='published' AND r.status='published' AND c.available_at <= $1::timestamptz AND c.ingested_at <= $1::timestamptz
  ORDER BY o.id,c.ingested_at,c.available_at,c.captured_at,c.id LIMIT 8193`;
// Two phases: discover source chains through routed predicates on any visible
// revision, then expand every discovered chain to all of its visible revisions,
// including corrections whose routing moved outside the predicate.
const closureSql = (predicate: string) => `WITH keys AS (
  SELECT DISTINCT o.source_key FROM public.predictive_observations o WHERE (${predicate}) AND EXISTS (
    SELECT 1 FROM public.predictive_artifact_observations l JOIN public.predictive_captures c ON c.artifact_id=l.artifact_id
    JOIN public.predictive_ingestion_runs r ON r.id=c.run_id WHERE l.observation_id=o.id AND c.state='published' AND r.status='published'
      AND c.available_at <= $1::timestamptz AND c.ingested_at <= $1::timestamptz)),
  chosen AS (SELECT o.* FROM public.predictive_observations o JOIN keys k ON k.source_key=o.source_key)
  ${envelopeSql}`;
export const MEMBERSHIP_READ_SQL = closureSql("o.kind='membership' AND o.player_id=$2 AND o.effective_from < $3 AND o.effective_to > $4");
export const SCHEDULE_READ_SQL = closureSql("o.kind='schedule' AND o.season BETWEEN $3 AND $4 AND (o.home_team_id=ANY($2::text[]) OR o.away_team_id=ANY($2::text[]))");
export const ENTITY_READ_SQL = closureSql("o.game_id=ANY($2::uuid[]) AND (o.kind IN ('schedule','event-state-marker','team-game-stats') OR o.player_id=$3)");
const idReadSql = closureSql("o.id=ANY($2::text[])");
const decisionScopeReadSql = closureSql("o.entity_key=ANY($2::text[]) OR o.entity_key LIKE ANY($3::text[])");
const aliasReadSql = closureSql("o.kind='schedule' AND o.raw_game_id=ANY($2::text[])");
const coverageReadSql = closureSql("o.kind='schedule-coverage' AND o.team_id=ANY($2::text[]) AND o.data->>'fromSeason'=$3 AND o.data->>'throughSeason'=$4");
const normalizationBridgeReadSql = closureSql("o.entity_key=ANY($2::text[])");
const normalizationReverseReadSql = closureSql("(o.kind='game-bridge' AND o.game_id=ANY($2::uuid[])) OR (o.kind='player-bridge' AND o.player_id=ANY($3::text[]))");
const normalizationScheduleReadSql = closureSql("o.kind='schedule' AND o.game_id=ANY($2::uuid[])");
const PROFILE_SQL = `SELECT jsonb_build_object('id',id,'purpose',purpose,'provider',provider,'feed',feed,'releaseTag',release_tag,
  'assetPattern',asset_pattern,'headerProfileSha256',header_profile_sha256,'parserVersion',parser_version,'allowlistVersion',allowlist_version,
  'license',license,'attribution',attribution,'evidenceKinds',to_jsonb(evidence_kinds),'registeredAt',${timestamp("registered_at")}) AS profile
  FROM public.predictive_source_profiles WHERE id=ANY($1::text[]) ORDER BY id`;
const RIGHTS_SQL = `SELECT jsonb_build_object('id',id,'profileId',profile_id,'predecessorId',predecessor_id,'allowedUses',to_jsonb(allowed_uses),
  'effectiveFrom',${timestamp("effective_from")},'effectiveTo',${timestamp("effective_to")},'decidedAt',${timestamp("decided_at")},
  'evidenceKind',evidence_kind,'evidenceReference',evidence_reference) AS decision
  FROM public.predictive_rights_decisions WHERE profile_id=ANY($1::text[]) ORDER BY id`;
const decisionSql = (predicate: string) => `SELECT jsonb_build_object('id',d.id,'kind',d.kind,'entityKey',d.entity_key,'policyId',d.policy_id,'mode',d.mode,
  'decidedAt',${timestamp("d.decided_at")},'predecessorId',d.predecessor_id,'outcome',d.outcome,
  'inputs',coalesce((SELECT jsonb_agg(jsonb_build_object('observationId',i.observation_id,'role',i.role) ORDER BY i.observation_id COLLATE "C")
    FROM public.predictive_decision_inputs i WHERE i.decision_id=d.id),'[]'::jsonb)) AS decision
  FROM public.predictive_decisions d JOIN public.predictive_ingestion_runs r ON r.id=d.run_id
  WHERE r.status='published' AND d.kind IN ('reconciliation','completion','participation','snap-source-compatibility') AND ${predicate} ORDER BY d.id`;
const DECISION_SQL = decisionSql("d.entity_key=ANY($2::text[]) AND d.decided_at <= $1::timestamptz");
const DECISION_BY_ID_SQL = decisionSql("d.id=$1");
const DECISIONS_BY_ID_SQL = decisionSql("d.id=ANY($1::text[])");

const decisionScope = (decision: Decision) => {
  if (decision.kind === "reconciliation") {
    return { exact: [decision.entityKey.slice("reconciliation:".length)], prefixes: [] };
  }
  if (decision.kind === "completion") {
    return { exact: [], prefixes: ["event-state-marker:" + decision.entityKey.slice("completion:".length) + ":%"] };
  }
  const [, gameId, playerId] = decision.entityKey.split(":");
  return { exact: ["player-game-stats:" + gameId + ":" + playerId], prefixes: ["participation-evidence:" + gameId + ":" + playerId + ":%"] };
};

// retention-policy-v1 removed_ids_digest: SHA-256 of the canonical JSON array of
// {id, kind} pairs ordered by kind then id. Mirrors predictive_retention_execute().
export const retentionIdsDigest = (removed: { kind: string; id: string }[]) =>
  digest(canonical([...removed].sort((a, b) => compareText(a.kind, b.kind) || compareText(a.id, b.id)).map(({ kind, id }) => ({ id, kind }))));

// No remote session, primary test DB or unregistered scratch database can use
// this local proof. The caller owns one session; operations are sequential.
export const createLocalPredictiveStore = async (client: Client, target: Target, privateArtifacts: PrivateArtifactStore) => {
  const artifacts = privateArtifacts.database;
  const assertTarget = async () => { target.assertTarget(target.expected); await checkConnectedTarget(client, target.expected); };
  await assertTarget();
  let busy = false;
  let batch: ReturnType<typeof createEvidenceBatch> | null = null;
  let batchClock: string | null = null;
  let batchAccess: (() => Promise<void>) | null = null;
  const readQuery = (sql: string, values: unknown[] = []) => batch ? batch.query(sql, values) : client.query(sql, values);
  const memoEvidence = <T>(namespace: string, key: unknown, verify: () => Promise<T>): Promise<T> =>
    batch ? batch.memo(namespace, key, verify) : verify();
  let verifiedBytes = 0;
  const verifiedDigests = new Set<string>();
  const verifiedCsvFiles = new Map<string, { feed: SourceStatsFeed; parsed: Awaited<ReturnType<typeof parseSourceCsv>> }>();
  const verifiedJson = new Map<string, { artifact: Artifact; revisions: Map<string, Revision> }>();
  const verifiedCsv = new Map<string, { capture: SourceStatsCapture; expected: SourceClaimRow[] }>();
  const readBytes = (reference: string, sha256: string, size: number) => memoEvidence("file", [reference, sha256, size], async () => {
    reserveVerifiedBytes(Number(size), sha256);
    if (batchAccess) await batchAccess();
    return artifacts.read(reference, sha256, Number(size));
  });
  const readWireBytes = (reference: string, sha256: string, size: number) => memoEvidence("wire-file", [reference, sha256, size], async () => {
    reserveVerifiedBytes(size, sha256);
    if (batchAccess) await batchAccess();
    return artifacts.readBinary(reference, sha256, size);
  });
  const reserveVerifiedBytes = (bytes: number, sha256: string) => {
    if (verifiedDigests.has(sha256)) return;
    verifiedDigests.add(sha256); verifiedBytes += bytes;
    if (verifiedBytes > 20_000_000) refuse("source-verification-byte-bounds-refused");
  };
  const profilesFor = async (ids: string[]): Promise<Profile[]> =>
    (await readQuery(PROFILE_SQL, [ids])).rows.map((row) => row.profile as Profile);
  const hydrate = async (raw: Raw[]): Promise<Observation[]> => {
    if (raw.length > PERSISTENCE_BOUNDS.rows) refuse("replay-row-bounds-refused");
    const profiles = new Map((await profilesFor([...new Set(raw.map((row) => row.artifact.profileId))])).map((profile) => [profile.id, profile]));
    const parsed = verifiedJson;
    const result: Observation[] = [];
    for (const row of raw) {
      let stored = parsed.get(row.artifact.id);
      if (!stored) {
        const { byteSize, storageRef, ...metadata } = row.artifact;
        reserveVerifiedBytes(Number(byteSize), metadata.sha256);
        const artifact: Artifact = { ...metadata, bytes: await readBytes(storageRef, metadata.sha256, byteSize) };
        // Every stored row is re-verified against its immutable source bytes.
        const checked = validateDataset({ formatVersion: 2, profiles: [profiles.get(artifact.profileId)!], rightsDecisions: [], artifacts: [artifact], captures: [], decisions: [], labels: [], identityLinks: [] });
        stored = { artifact, revisions: new Map(checked.revisions.get(artifact.id)!.map((revision) => [revision.id, revision])) };
        parsed.set(artifact.id, stored);
      }
      if (canonical(stored.revisions.get(row.revision.id)) !== canonical(row.revision)) refuse("stored-observation-mismatch");
      result.push(observation(row.revision, row.capture, stored.artifact));
    }
    return result;
  };
  const read = async (sql: string, values: unknown[]) => hydrate((await readQuery(sql, values)).rows.map((row) => row.envelope as Raw));
  const transaction = async <T>(work: () => Promise<T>, readonly = false, guarded = false): Promise<T> => {
    if (busy) refuse("predictive-session-busy"); busy = true;
    verifiedBytes = 0; verifiedJson.clear(); verifiedCsv.clear(); verifiedCsvFiles.clear(); verifiedDigests.clear();
    try {
      await assertTarget();
      await client.query(readonly ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" : "BEGIN");
      try {
        await client.query("SET LOCAL search_path = public");
        await client.query("SET LOCAL statement_timeout = '10s'");
        await client.query("SET LOCAL lock_timeout = '3s'");
        await client.query("SET LOCAL idle_in_transaction_session_timeout = '15s'");
        if (guarded) {
          batchClock = (await client.query("SELECT public.predictive_training_read_guard() AS clock")).rows[0].clock as string;
          batch = createEvidenceBatch((sql, values) => client.query(sql, values));
        } else if (!readonly) await client.query("SELECT pg_advisory_xact_lock($1,1)", [LOCK_NAMESPACE]);
        const result = await work(); await client.query("COMMIT"); return result;
      } catch (error) { await client.query("ROLLBACK"); throw error; }
    } finally { batch = null; batchClock = null; batchAccess = null; verifiedJson.clear(); verifiedCsv.clear(); verifiedCsvFiles.clear(); verifiedDigests.clear(); verifiedBytes = 0; busy = false; }
  };
  // Acquired in ascending key order with a bounded wait; released in finally. A
  // lost connection drops the locks and fails every later query, so no unlink
  // runs without the lock.
  const withBlobLocks = async <T>(digests: string[], work: () => Promise<T>): Promise<T> => {
    const keys = [...new Set(digests.filter((value) => /^[a-f0-9]{64}$/.test(value)).map(blobLockKey))].sort((a, b) => a - b);
    const held: number[] = [];
    try {
      for (const key of keys) {
        await client.query("BEGIN");
        try {
          await client.query("SET LOCAL lock_timeout = '5s'");
          await client.query("SELECT pg_advisory_lock($1,$2)", [BLOB_LOCK_NAMESPACE, key]);
          held.push(key);
          await client.query("COMMIT");
        } catch (error) { await client.query("ROLLBACK"); throw error; }
      }
      return await work();
    } finally {
      for (const key of held.reverse()) await client.query("SELECT pg_advisory_unlock($1,$2)", [BLOB_LOCK_NAMESPACE, key]);
    }
  };
  const blobReferenced = async (reference: string): Promise<boolean> =>
    (await client.query("SELECT public.predictive_blob_referenced($1) AS referenced", [reference])).rows[0].referenced;
  // Files precede the SQL commit. After success or rollback, remove only bytes
  // that the committed database does not own, while retaining the digest locks.
  // A disconnected/crashed process leaves files for the bounded-age orphan sweep.
  const withBlobReferences = <T>(references: string[], work: () => Promise<T>) => withBlobLocks(references.map((reference) => reference.slice(0, 64)), async () => {
    try { return await work(); }
    finally {
      for (const reference of new Set(references.filter((value) => /^[a-f0-9]{64}\.(json|csv|csv\.gz)$/.test(value)))) {
        if (!await blobReferenced(reference)) await artifacts.remove(reference, reference.slice(0, 64));
      }
    }
  });
  const withBlobPublication = <T>(digests: string[], work: () => Promise<T>) =>
    withBlobReferences(digests.map((sha256) => sha256 + ".json"), work);
  const priorRun = async (id: string, sha256: string): Promise<RunResult | null> => {
    const row = (await client.query("SELECT request_sha256,status,failure_code FROM public.predictive_ingestion_runs WHERE id=$1", [id])).rows[0];
    if (!row) return null;
    if (row.request_sha256 !== sha256) refuse("run-id-conflict");
    return { id, status: row.status, failureCode: row.failure_code, reused: true };
  };
  const insertRun = async (id: string, sha256: string, now: string, status: RunResult["status"], failureCode: string | null,
    counts: { artifacts: number; captures: number; rows: number }, consumedBytes: number,
    codeVersion = "predictive-local-store-v2", peakRssBytes: number | null = null) => {
    await client.query(`INSERT INTO public.predictive_ingestion_runs
      (id,request_sha256,code_version,started_at,finished_at,status,failure_code,budget,requests,consumed_bytes,artifact_count,capture_count,row_count,peak_rss_bytes)
      VALUES ($1,$2,$11,$3,$3,$4,$5,$6,0,$7,$8,$9,$10,$12)`,
      [id, sha256, now, status, failureCode, PERSISTENCE_BOUNDS, consumedBytes, counts.artifacts, counts.captures, counts.rows, codeVersion, peakRssBytes]);
  };
  // Registrations are immutable: a repeated ID must carry identical content.
  const persistProfile = async (profile: Profile) => {
    const existing = (await profilesFor([profile.id]))[0];
    if (existing) { if (canonical(existing) !== canonical(profile)) refuse("profile-id-conflict"); return; }
    await client.query(`INSERT INTO public.predictive_source_profiles (id,purpose,provider,feed,release_tag,asset_pattern,header_profile_sha256,
      parser_version,allowlist_version,license,attribution,evidence_kinds,registered_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [profile.id, profile.purpose, profile.provider, profile.feed, profile.releaseTag, profile.assetPattern, profile.headerProfileSha256,
        profile.parserVersion, profile.allowlistVersion, profile.license, profile.attribution, profile.evidenceKinds, profile.registeredAt]);
  };
  const persistRights = async (decision: RightsDecision) => {
    const existing = (await client.query(RIGHTS_SQL.replace("profile_id=ANY($1::text[])", "id=$1"), [decision.id])).rows[0]?.decision;
    if (existing) { if (canonical(existing) !== canonical(decision)) refuse("rights-id-conflict"); return; }
    await client.query(`INSERT INTO public.predictive_rights_decisions (id,profile_id,predecessor_id,allowed_uses,effective_from,effective_to,
      decided_at,evidence_kind,evidence_reference) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [decision.id, decision.profileId, decision.predecessorId, decision.allowedUses, decision.effectiveFrom, decision.effectiveTo,
        decision.decidedAt, decision.evidenceKind, decision.evidenceReference]);
  };
  const persistArtifact = async (artifact: Artifact, mediaType: ArtifactMediaType = "application/json") => {
    const byteSize = Buffer.byteLength(artifact.bytes);
    await client.query(`INSERT INTO public.predictive_blobs (sha256,byte_size,media_type,storage_ref) VALUES ($1,$2,$3,$4)
      ON CONFLICT (sha256) DO NOTHING`, [artifact.sha256, byteSize, mediaType, artifact.sha256 + (mediaType === "text/csv" ? ".csv" : ".json")]);
    const blob = (await client.query("SELECT byte_size,media_type FROM public.predictive_blobs WHERE sha256=$1", [artifact.sha256])).rows[0];
    if (blob.byte_size !== byteSize || blob.media_type !== mediaType) refuse("blob-conflict");
    const values = [artifact.id, artifact.sha256, artifact.profileId, artifact.retrievalKind, artifact.origin, artifact.providerEtag,
      artifact.providerLastModified, artifact.releaseUpdatedAt, artifact.scopeKind, artifact.scopeSeason, artifact.scopeWeek, artifact.scopeGameId, artifact.scopeFilter];
    const row = (await client.query(`SELECT id,blob_sha256,profile_id,retrieval_kind,origin,provider_etag,provider_last_modified,
      ${timestamp("release_updated_at")} AS release_updated_at,scope_kind,scope_season,scope_week,scope_game_id,scope_filter
      FROM public.predictive_artifacts WHERE id=$1`, [artifact.id])).rows[0];
    if (row) { if (canonical(Object.values(row)) !== canonical(values)) refuse("artifact-id-conflict"); return; }
    // A game-scoped artifact names its game before any revision registers it.
    if (artifact.scopeGameId) await client.query("INSERT INTO public.predictive_games (id) VALUES ($1) ON CONFLICT DO NOTHING", [artifact.scopeGameId]);
    await client.query(`INSERT INTO public.predictive_artifacts (id,blob_sha256,profile_id,retrieval_kind,origin,provider_etag,provider_last_modified,
      release_updated_at,scope_kind,scope_season,scope_week,scope_game_id,scope_filter) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, values);
  };
  const persistCapture = async (capture: Capture, runId: string) => {
    const existing = (await client.query(`SELECT jsonb_build_object('id',id,'artifactId',artifact_id,'capturedAt',${timestamp("captured_at")},
      'availableAt',${timestamp("available_at")},'ingestedAt',${timestamp("ingested_at")},'publishedAt',${timestamp("published_at")},
      'publicationEvidence',publication_evidence,'state',state,'bodyComplete',body_complete,'headerVerified',header_verified,
      'parserSucceeded',parser_succeeded,'parsedRows',parsed_rows) AS capture FROM public.predictive_captures WHERE id=$1`, [capture.id])).rows[0];
    if (existing) { if (canonical(existing.capture) !== canonical(capture)) refuse("capture-id-conflict"); return; }
    await client.query(`INSERT INTO public.predictive_captures (id,run_id,artifact_id,captured_at,available_at,ingested_at,published_at,
      publication_evidence,state,body_complete,header_verified,parser_succeeded,parsed_rows) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [capture.id, runId, capture.artifactId, capture.capturedAt, capture.availableAt, capture.ingestedAt, capture.publishedAt,
        capture.publicationEvidence, capture.state, capture.bodyComplete, capture.headerVerified, capture.parserSucceeded, capture.parsedRows]);
  };
  const persistRevision = async (revision: Revision, artifact: Artifact) => {
    const old = (await client.query("SELECT kind,profile_id,source_record_id,data,predecessor_id,correction_reason FROM public.predictive_observations WHERE id=$1", [revision.id])).rows[0];
    if (old && (old.profile_id !== artifact.profileId || canonical({ id: revision.id, kind: old.kind, sourceRecordId: old.source_record_id, data: old.data,
      predecessorId: old.predecessor_id, correctionReason: old.correction_reason }) !== canonical(revision))) refuse("observation-id-conflict");
    if (!old) {
      const games = [...("gameId" in revision.data && revision.data.gameId ? [revision.data.gameId] : []),
        ...(revision.kind === "schedule-coverage" ? revision.data.gameIds : []), ...(revision.kind === "game-relation" ? [revision.data.predecessorGameId] : [])];
      for (const id of games) await client.query("INSERT INTO public.predictive_games (id) VALUES ($1) ON CONFLICT DO NOTHING", [id]);
      await client.query(`INSERT INTO public.predictive_observations (id,kind,profile_id,source_record_id,data,entity_key,source_key,predecessor_id,correction_reason)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [revision.id, revision.kind, artifact.profileId, revision.sourceRecordId, revision.data,
        entityKey(revision), sourceKey(revision, artifact.profileId), revision.predecessorId, revision.correctionReason]);
    }
    await client.query("INSERT INTO public.predictive_artifact_observations (artifact_id,observation_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [artifact.id, revision.id]);
  };
  // Identity links are immutable registrations: a repeated ID must be identical.
  const persistIdentityLink = async (link: IdentityLink) => {
    const existing = (await client.query(`SELECT jsonb_build_object('id',id,'statsProfileId',stats_profile_id,'bridgeProfileId',bridge_profile_id,
      'provider',provider,'decidedAt',${timestamp("decided_at")}) AS link FROM public.predictive_profile_identity_links WHERE id=$1`, [link.id])).rows[0]?.link;
    if (existing) { if (canonical(existing) !== canonical(link)) refuse("identity-link-id-conflict"); return; }
    await client.query(`INSERT INTO public.predictive_profile_identity_links (id,stats_profile_id,bridge_profile_id,provider,decided_at)
      VALUES ($1,$2,$3,$4,$5)`, [link.id, link.statsProfileId, link.bridgeProfileId, link.provider, link.decidedAt]);
  };
  const persistRegistrations = async (dataset: Dataset) => {
    for (const profile of dataset.profiles) await persistProfile(profile);
    for (const link of dataset.identityLinks) await persistIdentityLink(link);
    // Predecessors first: a chain is inserted root to head.
    const pending = [...dataset.rightsDecisions];
    while (pending.length) {
      const index = pending.findIndex((decision) => !decision.predecessorId || !pending.some((other) => other.id === decision.predecessorId));
      await persistRights(pending.splice(index === -1 ? 0 : index, 1)[0]);
    }
  };
  const persistDecision = async (decision: Decision, runId: string) => {
    const existing = (await client.query(DECISION_BY_ID_SQL, [decision.id])).rows[0]?.decision;
    if (existing) { if (canonical(existing) !== canonical({ ...decision, inputs: [...decision.inputs].sort((a, b) => a.observationId < b.observationId ? -1 : 1) })) refuse("decision-id-conflict"); return; }
    await client.query(`INSERT INTO public.predictive_decisions (id,kind,entity_key,policy_id,mode,outcome,run_id,decided_at,predecessor_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [decision.id, decision.kind, decision.entityKey, decision.policyId, decision.mode, decision.outcome,
      runId, decision.decidedAt, decision.predecessorId]);
    for (const input of decision.inputs) await client.query("INSERT INTO public.predictive_decision_inputs (decision_id,observation_id,role) VALUES ($1,$2,$3)",
      [decision.id, input.observationId, input.role]);
  };
  // Labels are immutable versions; the deferred check enforces all eight bindings.
  const persistLabel = async (label: Label, runId: string) => {
    const columns = [label.id, label.playerId, label.gameId, label.seasonType, label.stat, label.value, label.state, label.mode, label.policyId,
      label.labelVersion, label.predecessorId, runId, label.completionDecisionId, label.participationDecisionId, label.reconciliationDecisionId,
      label.selectedObservationId, label.eligibleFinalAt, label.postWindowCaptureId, label.finalizedAt, label.createdAt, label.playerBridgeObservationId];
    const existing = (await client.query("SELECT id FROM public.predictive_outcome_labels WHERE id=$1", [label.id])).rows[0];
    if (existing) refuse("label-id-conflict");
    await client.query(`INSERT INTO public.predictive_outcome_labels (id,player_id,game_id,season_type,stat,value,state,mode,policy_id,label_version,
      predecessor_id,run_id,completion_decision_id,participation_decision_id,reconciliation_decision_id,selected_observation_id,eligible_final_at,
      post_window_capture_id,finalized_at,created_at,player_bridge_observation_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`, columns);
  };
  // The decision each published capture relied on, recorded for audit. A missing
  // decision leaves no row, and the deferred publication check refuses commit.
  const recordRunRights = (runId: string) => client.query(`INSERT INTO public.predictive_run_rights (run_id,rights_decision_id)
    SELECT DISTINCT c.run_id, public.predictive_rights_in_force(a.profile_id, c.captured_at, c.captured_at)
    FROM public.predictive_captures c JOIN public.predictive_artifacts a ON a.id=c.artifact_id
    WHERE c.run_id=$1 AND c.state='published' AND public.predictive_rights_in_force(a.profile_id, c.captured_at, c.captured_at) IS NOT NULL
    ON CONFLICT DO NOTHING`, [runId]);

  const publishSourceStats = async (input: SourceStatsPublication): Promise<RunResult> => {
    const prepared = await prepareSourceClaims(input);
    const { artifact } = input; const reference = artifact.sha256 + ".csv";
    const requestHash = digest(canonical({ version: SOURCE_CLAIM_VERSION, input }));
    return withBlobReferences([reference], async () => {
      await artifacts.write(artifact.bytes, artifact.sha256, "text/csv");
      return transaction(async () => {
        const existing = await priorRun(input.id, requestHash); if (existing) return existing;
        await client.query("SELECT pg_advisory_xact_lock(520053,hashtext($1))", [input.profile.id]);
        // Importing an old archive is knowledge now, never a historical SQL write.
        const now = (await client.query(`SELECT ${timestamp("clock_timestamp()")} AS now`)).rows[0].now as string;
        if (instant(input.capturedAt) > instant(now)) refuse("source-publication-time-refused");
        await persistRegistrations({ formatVersion: 2, profiles: [input.profile], rightsDecisions: input.rightsDecisions,
          artifacts: [], captures: [], decisions: [], labels: [], identityLinks: [] });
        await insertRun(input.id, requestHash, now, "published", null, { artifacts: 1, captures: 1, rows: prepared.rows.length }, Buffer.byteLength(artifact.bytes),
          SOURCE_CLAIM_VERSION, process.resourceUsage().maxRSS * 1024);
        await persistArtifact(artifact, "text/csv");
        await persistCapture({ id: input.captureId, artifactId: artifact.id, capturedAt: input.capturedAt, availableAt: input.capturedAt,
          ingestedAt: now, publishedAt: null, publicationEvidence: null, state: "published", bodyComplete: true,
          headerVerified: true, parserSucceeded: true, parsedRows: prepared.rows.length }, input.id);
        for (const row of prepared.rows) await client.query(`INSERT INTO public.predictive_source_stats_rows
          (id,capture_id,row_ordinal,raw_key_sha256,selected_sha256,projection,failure_code) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [row.id, input.captureId, row.rowOrdinal, row.rawKeySha256, row.selectedSha256, row.projection, row.failureCode]);
        await recordRunRights(input.id);
        return { id: input.id, status: "published", failureCode: null, reused: false };
      });
    });
  };

  const readSourceStats = async (request: SourceStatsRequest, accessAt?: string): Promise<SourceStatsReplay> => {
    instant(request.cutoff);
    if (typeof request.profileId !== "string" || !request.profileId.trim() || request.profileId.length > 256 ||
        !/^2026_\d{2}_[A-Z]{2,3}_[A-Z]{2,3}$/.test(request.rawGameId) || !/^[A-Z]{2,3}$/.test(request.rawTeam) ||
        (request.rawPlayerId !== null && !/^00-\d{7}$/.test(request.rawPlayerId))) refuse("source-replay-request-refused");
    const profile = (await profilesFor([request.profileId]))[0];
    if (!profile || !["player", "team"].includes(profile.feed) || profile.parserVersion !== SOURCE_PROFILE_VERSION ||
        profile.allowlistVersion !== "predictive-raw-allowlist-v1" ||
        (profile.feed === "player") !== (request.rawPlayerId !== null)) refuse("source-replay-profile-refused");
    const feed = profile.feed as SourceStatsFeed;
    const accessible = (await readQuery(`SELECT public.predictive_rights_allow($1,coalesce($2::timestamptz,clock_timestamp()),coalesce($2::timestamptz,clock_timestamp()),'internal-research') AS allowed`, [profile.id, accessAt ?? null])).rows[0].allowed;
    const result = (reason: string | null, captures: SourceStatsCapture[], rows: SourceClaimRow[]): SourceStatsReplay => {
      const evidence = { version: SOURCE_CLAIM_VERSION, request, captures, rows };
      return { status: reason ? "unavailable-source-claim" : "observed-source-claim", reason, evidence,
        inputDigest: digest(canonical(evidence)), featuresPublished: false, labelsFinalized: false, populationCoverage: "unqualified" };
    };
    if (!accessible) return result("rights-not-in-force", [], []);
    // The newest source snapshot visible at cutoff wins, not the last imported
    // old archive. Equal-time contradictory captures remain ambiguous.
    const captures = (await readQuery(`WITH eligible AS (
      SELECT c.*, dense_rank() OVER (ORDER BY c.captured_at DESC) AS rank
      FROM public.predictive_captures c JOIN public.predictive_artifacts a ON a.id=c.artifact_id
      JOIN public.predictive_ingestion_runs r ON r.id=c.run_id JOIN public.predictive_blobs b ON b.sha256=a.blob_sha256
      WHERE a.profile_id=$1 AND a.scope_kind='season-file' AND a.scope_season=$2 AND a.scope_filter IS NULL
        AND b.media_type='text/csv' AND c.state='published' AND r.status='published'
        AND c.available_at <= $3::timestamptz AND c.ingested_at <= $3::timestamptz)
      SELECT c.id,c.run_id AS "runId",c.artifact_id AS "artifactId",${timestamp("c.captured_at")} AS "capturedAt",
        ${timestamp("c.available_at")} AS "availableAt",${timestamp("c.ingested_at")} AS "ingestedAt",c.parsed_rows AS "parsedRows",
        b.sha256,b.storage_ref AS "storageRef",b.byte_size AS "byteSize"
      FROM eligible c JOIN public.predictive_artifacts a ON a.id=c.artifact_id JOIN public.predictive_blobs b ON b.sha256=a.blob_sha256
      WHERE rank=1 ORDER BY c.ingested_at,c.id COLLATE "C" LIMIT 257`, [profile.id, SOURCE_SAMPLE_SEASON, request.cutoff])).rows as SourceStatsCapture[];
    if (captures.length > 256) refuse("source-replay-bounds-refused");
    if (!captures.length) {
      const removed = (await readQuery(`SELECT 1 FROM public.predictive_retention_events
        WHERE scope_descriptor->>'kind'='source' AND scope_descriptor->'profileIds' ? $1
          AND (scope_descriptor->>'capturedFrom' IS NULL OR (scope_descriptor->>'capturedFrom')::timestamptz <= $2::timestamptz) LIMIT 1`,
        [profile.id, request.cutoff])).rows.length > 0;
      return result(removed ? "retained-evidence-removed" : "source-capture-missing", [], []);
    }
    // Every cited capture is verified, including equal-time conflicts.
    for (const capture of captures) {
      let verified = verifiedCsv.get(capture.id);
      if (verified && canonical(verified.capture) !== canonical(capture)) refuse("stored-source-capture-mismatch");
      if (!verified) {
        reserveVerifiedBytes(Number(capture.byteSize), capture.sha256);
        let file = verifiedCsvFiles.get(capture.sha256);
        if (file && file.feed !== feed) refuse("stored-source-capture-mismatch");
        if (!file) {
          file = await memoEvidence("csv-file", [capture.storageRef, capture.sha256, Number(capture.byteSize), feed], async () => ({
            feed, parsed: await parseSourceCsv(feed, await readBytes(capture.storageRef, capture.sha256, Number(capture.byteSize)), PERSISTENCE_BOUNDS.rows),
          }));
          verifiedCsvFiles.set(capture.sha256, file);
        }
        const parsed = file.parsed;
        if (parsed.headerSha256 !== profile.headerProfileSha256 || parsed.rows.length !== capture.parsedRows) refuse("stored-source-capture-mismatch");
        verified = { capture, expected: parsed.rows.map((row, index) => projectSourceClaim(capture.id, feed, row, index + 1)) };
        verifiedCsv.set(capture.id, verified);
      }
      const expectedRows = verified.expected;
      const stored = (await readQuery(`SELECT id,row_ordinal AS "rowOrdinal",raw_key_sha256 AS "rawKeySha256",
        selected_sha256 AS "selectedSha256",projection,failure_code AS "failureCode"
        FROM public.predictive_source_stats_rows WHERE capture_id=$1 ORDER BY row_ordinal LIMIT 8193`, [capture.id])).rows;
      if (canonical(stored) !== canonical(expectedRows)) refuse("stored-source-row-mismatch");
    }
    if (new Set(captures.map((capture) => capture.sha256)).size > 1) return result("source-capture-ambiguous", captures, []);
    const capture = captures[0]; const expected = verifiedCsv.get(capture.id)!.expected;
    const key = sourceClaimKey({ game_id: request.rawGameId, team: request.rawTeam, player_id: request.rawPlayerId ?? "" }, feed);
    const matches = expected.filter((row) => row.rawKeySha256 === key);
    if (!matches.length) return result("source-row-missing", [capture], []);
    if (new Set(matches.map((row) => row.selectedSha256)).size > 1) return result("source-row-ambiguous", [capture], matches);
    return result(matches[0].failureCode ? "source-row-refused" : null, [capture], matches);
  };
  const replaySourceStats = (request: SourceStatsRequest) => transaction(() => readSourceStats(request), true);

  // Local codec diagnostics only: this does not select source facts or consumers.
  // Stable metadata is guarded; clock-sensitive access is never memoized.
  const replayCompressedInspections = (input: string[], options: { maxDecodedBytes?: number; maxRows?: number } = {}) => {
    if (!Array.isArray(input) || input.length < 1 || input.length > 64 || new Set(input).size !== input.length ||
        input.some(id => typeof id !== "string" || !id.trim() || id.length > 256 || /[\u0000-\u001f\u007f]/.test(id))) refuse("compressed-inspection-request-refused");
    const ids = [...input];
    if (!options || typeof options !== "object" || Array.isArray(options) || Object.keys(options).some(key => !["maxDecodedBytes","maxRows"].includes(key))) refuse("compressed-batch-limits-refused");
    const maxDecodedBytes = options.maxDecodedBytes === undefined ? 64_000_000 : options.maxDecodedBytes;
    const maxRows = options.maxRows === undefined ? 160_000 : options.maxRows;
    if (!Number.isSafeInteger(maxDecodedBytes) || maxDecodedBytes < 1 || maxDecodedBytes > 64_000_000 ||
        !Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > 160_000) refuse("compressed-batch-limits-refused");
    return transaction(async () => {
      type Entry = { captureId: string; proof: Awaited<ReturnType<typeof inspectCompressedSource>>; reference: string; sha256: string; byteSize: number };
      const load = async (): Promise<Entry[]> => (await client.query("SELECT public.predictive_read_compressed_inspections($1) AS entries", [ids])).rows[0].entries;
      const entries = await load();
      // A 30s execution deadline plus bounded runtime cleanup must fit within
      // this guarded transaction's idle timeout; no image is pulled here.
      await client.query("SET LOCAL idle_in_transaction_session_timeout = '45s'");
      batchAccess = async () => { await load(); };
      let decodedBytes = 0, decodedRows = 0;
      const reports = new Map<string, Entry>();
      for (const entry of entries) {
        const request: CompressedInspectionRequest = { feed: entry.proof.feed, season: entry.proof.season,
          wireSha256: entry.sha256, wireBytes: entry.byteSize };
        const inspection = await memoEvidence("compressed-inspection", [entry.reference,entry.sha256,entry.byteSize,
          request.feed,request.season,entry.proof.codecVersion], async () => {
          const remainingBytes = maxDecodedBytes - decodedBytes, remainingRows = maxRows - decodedRows;
          if (remainingBytes < 1 || remainingRows < 1) refuse("compressed-batch-work-budget-exceeded");
          const bytes = await readWireBytes(entry.reference, entry.sha256, entry.byteSize);
          const worker = await runCompressedWorker("inspect", bytes, request, { limits: {
            decodedBytes: Math.min(COMPRESSED_SOURCE_LIMITS.decodedBytes, remainingBytes),
            rows: Math.min(COMPRESSED_SOURCE_LIMITS.rows, remainingRows) } });
          const proof = worker.result as Awaited<ReturnType<typeof inspectCompressedSource>>;
          decodedBytes += proof.decodedBytes; decodedRows += proof.rows;
          return { ...proof, limits: { ...COMPRESSED_SOURCE_LIMITS } };
        });
        if (canonical(inspection) !== canonical(entry.proof)) refuse("compressed-inspection-integrity-failed");
        reports.set(entry.captureId, { ...entry, proof: inspection });
      }
      await batchAccess();
      return { snapshotAt: batchClock!, inspections: ids.map(id => reports.get(id)!),
        verification: { verifiedWireBytes: verifiedBytes, decodedBytes, decodedRows }, publicationSupported: false };
    }, false, true);
  };

  const readSourceNormalization = async (request: SourceStatsRequest, accessAt?: string, version: string = SOURCE_NORMALIZATION_VERSION) => memoEvidence("readSourceNormalization", [request, accessAt ?? null, version], async () => {
    const source = await readSourceStats(request, accessAt);
    const clock = accessAt ?? (await readQuery(`SELECT ${timestamp("clock_timestamp()")} AS now`)).rows[0].now as string;
    const context: Dataset = { formatVersion: 2, profiles: [], rightsDecisions: [], artifacts: [], captures: [], decisions: [], labels: [], identityLinks: [] };
    if (source.status !== "observed-source-claim") {
      context.profiles = await profilesFor([request.profileId]);
      context.rightsDecisions = (await readQuery(RIGHTS_SQL, [[request.profileId]])).rows.map((row) => row.decision as RightsDecision);
      return planNormalization(source, { ...context, replay: replayObservations([], new Set()) }, clock, version);
    }
    const stats = source.evidence.rows[0].projection!;
    const readContext = async (sql: string, values: unknown[]) => {
      const raw = (await readQuery(sql, values)).rows.map((row) => row.envelope as Raw);
      const ids = [...new Set(raw.map((row) => row.artifact.profileId))];
      const rights = (await readQuery(RIGHTS_SQL, [ids])).rows.map((row) => row.decision as RightsDecision);
      const blocked = blockedProfiles(rights, ids, clock, "internal-research");
      // Permission is checked before opening context bytes, including when the
      // resulting plan is unavailable. Historical hydration uses its audit
      // clock only after the separate current-access gate has passed.
      return hydrate(raw.filter((row) => !blocked.has(row.artifact.profileId)));
    };
    const keys = ["game-bridge:nflverse:" + stats.rawGameId, "team-alias:nflverse:" + stats.rawTeam,
      "team-alias:nflverse:" + stats.rawOpponent, ...(stats.rawPlayerId ? ["player-bridge:gsis:" + stats.rawPlayerId] : [])];
    const bridges = await readContext(normalizationBridgeReadSql, [request.cutoff, keys]);
    const games = [...new Set(bridges.flatMap((row) => row.revision.kind === "game-bridge" ? [row.revision.data.gameId] : []))];
    const players = [...new Set(bridges.flatMap((row) => row.revision.kind === "player-bridge" ? [row.revision.data.playerId] : []))];
    const reverse = await readContext(normalizationReverseReadSql, [request.cutoff, games, players]);
    const schedules = await readContext(normalizationScheduleReadSql, [request.cutoff, games]);
    const rawScheduleIds = [...new Set(schedules.flatMap((row) => row.revision.kind === "schedule" ? [row.revision.data.rawGameId] : []))];
    const aliases = await readContext(aliasReadSql, [request.cutoff, rawScheduleIds]);
    const observations = [...bridges, ...reverse, ...schedules, ...aliases];
    if (observations.length > PERSISTENCE_BOUNDS.rows) refuse("replay-row-bounds-refused");
    context.identityLinks = (await readQuery(`SELECT id,stats_profile_id AS "statsProfileId",bridge_profile_id AS "bridgeProfileId",
      provider,${timestamp("decided_at")} AS "decidedAt" FROM public.predictive_profile_identity_links
      WHERE stats_profile_id=$1 AND decided_at <= $2::timestamptz ORDER BY id COLLATE "C" LIMIT 257`, [request.profileId, request.cutoff])).rows as IdentityLink[];
    if (context.identityLinks.length > 256) refuse("source-normalization-link-bounds-refused");
    const profileIds = [...new Set([request.profileId, ...observations.map((row) => row.artifact.profileId),
      ...context.identityLinks.map((link) => link.bridgeProfileId)])];
    context.profiles = await profilesFor(profileIds);
    context.rightsDecisions = (await readQuery(RIGHTS_SQL, [profileIds])).rows.map((row) => row.decision as RightsDecision);
    const decisionKeys = games.map((id) => "reconciliation:schedule:" + id);
    context.decisions = (await readQuery(DECISION_SQL, [request.cutoff, decisionKeys])).rows.map((row) => row.decision as Decision);
    const checked = validateDataset({ ...context, decisions: [] });
    const visible = validateObservations(observations);
    validateDecisions(context.decisions, visible, checked.profiles);
    // hydrate() already verified every chosen row against its exact JSON bytes.
    // Reconstructing a full Dataset from partially selected artifacts would
    // pull unrelated corrections into this scoped read without their ancestors.
    const replay = replayObservations([...visible.values()], blockedProfiles(context.rightsDecisions, profileIds, clock, "internal-research"), context.decisions);
    return planNormalization(source, { ...context, replay }, clock, version);
  });
  const planSourceStatsNormalization = (request: SourceStatsRequest) => transaction(() => readSourceNormalization(request), true);

  const bindingHistory = async (request: SourceStatsRequest, cutoff: string): Promise<SourceBindingEvent[]> => {
    const key = sourceStatsRawKey(request);
    const records = (await readQuery(`SELECT b.id,b.predecessor_id AS "predecessorId",${timestamp("b.recorded_at")} AS "recordedAt",b.plan,
      CASE WHEN r.id IS NULL THEN NULL ELSE jsonb_build_object('id',r.id,'kind',r.kind,'sourceRecordId',r.source_record_id,
        'predecessorId',r.predecessor_id,'correctionReason',r.correction_reason,'data',r.data) END AS revision,
      b.profile_id AS "profileId",b.raw_key_sha256 AS "rawKey",${timestamp("b.cutoff")} AS cutoff,
      coalesce((SELECT jsonb_agg(x.capture_id ORDER BY x.capture_id COLLATE "C") FROM public.predictive_source_binding_captures x WHERE x.binding_id=b.id),'[]'::jsonb) AS captures,
      coalesce((SELECT jsonb_agg(x.row_id ORDER BY x.row_id COLLATE "C") FROM public.predictive_source_binding_rows x WHERE x.binding_id=b.id),'[]'::jsonb) AS rows,
      coalesce((SELECT jsonb_agg(jsonb_build_object('observationId',x.observation_id,'role',x.role,'captureId',x.capture_id,'artifactId',x.artifact_id)
        ORDER BY x.role COLLATE "C",x.observation_id COLLATE "C") FROM public.predictive_source_binding_dependencies x WHERE x.binding_id=b.id),'[]'::jsonb) AS dependencies,
      coalesce((SELECT jsonb_agg(x.link_id ORDER BY x.link_id COLLATE "C") FROM public.predictive_source_binding_links x WHERE x.binding_id=b.id),'[]'::jsonb) AS links,
      coalesce((SELECT jsonb_agg(x.decision_id ORDER BY x.decision_id COLLATE "C") FROM public.predictive_source_binding_decisions x WHERE x.binding_id=b.id),'[]'::jsonb) AS decisions,
      coalesce((SELECT jsonb_agg(x.rights_decision_id ORDER BY x.rights_decision_id COLLATE "C") FROM public.predictive_source_binding_rights x WHERE x.binding_id=b.id),'[]'::jsonb) AS rights
      FROM public.predictive_source_bindings b LEFT JOIN public.predictive_source_stats_revisions r ON r.id=b.revision_id
      WHERE b.profile_id=$1 AND b.raw_key_sha256=$2 AND b.recorded_at <= $3::timestamptz ORDER BY b.recorded_at,b.id COLLATE "C" LIMIT 257`,
      [request.profileId, key, cutoff])).rows;
    if (records.length > 256) refuse("source-binding-history-bounds-refused");
    const events: SourceBindingEvent[] = [];
    for (const row of records) {
      const plan = row.plan as SourceNormalizationPlan; const binding = plan.binding;
      if (row.profileId !== binding.sourceProfileId || row.rawKey !== sourceStatsRawKey(binding.sourceRequest) || row.cutoff !== binding.cutoff)
        refuse("stored-source-binding-mismatch");
      const ids = (values: string[]) => [...values].sort(compareText);
      const deps = binding.dependencies.map(({ observationId, role, captureId, artifactId }) => ({ observationId, role, captureId, artifactId }))
        .sort((a, b) => compareText(a.role, b.role) || compareText(a.observationId, b.observationId));
      if (canonical(row.captures) !== canonical(ids(binding.sourceCaptures.map((item) => item.id))) ||
          canonical(row.rows) !== canonical(ids(binding.sourceRows.map((item) => item.id))) || canonical(row.dependencies) !== canonical(deps) ||
          canonical(row.links) !== canonical(ids(binding.identityLinks.map((item) => item.id))) ||
          canonical(row.decisions) !== canonical(ids(binding.decisions.map((item) => item.id))) || canonical(row.rights) !== canonical(ids(binding.rightsDecisionIds)))
        refuse("stored-source-binding-associations-mismatch");
      events.push({ version: SOURCE_LINEAGE_VERSION, id: row.id, predecessorId: row.predecessorId, recordedAt: row.recordedAt, plan, revision: row.revision });
    }
    return events;
  };
  const databaseClock = async () => batchClock ?? (await readQuery(`SELECT ${timestamp("clock_timestamp()")} AS now`)).rows[0].now as string;
  const currentBindingAccess = async (history: Pick<SourceBindingEvent, "plan">[], clock: string) => {
    const profiles = [...new Set(history.flatMap((event) => [event.plan.binding.sourceProfileId, ...event.plan.binding.dependencies.map((dep) => dep.profileId)]))];
    const rights = (await readQuery(RIGHTS_SQL, [profiles])).rows.map((row) => row.decision as RightsDecision);
    return profiles.every((profile) => allows(rightsInForce(rights, profile, instant(clock), instant(clock)), "internal-research"));
  };
  const verifyBindingHistory = async (history: SourceBindingEvent[], cutoff: string) => {
    // Recompute the original proposal against immutable CSV/JSON bytes and its
    // original knowledge/access clocks; current access is a separate gate.
    for (const event of history) {
      await memoEvidence("binding-plan", event, async () => {
        const reproduced = await readSourceNormalization(event.plan.binding.sourceRequest, event.recordedAt, event.plan.binding.version);
        if (canonical(reproduced) !== canonical(event.plan)) refuse("stored-source-binding-plan-mismatch");
      });
    }
    return sourceBindingHeadsAt(history, cutoff);
  };
  const recordSourceNormalization = (id: string, request: Omit<SourceStatsRequest, "cutoff">, expectedHeadId: string | null) => transaction(async () => {
    exact(request, ["profileId", "rawGameId", "rawTeam", "rawPlayerId"]);
    const clock = await databaseClock(); const scoped = { ...request, cutoff: clock }; sourceStatsRawKey(scoped);
    const existing = (await client.query("SELECT profile_id,raw_key_sha256,predecessor_id,plan FROM public.predictive_source_bindings WHERE id=$1", [id])).rows[0];
    if (existing && (existing.profile_id !== request.profileId || existing.raw_key_sha256 !== sourceStatsRawKey(scoped) || existing.predecessor_id !== expectedHeadId))
      refuse("source-binding-id-conflict");
    const plan = existing?.plan as SourceNormalizationPlan | undefined ?? await readSourceNormalization(scoped, clock);
    if (existing && !await currentBindingAccess([{ plan }], clock)) refuse("predictive-source-plan-rights-profile-invalid");
    // Retries re-verify their original files too. SQL independently checks
    // current rights on both new records and exact retries.
    if (existing && canonical(await readSourceNormalization(plan.binding.sourceRequest, (await client.query(
      `SELECT ${timestamp("recorded_at")} AS now FROM public.predictive_source_bindings WHERE id=$1`, [id])).rows[0].now, plan.binding.version)) !== canonical(plan))
      refuse("stored-source-binding-plan-mismatch");
    const result = (await client.query("SELECT public.predictive_record_source_binding($1,$2,$3) AS result", [id, expectedHeadId, JSON.stringify(plan)])).rows[0].result;
    const history = await bindingHistory(scoped, result.recordedAt);
    const event = history.find((row) => row.id === id) ?? refuse("stored-source-binding-missing");
    sourceBindingHeadsAt(history, result.recordedAt);
    return { event, reused: result.reused as boolean, observationsPublished: false as const, featuresPublished: false as const, labelsFinalized: false as const };
  });
  const replaySourceNormalization = (request: SourceStatsRequest): Promise<SourceNormalizationReplay> => transaction(async () => {
    sourceStatsRawKey(request); const clock = await databaseClock();
    if (instant(request.cutoff) > instant(clock)) refuse("source-binding-future-cutoff-refused");
    const history = await bindingHistory(request, request.cutoff);
    const result = (reason: string | null, head: SourceBindingEvent | null, currentPlan: SourceNormalizationPlan): SourceNormalizationReplay => ({
      status: reason ? "unavailable-source-normalization" : "observed-source-normalization", reason, head, currentPlan,
      observationsPublished: false, featuresPublished: false, labelsFinalized: false, populationCoverage: "unqualified" });
    if (!await currentBindingAccess(history, clock)) {
      // Do not hydrate revoked provider bytes or return historical payloads.
      const source = { status: "unavailable-source-claim" as const, reason: "rights-not-in-force",
        evidence: { version: SOURCE_CLAIM_VERSION, request, captures: [], rows: [] }, inputDigest: "", featuresPublished: false as const,
        labelsFinalized: false as const, populationCoverage: "unqualified" as const };
      source.inputDigest = digest(canonical(source.evidence));
      return result("rights-not-in-force", null, planNormalization(source, { profiles: [], rightsDecisions: [], identityLinks: [], replay: replayObservations([], new Set()) }, clock));
    }
    const heads = await verifyBindingHistory(history, request.cutoff);
    const currentPlan = await readSourceNormalization(request, clock);
    const head = heads[0];
    if (!head) return result("source-binding-missing", null, currentPlan);
    if (sourceNormalizationBasis(head.plan) !== sourceNormalizationBasis(currentPlan)) return result("source-binding-stale", null, currentPlan);
    if (!head.revision) return result(head.plan.reason ?? "source-binding-withheld", null, currentPlan);
    return result(null, head, currentPlan);
  }, true);

  // Research read adapter: enumerate complete recorded raw lineages inside the
  // explicit profiles, verify them, replan, and only then filter canonically.
  // No SQL entity predicate may discard a rerouted successor or a new current
  // destination. Bounds refuse the entire read rather than returning a prefix.
  const readSourceStatsFacts = async (input: SourceFactRequest) => memoEvidence("readSourceStatsFacts", input, async () => {
    const request = sourceFactRequest(input); const clock = await databaseClock();
    if (instant(request.cutoff) > instant(clock)) refuse("source-binding-future-cutoff-refused");
    const profiles = await profilesFor(request.profileIds);
    if (profiles.length !== request.profileIds.length) return sourceFactSnapshot(request, [], [], "source-profile-missing");
    if (profiles.some((profile) => profile.provider !== "nflverse" || !["player", "team"].includes(profile.feed) ||
        profile.parserVersion !== SOURCE_PROFILE_VERSION || profile.allowlistVersion !== "predictive-raw-allowlist-v1"))
      return sourceFactSnapshot(request, [], [], "source-profile-refused");
    const rights = (await readQuery(RIGHTS_SQL, [request.profileIds])).rows.map((row) => row.decision as RightsDecision);
    if (blockedProfiles(rights, request.profileIds, clock, "internal-research").size)
      return sourceFactSnapshot(request, [], [], "rights-not-in-force");
    const records = (await readQuery(`SELECT DISTINCT b.profile_id AS "profileId",b.raw_key_sha256 AS "rawKey",
      (b.plan->'binding'->'sourceRequest') - 'cutoff' AS request FROM public.predictive_source_bindings b
      WHERE b.profile_id=ANY($1::text[]) AND b.recorded_at <= $2::timestamptz
      ORDER BY "profileId","rawKey",request LIMIT ${SOURCE_FACT_BOUNDS.lineages + 1}`, [request.profileIds, request.cutoff])).rows;
    if (records.length > SOURCE_FACT_BOUNDS.lineages) refuse("source-fact-bounds-refused");
    const requests: SourceStatsRequest[] = []; const history: SourceBindingEvent[] = [];
    for (const row of records) {
      exact(row.request, ["profileId", "rawGameId", "rawTeam", "rawPlayerId"]);
      const raw = { ...row.request, cutoff: request.cutoff } as SourceStatsRequest;
      if (row.profileId !== raw.profileId || row.rawKey !== sourceStatsRawKey(raw)) refuse("stored-source-binding-mismatch");
      requests.push(raw); history.push(...await bindingHistory(raw, request.cutoff));
      if (history.length > SOURCE_FACT_BOUNDS.events) refuse("source-fact-bounds-refused");
    }
    // Check every historical context profile before opening any provider bytes.
    // An inaccessible chain cannot be proven irrelevant by reading its payload.
    if (!await currentBindingAccess(history, clock)) return sourceFactSnapshot(request, [], [], "rights-not-in-force");
    await verifyBindingHistory(history, request.cutoff);
    const plans: SourceNormalizationPlan[] = [];
    for (const raw of requests) plans.push(await readSourceNormalization(raw, clock));
    return sourceFactHeadsAt(history, plans, request);
  });
  const checkedSourceFacts = async (input: SourceFactRequest) => memoEvidence("checkedSourceFacts", input, async () => {
    const snapshot = await readSourceStatsFacts(input);
    // SQL independently expands raw chains before canonical filtering and
    // recomputes current plans/rights. The reader independently proves bytes;
    // neither a hashed witness nor SQL metadata can substitute for that proof.
    const sqlWitness = (await readQuery("SELECT public.predictive_source_witness($1) AS witness", [snapshot.request])).rows[0].witness;
    if (canonical(sqlWitness) !== canonical(sourceFactWitness(snapshot))) refuse("stored-source-witness-mismatch");
    return snapshot;
  });
  const replaySourceStatsFacts = (input: SourceFactRequest) => transaction(() => checkedSourceFacts(input), true);

  const sourceDecisionProfiles = async (request: SourceDecisionRequest, nativeProfiles: string[]) => (await readQuery(`
    SELECT DISTINCT id COLLATE "C" AS id FROM (
      SELECT unnest($1::text[]) AS id UNION SELECT unnest($3::text[]) AS id
      UNION SELECT x->>'profileId' FROM public.predictive_source_bindings b CROSS JOIN LATERAL jsonb_array_elements(b.plan->'binding'->'dependencies') x
        WHERE b.profile_id=ANY($1::text[]) AND b.recorded_at <= $2::timestamptz) profiles ORDER BY 1`,
  [request.profileIds, request.cutoff, nativeProfiles])).rows.map((row) => row.id as string);
  const readSourceDecisionPlan = async (input: SourceDecisionRequest) => memoEvidence("readSourceDecisionPlan", input, async () => {
    const request = sourceDecisionRequest(input);
    let rawNative: Raw[] = [];
    if (request.kind === "participation") {
      const prefix = "participation-evidence:" + request.entityKey.slice("player-game-stats:".length) + ":%";
      rawNative = (await readQuery(decisionScopeReadSql, [request.cutoff, [], [prefix]])).rows.map((row) => row.envelope as Raw);
      const profiles = [...new Set(rawNative.map((row) => row.artifact.profileId))];
      const clock = await databaseClock();
      const rights = (await readQuery(RIGHTS_SQL, [profiles])).rows.map((row) => row.decision as RightsDecision);
      if (blockedProfiles(rights, profiles, clock, "internal-research").size) refuse("source-decision-access-refused");
    }
    // SQL checks access and native-head bounds using metadata before any files.
    // The independent file-backed plan still must agree with it afterwards.
    const sqlPlan = (await readQuery("SELECT public.predictive_source_decision_plan($1) AS plan", [request])).rows[0].plan;
    // Gate native and source/context rights before opening either kind of file.
    const snapshot = await checkedSourceFacts({ profileIds: request.profileIds, entityKeys: [request.entityKey], cutoff: request.cutoff });
    if (snapshot.reason === "rights-not-in-force") refuse("source-decision-access-refused");
    if (snapshot.reason) refuse(snapshot.reason);
    const visible = [...validateObservations(await hydrate(rawNative)).values()];
    const superseded = new Set(visible.map((row) => row.revision.predecessorId));
    const native = visible.filter((row) => !superseded.has(row.revision.id));
    const profiles = await profilesFor(await sourceDecisionProfiles(request, native.map((row) => row.artifact.profileId)));
    const mode = profiles.some((profile) => profile.purpose === "synthetic-test") ? "synthetic-proof" : "production-research";
    const plan = sourceDecisionPlan(snapshot, request, native, mode);
    if (canonical(sqlPlan) !== canonical(plan)) refuse("stored-source-decision-plan-mismatch");
    return plan;
  });
  const planSourceDecision = (request: SourceDecisionRequest) => transaction(() => readSourceDecisionPlan(request), true);
  const sourceDecisionHistory = async (request: SourceDecisionRequest): Promise<SourceDecisionRecord[]> => {
    const records = (await readQuery(`SELECT id,predecessor_id AS "predecessorId",${timestamp("recorded_at")} AS "recordedAt",plan
      FROM public.predictive_source_decisions WHERE kind=$1 AND entity_key=$2 AND scope_digest=$3 AND recorded_at <= $4::timestamptz
      ORDER BY recorded_at,id COLLATE "C" LIMIT 257`, [request.kind, request.entityKey, digest(canonical(request.profileIds)), request.cutoff])).rows as SourceDecisionRecord[];
    if (records.length > 256) refuse("source-decision-history-bounds-refused");
    const remaining = new Map(records.map((row) => [row.id, row])); const ordered: SourceDecisionRecord[] = [];
    let predecessor: string | null = null;
    while (remaining.size) {
      const next = [...remaining.values()].filter((row) => row.predecessorId === predecessor);
      if (next.length !== 1) refuse("stored-source-decision-history-mismatch");
      const record = next[0]; remaining.delete(record.id); ordered.push(record); predecessor = record.id;
      if (instant(record.plan.witness.cutoff) > instant(record.recordedAt) || (ordered.length > 1 &&
          (instant(ordered.at(-2)!.recordedAt) > instant(record.recordedAt) || instant(ordered.at(-2)!.plan.witness.cutoff) > instant(record.plan.witness.cutoff))))
        refuse("stored-source-decision-history-mismatch");
    }
    return ordered;
  };
  const verifySourceDecision = async (record: SourceDecisionRecord) => memoEvidence("verifySourceDecision", record, async () => {
    const request = sourceDecisionRequest({ kind: record.plan.kind, entityKey: record.plan.entityKey,
      profileIds: record.plan.witness.profileIds, cutoff: record.plan.witness.cutoff });
    if (canonical(await readSourceDecisionPlan(request)) !== canonical(record.plan)) refuse("stored-source-decision-plan-mismatch");
    const sorted = (values: string[]) => [...new Set(values)].sort(compareText);
    const expectedBindings = (await readQuery(`SELECT id FROM public.predictive_source_bindings
      WHERE profile_id=ANY($1::text[]) AND recorded_at <= $2::timestamptz ORDER BY id COLLATE "C"`, [request.profileIds, request.cutoff])).rows.map((row) => row.id);
    const links = (await readQuery(`SELECT
      ARRAY(SELECT binding_id FROM public.predictive_source_decision_bindings WHERE decision_id=$1 ORDER BY binding_id COLLATE "C") AS bindings,
      ARRAY(SELECT observation_id FROM public.predictive_source_decision_inputs WHERE decision_id=$1 ORDER BY observation_id COLLATE "C") AS inputs,
      ARRAY(SELECT rights_decision_id FROM public.predictive_source_decision_rights WHERE decision_id=$1 ORDER BY rights_decision_id COLLATE "C") AS rights`, [record.id])).rows[0];
    const profiles = await sourceDecisionProfiles(request, record.plan.nativeInputs.map((row) => row.profileId));
    const rights = (await readQuery(RIGHTS_SQL, [profiles])).rows.map((row) => row.decision as RightsDecision);
    const expectedRights = profiles.map((profile) => rightsInForce(rights, profile, instant(record.recordedAt), instant(record.recordedAt))?.id ?? refuse("stored-source-decision-rights-mismatch"));
    if (canonical(links.bindings) !== canonical(expectedBindings) || canonical(links.inputs) !== canonical(sorted(record.plan.nativeInputs.map((row) => row.observationId))) ||
        canonical(links.rights) !== canonical(sorted(expectedRights))) refuse("stored-source-decision-associations-mismatch");
  });
  const recordSourceDecision = (id: string, input: Omit<SourceDecisionRequest, "cutoff">, expectedHeadId: string | null) => transaction(async () => {
    exact(input, ["kind", "profileIds", "entityKey"]);
    const request = sourceDecisionRequest({ ...input, cutoff: await databaseClock() });
    const old = (await client.query(`SELECT id,predecessor_id AS "predecessorId",${timestamp("recorded_at")} AS "recordedAt",plan
      FROM public.predictive_source_decisions WHERE id=$1`, [id])).rows[0] as SourceDecisionRecord | undefined;
    if (old && (old.plan.kind !== request.kind || old.plan.entityKey !== request.entityKey ||
        canonical(old.plan.witness.profileIds) !== canonical(request.profileIds) || old.predecessorId !== expectedHeadId)) refuse("source-decision-id-conflict");
    const plan = old?.plan ?? await readSourceDecisionPlan(request);
    if (old) await verifySourceDecision(old);
    const { reused, ...record } = (await client.query("SELECT public.predictive_record_source_decision($1,$2,$3) AS result", [id, expectedHeadId, plan])).rows[0].result as SourceDecisionRecord & { reused: boolean };
    if (record.id !== id || record.predecessorId !== expectedHeadId || canonical(record.plan) !== canonical(plan)) refuse("stored-source-decision-record-mismatch");
    return { record, reused, featuresPublished: false as const, labelsFinalized: false as const };
  });
  const readSourceDecision = async (input: SourceDecisionRequest) => memoEvidence("readSourceDecision", input, async () => {
    const request = sourceDecisionRequest(input);
    const unavailable = (reason: string, currentPlan: SourceDecisionPlan | null = null) => ({
      status: "unavailable-source-decision" as const, reason, record: null, currentPlan, featuresPublished: false as const, labelsFinalized: false as const });
    try {
      const currentPlan = await readSourceDecisionPlan(request);
      const history = await sourceDecisionHistory(request);
      for (const record of history) await verifySourceDecision(record);
      const head = history.at(-1);
      if (!head) return unavailable("source-decision-missing", currentPlan);
      if (sourceDecisionBasis(head.plan) !== sourceDecisionBasis(currentPlan)) return unavailable("source-decision-stale", currentPlan);
      if (currentPlan.state === "withheld") return unavailable("source-evidence-withheld", currentPlan);
      return { status: "current-source-decision" as const, reason: null, record: head, currentPlan, featuresPublished: false as const, labelsFinalized: false as const };
    } catch (error) {
      if (error instanceof Error && error.message === "source-decision-access-refused") return unavailable("rights-not-in-force");
      throw error;
    }
  });
  const replaySourceDecision = (input: SourceDecisionRequest) => transaction(() => readSourceDecision(input), true);

  // Discover native context from routing metadata. Use-specific rights for all
  // source history/context/native evidence are checked BEFORE file hydration.
  const sourceFeatureRaw = async (request: Request) => {
    const load = async (sql: string, values: unknown[]) => (await readQuery(sql,values)).rows.map((row) => row.envelope as Raw);
    const initial = await load(ENTITY_READ_SQL,[request.cutoff,[request.gameId],request.playerId]);
    const routing = replayObservations(initial.map((row) => observation(row.revision,row.capture,{ ...row.artifact,bytes: "" })),new Set());
    const target = routing.select("schedule","schedule:" + request.gameId).observation?.revision.data;
    const member = routing.select("membership","membership:" + request.gameId + ":" + request.playerId).observation?.revision.data;
    let rows = initial;
    if (target && member) {
      const from = target.season - 2;
      const members = await load(MEMBERSHIP_READ_SQL,[request.cutoff,request.playerId,target.kickoff,`${from}-01-01T00:00:00.000Z`]);
      const teams = new Set([member.teamId]);
      members.forEach((row) => { if (row.revision.kind === "membership") teams.add(row.revision.data.teamId); });
      if (request.candidate === "player-opponent-v1:player_pass_yds") teams.add(target.homeTeamId === member.teamId ? target.awayTeamId : target.homeTeamId);
      const schedules = await load(SCHEDULE_READ_SQL,[request.cutoff,[...teams],from,target.season]);
      const coverage = await load(coverageReadSql,[request.cutoff,[...teams],String(from),String(target.season)]);
      const games = new Set([request.gameId]); const aliases = new Set<string>();
      for (const row of [...schedules,...members,...coverage]) {
        if ("gameId" in row.revision.data && row.revision.data.gameId) games.add(row.revision.data.gameId);
        if (row.revision.kind === "schedule") aliases.add(row.revision.data.rawGameId);
        if (row.revision.kind === "schedule-coverage") row.revision.data.gameIds.forEach((id) => games.add(id));
      }
      rows = [...initial,...members,...schedules,...coverage,...await load(aliasReadSql,[request.cutoff,[...aliases]]),
        ...await load(ENTITY_READ_SQL,[request.cutoff,[...games],request.playerId])];
    }
    return [...new Map(rows.filter((row) => !["player-game-stats","team-game-stats"].includes(row.revision.kind))
      .map((row) => [row.revision.id + "|" + row.capture.id,row])).values()];
  };
  const sourceAccess = async (profileIds: string[], cutoff: string, observations: string[], entityKeys: string[], use: "model-input" | "outcome-label") => {
    return (await readQuery("SELECT public.predictive_source_consumer_access($1) AS profiles",[{
      profileIds,cutoff,observations,entityKeys,use,
    }])).rows[0].profiles as string[];
  };
  const sourceConsumerFacts = async (profileIds: string[], entityKeys: string[], cutoff: string) => {
    const snapshot = await checkedSourceFacts({ profileIds,entityKeys,cutoff });
    const facts = new Map<string,SourceConsumerFact>();
    for (const entityKey of entityKeys) {
      const rec = await readSourceDecision({ kind: "reconciliation",profileIds,entityKey,cutoff });
      const part = entityKey.startsWith("player-game-stats:") ? await readSourceDecision({ kind: "participation",profileIds,entityKey,cutoff }) : null;
      facts.set(entityKey,{ snapshot,reconciliation: rec.record,participation: part?.record ?? null,
        reconciliationReason: rec.reason,participationReason: part?.reason ?? null });
    }
    return facts;
  };
  const readSourcePassingYards = async (request: Request, inputProfiles: string[]) => memoEvidence("readSourcePassingYards", [request, inputProfiles], async () => {
    validatePassingYardsRequest(request);
    const profiles = sourceFactRequest({ profileIds: inputProfiles,entityKeys: [],cutoff: request.cutoff }).profileIds;
    const raw = await sourceFeatureRaw(request);
    await sourceAccess(profiles,request.cutoff,raw.map((row) => row.revision.id),[],"model-input");
    const rows = await hydrate(raw); const visible = validateObservations(rows);
    const decisionKeys = [...new Set(rows.flatMap((row) => ["reconciliation:" + row.entityKey,
      ...("gameId" in row.revision.data ? ["completion:" + row.revision.data.gameId] : [])]))];
    const decisions = (await readQuery(DECISION_SQL,[request.cutoff,decisionKeys])).rows.map((row) => row.decision as Decision);
    const profileMap = new Map((await profilesFor([...new Set(rows.map((row) => row.artifact.profileId))])).map((row) => [row.id,row]));
    validateDecisions(decisions,visible,profileMap); validateCompletionDecisions(decisions,visible,profileMap);
    const retention = (await readQuery(`SELECT scope_descriptor->'profileIds' AS profiles FROM public.predictive_retention_events
      WHERE scope_descriptor->>'kind'='source' AND (scope_descriptor->>'capturedFrom' IS NULL
        OR (scope_descriptor->>'capturedFrom')::timestamptz <= $1::timestamptz)`, [request.cutoff])).rows.flatMap((row) => row.profiles as string[]);
    const replay = replayObservations(rows,new Set(),decisions,retention);
    const requested = new Set<string>();
    // Discover exactly the slots the existing coverage/window policy queries,
    // instead of loading three seasons of league-wide source dependencies.
    buildPassingYardsFromReplay(replay,request,{
      select: (_kind,key) => { requested.add(key); return { state: "missing",observation: null,dependencies: [] }; },
      participation: (game,player) => { requested.add("player-game-stats:" + game + ":" + player); return { state: "unresolved",inputs: [] }; },
    });
    if (request.candidate === "player-opponent-v1:player_pass_yds") for (const key of [...requested]) if (key.startsWith("player-game-stats:")) {
      const game = key.split(":")[1];
      const member = replay.select("membership","membership:" + game + ":" + request.playerId).observation?.revision.data;
      if (member) requested.add("team-game-stats:" + game + ":" + member.teamId);
    }
    const keys = [...requested].sort(compareText);
    const accessed = await sourceAccess(profiles,request.cutoff,raw.map((row) => row.revision.id),keys,"model-input");
    const synthetic = (await profilesFor(accessed)).some((row) => row.purpose === "synthetic-test");
    return buildSourcePassingYards(replay,request,profiles,await sourceConsumerFacts(profiles,keys,request.cutoff),synthetic);
  });
  const replaySourcePassingYards = (request: Request,profileIds: string[]) => transaction(() => readSourcePassingYards(request,profileIds),true);
  const saveSourceConsumer = async (id: string,body: SourceConsumerBody,expectedHeadId: string | null): Promise<SourceConsumerRecord> => {
    const bytes = canonical(body); const sha256 = digest(bytes);
    return withBlobPublication([sha256],() => transaction(async () => {
      await artifacts.write(bytes,sha256);
      await client.query(`INSERT INTO public.predictive_blobs(sha256,byte_size,media_type,storage_ref) VALUES($1,$2,'application/json',$3)
        ON CONFLICT(sha256) DO NOTHING`,[sha256,Buffer.byteLength(bytes),sha256 + ".json"]);
      const record = (await client.query("SELECT public.predictive_record_source_consumer($1,$2,$3) AS result",[id,expectedHeadId,body])).rows[0].result as SourceConsumerRecord;
      if (record.id !== id || record.bodySha256 !== sha256 || canonical(record.body) !== canonical(body) ||
          record.executionDigest !== sourceConsumerExecutionDigest(sha256,record.rightsDecisions,record.recordedAt)) refuse("source-consumer-record-mismatch");
      return record;
    }));
  };
  const recordSourcePassingYards = async (id: string,request: Request,profileIds: string[]) =>
    saveSourceConsumer(id,await replaySourcePassingYards(request,profileIds),null);
  const readSourceFinalLabel = async (request: { playerId: string; gameId: string; profileIds: string[] },cutoff: string) => memoEvidence("readSourceFinalLabel", [request, cutoff], async () => {
    exact(request,["playerId","gameId","profileIds"]);
    const entityKey = "player-game-stats:" + request.gameId + ":" + request.playerId;
    const profiles = sourceFactRequest({ profileIds: request.profileIds,entityKeys: [entityKey],cutoff }).profileIds;
    const raw = (await readQuery(ENTITY_READ_SQL,[cutoff,[request.gameId],request.playerId])).rows.map((row) => row.envelope as Raw)
      // Preserve absence and rerouted successor heads; filtering by kind
      // alone would resurrect the predecessor's completion marker.
      .filter((row) => row.revision.kind === "event-state-marker" ||
        (row.revision.kind === "source-row-absent" && row.revision.data.priorEntityKey.startsWith("event-state-marker:")));
    await sourceAccess(profiles,cutoff,raw.map((row) => row.revision.id),[entityKey],"outcome-label");
    const rows = await hydrate(raw); const decisions = (await readQuery(DECISION_SQL,[cutoff,["completion:" + request.gameId]])).rows.map((row) => row.decision as Decision);
    const profileMap = new Map((await profilesFor([...new Set(rows.map((row) => row.artifact.profileId))])).map((row) => [row.id,row]));
    validateCompletionDecisions(decisions,validateObservations(rows),profileMap);
    const replay = replayObservations(rows,new Set(),decisions); const completion = replay.completion(request.gameId);
    const cited = replay.citedCompletions()[0];
    if (completion.state !== "completed" || !cited || !completion.completionObservedAt) refuse("source-label-completion-refused");
    const fact = (await sourceConsumerFacts(profiles,[entityKey],cutoff)).get(entityKey)!;
    const result = buildSourceFinalLabel(fact,{ id: cited.id,completionObservedAt: completion.completionObservedAt },profiles);
    result.manifest.observations = rows.map((row) => row.revision.id).sort(compareText);
    result.inputDigest = sourceConsumerInputDigest(result);
    return result;
  });
  const recordSourceFinalLabel = async (id: string,request: { playerId: string; gameId: string; profileIds: string[] },expectedHeadId: string | null) => {
    const body = await transaction(async () => readSourceFinalLabel(request,await databaseClock()),true);
    return saveSourceConsumer(id,body,expectedHeadId);
  };
  const verifySourceConsumer = async (record: SourceConsumerRecord) => {
    const bytes = canonical(record.body);
    if (await readBytes(record.bodySha256 + ".json",record.bodySha256,Buffer.byteLength(bytes)) !== bytes ||
        record.executionDigest !== sourceConsumerExecutionDigest(record.bodySha256,record.rightsDecisions,record.recordedAt)) refuse("stored-source-consumer-mismatch");
    const body = record.body.kind === "feature"
      ? await readSourcePassingYards({ ...record.body.bundle.request,computedAt: record.body.bundle.computedAt },record.body.manifest.profileIds)
      : await readSourceFinalLabel({ playerId: record.body.playerId,gameId: record.body.gameId,profileIds: record.body.manifest.profileIds },record.body.manifest.cutoff);
    if (canonical(body) !== canonical(record.body)) refuse("stored-source-consumer-mismatch");
    return record;
  };
  const replaySourceConsumer = (id: string) => transaction(async () => {
    // The SQL reader checks current use rights and sealed association closure
    // before the application opens either the run blob or source evidence.
    const record = (await client.query("SELECT public.predictive_source_consumer_check($1) AS result",[id])).rows[0].result as SourceConsumerRecord | null;
    if (!record) return null;
    return verifySourceConsumer(record);
  },true);

  // All current use rights and association checks precede the first byte read,
  // including kickoff context not present in a selected consumer's profile set.
  const authorizeConsumerBatch = async (ids: string[], extraUses: { profile: string; use: "model-input" | "outcome-label" }[] = []) => {
    const check = () => client.query(`SELECT id,public.predictive_source_consumer_check(id) AS result
      FROM unnest($1::text[]) id ORDER BY id COLLATE "C"`, [ids]);
    const checked = (await check()).rows as { id: string; result: SourceConsumerRecord | null }[];
    const records = new Map(checked.map((row) => [row.id, row.result]));
    if (checked.length !== ids.length || records.size !== ids.length || ids.some((id) => !records.has(id))) refuse("training-evidence-inventory-mismatch");
    if (Buffer.byteLength(canonical(checked)) > TRAINING_BOUNDS.pageBytes) refuse("training-page-byte-bounds-refused");
    const rightsIds = [...new Set(checked.flatMap(({ result }) => result?.rightsDecisions ?? []))];
    const rights = (await client.query("SELECT id,profile_id FROM public.predictive_rights_decisions WHERE id=ANY($1::text[])", [rightsIds])).rows;
    if (rights.length !== rightsIds.length) refuse("training-evidence-inventory-mismatch");
    const profileByRight = new Map(rights.map((row) => [row.id, row.profile_id as string]));
    const consumerUses = checked.flatMap(({ result }) => result?.rightsDecisions.map((id) => {
      const use = { profile: profileByRight.get(id)!, use: result.kind === "feature" ? "model-input" : "outcome-label" };
      return use;
    }) ?? []);
    const uses = [...new Map([...consumerUses, ...extraUses].map((use) => [canonical(use), use])).values()];
    // The association/profile closure cannot change under the guard. Clock
    // expiry still can: check its current rights before EACH unique file and
    // at delivery, bypassing the metadata cache. Full SQL reconstruction was
    // already checked per record above and need not be repeated at delivery.
    batchAccess = async () => {
      const allowed = (await client.query(`WITH clock AS MATERIALIZED (SELECT clock_timestamp() AS t)
        SELECT coalesce(bool_and(public.predictive_rights_allow(x.profile,c.t,c.t,'internal-research')
          AND public.predictive_rights_allow(x.profile,c.t,c.t,x.use)),true) AS allowed
        FROM jsonb_to_recordset($1::jsonb) x(profile text,use text) CROSS JOIN clock c`, [JSON.stringify(uses)])).rows[0].allowed;
      if (allowed !== true) refuse("source-consumer-rights-refused");
    };
    await batchAccess();
    return records;
  };
  const verifyConsumerBatch = async (records: Map<string, SourceConsumerRecord | null>) => {
    const results = await Promise.allSettled([...records.values()].map(async (result) => result && verifySourceConsumer(result)));
    // Drain every branch before rollback/COMMIT; pending work cannot escape
    // the guard into the next store operation, including on a damaged file.
    for (const result of results) if (result.status === "rejected") throw result.reason;
  };
  // Evidence primitive, not a training dataset API: no selection, kickoff
  // assertion, manifest, pin or population qualification is established here.
  // Guarded READ COMMITTED is intentional: acquire all table locks BEFORE
  // taking the clock/snapshots, including changes waiting ahead of the guard.
  const replaySourceConsumers = (input: string[]) => {
    if (!Array.isArray(input) || !input.length || input.length > TRAINING_BOUNDS.pageRows || input.some((id) =>
      typeof id !== "string" || !id.trim() || id.length > 256 || /[\u0000-\u001f\u007f]/.test(id))) refuse("training-consumer-bounds-refused");
    const requested = [...input], ids = [...new Set(requested)];
    return transaction(async () => {
      const records = await authorizeConsumerBatch(ids);
      if (Buffer.byteLength(canonical(requested.map((id) => records.get(id)))) > TRAINING_BOUNDS.pageBytes) refuse("training-page-byte-bounds-refused");
      await verifyConsumerBatch(records);
      // A lock prevents DML, but not clock-based expiry/scheduled decisions.
      // Recheck at delivery time without the query cache before returning bytes.
      await batchAccess!();
      return { snapshotAt: batchClock!, records: requested.map((id) => records.get(id)!),
        verification: { ...batch!.metrics(), verifiedBytes }, populationCoverage: "unqualified" as const };
    }, false, true);
  };

  // Discover kickoff metadata before authorization. Hydration is deferred until
  // every selected consumer and context profile passes current rights; both
  // preview and fixed-shard verification use this same schedule policy.
  const trainingKickoffContext = async (request: FittingRunRequest) => {
    const groups = new Map<string, { ordinals: number[]; rows: Raw[]; decisions: Decision[] }>();
    request.slots.forEach((slot, ordinal) => {
      const group = groups.get(slot.featureCutoff) ?? { ordinals: [], rows: [], decisions: [] };
      group.ordinals.push(ordinal); groups.set(slot.featureCutoff, group);
    });
    // Expand every visible source chain before resolving the requested head,
    // including corrections routed to a different game and raw-ID collisions.
    for (const [cutoff, group] of groups) {
      const gameIds = [...new Set(group.ordinals.map((i) => request.slots[i].gameId))];
      const raw = (await readQuery(normalizationScheduleReadSql, [cutoff, gameIds])).rows.map((row) => row.envelope as Raw);
      const aliases = [...new Set(raw.flatMap((row) => row.revision.kind === "schedule" ? [row.revision.data.rawGameId] : []))];
      group.rows = aliases.length ? (await readQuery(aliasReadSql, [cutoff, aliases])).rows.map((row) => row.envelope as Raw) : raw;
      const keys = [...new Set([...gameIds.map((id) => "reconciliation:schedule:" + id), ...group.rows.flatMap((row) =>
        row.revision.kind === "schedule" ? ["reconciliation:schedule:" + row.revision.data.gameId] : [])])];
      group.decisions = (await readQuery(DECISION_SQL, [cutoff, keys])).rows.map((row) => row.decision as Decision);
    }
    const kickoffProfiles = [...new Set([...groups.values()].flatMap((group) => group.rows.map((row) => row.artifact.profileId)))];
    const rights = (await readQuery(RIGHTS_SQL, [kickoffProfiles])).rows.map((row) => row.decision as RightsDecision);
    // Check historical permission too, before any kickoff/consumer file opens.
    for (const [cutoff, group] of groups) for (const profile of new Set(group.rows.map((row) => row.artifact.profileId))) {
      const right = rightsInForce(rights, profile, instant(cutoff), instant(cutoff));
      if (!allows(right, "internal-research") || !allows(right, "model-input")) refuse("training-kickoff-rights-refused");
    }
    const verify = async () => {
      const kickoffs: TrainingKickoffProof[] = new Array(request.slots.length);
      for (const [, group] of groups) {
        const observations = await hydrate(group.rows);
        const profiles = new Map((await profilesFor(kickoffProfiles)).map((profile) => [profile.id, profile]));
        validateDecisions(group.decisions, new Map(observations.map((row) => [row.revision.id, row])), profiles);
        const replay = replayObservations(observations, new Set(), group.decisions);
        for (const ordinal of group.ordinals) {
          const slot = request.slots[ordinal], chosen = replay.select("schedule", "schedule:" + slot.gameId);
          if (!chosen.observation) refuse("training-kickoff-" + chosen.state);
          const row = chosen.observation, schedule = row.revision.data;
          if (row.revision.id !== slot.kickoffObservationId || schedule.gameId !== slot.gameId || schedule.season !== slot.season ||
              schedule.seasonType !== slot.seasonType || schedule.kickoff !== slot.kickoff) refuse("training-kickoff-reference-mismatch");
          kickoffs[ordinal] = { observationId: row.revision.id, profileId: row.artifact.profileId,
            dependencies: chosen.dependencies.map((dependency) => ({ observationId: dependency.revision.id,
              captureId: dependency.capture.id, artifactId: dependency.artifact.id, sha256: dependency.artifact.sha256,
              availableAt: dependency.capture.availableAt, ingestedAt: dependency.capture.ingestedAt }))
              .sort((a, b) => compareText(a.observationId, b.observationId)),
            decisions: replay.usedDecisions().filter((decision) => decision.entityKey === "reconciliation:schedule:" + slot.gameId)
              .map((decision) => ({ id: decision.id, sha256: digest(canonical(decision)) })) };
        }
      }
      return kickoffs;
    };
    return { kickoffProfiles, verify };
  };

  // A bounded rehearsal of complete run selection. It writes no run, manifest
  // or pin, and its result cannot be supplied as trusted durable membership.
  // The eventual recorder must independently enforce the request in SQL and
  // persist selections from its own guarded snapshot, not trust this preview.
  const previewFittingRun = (input: FittingRunRequest) => {
    const supplied = structuredClone(input);
    return transaction(async () => {
      const snapshotAt = batchClock!, request = normalizeFittingRunRequest(supplied, snapshotAt);
      const metadata = checkTrainingMetadataSelection((await client.query<TrainingMetadataSelection>(TRAINING_SELECTION_SQL,
        [...trainingSelectionParameters(request, snapshotAt)])).rows, request.slots.length);
      const context = await trainingKickoffContext(request);
      const ids = [...new Set(metadata.flatMap((row) => [row.featureId, row.labelId].filter((id): id is string => id !== null)))];
      const records = await authorizeConsumerBatch(ids, context.kickoffProfiles.map((profile) => ({ profile, use: "model-input" })));
      if ([...records.values()].some((record) => record === null)) refuse("training-selection-inventory-mismatch");
      const kickoffs = await context.verify();
      await verifyConsumerBatch(records);
      const selected = selectTrainingRows(request, snapshotAt, [...records.values()].filter((record): record is SourceConsumerRecord => record !== null), new Set(), metadata);
      const result = trainingRunPreview(request, snapshotAt, selected, metadata, kickoffs);
      await batchAccess!();
      return { ...result, verification: { ...batch!.metrics(), verifiedBytes } };
    }, false, true);
  };

  // Metadata preparation is atomic and execute-only. SQL independently checks
  // the entire inventory, kickoff/current rights and selected consumer links.
  // No protected file is opened here: assigned shards must still reproduce and
  // pin these exact selections before a fitting run can become usable.
  const prepareFittingRun = (input: FittingRunRequest) => {
    const request = structuredClone(input);
    return transaction(async () => (await client.query("SELECT public.predictive_prepare_training_run($1) AS result", [request]))
      .rows[0].result as TrainingRunInventory & { reused: boolean });
  };
  const readFittingRun = (id: string) => transaction(async () =>
    (await client.query("SELECT public.predictive_training_run_read($1) AS result", [id])).rows[0].result as TrainingRunInventory | null,
  false, true);

  // Verify only an already-assigned shard. No latest-match SQL is run and no
  // durable dataset/pin is implied by this ephemeral metadata proof. Sealing
  // will reuse this guarded path in the same transaction as its SQL recorder.
  const verifyDatasetShard = (input: TrainingShardRequest) => {
    const supplied = normalizeTrainingShardRequest(input);
    return transaction(async () => {
      const inventory = (await client.query("SELECT public.predictive_training_run_read($1) AS result", [supplied.fittingRunId]))
        .rows[0].result as TrainingRunInventory | null;
      if (!inventory) refuse("training-run-not-found");
      const rows = trainingShardMembership(inventory, supplied);
      const currentClock = async () => (await client.query(`SELECT ${timestamp("clock_timestamp()")} AS clock`)).rows[0].clock as string;
      assertTrainingShardUnexpired(rows, await currentClock());
      const context = await trainingKickoffContext({ ...inventory.request, slots: rows.map((row) => row.slot) });
      const ids = [...new Set(rows.flatMap((row) => [row.selection.featureId, row.selection.labelId].filter((id): id is string => id !== null)))];
      const records = await authorizeConsumerBatch(ids, [...inventory.protectedUses,
        ...context.kickoffProfiles.map((profile) => ({ profile, use: "model-input" as const }))]);
      if ([...records.values()].some((record) => record === null)) refuse("training-shard-evidence-mismatch");
      // Scheduled expiry must also stop a later file read, not just delivery.
      const rightsAccess = batchAccess!;
      batchAccess = async () => { await rightsAccess(); assertTrainingShardUnexpired(rows, await currentClock()); };
      const kickoffs = await context.verify();
      await verifyConsumerBatch(records);
      const proof = trainingShardProof(inventory, supplied, await currentClock(),
        [...records.values()].filter((record): record is SourceConsumerRecord => record !== null), kickoffs);
      await batchAccess!();
      return { ...proof, verification: { ...batch!.metrics(), verifiedBytes } };
    }, false, true);
  };

  const publish = async (id: string, dataset: Dataset, now: string): Promise<RunResult> => {
    if (typeof id !== "string" || !id.trim() || id.length > 256) refuse("invalid-run-id"); instant(now);
    if (dataset.captures.some((capture) => !["published", "incomplete"].includes(capture.state))) refuse("invalid-enum");
    // Validate byte/schema/registration envelopes before files or SQL. Lineage
    // and rights are checked in the transaction against existing stored rows.
    const checked = validateDataset({ ...dataset, captures: dataset.captures.map((capture) => ({ ...capture, state: "incomplete" })) });
    const bytes = dataset.artifacts.reduce((sum, artifact) => sum + Buffer.byteLength(artifact.bytes), 0);
    if (bytes > PERSISTENCE_BOUNDS.bytes || [...checked.revisions.values()].reduce((sum, rows) => sum + rows.length, 0) > PERSISTENCE_BOUNDS.rows) refuse("publication-bounds-refused");
    if ((!dataset.captures.length && !checked.decisions.length && !dataset.labels.length) || dataset.captures.some((capture) => instant(capture.ingestedAt) > instant(now)) ||
        checked.decisions.some((decision) => instant(decision.decidedAt) > instant(now)) ||
        dataset.labels.some((label) => instant(label.createdAt) > instant(now))) refuse("publication-time-refused");
    for (const capture of dataset.captures) {
      if (capture.state === "published" && (!capture.bodyComplete || !capture.headerVerified || !capture.parserSucceeded)) refuse("incomplete-capture-published");
      if (capture.state === "published" && capture.parsedRows !== checked.revisions.get(capture.artifactId)!.length) refuse("capture-row-count-mismatch");
    }
    const requestHash = digest(canonical(dataset));
    const counts = { artifacts: dataset.artifacts.length, captures: new Set(dataset.captures.map((capture) => capture.id)).size,
      rows: new Set([...checked.revisions.values()].flatMap((rows) => rows.map((revision) => revision.id))).size };
    return withBlobPublication(dataset.artifacts.map((artifact) => artifact.sha256), async () => {
      for (const artifact of dataset.artifacts) await artifacts.write(artifact.bytes, artifact.sha256);
      return transaction(async () => {
        const existing = await priorRun(id, requestHash); if (existing) return existing;
        await persistRegistrations(dataset);
        const incomplete = dataset.captures.some((capture) => capture.state !== "published");
        if (incomplete) {
          await insertRun(id, requestHash, now, "incomplete", "partial-acquisition", { ...counts, rows: 0 }, bytes);
          for (const artifact of dataset.artifacts) await persistArtifact(artifact);
          for (const capture of dataset.captures) await persistCapture({ ...capture, id: id + ":diagnostic:" + capture.id, state: "incomplete" }, id);
          return { id, status: "incomplete", failureCode: "partial-acquisition", reused: false };
        }
        const byId = new Map(dataset.artifacts.map((artifact) => [artifact.id, artifact]));
        const incoming = dataset.captures.flatMap((capture) => checked.revisions.get(capture.artifactId)!.map((revision) =>
          observation(revision, capture, byId.get(capture.artifactId)!)));
        const referenced = [...new Set([...incoming.flatMap((row) => [row.revision.id, ...(row.revision.predecessorId ? [row.revision.predecessorId] : [])]),
          ...checked.decisions.flatMap((decision) => decision.inputs.map((input) => input.observationId))])];
        const scopes = new Map<string, { exact: Set<string>; prefixes: Set<string> }>();
        for (const decision of checked.decisions) {
          const group = scopes.get(decision.decidedAt) ?? { exact: new Set<string>(), prefixes: new Set<string>() };
          const scope = decisionScope(decision);
          scope.exact.forEach((value) => group.exact.add(value)); scope.prefixes.forEach((value) => group.prefixes.add(value));
          scopes.set(decision.decidedAt, group);
        }
        const scopeRows: Observation[] = [];
        for (const [decidedAt, scope] of scopes) {
          scopeRows.push(...await read(decisionScopeReadSql, [decidedAt, [...scope.exact], [...scope.prefixes]]));
        }
        const knownRows = [...await read(idReadSql, [now, referenced]), ...scopeRows, ...incoming];
        const known = validateObservations(knownRows);
        if (known.size > PERSISTENCE_BOUNDS.rows) refuse("publication-bounds-refused");
        if (checked.decisions.length) {
          const profiles = new Map([...(await profilesFor([...new Set([...known.values()].map((row) => row.artifact.profileId))])), ...dataset.profiles]
            .map((profile) => [profile.id, profile]));
          const earlier = (await client.query(DECISIONS_BY_ID_SQL,
            [checked.decisions.flatMap((decision) => decision.predecessorId ? [decision.predecessorId] : [])])).rows.map((row) => row.decision as Decision);
          const all = [...earlier.filter((item) => !checked.decisions.some((decision) => decision.id === item.id)), ...checked.decisions];
          validateDecisions(all, known, profiles);
        }
        await insertRun(id, requestHash, now, "published", null, counts, bytes);
        for (const artifact of dataset.artifacts) await persistArtifact(artifact);
        for (const capture of dataset.captures) await persistCapture(capture, id);
        for (const artifact of dataset.artifacts.filter((item) => dataset.captures.some((capture) => capture.artifactId === item.id))) {
          for (const revision of checked.revisions.get(artifact.id)!) await persistRevision(revision, artifact);
        }
        for (const decision of checked.decisions) await persistDecision(decision, id);
        for (const label of dataset.labels) await persistLabel(label, id);
        await recordRunRights(id);
        return { id, status: "published", failureCode: null, reused: false };
      });
    });
  };

  const recordRefusalLocked = async (id: string, dataset: Dataset, now: string): Promise<RunResult> => {
    if (typeof id !== "string" || !id.trim() || id.length > 256) refuse("invalid-run-id"); instant(now);
    const requestHash = digest(canonical(dataset));
    const diagnostics: { artifact: Artifact; captures: Capture[] }[] = [];
    let profiles: Profile[] = [];
    // Failed source bodies may be retained as diagnostics only. Validate the
    // routing/metadata envelope independently; never parse them as observations.
    if (Array.isArray(dataset.artifacts) && Array.isArray(dataset.captures) && dataset.artifacts.length <= PERSISTENCE_BOUNDS.artifacts &&
        dataset.captures.length <= PERSISTENCE_BOUNDS.captures &&
        dataset.artifacts.reduce((sum, artifact) => sum + (typeof artifact.bytes === "string" ? Buffer.byteLength(artifact.bytes) : PERSISTENCE_BOUNDS.bytes + 1), 0) <= PERSISTENCE_BOUNDS.bytes) {
      for (const original of dataset.artifacts) {
        try {
          const captures = dataset.captures.filter((capture) => capture.artifactId === original.id).map((capture) => ({ ...capture, state: "incomplete" as const }));
          const envelope = validateDataset({ formatVersion: 2, profiles: dataset.profiles, rightsDecisions: [],
            artifacts: [{ ...original, bytes: "[]", sha256: digest("[]") }], captures, decisions: [], labels: [], identityLinks: [] });
          await artifacts.write(original.bytes, original.sha256);
          const artifact = { ...original, id: "diagnostic-artifact:" + digest(id + ":" + original.id) };
          profiles = [...envelope.profiles.values()];
          diagnostics.push({ artifact, captures: captures.map((capture) => ({ ...capture, artifactId: artifact.id,
            id: "diagnostic-capture:" + digest(id + ":" + capture.id) })) });
        } catch { /* Invalid routing/bytes cannot be retained; the fixed run failure remains. */ }
      }
    }
    return transaction(async () => {
      const existing = await priorRun(id, requestHash);
      if (existing?.status === "published") refuse("published-run-retry-refused");
      if (existing) return existing;
      await insertRun(id, requestHash, now, "refused", "publication-refused", {
        artifacts: diagnostics.length, captures: new Set(diagnostics.flatMap((diagnostic) => diagnostic.captures.map((capture) => capture.id))).size, rows: 0,
      }, 0);
      for (const profile of profiles) await persistProfile(profile);
      for (const diagnostic of diagnostics) {
        await persistArtifact(diagnostic.artifact);
        for (const capture of diagnostic.captures) await persistCapture(capture, id);
      }
      return { id, status: "refused", failureCode: "publication-refused", reused: false };
    });
  };

  // Diagnostic bytes are written to the artifact store too, so the same locks apply.
  const recordRefusal = async (id: string, dataset: Dataset, now: string): Promise<RunResult> => {
    const digests = Array.isArray(dataset?.artifacts) ? dataset.artifacts.map((artifact) => typeof artifact?.sha256 === "string" ? artifact.sha256 : "") : [];
    return withBlobPublication(digests, () => recordRefusalLocked(id, dataset, now));
  };

  const compute = async (request: Request) => transaction(async () => {
    validatePassingYardsRequest(request);
    const initial = await read(ENTITY_READ_SQL, [request.cutoff, [request.gameId], request.playerId]);
    // Discovery only; rights are applied to the complete row set below.
    const selected = replayObservations(initial, new Set());
    const targetGame = selected.select("schedule", "schedule:" + request.gameId).observation?.revision.data;
    const targetMember = selected.select("membership", "membership:" + request.gameId + ":" + request.playerId).observation?.revision.data;
    let rows = initial;
    if (targetGame && targetMember) {
      const fromSeason = targetGame.season - 2;
      const members = await read(MEMBERSHIP_READ_SQL, [request.cutoff, request.playerId, targetGame.kickoff, `${fromSeason}-01-01T00:00:00.000Z`]);
      const teams = new Set([targetMember.teamId]);
      for (const row of members) if (row.revision.kind === "membership") teams.add(row.revision.data.teamId);
      if (request.candidate === "player-opponent-v1:player_pass_yds") teams.add(targetGame.homeTeamId === targetMember.teamId ? targetGame.awayTeamId : targetGame.homeTeamId);
      const schedules = await read(SCHEDULE_READ_SQL, [request.cutoff, [...teams], fromSeason, targetGame.season]);
      const coverage = await read(coverageReadSql, [request.cutoff, [...teams], String(fromSeason), String(targetGame.season)]);
      const gameIds = new Set([request.gameId]);
      const rawIds = new Set<string>();
      for (const row of [...schedules, ...members, ...coverage]) {
        if ("gameId" in row.revision.data && row.revision.data.gameId) gameIds.add(row.revision.data.gameId);
        if (row.revision.kind === "schedule") rawIds.add(row.revision.data.rawGameId);
        if (row.revision.kind === "schedule-coverage") row.revision.data.gameIds.forEach((value) => gameIds.add(value));
      }
      const aliases = await read(aliasReadSql, [request.cutoff, [...rawIds]]);
      const entities = await read(ENTITY_READ_SQL, [request.cutoff, [...gameIds], request.playerId]);
      rows = [...initial, ...members, ...schedules, ...coverage, ...aliases, ...entities];
    }
    if (rows.length > PERSISTENCE_BOUNDS.rows) refuse("replay-row-bounds-refused");
    // Current access uses the database clock, never a caller-supplied time: an
    // old computedAt cannot bypass a later revocation.
    const clock = (await client.query(`SELECT ${timestamp("now()")} AS now`)).rows[0].now as string;
    const profileIds = [...new Set(rows.map((row) => row.artifact.profileId))];
    const rights = (await client.query(RIGHTS_SQL, [profileIds])).rows.map((row) => row.decision as RightsDecision);
    const visible = validateObservations(rows);
    const decisionKeys = new Set([...visible.values()].flatMap((row) => ["reconciliation:" + row.entityKey,
      ...("gameId" in row.revision.data && row.revision.data.gameId ? ["completion:" + row.revision.data.gameId] : []),
      ...("gameId" in row.revision.data && row.revision.data.gameId && "playerId" in row.revision.data && row.revision.data.playerId === request.playerId
        ? ["participation:" + row.revision.data.gameId + ":" + request.playerId] : [])]));
    const decisions = (await client.query(DECISION_SQL, [request.cutoff, [...decisionKeys]])).rows.map((row) => row.decision as Decision);
    const profileMap = new Map((await profilesFor(profileIds)).map((profile) => [profile.id, profile]));
    validateDecisions(decisions, visible, profileMap);
    validateCompletionDecisions(decisions, visible, profileMap);
    validateParticipationDecisions(decisions, visible, profileMap);
    // Profiles an executed source retention event may have removed evidence from
    // at or before the cutoff; replay reports retained-evidence-removed for them.
    const retention = (await client.query(`SELECT scope_descriptor->'profileIds' AS profiles FROM public.predictive_retention_events
      WHERE scope_descriptor->>'kind'='source' AND (scope_descriptor->>'capturedFrom' IS NULL
        OR (scope_descriptor->>'capturedFrom')::timestamptz <= $1::timestamptz)`, [request.cutoff])).rows.flatMap((row) => row.profiles as string[]);
    const bundle = buildPassingYardsFromReplay(replayObservations(rows, blockedProfiles(rights, profileIds, clock), decisions, retention), request);
    return { bundle, clock, rights, profileMap };
  }, true);
  const replay = async (request: Request) => (await compute(request)).bundle;

  // Save every run: compute in the read-only snapshot, then record the exact
  // bundle and its manifest through predictive_record_feature_run() as the
  // recorder, without rereading evidence. The function stamps recorded_at and
  // recomputes the rights in force; the returned digest is cross-checked here. A
  // run that cannot be recorded is not returned as usable.
  const replayAndRecord = async (request: Request) => {
    const { bundle, profileMap } = await compute(request);
    const profiles = [...new Set(bundle.dependencies.map((dependency) => dependency.profileId))];
    const synthetic = profiles.some((id) => profileMap.get(id)?.purpose === "synthetic-test");
    const { run, dependencies, bundleBytes, bundleSha256 } = featureRunRequest(bundle, synthetic);
    try {
      return await withBlobPublication([bundleSha256], () => transaction(async () => {
        await client.query("SET LOCAL ROLE predictive_recorder");
        await artifacts.write(bundleBytes, bundleSha256);
        await client.query(`INSERT INTO public.predictive_blobs (sha256,byte_size,media_type,storage_ref) VALUES ($1,$2,'application/json',$3)
          ON CONFLICT (sha256) DO NOTHING`, [bundleSha256, Buffer.byteLength(bundleBytes), bundleSha256 + ".json"]);
        const recorded = (await client.query("SELECT public.predictive_record_feature_run($1,$2) AS result",
          [JSON.stringify(run), JSON.stringify(dependencies)])).rows[0].result as { featureRunId: string; recordedAt: string; executionDigest: string; rightsDecisions: string[] };
        const expected = executionDigest({ inputDigest: bundle.inputDigest, rightsDecisions: recorded.rightsDecisions, policies: dependencies.policies,
          featureVersion: bundle.featureVersion, codeVersion: FEATURE_CODE_VERSION, computedAt: bundle.computedAt, recordedAt: recorded.recordedAt });
        if (expected !== recorded.executionDigest || recorded.featureRunId !== "feature-run:" + expected) refuse("feature-run-digest-mismatch");
        return { status: "recorded" as const, bundle, featureRunId: recorded.featureRunId, inputDigest: bundle.inputDigest, executionDigest: recorded.executionDigest };
      }));
    } catch {
      return { status: "unavailable" as const, reason: "feature-run-not-recorded" };
    }
  };

  // Artifact failures produce an explicit unavailable result, never usable
  // summaries with missing provenance. The fixed code reveals no file paths.
  const safeReplay = async (request: Request) => {
    try { return { status: "replayed" as const, bundle: await replay(request) }; }
    catch { return { status: "unavailable" as const, reason: "persisted-replay-unavailable" }; }
  };
  // retention-policy-v1: one owner-run event per transaction, executed only by the
  // definer function as predictive_retention_owner. Blob files are removed after
  // commit from the removal queue, each under its digest's lock and only while no
  // row references it (a concurrent publication may have re-added the bytes).
  const retain = async (event: RetentionEvent): Promise<RetentionResult> => {
    const result = await transaction(async () => {
      if (!(await client.query("SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='predictive_retention_owner'")).rows.length) refuse("retention-owner-role-unavailable");
      await client.query("SET LOCAL ROLE predictive_retention_owner");
      const removed = (await client.query("SELECT public.predictive_retention_execute($1,$2,$3,$4,$5,$6) AS result",
        [event.id, event.reason, event.authority, event.decidedAt, JSON.stringify(event.scope), event.auditLevel])).rows[0].result as RetentionResult;
      // Older prefixes have no training hook/audit API. Historical upgrade
      // tests still use the original store, so discover this optional forward
      // capability without changing legacy zero-row results.
      if ((await client.query("SELECT to_regprocedure('public.predictive_training_retention_result(text)') AS available")).rows[0].available) {
        const audit = (await client.query("SELECT public.predictive_training_retention_result($1) AS result", [event.id])).rows[0].result;
        if (audit) removed.trainingRetention = audit;
      }
      return removed;
    });
    for (const reference of result.removedBlobRefs) await removeQueuedBlob(reference);
    return result;
  };
  // Under the digest's lock: a blob referenced again keeps its file; otherwise
  // the file is unlinked. Either way the queue row goes only after that, so a
  // crash or failed unlink leaves it for resumeBlobRemovals().
  const removeQueuedBlob = async (reference: string) => {
    const sha256 = reference.slice(0, 64);
    await withBlobLocks([sha256], async () => {
      const referenced = await blobReferenced(reference);
      if (!referenced) await artifacts.remove(reference, sha256);
      await client.query("SELECT public.predictive_ack_blob_removal($1)", [reference]);
    });
  };
  const resumeBlobRemovals = async () => {
    const references = (await client.query("SELECT public.predictive_pending_blob_removals() AS storage_ref")).rows
      .map((row) => row.storage_ref as string);
    for (const reference of references) await removeQueuedBlob(reference);
    return references;
  };
  // Owner-run, resumable orphan recovery. Never scans archive/journal files.
  // Recheck both age and committed references after acquiring each digest lock.
  const sweepOrphanBlobs = async (graceMs = 24 * 60 * 60 * 1000) => {
    if (!Number.isSafeInteger(graceMs) || graceMs < 60 * 60 * 1000 || graceMs > 30 * 24 * 60 * 60 * 1000) refuse("blob-grace-refused");
    const before = Number((await client.query("SELECT extract(epoch FROM clock_timestamp()) * 1000 AS now")).rows[0].now) - graceMs;
    const removed: string[] = [];
    for (const candidate of await artifacts.candidates(before)) await withBlobLocks([candidate.sha256], async () => {
      // Both role-checked APIs confirm the lock. Temporary names are never
      // referenced; final ownership binds the exact address, including suffix.
      if (candidate.kind === "temporary") await client.query("SELECT public.predictive_blob_lock_guard($1)", [candidate.sha256]);
      else if (await blobReferenced(candidate.reference)) return;
      if (await artifacts.removeOrphan(candidate, before)) removed.push(candidate.reference);
    });
    return removed;
  };
  const retentionEvents = async (): Promise<RecordedRetentionEvent[]> => {
    const events = (await client.query(`SELECT id,reason,authority,${timestamp("decided_at")} AS "decidedAt",
      scope_descriptor AS scope,audit_level AS "auditLevel",removed_counts AS "removedCounts",removed_ids_digest AS "removedIdsDigest",
      ${timestamp("executed_at")} AS "executedAt" FROM public.predictive_retention_history()`)).rows as RecordedRetentionEvent[];
    if ((await client.query("SELECT to_regprocedure('public.predictive_training_retention_result(text)') AS available")).rows[0].available) {
      for (const event of events) {
        const audit = (await client.query("SELECT public.predictive_training_retention_result($1) AS result", [event.id])).rows[0].result;
        if (audit) event.trainingRetention = audit;
      }
    }
    return events;
  };
  // A restored backup re-applies every retention event recorded since, oldest
  // first, by its scope descriptor, before any read. A present event is skipped;
  // matched is false when the backup lacked rows the original removal saw.
  const reapply = async (events: RecordedRetentionEvent[]) => {
    const results: { eventId: string; status: "present" | "reapplied"; matched: boolean }[] = [];
    for (const event of [...events].sort((a, b) => instant(a.executedAt) - instant(b.executedAt) || compareText(a.id, b.id))) {
      if ((await client.query("SELECT 1 FROM public.predictive_retention_history() WHERE id=$1", [event.id])).rows.length) {
        results.push({ eventId: event.id, status: "present", matched: true }); continue;
      }
      const result = await retain({ id: event.id, reason: event.reason, authority: event.authority, decidedAt: event.decidedAt, scope: event.scope, auditLevel: event.auditLevel });
      results.push({ eventId: event.id, status: "reapplied",
        matched: result.removedIdsDigest === event.removedIdsDigest && canonical(result.removedCounts) === canonical(event.removedCounts) &&
          canonical(result.trainingRetention ?? null) === canonical(event.trainingRetention ?? null) });
    }
    return results;
  };
  return { publish, publishSourceStats, replaySourceStats, replayCompressedInspections, planSourceStatsNormalization, recordSourceNormalization, replaySourceNormalization, replaySourceStatsFacts,
    planSourceDecision, recordSourceDecision, replaySourceDecision, replaySourcePassingYards, recordSourcePassingYards, recordSourceFinalLabel, replaySourceConsumer, replaySourceConsumers, previewFittingRun, prepareFittingRun, readFittingRun, verifyDatasetShard,
    replay, replayAndRecord, safeReplay, recordRefusal, retain, retentionEvents, reapply, resumeBlobRemovals, sweepOrphanBlobs };
};
