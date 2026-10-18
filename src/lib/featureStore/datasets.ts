import type { Client } from "pg";
import { FEATURE_VERSION, LABEL_VERSION, HISTORY_POLICY, type CodeIdentity } from "./derived.ts";
import type { EvidenceMode } from "./asOf.ts";
import { objectKey, sha256, type ObjectStore } from "./objectStore.ts";

type Database = Pick<Client, "query">;
export type DatasetSpec = {
  mode: EvidenceMode;
  featureVersion: typeof FEATURE_VERSION;
  labelVersion: typeof LABEL_VERSION;
  historyPolicy: typeof HISTORY_POLICY;
  featuresAsOf: string;
  labelsAsOf: string;
  includeRetrospective: boolean;
  includeSuperseded: boolean;
};
export type DatasetRow = {
  featureId: string; labelId: string; playerId: string; gameId: string; season: number;
  cutoff: string; labelCutoff: string; sampleSize: number; history: { gameId: string; kickoff: string; yards: number }[];
  label: number; flags: string[];
};
type Selection = { rows: DatasetRow[]; snapshots: string[]; exclusions: Record<string, number>; valid: boolean };
type Access = { allowed: boolean; decisions: { profileId: string; decisionId: string | null }[]; checked_at: string };

// Logical reproducibility: natural keys + values and algorithm policy only.
// UUIDs, ingestion/knowledge clocks, rights receipts and stale flags belong to
// the exact-file hash, so re-materializing identical values retains this hash.
export const datasetContentSha256 = (spec: Pick<DatasetSpec,"mode"|"featureVersion"|"labelVersion"|"historyPolicy">, rows: DatasetRow[]) => {
  const canonical = rows.map(r => ({playerId:r.playerId,gameId:r.gameId,stat:"passing_yards",season:r.season,
    cutoff:new Date(r.cutoff).toISOString(),sampleSize:r.sampleSize,
    history:r.history.map(h=>({gameId:h.gameId,kickoff:new Date(h.kickoff).toISOString(),yards:h.yards})),label:r.label}))
    .sort((a,b)=>a.gameId<b.gameId?-1:a.gameId>b.gameId?1:a.playerId<b.playerId?-1:a.playerId>b.playerId?1:0);
  return sha256(Buffer.from(JSON.stringify({format:"qb-passing-yards-content-v1",mode:spec.mode,
    featureVersion:spec.featureVersion,labelVersion:spec.labelVersion,historyPolicy:spec.historyPolicy,rows:canonical})));
};

