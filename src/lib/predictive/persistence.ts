import type { Client } from "pg";
import { checkConnectedTarget } from "../../../scripts/db-migrations/core.mjs";
import type { ArtifactStore } from "./artifacts.ts";
import type { Artifact, Capture, Dataset, Observation, Profile, Request, Revision, RightsDecision } from "./types.ts";
import { buildPassingYardsFromReplay, validatePassingYardsRequest } from "./passingYards.ts";
import { blockedProfiles, replayObservations } from "./replay.ts";
import { canonical, digest, entityKey, instant, observation, refuse, sourceKey, validateDataset, validateObservations } from "./validation.ts";

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
    'scopeKind',a.scope_kind,'scopeSeason',a.scope_season,'scopeWeek',a.scope_week,'scopeFilter',a.scope_filter,
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
        const checked = validateDataset({ formatVersion: 2, profiles: [profiles.get(artifact.profileId)!], rightsDecisions: [], artifacts: [artifact], captures: [] });
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
      artifact.providerLastModified, artifact.releaseUpdatedAt, artifact.scopeKind, artifact.scopeSeason, artifact.scopeWeek, artifact.scopeFilter];
    const row = (await client.query(`SELECT id,blob_sha256,profile_id,retrieval_kind,origin,provider_etag,provider_last_modified,
      ${timestamp("release_updated_at")} AS release_updated_at,scope_kind,scope_season,scope_week,scope_filter
      FROM public.predictive_artifacts WHERE id=$1`, [artifact.id])).rows[0];
    if (row) { if (canonical(Object.values(row)) !== canonical(values)) refuse("artifact-id-conflict"); return; }
    await client.query(`INSERT INTO public.predictive_artifacts (id,blob_sha256,profile_id,retrieval_kind,origin,provider_etag,provider_last_modified,
      release_updated_at,scope_kind,scope_season,scope_week,scope_filter) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, values);
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
      const games = "gameId" in revision.data ? [revision.data.gameId] : revision.kind === "schedule-coverage" ? revision.data.gameIds : [];
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
    if (!dataset.captures.length || dataset.captures.some((capture) => instant(capture.ingestedAt) > instant(now))) refuse("publication-time-refused");
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
      const referenced = [...new Set(incoming.flatMap((row) => [row.revision.id, ...(row.revision.predecessorId ? [row.revision.predecessorId] : [])]))];
      validateObservations([...await read(idReadSql, [now, referenced]), ...incoming]);
      await insertRun(id, requestHash, now, "published", null, counts, bytes);
      for (const artifact of dataset.artifacts) await persistArtifact(artifact);
      for (const capture of dataset.captures) await persistCapture(capture, id);
      for (const artifact of dataset.artifacts.filter((item) => dataset.captures.some((capture) => capture.artifactId === item.id))) {
        for (const revision of checked.revisions.get(artifact.id)!) await persistRevision(revision, artifact);
      }
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
            artifacts: [{ ...original, bytes: "[]", sha256: digest("[]") }], captures });
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

  const replay = async (request: Request) => transaction(async () => {
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
        if ("gameId" in row.revision.data) gameIds.add(row.revision.data.gameId);
        if (row.revision.kind === "schedule") rawIds.add(row.revision.data.rawGameId);
        if (row.revision.kind === "schedule-coverage") row.revision.data.gameIds.forEach((value) => gameIds.add(value));
      }
      const aliases = await read(aliasReadSql, [request.cutoff, [...rawIds]]);
      const entities = await read(ENTITY_READ_SQL, [request.cutoff, [...gameIds], request.playerId]);
      rows = [...initial, ...members, ...schedules, ...coverage, ...aliases, ...entities];
    }
    if (rows.length > PERSISTENCE_BOUNDS.rows) refuse("replay-row-bounds-refused");
    // Current access: rights known and in force at computation time.
    const profileIds = [...new Set(rows.map((row) => row.artifact.profileId))];
    const decisions = (await client.query(RIGHTS_SQL, [profileIds])).rows.map((row) => row.decision as RightsDecision);
    return buildPassingYardsFromReplay(replayObservations(rows, blockedProfiles(decisions, profileIds, request.computedAt)), request);
  }, true);

  // Artifact failures produce an explicit unavailable result, never usable
  // summaries with missing provenance. The fixed code reveals no file paths.
  const safeReplay = async (request: Request) => {
    try { return { status: "replayed" as const, bundle: await replay(request) }; }
    catch { return { status: "unavailable" as const, reason: "persisted-replay-unavailable" }; }
  };
  return { publish, replay, safeReplay, recordRefusal };
};
