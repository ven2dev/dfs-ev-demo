import type { Client } from "pg";
import type { EvidenceMode } from "./asOf.ts";
import { startJob, finishJob } from "./jobs.ts";
import { sha256 } from "./objectStore.ts";
import { NORMALIZER_VERSION } from "./source.ts";

export const FEATURE_VERSION = "qb-passing-yards-feature-v1";
export const LABEL_VERSION = "qb-passing-yards-label-v1";
export const HISTORY_POLICY = "prior-eligible-reg-max16-min2-cutoff1h-v1";
export type DerivedRequest = { season: number; mode: EvidenceMode; checkpoint?: string };
export type CodeIdentity = { gitSha: string; contentSha256: string };

const featureSelect = `
WITH context AS MATERIALIZED (
  SELECT * FROM fs138.qb_job_context($2,$3,$4,'features',$5)
), prior AS MATERIALIZED (
  SELECT *,count(*) OVER(PARTITION BY player_id,game_id,context_kickoff) AS kickoff_count,row_number() OVER(PARTITION BY player_id,game_id ORDER BY context_kickoff DESC,context_game_id) AS ordinal
  FROM context WHERE context_game_id<>game_id AND context_kickoff<cutoff AND cardinality(reasons)=0
), histories AS MATERIALIZED (
  SELECT player_id,game_id,count(*)::integer AS n,
    jsonb_agg(jsonb_build_object('gameId',context_game_id,'kickoff',context_kickoff,'yards',yards)
      ORDER BY context_kickoff DESC,context_game_id) AS history,
    bool_or(kickoff_count>1) AS order_conflict
  FROM prior WHERE ordinal<=16 GROUP BY player_id,game_id
), gaps AS MATERIALIZED (
  SELECT player_id,game_id,jsonb_agg(jsonb_build_object('gameId',context_game_id,'reasons',reasons) ORDER BY context_game_id) AS gaps
  FROM context WHERE context_game_id<>game_id AND coalesce(context_kickoff,discovery_kickoff)<cutoff AND cardinality(reasons)>0
  GROUP BY player_id,game_id
), prepared AS MATERIALIZED (
  SELECT c.player_id,c.game_id,c.season,c.cutoff,coalesce(h.n,0) AS n,coalesce(h.history,'[]'::jsonb) AS history,
    coalesce(g.gaps,'[]'::jsonb) AS gaps,
    c.target_reasons || array_remove(ARRAY[CASE WHEN coalesce(h.n,0)<2 THEN 'insufficient-history' END,
      CASE WHEN h.order_conflict THEN 'history-order-ambiguous' END],NULL) AS reasons
  FROM context c LEFT JOIN histories h USING(player_id,game_id) LEFT JOIN gaps g USING(player_id,game_id)
  WHERE c.context_game_id=c.game_id
), inserted AS (
  INSERT INTO fs138.feature_values(job_id,player_id,game_id,stat,season,cutoff,checkpoint,feature_version,history_policy,
    evidence_mode,state,reasons,flags,sample_size,history,history_gaps,supersedes_id)
  SELECT $1,p.player_id,p.game_id,'passing_yards',p.season,p.cutoff,$3,$6,$7,$4,
    CASE WHEN cardinality(p.reasons)=0 THEN 'usable' ELSE 'unavailable' END,p.reasons,
    CASE WHEN $4='retrospective-reconstruction-v1' THEN ARRAY['historical-availability-unverified'] ELSE '{}'::text[] END,
    p.n,p.history,p.gaps,(SELECT f.feature_id FROM fs138.feature_values f WHERE f.player_id=p.player_id AND f.game_id=p.game_id
      AND f.stat='passing_yards' AND f.feature_version=$6 AND f.evidence_mode=$4 AND f.checkpoint<=$3 ORDER BY f.checkpoint DESC,f.computed_at DESC,f.feature_id DESC LIMIT 1)
  FROM prepared p RETURNING feature_id,state,sample_size
), lineage AS (
  INSERT INTO fs138.feature_inputs SELECT i.feature_id,snapshot_id FROM inserted i CROSS JOIN unnest($8::uuid[]) snapshot_id
), job_lineage AS (
  INSERT INTO fs138.job_inputs SELECT $1::uuid,snapshot_id FROM unnest($8::uuid[]) snapshot_id
)
SELECT count(*)::integer AS rows,count(*) FILTER(WHERE state='usable')::integer AS usable,
  count(*) FILTER(WHERE state='unavailable')::integer AS unavailable,coalesce(max(sample_size),0)::integer AS max_sample FROM inserted`;