// One point-in-time join. Event-time no-look-ahead was already enforced by the
// trusted feature job; this does not reopen or revalidate normalized evidence.
export const DATASET_JOIN_SQL = `WITH clock AS MATERIALIZED(SELECT clock_timestamp() AS now),
f AS MATERIALIZED(
 SELECT *,row_number() OVER(PARTITION BY player_id,game_id,stat ORDER BY checkpoint DESC,computed_at DESC,feature_id DESC) AS head,
  row_number() OVER(PARTITION BY player_id,game_id,stat,state ORDER BY checkpoint DESC,computed_at DESC,feature_id DESC) AS valid_head
 FROM fs138.feature_values WHERE feature_version=$1 AND history_policy=$3 AND evidence_mode=$4
  AND computed_at<=$5::timestamptz AND checkpoint<=$5::timestamptz
), l AS MATERIALIZED(
 SELECT *,row_number() OVER(PARTITION BY player_id,game_id,stat ORDER BY label_cutoff DESC,known_at DESC,label_id DESC) AS head,
  row_number() OVER(PARTITION BY player_id,game_id,stat,state ORDER BY label_cutoff DESC,known_at DESC,label_id DESC) AS valid_head
 FROM fs138.outcome_labels WHERE label_version=$2 AND evidence_mode=$4
  AND known_at<=$6::timestamptz AND label_cutoff<=$6::timestamptz
) , fv AS MATERIALIZED(SELECT * FROM f WHERE state='usable' AND valid_head=1),
lv AS MATERIALIZED(SELECT * FROM l WHERE state='usable' AND valid_head=1),
keys AS MATERIALIZED(SELECT player_id,game_id,stat,season FROM f WHERE head=1),
selected AS MATERIALIZED(
 SELECT k.*,f.feature_id,l.label_id,f.cutoff,f.sample_size,f.history,l.label_cutoff,l.value,
  coalesce(f.flags,'{}')||coalesce(l.flags,'{}')||
   CASE WHEN f.feature_id IS NOT NULL AND EXISTS(SELECT 1 FROM fs138.feature_values n WHERE n.player_id=f.player_id AND n.game_id=f.game_id AND n.stat=f.stat AND n.feature_version=f.feature_version AND n.evidence_mode=f.evidence_mode AND (n.checkpoint,n.computed_at,n.feature_id)>(f.checkpoint,f.computed_at,f.feature_id)) THEN ARRAY['superseded-feature'] ELSE '{}'::text[] END||
   CASE WHEN l.label_id IS NOT NULL AND EXISTS(SELECT 1 FROM fs138.outcome_labels n WHERE n.player_id=l.player_id AND n.game_id=l.game_id AND n.stat=l.stat AND n.label_version=l.label_version AND n.evidence_mode=l.evidence_mode AND (n.label_cutoff,n.known_at,n.label_id)>(l.label_cutoff,l.known_at,l.label_id)) THEN ARRAY['superseded-label'] ELSE '{}'::text[] END||
   CASE WHEN f.head>1 THEN ARRAY['stale-feature'] ELSE '{}'::text[] END||CASE WHEN l.head>1 THEN ARRAY['stale-label'] ELSE '{}'::text[] END AS flags
 FROM keys k LEFT JOIN fv f USING(player_id,game_id,stat) LEFT JOIN lv l USING(player_id,game_id,stat)
), classified AS MATERIALIZED(
 SELECT *,CASE WHEN season=2021 THEN 'warm-up-only' WHEN feature_id IS NULL THEN 'feature-unavailable'
  WHEN label_id IS NULL THEN 'label-unavailable'
  WHEN NOT $7::boolean AND 'historical-availability-unverified'=ANY(flags) THEN 'retrospective-excluded'
  WHEN NOT $8::boolean AND flags&&ARRAY['superseded-feature','superseded-label','stale-feature','stale-label'] THEN 'superseded-excluded' END AS exclusion
 FROM selected
), inputs AS(
 SELECT i.snapshot_id FROM f JOIN fs138.feature_inputs i USING(feature_id)
 UNION SELECT i.snapshot_id FROM l JOIN fs138.label_inputs i USING(label_id)
)
SELECT coalesce((SELECT jsonb_agg(jsonb_build_object('featureId',feature_id,'labelId',label_id,'playerId',player_id,'gameId',game_id,
 'season',season,'cutoff',cutoff,'labelCutoff',label_cutoff,'sampleSize',sample_size,'history',history,'label',value,
 'flags',(SELECT coalesce(jsonb_agg(flag ORDER BY flag),'[]') FROM(SELECT DISTINCT unnest(flags) AS flag) x)) ORDER BY game_id,player_id)
 FROM classified WHERE exclusion IS NULL),'[]') AS rows,
 coalesce((SELECT array_agg(snapshot_id ORDER BY snapshot_id) FROM inputs),'{}') AS snapshots,
 coalesce((SELECT jsonb_object_agg(exclusion,n) FROM(SELECT exclusion,count(*)::integer AS n FROM classified WHERE exclusion IS NOT NULL GROUP BY exclusion) e),'{}') AS exclusions,
 $5::timestamptz<=now AND $6::timestamptz<=now AS valid FROM clock`;

