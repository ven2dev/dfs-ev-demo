import type { Client } from "pg";
import { checkConnectedTarget } from "../../../scripts/db-migrations/core.mjs";
import type { ArtifactStore } from "./artifacts.ts";
import type { Artifact, Capture, Dataset, Observation, Request, Revision } from "./types.ts";
import { buildPassingYardsFromReplay, validatePassingYardsRequest } from "./passingYards.ts";
import { replayObservations } from "./replay.ts";
import { canonical, digest, instant, refuse, validateDataset, validateObservations } from "./validation.ts";

export const PERSISTENCE_BOUNDS = { artifacts: 256, captures: 512, bytes: 8_000_000, rows: 8192 } as const;
const LOCK_NAMESPACE = 520052;
type Target = { expected: object; assertTarget: (config: object) => void };
type Raw = { revision: Revision; capture: Capture; artifact: Omit<Artifact, "bytes"> & { byteSize: number; storageRef: string } };
type RunResult = { id: string; status: "published" | "incomplete" | "refused"; failureCode: string | null; reused: boolean };
const timestamp = (column: string) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const envelopeSql = `SELECT jsonb_build_object('revision', jsonb_build_object('id',o.id,'kind',o.kind,'predecessorId',o.predecessor_id,'correctionReason',o.correction_reason,'data',o.data),
  'capture',jsonb_build_object('id',c.id,'artifactId',c.artifact_id,'capturedAt',${timestamp("c.captured_at")},'availableAt',${timestamp("c.available_at")},'ingestedAt',${timestamp("c.ingested_at")},
    'publishedAt',${timestamp("c.published_at")},'publicationEvidence',c.publication_evidence,'state',c.state),
  'artifact',jsonb_build_object('id',a.id,'sha256',a.sha256,'byteSize',a.byte_size,'storageRef',a.storage_ref,'source',a.source,'origin',a.origin,'feed',a.feed,
    'schemaVersion',a.schema_version,'parserVersion',a.parser_version,'rightsReviewVersion',a.rights_review_version)) AS envelope
  FROM chosen o JOIN public.predictive_artifact_observations l ON l.observation_id=o.id
  JOIN public.predictive_artifacts a ON a.id=l.artifact_id JOIN public.predictive_captures c ON c.artifact_id=a.id
  JOIN public.predictive_ingestion_runs r ON r.id=c.run_id
  WHERE c.state='published' AND r.status='published' AND c.available_at <= $1::timestamptz AND c.ingested_at <= $1::timestamptz
  ORDER BY o.id,c.ingested_at,c.available_at,c.captured_at,c.id LIMIT 8193`;
const closureSql = (predicate: string) => `WITH keys AS (
  SELECT DISTINCT o.natural_key FROM public.predictive_observations o WHERE (${predicate}) AND EXISTS (
    SELECT 1 FROM public.predictive_artifact_observations l JOIN public.predictive_captures c ON c.artifact_id=l.artifact_id
    JOIN public.predictive_ingestion_runs r ON r.id=c.run_id WHERE l.observation_id=o.id AND c.state='published' AND r.status='published'
      AND c.available_at <= $1::timestamptz AND c.ingested_at <= $1::timestamptz)),
  chosen AS (SELECT o.* FROM public.predictive_observations o JOIN keys k ON k.natural_key=o.natural_key)
  ${envelopeSql}`;
export const MEMBERSHIP_READ_SQL = closureSql("o.kind='membership' AND o.player_id=$2 AND o.effective_from < $3 AND o.effective_to > $4");
export const SCHEDULE_READ_SQL = closureSql("o.kind='schedule' AND o.season BETWEEN $3 AND $4 AND (o.home_team_id=ANY($2::text[]) OR o.away_team_id=ANY($2::text[]))");
export const ENTITY_READ_SQL = closureSql("o.game_id=ANY($2::uuid[]) AND (o.kind='schedule' OR o.kind='completion' OR o.player_id=$3 OR o.kind='team-passing')");
const idReadSql = closureSql("o.id=ANY($2::text[])");
const aliasReadSql = closureSql("o.kind='schedule' AND o.raw_game_id=ANY($2::text[])");
const coverageReadSql = closureSql("o.kind='schedule-coverage' AND o.team_id=ANY($2::text[]) AND o.data->>'fromSeason'=$3 AND o.data->>'throughSeason'=$4");

