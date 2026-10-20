import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { promisify } from "node:util";
import type { Client } from "pg";
import { MODEL_VERSION } from "@dfs-ev/domain/baseline";
import { buildDataset, readDataset, type DatasetRow, type DatasetSpec } from "../../src/featureStore/datasets.ts";
import { FEATURE_VERSION, LABEL_VERSION, HISTORY_POLICY, runDerivedJob, type CodeIdentity } from "../../src/featureStore/derived.ts";
import { EMPIRICAL_ADAPTER } from "../../src/featureStore/empiricalAdapter.ts";
import { ingestSource } from "../../src/featureStore/ingest.ts";
import { openLocalObjectStore } from "../../src/featureStore/localObjectStore.ts";
import { objectKey, sha256, type ObjectStore } from "../../src/featureStore/objectStore.ts";
import { NORMALIZER_VERSION } from "../../src/featureStore/source.ts";
import type { SourceAsset } from "../../src/featureStore/source.ts";

export const EVALUATION_ROOT = new URL("../../../../", import.meta.url);
export const EXPECTED_COHORT = { examples: 2504,
  contentSha256: "a4de10aaefec7ec33d1c913fc255ee3527108f9d1f53e22afb79b82a9f9c607d" } as const;
export const PREREGISTRATION = { commit: "6aa7953", path: "docs/feature-store-spike-preregistration.md",
  sha256: "dc6bf2e044bcbdd6de4b1d6f91db9c623f630ad1eaf7bf1b8abdfe1f3c05c97d" } as const;
export const EVALUATION_MODES = ["retrospective-reconstruction-v1", "strict-point-in-time-v1"] as const;

type FixtureDatabase = { admin: Client; writer: Client; reader: Client; queryCounts: { writer: number; reader: number } };
export type PinnedDataset = { contentSha256: string; spec: DatasetSpec; exclusions: Record<string, number>; rows: DatasetRow[] };
export type CoverageRow = { player_id: string; game_id: string; season: number; cutoff: string;
  sample_size: number; feature_state: string; feature_reasons: string[]; history_gaps: { gameId: string; reasons: string[] }[];
  label_state: string | null; label_reasons: string[]; flags: string[]; zero_attempts: boolean | null };
const persist = async (store: ObjectStore, value: unknown) => {
  const bytes = Buffer.from(JSON.stringify(value) + "\n");
  const key = objectKey("audits", bytes);
  await store.putIfAbsent(key, bytes);
  return { objectKey: key, sha256: sha256(bytes), byteSize: bytes.byteLength };
};

// Actual file hashes identify uncommitted implementation bytes as well as HEAD.
// The experiment never treats a base commit alone as the implementation identity.
export const evaluationCodeIdentity = async () => {
  const sourceDirectory = "services/pipeline/src/featureStore/";
  const files = [
    ...await readdir(new URL(sourceDirectory, EVALUATION_ROOT)).then(names => names.filter(n => n.endsWith(".ts")).map(n => sourceDirectory + n)),
    "services/pipeline/scripts/feature-store/evaluation-fixture.ts", "services/pipeline/scripts/feature-store/evaluation-prepare.ts",
    "services/pipeline/scripts/feature-store/harness.ts",
    "services/pipeline/scripts/feature-store/evaluation-report.ts", "services/pipeline/scripts/feature-store/evaluation-run.ts",
    "packages/domain/src/projection/qb-evaluation.ts", "packages/domain/src/projection/evaluation.ts", "packages/db/proposals/138_feature_store.sql",
    "packages/db/proposals/138_dataset_governance.sql", "packages/db/proposals/163_effective_rights.sql",
    "packages/domain/src/projection/empirical.ts", "packages/domain/src/projection/baseline.ts", "packages/domain/package.json",
    "services/pipeline/package.json", "package-lock.json",
  ].sort();
  const codeHashes = Object.fromEntries(await Promise.all(files.map(async file =>
    [file, sha256(await readFile(new URL(file, EVALUATION_ROOT)))])));
  const gitSha = (await promisify(execFile)("git", ["rev-parse", "HEAD"], { cwd: EVALUATION_ROOT })).stdout.trim();
  return { code: { gitSha, contentSha256: sha256(Buffer.from(JSON.stringify(codeHashes))) }, codeHashes };
};

