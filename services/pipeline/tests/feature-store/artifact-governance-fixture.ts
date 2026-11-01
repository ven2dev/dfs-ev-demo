import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { MODEL_VERSION } from "@dfs-ev/domain/baseline";
import { QB_EVALUATOR_VERSION, type QbEvidenceMode } from "@dfs-ev/domain/qb-evaluation";
import { datasetContentSha256, type DatasetRow, type DatasetSpec } from "../../src/featureStore/datasets.ts";
import { FEATURE_VERSION, LABEL_VERSION, HISTORY_POLICY } from "../../src/featureStore/derived.ts";
import { EMPIRICAL_ADAPTER } from "../../src/featureStore/empiricalAdapter.ts";
import { MODEL_PREREGISTRATION } from "../../src/featureStore/modelManifests.ts";
import { sha256, type ObjectStore } from "../../src/featureStore/objectStore.ts";
import type { Artifact, QbInputPins } from "../../src/featureStore/qbReports.ts";

type Database = Pick<Client, "query">;
export const governanceCode = { gitSha: "a".repeat(40), contentSha256: sha256(Buffer.from("#166 synthetic graph control")) };
export const governanceIdentity = { format: "qb-model-run-v1", designation: "uncalibrated-interim-hit-rate",
  modelVersion: MODEL_VERSION, featureVersion: FEATURE_VERSION, labelVersion: LABEL_VERSION,
  historyPolicy: HISTORY_POLICY, scoringPolicy: QB_EVALUATOR_VERSION, adapter: EMPIRICAL_ADAPTER,
  preregistration: MODEL_PREREGISTRATION, code: governanceCode };
export type GovernanceDataset = { datasetId: string; mode: QbEvidenceMode; spec: DatasetSpec;
  objectKey: string; fileSha256: string; byteSize: number; contentSha256: string; rowCount: number; sources: string[] };

