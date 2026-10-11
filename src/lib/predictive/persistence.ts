import type { Client } from "pg";
import { checkConnectedTarget } from "../../../scripts/db-migrations/core.mjs";
import type { ArtifactStore } from "./artifacts.ts";
import type { Artifact, Capture, Dataset, Decision, Label, Observation, Profile, RecordedRetentionEvent, Request, RetentionEvent, RetentionResult,
  Revision, RightsDecision } from "./types.ts";
import { validateCompletionDecisions } from "./completion.ts";
import { validateParticipationDecisions } from "./participation.ts";
import { featureRunRecord } from "./featureRuns.ts";
import { buildPassingYardsFromReplay, validatePassingYardsRequest } from "./passingYards.ts";
import { blockedProfiles, replayObservations } from "./replay.ts";
import { canonical, compareText, digest, entityKey, instant, observation, refuse, rightsInForce, sourceKey, validateDataset, validateDecisions, validateObservations } from "./validation.ts";

export const PERSISTENCE_BOUNDS = { artifacts: 256, captures: 512, bytes: 8_000_000, rows: 8192 } as const;
const LOCK_NAMESPACE = 520052;
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
  WHERE r.status='published' AND d.kind IN ('reconciliation','completion','participation') AND ${predicate} ORDER BY d.id`;
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

// No remote session, primary test DB or unregistered scratch database can use
// this local proof. The caller owns one session; operations are sequential.
export const createLocalPredictiveStore = async (client: Client, target: Target, artifacts: ArtifactStore) => {
  const assertTarget = async () => { target.assertTarget(target.expected); await checkConnectedTarget(client, target.expected); };
  await assertTarget();
  let busy = false;
  const profilesFor = async (ids: string[]): Promise<Profile[]> =>
    (await client.query(PROFILE_SQL, [ids])).rows.map((row) => row.profile as Profile);
  const hydrate = async (raw: Raw[]): Promise<Observation[]> => {
    if (raw.length > PERSISTENCE_BOUNDS.rows) refuse("replay-row-bounds-refused");
    const profiles = new Map((await profilesFor([...new Set(raw.map((row) => row.artifact.profileId))])).map((profile) => [profile.id, profile]));
    const parsed = new Map<string, { artifact: Artifact; revisions: Map<string, Revision> }>();
    const result: Observation[] = [];
    for (const row of raw) {
      let stored = parsed.get(row.artifact.id);
      if (!stored) {
        const { byteSize, storageRef, ...metadata } = row.artifact;
        const artifact: Artifact = { ...metadata, bytes: await artifacts.read(storageRef, metadata.sha256, byteSize) };
        // Every stored row is re-verified against its immutable source bytes.
        const checked = validateDataset({ formatVersion: 2, profiles: [profiles.get(artifact.profileId)!], rightsDecisions: [], artifacts: [artifact], captures: [], decisions: [], labels: [] });
        stored = { artifact, revisions: new Map(checked.revisions.get(artifact.id)!.map((revision) => [revision.id, revision])) };
        parsed.set(artifact.id, stored);
      }
      if (canonical(stored.revisions.get(row.revision.id)) !== canonical(row.revision)) refuse("stored-observation-mismatch");
      result.push(observation(row.revision, row.capture, stored.artifact));
    }
    return result;
  };
  const read = async (sql: string, values: unknown[]) => hydrate((await client.query(sql, values)).rows.map((row) => row.envelope as Raw));
  const transaction = async <T>(work: () => Promise<T>, readonly = false): Promise<T> => {
    if (busy) refuse("predictive-session-busy"); busy = true;
    try {
      await assertTarget();
      await client.query(readonly ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" : "BEGIN");
      try {
        await client.query("SET LOCAL search_path = public");
        await client.query("SET LOCAL statement_timeout = '10s'");
        await client.query("SET LOCAL lock_timeout = '3s'");
        await client.query("SET LOCAL idle_in_transaction_session_timeout = '15s'");
        if (!readonly) await client.query("SELECT pg_advisory_xact_lock($1,1)", [LOCK_NAMESPACE]);
        const result = await work(); await client.query("COMMIT"); return result;
      } catch (error) { await client.query("ROLLBACK"); throw error; }
    } finally { busy = false; }
  };
  const priorRun = async (id: string, sha256: string): Promise<RunResult | null> => {
    const row = (await client.query("SELECT request_sha256,status,failure_code FROM public.predictive_ingestion_runs WHERE id=$1", [id])).rows[0];
    if (!row) return null;
    if (row.request_sha256 !== sha256) refuse("run-id-conflict");
    return { id, status: row.status, failureCode: row.failure_code, reused: true };
  };
  const insertRun = async (id: string, sha256: string, now: string, status: RunResult["status"], failureCode: string | null,
    counts: { artifacts: number; captures: number; rows: number }, consumedBytes: number) => {
    await client.query(`INSERT INTO public.predictive_ingestion_runs
      (id,request_sha256,code_version,started_at,finished_at,status,failure_code,budget,requests,consumed_bytes,artifact_count,capture_count,row_count,peak_rss_bytes)
      VALUES ($1,$2,'predictive-local-store-v2',$3,$3,$4,$5,$6,0,$7,$8,$9,$10,NULL)`,
      [id, sha256, now, status, failureCode, PERSISTENCE_BOUNDS, consumedBytes, counts.artifacts, counts.captures, counts.rows]);
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
  const persistArtifact = async (artifact: Artifact) => {
    const byteSize = Buffer.byteLength(artifact.bytes);
    await client.query(`INSERT INTO public.predictive_blobs (sha256,byte_size,media_type,storage_ref) VALUES ($1,$2,'application/json',$3)
      ON CONFLICT (sha256) DO NOTHING`, [artifact.sha256, byteSize, artifact.sha256 + ".json"]);
    const blob = (await client.query("SELECT byte_size,media_type FROM public.predictive_blobs WHERE sha256=$1", [artifact.sha256])).rows[0];
    if (blob.byte_size !== byteSize || blob.media_type !== "application/json") refuse("blob-conflict");
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
  const persistRegistrations = async (dataset: Dataset) => {
    for (const profile of dataset.profiles) await persistProfile(profile);
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
      label.selectedObservationId, label.eligibleFinalAt, label.postWindowCaptureId, label.finalizedAt, label.createdAt];
    const existing = (await client.query("SELECT id FROM public.predictive_outcome_labels WHERE id=$1", [label.id])).rows[0];
    if (existing) refuse("label-id-conflict");
    await client.query(`INSERT INTO public.predictive_outcome_labels (id,player_id,game_id,season_type,stat,value,state,mode,policy_id,label_version,
      predecessor_id,run_id,completion_decision_id,participation_decision_id,reconciliation_decision_id,selected_observation_id,eligible_final_at,
      post_window_capture_id,finalized_at,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`, columns);
  };
  // The decision each published capture relied on, recorded for audit. A missing
  // decision leaves no row, and the deferred publication check refuses commit.
  const recordRunRights = (runId: string) => client.query(`INSERT INTO public.predictive_run_rights (run_id,rights_decision_id)
    SELECT DISTINCT c.run_id, public.predictive_rights_in_force(a.profile_id, c.captured_at, c.captured_at)
    FROM public.predictive_captures c JOIN public.predictive_artifacts a ON a.id=c.artifact_id
    WHERE c.run_id=$1 AND c.state='published' AND public.predictive_rights_in_force(a.profile_id, c.captured_at, c.captured_at) IS NOT NULL
    ON CONFLICT DO NOTHING`, [runId]);

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
  };

  const recordRefusal = async (id: string, dataset: Dataset, now: string): Promise<RunResult> => {
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
            artifacts: [{ ...original, bytes: "[]", sha256: digest("[]") }], captures, decisions: [], labels: [] });
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
  // bundle and dependencies in a separate transaction as the recorder, without
  // rereading evidence. A run that cannot be recorded is not returned as usable.
  const replayAndRecord = async (request: Request) => {
    const { bundle, clock, rights, profileMap } = await compute(request);
    const profiles = [...new Set(bundle.dependencies.map((dependency) => dependency.profileId))];
    const at = instant(clock);
    const rightsAtAccess = new Map(profiles.map((id) => [id, rightsInForce(rights, id, at, at)?.id ?? null]));
    const synthetic = profiles.some((id) => profileMap.get(id)?.purpose === "synthetic-test");
    try {
      return await transaction(async () => {
        if ((await client.query("SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='predictive_recorder'")).rows.length) {
          await client.query("SET LOCAL ROLE predictive_recorder");
        }
        const recordedAt = (await client.query(`SELECT ${timestamp("now()")} AS now`)).rows[0].now as string;
        const record = featureRunRecord(bundle, { rightsInForce: rightsAtAccess, synthetic, recordedAt });
        await artifacts.write(record.bundleBytes, record.bundleSha256);
        await client.query(`INSERT INTO public.predictive_blobs (sha256,byte_size,media_type,storage_ref) VALUES ($1,$2,'application/json',$3)
          ON CONFLICT (sha256) DO NOTHING`, [record.bundleSha256, Buffer.byteLength(record.bundleBytes), record.bundleSha256 + ".json"]);
        await client.query(`INSERT INTO public.predictive_feature_runs (id,mode,feature_version,candidate,player_id,game_id,cutoff,computed_at,recorded_at,
          code_version,status,reasons,input_digest,execution_digest,bundle_blob_sha256) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [record.id, record.mode, record.featureVersion, record.candidate, record.playerId, record.gameId, record.cutoff, record.computedAt, record.recordedAt,
          record.codeVersion, record.status, record.reasons, record.inputDigest, record.executionDigest, record.bundleSha256]);
        const columns = { observations: "observation_id", decisions: "decision_id", rightsDecisions: "rights_decision_id",
          policies: "policy_id", featureDefinitions: "feature_definition_id" } as const;
        for (const [group, column] of Object.entries(columns)) {
          for (const value of record.dependencies[group as keyof typeof columns]) {
            await client.query(`INSERT INTO public.predictive_feature_run_dependencies (feature_run_id,${column}) VALUES ($1,$2)`, [record.id, value]);
          }
        }
        return { status: "recorded" as const, bundle, featureRunId: record.id, inputDigest: record.inputDigest, executionDigest: record.executionDigest };
      });
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
  // commit, and only while no row references them (a concurrent publication may
  // have re-added the same bytes).
  const retain = async (event: RetentionEvent): Promise<RetentionResult> => {
    const result = await transaction(async () => {
      if (!(await client.query("SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='predictive_retention_owner'")).rows.length) refuse("retention-owner-role-unavailable");
      await client.query("SET LOCAL ROLE predictive_retention_owner");
      return (await client.query("SELECT public.predictive_retention_execute($1,$2,$3,$4,$5,$6) AS result",
        [event.id, event.reason, event.authority, event.decidedAt, JSON.stringify(event.scope), event.auditLevel])).rows[0].result as RetentionResult;
    });
    for (const reference of result.removedBlobRefs) {
      const sha256 = reference.slice(0, 64);
      if ((await client.query("SELECT 1 FROM public.predictive_blobs WHERE sha256=$1", [sha256])).rows.length) continue;
      await artifacts.remove(reference, sha256);
    }
    return result;
  };
  const retentionEvents = async (): Promise<RecordedRetentionEvent[]> => (await client.query(`SELECT id,reason,authority,${timestamp("decided_at")} AS "decidedAt",
    scope_descriptor AS scope,audit_level AS "auditLevel",removed_counts AS "removedCounts",removed_ids_digest AS "removedIdsDigest",
    ${timestamp("executed_at")} AS "executedAt" FROM public.predictive_retention_events ORDER BY executed_at, id COLLATE "C"`)).rows;
  // A restored backup re-applies every retention event recorded since, oldest
  // first, by its scope descriptor, before any read. A present event is skipped;
  // matched is false when the backup lacked rows the original removal saw.
  const reapply = async (events: RecordedRetentionEvent[]) => {
    const results: { eventId: string; status: "present" | "reapplied"; matched: boolean }[] = [];
    for (const event of [...events].sort((a, b) => instant(a.executedAt) - instant(b.executedAt) || compareText(a.id, b.id))) {
      if ((await client.query("SELECT 1 FROM public.predictive_retention_events WHERE id=$1", [event.id])).rows.length) {
        results.push({ eventId: event.id, status: "present", matched: true }); continue;
      }
      const result = await retain({ id: event.id, reason: event.reason, authority: event.authority, decidedAt: event.decidedAt, scope: event.scope, auditLevel: event.auditLevel });
      results.push({ eventId: event.id, status: "reapplied",
        matched: result.removedIdsDigest === event.removedIdsDigest && canonical(result.removedCounts) === canonical(event.removedCounts) });
    }
    return results;
  };
  return { publish, replay, replayAndRecord, safeReplay, recordRefusal, retain, retentionEvents, reapply };
};