const validate = (spec: DatasetSpec) => {
  const zoned = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::?\d{2})?)$/;
  if (spec.featureVersion !== FEATURE_VERSION || spec.labelVersion !== LABEL_VERSION || spec.historyPolicy !== HISTORY_POLICY ||
      !["strict-point-in-time-v1", "retrospective-reconstruction-v1"].includes(spec.mode) ||
      ![spec.featuresAsOf, spec.labelsAsOf].every(s => zoned.test(s) && Number.isFinite(Date.parse(s))) ||
      typeof spec.includeRetrospective !== "boolean" || typeof spec.includeSuperseded !== "boolean") throw new Error("dataset-spec-refused");
};

// Exactly one status/rights query at each boundary. Missing rights fail closed.
// The current valid-time decision is selected using the database knowledge clock.
const authorize = async (client: Database, snapshots: string[], datasetId: string | null): Promise<Access> => {
  const result = (await client.query<Access>(`WITH clock AS MATERIALIZED(SELECT clock_timestamp() AS now),
 wanted AS MATERIALIZED(SELECT DISTINCT unnest($1::uuid[]) AS snapshot_id),
 profiles AS(SELECT DISTINCT s.profile_id FROM wanted w JOIN fs138.source_snapshots s USING(snapshot_id)),
 decisions AS MATERIALIZED(
  SELECT p.profile_id,r.decision_id,r.allowed_uses FROM profiles p CROSS JOIN clock
  LEFT JOIN LATERAL(SELECT * FROM fs138.rights_decisions r WHERE r.profile_id=p.profile_id AND r.recorded_at<=now
   AND r.valid_from<=now AND (r.valid_until IS NULL OR r.valid_until>now) ORDER BY r.recorded_at DESC,r.decision_id DESC LIMIT 1) r ON true
 ) SELECT now::text AS checked_at,
  NOT EXISTS(SELECT 1 FROM wanted w LEFT JOIN fs138.source_snapshots s USING(snapshot_id) WHERE s.snapshot_id IS NULL OR s.deleted_at IS NOT NULL)
  AND NOT EXISTS(SELECT 1 FROM decisions WHERE decision_id IS NULL OR NOT('research'=ANY(allowed_uses)))
  AND ($2::uuid IS NULL OR EXISTS(SELECT 1 FROM fs138.dataset_manifests WHERE dataset_id=$2 AND invalidated_at IS NULL)) AS allowed,
  coalesce((SELECT jsonb_agg(jsonb_build_object('profileId',profile_id,'decisionId',decision_id) ORDER BY profile_id) FROM decisions),'[]') AS decisions
 FROM clock`, [snapshots, datasetId])).rows[0];
  if (!result.allowed) throw new Error("dataset-current-rights-or-status-refused");
  return result;
};