const labelSelect = `
WITH context AS MATERIALIZED (
  SELECT * FROM fs138.qb_job_context($2,$3,$4,'labels',$5)
), prepared AS MATERIALIZED (
  SELECT *,reasons || array_remove(ARRAY[CASE WHEN context_kickoff >= $3::timestamptz THEN 'game-not-before-label-cutoff' END],NULL) AS label_reasons
  FROM context
), inserted AS (
  INSERT INTO fs138.outcome_labels(job_id,player_id,game_id,stat,season,label_cutoff,label_version,evidence_mode,state,reasons,flags,value,supersedes_id)
  SELECT $1,p.player_id,p.game_id,'passing_yards',p.season,$3,$6,$4,
    CASE WHEN cardinality(p.label_reasons)=0 THEN 'usable' ELSE 'unavailable' END,p.label_reasons,
    CASE WHEN $4='retrospective-reconstruction-v1' THEN ARRAY['historical-availability-unverified'] ELSE '{}'::text[] END,
    CASE WHEN cardinality(p.label_reasons)=0 THEN p.yards ELSE NULL END,
    (SELECT l.label_id FROM fs138.outcome_labels l WHERE l.player_id=p.player_id AND l.game_id=p.game_id
      AND l.stat='passing_yards' AND l.label_version=$6 AND l.evidence_mode=$4 AND l.label_cutoff<=$3 ORDER BY l.label_cutoff DESC,l.known_at DESC,l.label_id DESC LIMIT 1)
  FROM prepared p RETURNING label_id,state
), lineage AS (
  INSERT INTO fs138.label_inputs SELECT i.label_id,snapshot_id FROM inserted i CROSS JOIN unnest($7::uuid[]) snapshot_id
), job_lineage AS (
  INSERT INTO fs138.job_inputs SELECT $1::uuid,snapshot_id FROM unnest($7::uuid[]) snapshot_id
)
SELECT count(*)::integer AS rows,count(*) FILTER(WHERE state='usable')::integer AS usable,
  count(*) FILTER(WHERE state='unavailable')::integer AS unavailable,0::integer AS max_sample FROM inserted`;

// Exported for the isolated database plan probe; no public product route uses it.
export const FEATURE_JOB_SQL = featureSelect;

// No source bytes or caller-computed values enter this API. Trusted pipeline
// jobs execute one typed, set-based materialization for every target in a season.
export const runDerivedJob = async (client: Pick<Client, "query">, kind: "features" | "labels",
  request: DerivedRequest, code: CodeIdentity) => {
  const started = performance.now();
  const zoned = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::?\d{2})?)$/;
  if (!Number.isInteger(request.season) || request.season<2021 || request.season>2025 ||
      !["strict-point-in-time-v1", "retrospective-reconstruction-v1"].includes(request.mode) ||
      (request.checkpoint !== undefined && (!zoned.test(request.checkpoint) || !Number.isFinite(Date.parse(request.checkpoint)))))
    throw new Error("derived-request-refused");
  await client.query("ANALYZE fs138.job_runs,fs138.source_snapshots,fs138.norm_schedule,fs138.norm_player_game_stats,fs138.norm_identity,fs138.norm_participation");
  const plan = (await client.query<{ checkpoint: string; valid: boolean; inputs: { snapshot_id: string; sha256: string }[] }>(`
    WITH clock AS MATERIALIZED (SELECT clock_timestamp() AS now), selected AS (
      SELECT coalesce($1::timestamptz,now) AS checkpoint,now FROM clock
    ) SELECT checkpoint::text,checkpoint<=now AS valid,
      coalesce((SELECT jsonb_agg(jsonb_build_object('snapshot_id',s.snapshot_id,'sha256',s.sha256) ORDER BY s.snapshot_id)
        FROM fs138.source_snapshots s JOIN fs138.job_runs j ON j.job_id=s.job_id
        WHERE s.ingested_at<=checkpoint AND j.status='succeeded'),'[]') AS inputs FROM selected`, [request.checkpoint ?? null])).rows[0];
  if (!plan.valid) throw new Error("future-checkpoint-refused");
  const snapshotIds = plan.inputs.map((input) => input.snapshot_id);
  const policy = { kind,season: request.season,mode: request.mode,checkpoint: plan.checkpoint,
    featureVersion: FEATURE_VERSION,labelVersion: LABEL_VERSION,history: HISTORY_POLICY,normalizer: NORMALIZER_VERSION,code };
  const job = await startJob(client,{ kind,codeSha: code.gitSha,policySha256: sha256(Buffer.from(JSON.stringify(policy))),
    inputSetSha256: sha256(Buffer.from(JSON.stringify(plan.inputs))) });
  if (!job.created) return { status: "existing" as const,jobId: job.jobId,jobStatus: job.status,checkpoint: plan.checkpoint,elapsedMs: performance.now()-started };
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = '84s'");
    // Installed pg/lib/client.js supports per-query query_timeout; its types
    // omit that field, so keep the structurally compatible configuration named.
    const materialization = { text: kind === "features" ? featureSelect : labelSelect, query_timeout: 90_000, values: [job.jobId,request.season,plan.checkpoint,request.mode,NORMALIZER_VERSION,
        kind === "features" ? FEATURE_VERSION : LABEL_VERSION,...(kind === "features" ? [HISTORY_POLICY,snapshotIds] : [snapshotIds])] };
    const result = await client.query<{ rows: number; usable: number; unavailable: number; max_sample: number }>(materialization);
    const counts = result.rows[0];
    await finishJob(client,job.jobId,{counts});
    await client.query("COMMIT");
    return { status: "succeeded" as const,jobId: job.jobId,checkpoint: plan.checkpoint,counts,
      elapsedMs: performance.now()-started,work: { materializations: 1,perExampleQueries: 0,sourceByteReads: 0 } };
  } catch (error) {
    // A client timeout does not cancel a PostgreSQL backend. Do not queue
    // rollback/retry on an interrupted connection; its owner must replace it.
    if (error instanceof Error && /Query read timeout|Connection terminated|Connection closed/.test(error.message))
      throw new Error("derived-connection-interrupted-replace", { cause: error });
    await client.query("ROLLBACK");
    await finishJob(client,job.jobId,{counts:{},errorCode:"derived-publication-failed"});
    throw error;
  }
};