// No remote session, primary test DB or unregistered scratch database can use
// this local proof. The caller owns one session; operations are sequential.
export const createLocalPredictiveStore = async (client: Client, target: Target, artifacts: ArtifactStore) => {
  const assertTarget = async () => { target.assertTarget(target.expected); await checkConnectedTarget(client, target.expected); };
  await assertTarget();
  let busy = false;
  const hydrate = async (raw: Raw[]): Promise<Observation[]> => {
    if (raw.length > PERSISTENCE_BOUNDS.rows) refuse("replay-row-bounds-refused");
    const parsed = new Map<string, { artifact: Artifact; revisions: Map<string, Revision> }>();
    const result: Observation[] = [];
    for (const row of raw) {
      let stored = parsed.get(row.artifact.id);
      if (!stored) {
        const { byteSize, storageRef, ...metadata } = row.artifact;
        const artifact: Artifact = { ...metadata, bytes: await artifacts.read(storageRef, metadata.sha256, byteSize) };
        const checked = validateDataset({ formatVersion: 1, artifacts: [artifact], captures: [] });
        stored = { artifact, revisions: new Map(checked.revisions.get(artifact.id)!.map((revision) => [revision.id, revision])) };
        if (stored.revisions.size !== checked.revisions.get(artifact.id)!.length) refuse("observation-id-conflict");
        parsed.set(artifact.id, stored);
      }
      if (canonical(stored.revisions.get(row.revision.id)) !== canonical(row.revision)) refuse("stored-observation-mismatch");
      result.push({ revision: row.revision, capture: row.capture, artifact: stored.artifact });
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
    counts: { artifacts: number; captures: number; rows: number }) => {
    await client.query(`INSERT INTO public.predictive_ingestion_runs
      (id,request_sha256,code_version,adapter_version,started_at,finished_at,status,failure_code,bounds,artifact_count,capture_count,row_count)
      VALUES ($1,$2,'predictive-local-store-v1','synthetic-json-v1',$3,$3,$4,$5,$6,$7,$8,$9)`,
      [id, sha256, now, status, failureCode, PERSISTENCE_BOUNDS, counts.artifacts, counts.captures, counts.rows]);
  };
  const persistArtifact = async (artifact: Artifact) => {
    const values = [artifact.id, artifact.sha256, Buffer.byteLength(artifact.bytes), artifact.sha256 + ".json", artifact.source,
      artifact.origin, artifact.feed, artifact.schemaVersion, artifact.parserVersion, artifact.rightsReviewVersion];
    const row = (await client.query(`SELECT id,sha256,byte_size,storage_ref,source,origin,feed,schema_version,parser_version,rights_review_version
      FROM public.predictive_artifacts WHERE id=$1`, [artifact.id])).rows[0];
    if (row) { if (canonical(Object.values(row)) !== canonical(values)) refuse("artifact-id-conflict"); return; }
    await client.query(`INSERT INTO public.predictive_artifacts
      (id,sha256,byte_size,storage_ref,source,origin,feed,schema_version,parser_version,rights_review_version)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, values);
  };
  const persistCapture = async (capture: Capture, runId: string) => {
    const existing = (await client.query(`SELECT jsonb_build_object('id',id,'artifactId',artifact_id,'capturedAt',${timestamp("captured_at")},
      'availableAt',${timestamp("available_at")},'ingestedAt',${timestamp("ingested_at")},'publishedAt',${timestamp("published_at")},
      'publicationEvidence',publication_evidence,'state',state) AS capture FROM public.predictive_captures WHERE id=$1`, [capture.id])).rows[0];
    if (existing) { if (canonical(existing.capture) !== canonical(capture)) refuse("capture-id-conflict"); return; }
    await client.query(`INSERT INTO public.predictive_captures (id,run_id,artifact_id,captured_at,available_at,ingested_at,published_at,publication_evidence,state)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [capture.id, runId, capture.artifactId, capture.capturedAt, capture.availableAt,
      capture.ingestedAt, capture.publishedAt, capture.publicationEvidence, capture.state]);
  };
  const persistRevision = async (revision: Revision, artifactId: string) => {
    const old = (await client.query("SELECT kind,data,predecessor_id,correction_reason FROM public.predictive_observations WHERE id=$1", [revision.id])).rows[0];
    if (old && canonical({ id: revision.id, kind: old.kind, data: old.data, predecessorId: old.predecessor_id, correctionReason: old.correction_reason }) !== canonical(revision)) refuse("observation-id-conflict");
    if (!old) {
      const data = revision.data;
      for (const name of ["teamId", "homeTeamId", "awayTeamId"] as const) {
        if (name in data) await client.query("INSERT INTO public.predictive_teams (id) VALUES ($1) ON CONFLICT DO NOTHING", [data[name as keyof typeof data]]);
      }
      const games = "gameId" in data ? [data.gameId] : revision.kind === "schedule-coverage" ? revision.data.gameIds : [];
      for (const id of games) await client.query("INSERT INTO public.predictive_games (id) VALUES ($1) ON CONFLICT DO NOTHING", [id]);
      await client.query("INSERT INTO public.predictive_observations (id,kind,data,predecessor_id,correction_reason) VALUES ($1,$2,$3,$4,$5)",
        [revision.id, revision.kind, revision.data, revision.predecessorId, revision.correctionReason]);
    }
    await client.query("INSERT INTO public.predictive_artifact_observations (artifact_id,observation_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [artifactId, revision.id]);
  };

  const publish = async (id: string, dataset: Dataset, now: string): Promise<RunResult> => {
    if (typeof id !== "string" || !id.trim() || id.length > 256) refuse("invalid-run-id"); instant(now);
    if (dataset.captures.some((capture) => !["published", "incomplete"].includes(capture.state))) refuse("invalid-enum");
    // Validate byte/schema/capture envelopes before files or SQL. Lineage is
    // checked in the transaction against existing published predecessor rows.
    const checked = validateDataset({ ...dataset, captures: dataset.captures.map((capture) => ({ ...capture, state: "incomplete" })) });
    if (dataset.artifacts.reduce((sum, artifact) => sum + Buffer.byteLength(artifact.bytes), 0) > PERSISTENCE_BOUNDS.bytes ||
      [...checked.revisions.values()].reduce((sum, rows) => sum + rows.length, 0) > PERSISTENCE_BOUNDS.rows) refuse("publication-bounds-refused");
    if (!dataset.captures.length || dataset.captures.some((capture) => instant(capture.ingestedAt) > instant(now))) refuse("publication-time-refused");
    const requestHash = digest(canonical(dataset));
    const counts = { artifacts: dataset.artifacts.length, captures: new Set(dataset.captures.map((capture) => capture.id)).size,
      rows: new Set([...checked.revisions.values()].flatMap((rows) => rows.map((revision) => revision.id))).size };
    if ([...checked.revisions.values()].some((rows) => new Set(rows.map((revision) => revision.id)).size !== rows.length)) refuse("duplicate-artifact-observation");
    for (const artifact of dataset.artifacts) await artifacts.write(artifact.bytes, artifact.sha256);
    return transaction(async () => {
      const existing = await priorRun(id, requestHash); if (existing) return existing;
      const incomplete = dataset.captures.some((capture) => capture.state !== "published");
      if (incomplete) {
        await insertRun(id, requestHash, now, "incomplete", "partial-acquisition", { ...counts, rows: 0 });
        for (const artifact of dataset.artifacts) await persistArtifact(artifact);
        for (const capture of dataset.captures) await persistCapture({ ...capture, id: id + ":diagnostic:" + capture.id, state: "incomplete" }, id);
        return { id, status: "incomplete", failureCode: "partial-acquisition", reused: false };
      }
      const incoming = dataset.captures.flatMap((capture) => checked.revisions.get(capture.artifactId)!.map((revision) => ({
        revision, capture, artifact: dataset.artifacts.find((artifact) => artifact.id === capture.artifactId)!,
      })));
      const referenced = [...new Set(incoming.flatMap((row) => [row.revision.id, ...(row.revision.predecessorId ? [row.revision.predecessorId] : [])]))];
      const historical = await read(idReadSql, [now, referenced]);
      validateObservations([...historical, ...incoming]);
      await insertRun(id, requestHash, now, "published", null, counts);
      for (const artifact of dataset.artifacts) await persistArtifact(artifact);
      for (const capture of dataset.captures) await persistCapture(capture, id);
      for (const artifact of dataset.artifacts.filter((item) => dataset.captures.some((capture) => capture.artifactId === item.id))) {
        for (const revision of checked.revisions.get(artifact.id)!) await persistRevision(revision, artifact.id);
      }
      return { id, status: "published", failureCode: null, reused: false };
    });
  };

  const recordRefusal = async (id: string, dataset: Dataset, now: string): Promise<RunResult> => {
    if (typeof id !== "string" || !id.trim() || id.length > 256) refuse("invalid-run-id"); instant(now);
    const requestHash = digest(canonical(dataset));
    const diagnostics: { artifact: Artifact; captures: Capture[] }[] = [];
    // Failed source bodies may be retained as diagnostics only. Validate the
    // routing/metadata envelope independently; never parse them as observations.
    if (dataset.artifacts.length <= PERSISTENCE_BOUNDS.artifacts && dataset.captures.length <= PERSISTENCE_BOUNDS.captures &&
        dataset.artifacts.reduce((sum, artifact) => sum + (typeof artifact.bytes === "string" ? Buffer.byteLength(artifact.bytes) : PERSISTENCE_BOUNDS.bytes + 1), 0) <= PERSISTENCE_BOUNDS.bytes) {
      for (const original of dataset.artifacts) {
        try {
          const captures = dataset.captures.filter((capture) => capture.artifactId === original.id);
          validateDataset({ formatVersion: 1, artifacts: [{ ...original, bytes: "[]", sha256: digest("[]") }], captures });
          await artifacts.write(original.bytes, original.sha256);
          const artifact = { ...original, id: "diagnostic-artifact:" + digest(id + ":" + original.id) };
          diagnostics.push({ artifact, captures: captures.map((capture) => ({ ...capture, artifactId: artifact.id,
            id: "diagnostic-capture:" + digest(id + ":" + capture.id), state: "incomplete" })) });
        } catch { /* Invalid routing/bytes cannot be retained; the fixed run failure remains. */ }
      }
    }
    return transaction(async () => {
      const existing = await priorRun(id, requestHash);
      if (existing?.status === "published") refuse("published-run-retry-refused");
      if (existing) return existing;
      await insertRun(id, requestHash, now, "refused", "publication-refused", {
        artifacts: diagnostics.length, captures: new Set(diagnostics.flatMap((diagnostic) => diagnostic.captures.map((capture) => capture.id))).size, rows: 0,
      });
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
    const selected = replayObservations(initial);
    const targetGame = selected.select("schedule", "schedule:" + request.gameId).observation?.revision.data;
    const targetMember = selected.select("membership", "membership:" + request.gameId + ":" + request.playerId).observation?.revision.data;
    if (!targetGame || !targetMember) return buildPassingYardsFromReplay(selected, request);
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
      if (row.revision.kind === "schedule-coverage") row.revision.data.gameIds.forEach((id) => gameIds.add(id));
    }
    const aliases = await read(aliasReadSql, [request.cutoff, [...rawIds]]);
    const entities = await read(ENTITY_READ_SQL, [request.cutoff, [...gameIds], request.playerId]);
    const rows = [...initial, ...members, ...schedules, ...coverage, ...aliases, ...entities];
    if (rows.length > PERSISTENCE_BOUNDS.rows) refuse("replay-row-bounds-refused");
    return buildPassingYardsFromReplay(replayObservations(rows), request);
  }, true);

  // Artifact failures produce an explicit unavailable result, never usable
  // summaries with missing provenance. The fixed code reveals no file paths.
  const safeReplay = async (request: Request) => {
    try { return { status: "replayed" as const, bundle: await replay(request) }; }
    catch { return { status: "unavailable" as const, reason: "persisted-replay-unavailable" }; }
  };
  return { publish, replay, safeReplay, recordRefusal };
};