export const buildDataset = async (client: Database, store: ObjectStore, spec: DatasetSpec, code: CodeIdentity) => {
  const started = performance.now();
  validate(spec);
  const joinQuery = {text: DATASET_JOIN_SQL,
    values: [spec.featureVersion, spec.labelVersion, spec.historyPolicy, spec.mode, spec.featuresAsOf, spec.labelsAsOf, spec.includeRetrospective, spec.includeSuperseded],
    query_timeout: 25_000};
  const selection = (await client.query<Selection>(joinQuery)).rows[0];
  if (!selection.valid) throw new Error("dataset-future-clock-refused");
  const authorization = await authorize(client, selection.snapshots, null);
  const contentSha256 = datasetContentSha256(spec,selection.rows);
  const pinned = { contentSha256, format: "qb-passing-yards-dataset-v1", spec, code, snapshots: selection.snapshots,
    rights: authorization.decisions, exclusions: selection.exclusions, rows: selection.rows };
  const bytes = Buffer.from(JSON.stringify(pinned) + "\n");
  const key = objectKey("datasets", bytes);
  const inputSha256 = sha256(Buffer.from(JSON.stringify({spec, snapshots: selection.snapshots,
    members: selection.rows.map(r => [r.featureId,r.labelId]), code})));
  let datasetId: string;
  let inTransaction = false;
  try {
    await store.putIfAbsent(key,bytes);
    await client.query("BEGIN");
    inTransaction = true;
    await client.query("SET LOCAL statement_timeout='21s'");
    await client.query(`WITH guard AS MATERIALIZED(SELECT fs138.lock_active_snapshots($1::uuid[]) AS ok)
      SELECT fs138.lock_object_for_publication($2) FROM guard WHERE ok`,[selection.snapshots,key]);
    const object = await store.head(key);
    if (!object || object.sha256!==sha256(bytes) || object.byteSize!==bytes.byteLength)
      throw new Error("dataset-object-missing-or-mismatched");
    const publication = await client.query<{dataset_id:string}>(`WITH guard AS MATERIALIZED(SELECT fs138.lock_active_snapshots($1::uuid[]) AS ok),
     manifest AS(INSERT INTO fs138.dataset_manifests(code_sha,implementation_sha256,spec,input_sha256,file_sha256,object_key,byte_size,row_count,exclusions,rights_receipt,content_sha256)
      SELECT $2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$13 FROM guard WHERE ok RETURNING dataset_id),
     members AS(INSERT INTO fs138.dataset_members SELECT dataset_id,r."featureId",r."labelId" FROM manifest
      CROSS JOIN jsonb_to_recordset($12::jsonb) AS r("featureId" uuid,"labelId" uuid)),
     inputs AS(INSERT INTO fs138.dataset_inputs SELECT dataset_id,snapshot_id FROM manifest CROSS JOIN unnest($1::uuid[]) snapshot_id)
     SELECT dataset_id FROM manifest`, [selection.snapshots,code.gitSha,code.contentSha256,spec,inputSha256,
        sha256(bytes),key,bytes.byteLength,selection.rows.length,selection.exclusions,authorization,
        JSON.stringify(selection.rows.map(r => ({featureId:r.featureId,labelId:r.labelId}))),contentSha256]);
    datasetId = publication.rows[0].dataset_id;
    await client.query("COMMIT");
  } catch (error) {
    if (error instanceof Error && /Query read timeout|Connection terminated|Connection closed/.test(error.message))
      throw new Error("dataset-connection-interrupted-replace", {cause:error});
    if (inTransaction) await client.query("ROLLBACK");
    await client.query("SELECT fs138.requeue_removed_object($1)",[key]);
    // Immutable uncommitted bytes are discoverable through ObjectStore.list.
    throw error;
  }
  const delivery = await authorize(client, selection.snapshots, datasetId);
  return {datasetId, objectKey:key,fileSha256:sha256(bytes),contentSha256,inputSha256,byteSize:bytes.byteLength,
    rowCount:selection.rows.length,exclusions:selection.exclusions,authorization,delivery,elapsedMs:performance.now()-started,
    work:{statements:8,rightsQueries:2,pointInTimeJoins:1,perRowQueries:0,objectWrites:1,sourceByteReads:0}};
};

export const readDataset = async (client: Database, store: ObjectStore, datasetId: string) => {
  const manifest = (await client.query<{object_key:string;file_sha256:string;snapshots:string[]}>(`SELECT d.object_key,d.file_sha256,
   ARRAY(SELECT snapshot_id FROM fs138.dataset_inputs i WHERE i.dataset_id=d.dataset_id ORDER BY snapshot_id) AS snapshots
   FROM fs138.dataset_manifests d WHERE dataset_id=$1`,[datasetId])).rows[0];
  if (!manifest) throw new Error("dataset-missing");
  await authorize(client,manifest.snapshots,datasetId);
  const bytes = await store.get(manifest.object_key);
  await authorize(client,manifest.snapshots,datasetId);
  // Ingestion/build verified content; scheduled audits own storage-integrity
  // rehashing. No per-row or per-file source reconstruction on ordinary reads.
  return bytes;
};