export const verifyPreregistration = async () => {
  const current = await readFile(new URL(PREREGISTRATION.path, EVALUATION_ROOT));
  const committed = (await promisify(execFile)("git", ["show", `${PREREGISTRATION.commit}:${PREREGISTRATION.path}`],
    { cwd: EVALUATION_ROOT, encoding: "buffer" })).stdout;
  assert.equal(sha256(current), PREREGISTRATION.sha256, "preregistration-current-document-mismatch");
  assert.equal(sha256(committed), PREREGISTRATION.sha256, "preregistration-committed-document-mismatch");
  const commit = (await promisify(execFile)("git", ["rev-parse", PREREGISTRATION.commit], { cwd: EVALUATION_ROOT })).stdout.trim();
  return { ...PREREGISTRATION, commit, approved: true };
};

// Setup only: one bulk ingestion per exact file and one materialization per
// season/kind/mode. Evaluation later consumes the pinned file, never this raw path.
export const prepareEvaluationFixture = async (
  database: FixtureDatabase, store: ObjectStore, code: CodeIdentity,
  progress: (event: Record<string, unknown>) => void = () => {},
) => {
  const preregistration = await verifyPreregistration();
  const manifestBytes = await readFile(new URL("docs/evidence/feature-store-138/step-3-source-manifest.json", EVALUATION_ROOT));
  const manifest = JSON.parse(manifestBytes.toString()) as { assets: { asset: SourceAsset }[] };
  const previous = JSON.parse(await readFile(new URL("docs/evidence/feature-store-138/step-3-real-ingestion.json", EVALUATION_ROOT), "utf8")) as {
    storageRoot: string; results: { name: string; objectKey: string; wireSha256: string }[] };
  assert.equal(manifest.assets.length, 16);
  assert.equal(new Set(manifest.assets.map(({ asset }) => asset.name)).size, 16);
  const originals = await openLocalObjectStore(previous.storageRoot);
  const inputs = [];
  for (const { asset } of manifest.assets) {
    const prior = previous.results.find(r => r.name === asset.name);
    assert(prior, `pinned-source-missing:${asset.name}`);
    const bytes = await originals.get(prior.objectKey);
    assert.equal(sha256(bytes), prior.wireSha256, `pinned-wire-mismatch:${asset.name}`);
    assert.equal(bytes.byteLength, asset.wire_bytes);
    const result = await ingestSource(database.writer, store, asset, code,
      { download: async () => ({ bytes, capturedAt: new Date().toISOString(), requests: 0 }) });
    assert.equal(result.status, "ingested");
    inputs.push({ name: asset.name, expectedWireSha256: prior.wireSha256, ...result });
    progress({ stage: "ingest", name: asset.name, rows: result.normalizedRows });
  }
  const clock = async () => (await database.admin.query<{ clock: string }>("SELECT clock_timestamp()::text AS clock")).rows[0].clock;
  const ingestionCheckpoint = await clock();
  await database.writer.query(`INSERT INTO fs138.rights_decisions(profile_id,allowed_uses,valid_from,rationale)
    SELECT profile_id,ARRAY['research'],clock_timestamp(),'owner-approved #164 local research; no serving clearance'
    FROM fs138.source_profiles`);
  const observedStats = (await database.reader.query<{ player_id: string; game_id: string; season: number;
    zero_attempts: boolean | null; roster_join_missing: boolean }>(`WITH stats AS MATERIALIZED (
    SELECT DISTINCT ON(n.player_id,n.game_id) n.* FROM fs138.norm_player_game_stats n
    JOIN fs138.source_snapshots s USING(snapshot_id) WHERE s.deleted_at IS NULL AND s.ingested_at<=$1
      AND n.normalizer_version=$2 ORDER BY n.player_id,n.game_id,s.available_at DESC,s.ingested_at DESC,n.snapshot_id
   ) SELECT n.player_id,n.game_id,substring(n.game_id from '^([0-9]{4})_')::integer AS season,
    CASE WHEN n.state='usable' THEN n.passing_attempts=0 END AS zero_attempts,
    NOT EXISTS(SELECT 1 FROM fs138.norm_identity i JOIN fs138.norm_schedule g
      ON g.season=i.season AND g.week=i.week AND i.team IN(g.home_team,g.away_team)
      WHERE i.player_id=n.player_id AND g.game_id=n.game_id AND i.team=n.team
       AND i.normalizer_version=$2 AND g.normalizer_version=$2) AS roster_join_missing FROM stats n
    ORDER BY season,n.game_id,n.player_id`,[ingestionCheckpoint,NORMALIZER_VERSION])).rows;
  const observedByKey = new Map(observedStats.map(row => [JSON.stringify([row.player_id,row.game_id]),row]));
  const rosterGaps = (await database.reader.query<{season:number;unmatched:number}>(`SELECT i.season,count(*)::integer AS unmatched
    FROM fs138.norm_identity i WHERE i.normalizer_version=$1 AND NOT EXISTS(
     SELECT 1 FROM fs138.norm_schedule g WHERE g.normalizer_version=$1 AND g.season=i.season AND g.week=i.week
      AND i.team IN(g.home_team,g.away_team)) GROUP BY i.season ORDER BY i.season`,[NORMALIZER_VERSION])).rows;
  const populationDiagnostics = [2021,2022,2023,2024,2025].map(season => {
    const rows=observedStats.filter(r=>r.season===season);
    return {season,observedQbStats:rows.length,statsWithoutMatchingRoster:rows.filter(r=>r.roster_join_missing).length,
      rosterRowsWithoutScheduledGame:rosterGaps.find(r=>r.season===season)?.unmatched??0,
      zeroAttempts:rows.filter(r=>r.zero_attempts===true).length,unknownAttempts:rows.filter(r=>r.zero_attempts===null).length};
  });
  const populationArtifact = await persist(store,{format:"qb-evaluation-observed-stats-v1",rows:observedStats});
  const prepared = [];
  for (const mode of EVALUATION_MODES) {
    const jobs = [];
    for (const season of [2021, 2022, 2023, 2024, 2025]) for (const kind of ["features", "labels"] as const) {
      const result = await runDerivedJob(database.writer, kind, { season, mode, checkpoint: ingestionCheckpoint }, code);
      assert.equal(result.status, "succeeded");
      jobs.push({ season, kind, ...result });
      progress({ stage: "derive", mode, season, kind, counts: result.counts });
    }
    const publishedAsOf = await clock();
    const spec: DatasetSpec = { mode, featureVersion: FEATURE_VERSION, labelVersion: LABEL_VERSION, historyPolicy: HISTORY_POLICY,
      featuresAsOf: publishedAsOf, labelsAsOf: publishedAsOf, includeRetrospective: mode === "retrospective-reconstruction-v1", includeSuperseded: true };
    const beforeBuild = database.queryCounts.writer;
    const dataset = await buildDataset(database.writer, store, spec, code);
    assert.equal(database.queryCounts.writer - beforeBuild, 8);
    const beforeRead = database.queryCounts.reader;
    const readSql: string[] = [], readKeys: string[] = [];
    const measuredReader = new Proxy(database.reader, { get(target, property) {
      if (property !== "query") return Reflect.get(target, property, target);
      return (...args: unknown[]) => {
        const query = args[0];
        readSql.push(typeof query === "string" ? query : (query as { text: string }).text);
        return Reflect.apply(target.query, target, args);
      };
    } });
    const measuredStore = { ...store, get: async (key: string) => { readKeys.push(key); return store.get(key); } };
    const bytes = await readDataset(measuredReader, measuredStore, dataset.datasetId);
    assert.equal(database.queryCounts.reader - beforeRead, 3);
    assert.equal(readSql.length, 3);
    assert.equal(readSql.filter(sql => sql.includes("fs138.effective_rights(")).length, 2);
    assert(!readSql.some(sql => /fs138\.(norm_|normalized_evidence)/.test(sql)), "raw-reconstruction-during-cohort-read");
    assert.deepEqual(readKeys, [dataset.objectKey]);
    const readWork = { statements: readSql.length, rightsChecks: 2, objectReads: readKeys.length,
      perExampleQueries: 0, rawSourceReads: 0 };
    assert.equal(sha256(bytes), dataset.fileSha256);
    const content = JSON.parse(bytes.toString()) as PinnedDataset;
    assert.equal(content.contentSha256, dataset.contentSha256);
    const seen = new Set<string>();
    for (const row of content.rows) {
      const identity = JSON.stringify([row.playerId, row.gameId, HISTORY_POLICY]);
      assert(!seen.has(identity), "duplicate-player-game-policy"); seen.add(identity);
      assert(row.season >= 2022 && row.season <= 2025, "warmup-or-outside-evaluation");
      assert.equal(row.sampleSize, row.history.length);
      assert(row.sampleSize >= 2 && row.sampleSize <= 16);
      assert(row.history.every(h => h.gameId !== row.gameId && Date.parse(h.kickoff) < Date.parse(row.cutoff)), "event-time-leak");
      assert.equal(new Set(row.history.map(h => h.gameId)).size, row.history.length);
      assert.equal(Date.parse(row.labelCutoff), Date.parse(ingestionCheckpoint));
      assert(row.history.every(h => Number.isSafeInteger(h.yards)) && Number.isSafeInteger(row.label));
      if (mode === "retrospective-reconstruction-v1") assert(row.flags.includes("historical-availability-unverified"));
    }
    if (mode === "retrospective-reconstruction-v1") {
      assert.equal(dataset.rowCount, EXPECTED_COHORT.examples, "cohort-example-count-mismatch");
      assert.equal(dataset.contentSha256, EXPECTED_COHORT.contentSha256, "cohort-natural-content-mismatch");
    }
    const coverage = (await database.reader.query<CoverageRow>(`SELECT f.player_id,f.game_id,f.season,f.cutoff::text,f.sample_size,
      f.state AS feature_state,f.reasons AS feature_reasons,f.history_gaps,l.state AS label_state,
      coalesce(l.reasons,'{}') AS label_reasons,f.flags||coalesce(l.flags,'{}') AS flags
      FROM fs138.feature_values f LEFT JOIN fs138.outcome_labels l
        ON (l.player_id,l.game_id,l.evidence_mode,l.label_version)=(f.player_id,f.game_id,f.evidence_mode,$2)
      WHERE f.evidence_mode=$1 AND f.feature_version=$3 AND f.history_policy=$4 ORDER BY f.season,f.game_id,f.player_id`,
    [mode, LABEL_VERSION, FEATURE_VERSION, HISTORY_POLICY])).rows.map(row => ({...row,
      zero_attempts: observedByKey.get(JSON.stringify([row.player_id,row.game_id]))?.zero_attempts ?? null}));
    const coverageArtifact = await persist(store, { format: "qb-evaluation-coverage-v1", mode, rows: coverage });
    const coverageSummary = [2021, 2022, 2023, 2024, 2025].map(season => {
      const rows = coverage.filter(r => r.season === season);
      return { season, candidates: rows.length, usableFeatures: rows.filter(r => r.feature_state === "usable").length,
        usableLabels: rows.filter(r => r.label_state === "usable").length,
        selected: content.rows.filter(r => r.season === season).length,
        strata: Object.fromEntries([[2, 4], [5, 8], [9, 16]].map(([lo, hi]) =>
          [`${lo}-${hi}`, content.rows.filter(r => r.season === season && r.sampleSize >= lo && r.sampleSize <= hi).length])) };
    });
    prepared.push({ mode, spec, dataset, content, coverage, coverageArtifact, coverageSummary, jobs, readWork });
    progress({ stage: "pinned-dataset", mode, examples: dataset.rowCount, contentSha256: dataset.contentSha256 });
  }
  const snapshots = (await database.reader.query(`SELECT snapshot_id,profile_id,sha256,object_key,
    available_at::text,captured_at::text,ingested_at::text,evidence_basis FROM fs138.source_snapshots ORDER BY profile_id`)).rows;
  const pins = { format: "qb-evaluation-input-pins-v1", preregistration, code, ingestionCheckpoint,
    versions: { model: MODEL_VERSION, adapter: EMPIRICAL_ADAPTER, feature: FEATURE_VERSION, label: LABEL_VERSION, history: HISTORY_POLICY },
    sourceManifestSha256: sha256(manifestBytes), inputs, snapshots, populationDiagnostics, populationArtifact,
    modes: prepared.map(({ mode, dataset, spec, coverageArtifact, readWork }) => ({ mode, dataset, spec, coverageArtifact, readWork })),
    rightsScope: "research", designation: "uncalibrated-interim-hit-rate", scoringRun: false };
  const inputPinsArtifact = await persist(store, pins);
  return { pins, inputPinsArtifact, prepared };
};