// Internal display fixtures, not the rights-authorized product API (step 5).
// Code-owned identifiers select a table; source/caller strings remain parameters.
type DisplayRequest = {playerId:string;gameId:string;mode:EvidenceMode;knownAsOf:string};
const readLastValidDerived = async (client: Pick<Client,"query">,kind:"features"|"labels",request:DisplayRequest) => {
  const names=kind==="features"
    ? {table:"feature_values",id:"feature_id",clock:"computed_at",cutoff:"checkpoint",version:"feature_version",value:"history",versionValue:FEATURE_VERSION}
    : {table:"outcome_labels",id:"label_id",clock:"known_at",cutoff:"label_cutoff",version:"label_version",value:"value",versionValue:LABEL_VERSION};
  const result = await client.query(`WITH visible AS (
    SELECT * FROM fs138.${names.table} WHERE player_id=$1 AND game_id=$2 AND evidence_mode=$3
      AND ${names.version}=$5 AND ${names.clock}<=$4::timestamptz
  ), head AS (SELECT * FROM visible ORDER BY ${names.cutoff} DESC,${names.clock} DESC,${names.id} DESC LIMIT 1),
  valid AS (SELECT * FROM visible WHERE state='usable' ORDER BY ${names.cutoff} DESC,${names.clock} DESC,${names.id} DESC LIMIT 1)
  SELECT head.${names.id} AS head_id,valid.${names.id} AS displayed_id,valid.${names.value} AS value,head.reasons,
    (valid.${names.id} IS NOT NULL AND valid.${names.id}<>head.${names.id}) AS stale,
    EXISTS(SELECT 1 FROM visible newer WHERE newer.supersedes_id=valid.${names.id}) AS superseded,
    CASE WHEN valid.${names.id} IS NULL THEN 'unavailable'
      WHEN valid.${names.id}<>head.${names.id} THEN 'last valid value; newer result unavailable'
      WHEN EXISTS(SELECT 1 FROM visible previous WHERE previous.${names.id}=valid.supersedes_id
        AND previous.${names.value} IS DISTINCT FROM valid.${names.value}) THEN 'corrected value'
      ELSE 'current value' END AS display_status
  FROM head LEFT JOIN valid ON true`,[request.playerId,request.gameId,request.mode,request.knownAsOf,names.versionValue]);
  return result.rows[0] ?? null;
};
export const readLastValidLabel = (client:Pick<Client,"query">,request:DisplayRequest) => readLastValidDerived(client,"labels",request);
export const readLastValidFeature = (client:Pick<Client,"query">,request:DisplayRequest) => readLastValidDerived(client,"features",request);