// These controls qualify dependency/lock policy. Synthetic graph reports are
// labeled; only inputPins() produces envelopes consumed by the actual scorer.
export const governanceFixture = (writer: Database, store: ObjectStore) => {
  const persist = async (namespace: "raw" | "datasets" | "audits" | "models", value: unknown) => {
    const bytes = Buffer.from(JSON.stringify(value) + "\n"), digest = sha256(bytes);
    const artifact = { objectKey: `${namespace}/${digest}`, sha256: digest, byteSize: bytes.length };
    await store.putIfAbsent(artifact.objectKey, bytes); return artifact;
  };
  const source = async () => {
    const profile = `governance-${randomUUID()}`;
    await writer.query(`INSERT INTO fs138.source_profiles(profile_id,provider,feed,parser_version,license)
      VALUES($1,'synthetic','stats','test','{}')`, [profile]);
    await writer.query(`INSERT INTO fs138.rights_decisions(profile_id,allowed_uses,valid_from,rationale)
      VALUES($1,ARRAY['research'],clock_timestamp(),'synthetic #166 fixture')`, [profile]);
    const job = (await writer.query(`INSERT INTO fs138.job_runs(kind,code_sha,policy_sha256,input_set_sha256)
      VALUES('model',$1,$2,$3) RETURNING job_id`, [governanceCode.gitSha, governanceCode.contentSha256,
      sha256(Buffer.from(profile))])).rows[0].job_id as string;
    const artifact = await persist("raw", { profile });
    const snapshot = (await writer.query(`INSERT INTO fs138.source_snapshots(profile_id,job_id,sha256,byte_size,object_key,
      media_type,decoded_sha256,header_sha256,row_count,captured_at,available_at,evidence_basis)
      VALUES($1,$2,$3,$4,$5,'text/csv',$3,$3,0,'2020-01-01','2020-01-01','retrospective') RETURNING snapshot_id`,
    [profile, job, artifact.sha256, artifact.byteSize, artifact.objectKey])).rows[0].snapshot_id as string;
    return { profile, snapshot, job, artifact };
  };
  const example = async (input: Awaited<ReturnType<typeof source>>): Promise<DatasetRow> => {
    const playerId = randomUUID(), gameId = randomUUID();
    const history = [{ gameId: "h1", kickoff: "2021-01-01T00:00:00Z", yards: 100 },
      { gameId: "h2", kickoff: "2021-01-02T00:00:00Z", yards: 200 }];
    const featureId = (await writer.query(`INSERT INTO fs138.feature_values(job_id,player_id,game_id,stat,season,
      cutoff,checkpoint,feature_version,history_policy,evidence_mode,state,reasons,flags,sample_size,history,history_gaps)
      VALUES($1,$2,$3,'passing_yards',2022,'2022-01-01',clock_timestamp(),$4,$5,'strict-point-in-time-v1',
        'usable','{}','{}',2,$6,'[]') RETURNING feature_id`,
    [input.job, playerId, gameId, FEATURE_VERSION, HISTORY_POLICY, JSON.stringify(history)])).rows[0].feature_id as string;
    const labelId = (await writer.query(`INSERT INTO fs138.outcome_labels(job_id,player_id,game_id,stat,season,
      label_cutoff,label_version,evidence_mode,state,reasons,flags,value)
      VALUES($1,$2,$3,'passing_yards',2022,'2022-01-02',$4,'strict-point-in-time-v1','usable','{}','{}',250)
      RETURNING label_id`, [input.job, playerId, gameId, LABEL_VERSION])).rows[0].label_id as string;
    await writer.query("INSERT INTO fs138.feature_inputs VALUES($1,$2)", [featureId, input.snapshot]);
    await writer.query("INSERT INTO fs138.label_inputs VALUES($1,$2)", [labelId, input.snapshot]);
    await writer.query(`INSERT INTO fs138.norm_player_game_stats(snapshot_id,normalizer_version,job_id,player_id,
      game_id,team,passing_attempts,passing_yards,state,reasons) VALUES($1,'synthetic',$2,$3,$4,'T',30,250,'usable','{}')`,
    [input.snapshot, input.job, playerId, gameId]);
    return { featureId, labelId, playerId, gameId, season: 2022, cutoff: "2022-01-01T00:00:00Z",
      labelCutoff: "2022-01-02T00:00:00Z", sampleSize: 2, history, label: 250, flags: [] };
  };
  const dataset = async (sources: string[], mode: QbEvidenceMode = "strict-point-in-time-v1",
    rows: DatasetRow[] = []): Promise<GovernanceDataset> => {
    const spec: DatasetSpec = { mode, featureVersion: FEATURE_VERSION, labelVersion: LABEL_VERSION,
      historyPolicy: HISTORY_POLICY, featuresAsOf: new Date().toISOString(), labelsAsOf: new Date().toISOString(),
      includeRetrospective: mode === "retrospective-reconstruction-v1", includeSuperseded: true };
    const contentSha256 = datasetContentSha256(spec, rows);
    const artifact = await persist("datasets", { format: "qb-passing-yards-dataset-v1", code: governanceCode,
      spec, contentSha256, rows, fixtureId: randomUUID() });
    const datasetId = (await writer.query(`INSERT INTO fs138.dataset_manifests(code_sha,implementation_sha256,spec,input_sha256,
      file_sha256,object_key,byte_size,row_count,exclusions,rights_receipt,content_sha256)
      VALUES($1,$2,$3,$2,$4,$5,$6,$8,'{}','{}',$7) RETURNING dataset_id`,
    [governanceCode.gitSha, governanceCode.contentSha256, spec, artifact.sha256, artifact.objectKey,
      artifact.byteSize, contentSha256, rows.length])).rows[0].dataset_id as string;
    await writer.query("INSERT INTO fs138.dataset_inputs SELECT $1,unnest($2::uuid[])", [datasetId, sources]);
    await writer.query(`INSERT INTO fs138.dataset_members SELECT $1,r."featureId",r."labelId"
      FROM jsonb_to_recordset($2) r("featureId" uuid,"labelId" uuid)`, [datasetId, JSON.stringify(rows)]);
    return { datasetId, mode, spec, objectKey: artifact.objectKey, fileSha256: artifact.sha256,
      contentSha256, byteSize: artifact.byteSize, rowCount: rows.length, sources };
  };
  const report = (data: GovernanceDataset) => persist("audits", { syntheticGraphReport: true, datasetId: data.datasetId });
  const objects = async (datasets: GovernanceDataset[], reports?: Artifact[]) => {
    const files = reports ?? await Promise.all(datasets.map(report));
    const descriptor = await persist("models", { syntheticGraphDescriptor: true, id: randomUUID(), datasets, files });
    return [{ slot: "descriptor", datasetId: null, objectKey: descriptor.objectKey,
      fileSha256: descriptor.sha256, byteSize: descriptor.byteSize }, ...datasets.map((d, n) => ({ slot: d.mode,
      datasetId: d.datasetId, objectKey: files[n].objectKey, fileSha256: files[n].sha256, byteSize: files[n].byteSize }))];
  };
  const inputPins = async (datasets: GovernanceDataset[]) => {
    const pins: QbInputPins = { format: "qb-evaluation-input-pins-v1", rightsScope: "research",
      designation: "uncalibrated-interim-hit-rate", preregistration: { ...MODEL_PREREGISTRATION, approved: true },
      code: governanceCode, versions: { model: MODEL_VERSION, adapter: EMPIRICAL_ADAPTER,
        feature: FEATURE_VERSION, label: LABEL_VERSION, history: HISTORY_POLICY }, populationDiagnostics: [],
      populationArtifact: await persist("audits", { format: "qb-evaluation-observed-stats-v1", rows: [] }), modes: [] };
    for (const d of datasets) pins.modes.push({ mode: d.mode, spec: d.spec, dataset: d,
      coverageArtifact: await persist("audits", { format: "qb-evaluation-coverage-v1", mode: d.mode, rows: [] }) });
    return persist("audits", pins);
  };
  return { source, example, dataset, report, objects, inputPins, persist };
};

// Actual 2,504-row controls without 12,520 fixture INSERT round trips. These
// synthetic values prove work independence, not retained-report provenance.
export const governanceExamples = async (writer: Database, input: { job: string; snapshot: string }, count: number): Promise<DatasetRow[]> => {
  const prefix = randomUUID();
  const result = await writer.query(`WITH f AS (
    INSERT INTO fs138.feature_values(job_id,player_id,game_id,stat,season,cutoff,checkpoint,feature_version,
      history_policy,evidence_mode,state,reasons,flags,sample_size,history,history_gaps)
    SELECT $1,$3||n,$3||n,'passing_yards',2022,'2022-01-01',clock_timestamp(),$4,$5,
      'retrospective-reconstruction-v1','usable','{}',ARRAY['historical-availability-unverified'],2,
      '[{"gameId":"h1","kickoff":"2021-01-01T00:00:00Z","yards":100},{"gameId":"h2","kickoff":"2021-01-02T00:00:00Z","yards":200}]','[]'
    FROM generate_series(1,$6::integer) n RETURNING *
  ), l AS (
    INSERT INTO fs138.outcome_labels(job_id,player_id,game_id,stat,season,label_cutoff,label_version,
      evidence_mode,state,reasons,flags,value)
    SELECT $1,player_id,game_id,'passing_yards',2022,'2022-01-02',$7,'retrospective-reconstruction-v1',
      'usable','{}',ARRAY['historical-availability-unverified'],250 FROM f RETURNING *
  ), fi AS (INSERT INTO fs138.feature_inputs SELECT feature_id,$2 FROM f),
  li AS (INSERT INTO fs138.label_inputs SELECT label_id,$2 FROM l)
  SELECT f.feature_id AS "featureId",l.label_id AS "labelId",f.player_id AS "playerId",f.game_id AS "gameId",
    f.season,f.cutoff,f.sample_size AS "sampleSize",f.history,l.label_cutoff AS "labelCutoff",l.value AS label,f.flags
  FROM f JOIN l USING(player_id) ORDER BY f.game_id`,
  [input.job, input.snapshot, prefix, FEATURE_VERSION, HISTORY_POLICY, count, LABEL_VERSION]);
  return result.rows.map(row => ({ ...row, cutoff: row.cutoff.toISOString(), labelCutoff: row.labelCutoff.toISOString() }));
};
