import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import type { Client } from "pg";
import { sha256 } from "../../src/featureStore/objectStore.ts";
import { FEATURE_VERSION, LABEL_VERSION, HISTORY_POLICY } from "../../src/featureStore/derived.ts";
import type { DatasetSpec } from "../../src/featureStore/datasets.ts";

// Exact relational graph, independent of raw-object caches, network or local
// paths. All inserts/terminal updates use the ordinary trusted-writer triggers;
// captured knowledge clocks are never restored as proof of current eligibility.
const tables = ["source_profiles", "job_runs", "source_snapshots", "job_inputs", "norm_schedule",
  "norm_player_game_stats", "norm_identity", "norm_participation", "feature_values", "outcome_labels", "feature_inputs", "label_inputs"] as const;
type Fixture = { records: Record<typeof tables[number], Record<string, unknown>[]> };
type Database = { writer: Client; admin: Client };
export const loadJobVisibilityWorkFixture = async ({ writer, admin }: Database,
  profile: "full" | "producer-ci" | "dataset-ci" = "full") => {
  const manifest = JSON.parse(await readFile(new URL("./fixtures/job-visibility-work-v1.manifest.json", import.meta.url), "utf8"));
  const gzip = await readFile(new URL("./fixtures/job-visibility-work-v1.json.gz", import.meta.url));
  assert.equal(sha256(gzip), manifest.payload.gzipSha256, "work-fixture-compressed-hash");
  const bytes = gunzipSync(gzip); assert.equal(sha256(bytes), manifest.payload.sha256, "work-fixture-hash");
  assert.equal(bytes.length, manifest.payload.byteSize);
  const fixture = JSON.parse(bytes.toString()) as Fixture;
  for (const table of tables) assert.equal(fixture.records[table].length, manifest.counts[table], "work-fixture-count:" + table);
  // Hash the full pinned payload first. Standard CI provisions only the graph
  // its query needs, reducing WAL without changing SQL, ceilings or producers.
  const slice = JSON.parse(await readFile(new URL("./fixtures/job-visibility-ci-slice-v1.json", import.meta.url), "utf8"));
  if (profile === "producer-ci") {
    for (const table of ["feature_values", "outcome_labels", "feature_inputs", "label_inputs"] as const) fixture.records[table] = [];
  } else if (profile === "dataset-ci") {
    for (const table of ["norm_schedule", "norm_player_game_stats", "norm_identity", "norm_participation"] as const) fixture.records[table] = [];
    fixture.records.feature_values = fixture.records.feature_values.filter(row => row.season === slice.season);
    fixture.records.outcome_labels = fixture.records.outcome_labels.filter(row => row.season === slice.season);
    const features = new Set(fixture.records.feature_values.map(row => row.feature_id));
    const labels = new Set(fixture.records.outcome_labels.map(row => row.label_id));
    fixture.records.feature_inputs = fixture.records.feature_inputs.filter(row => features.has(row.feature_id));
    fixture.records.label_inputs = fixture.records.label_inputs.filter(row => labels.has(row.label_id));
  }
  const provisionedCounts = Object.fromEntries(tables.map(table => [table, fixture.records[table].length]));
  const provisionedManifest = { ...manifest, profile, counts: provisionedCounts,
    ...(profile === "dataset-ci" ? { modes: slice.modes, naturalKeys: slice.naturalKeys, season: slice.season } : {}) };
  const insert = async (table: typeof tables[number], rows: Record<string, unknown>[]) => {
    if (rows.length) await writer.query(`INSERT INTO fs138.${table} SELECT * FROM jsonb_populate_recordset(NULL::fs138.${table},$1)`, [JSON.stringify(rows)]);
  };
  await insert("source_profiles", fixture.records.source_profiles);
  const featureJobs = new Map(fixture.records.feature_values.map(row => [row.feature_id, row.job_id]));
  const labelJobs = new Map(fixture.records.outcome_labels.map(row => [row.label_id, row.job_id]));
  const outputs = tables.filter(table => table !== "source_profiles" && table !== "job_runs");
  const grouped = new Map(outputs.map(table => {
    const byJob = new Map<unknown, Record<string, unknown>[]>();
    for (const row of fixture.records[table]) {
      const id = table === "feature_inputs" ? featureJobs.get(row.feature_id)
        : table === "label_inputs" ? labelJobs.get(row.label_id) : row.job_id;
      assert(id, "work-fixture-output-owner:" + table);
      const rows = byJob.get(id) ?? []; rows.push(row); byJob.set(id, rows);
    }
    return [table, byJob] as const;
  }));
  const jobs = [...fixture.records.job_runs].sort((a, b) => Date.parse(String(a.recorded_at)) - Date.parse(String(b.recorded_at)));
  for (const job of jobs) {
    assert.equal(job.status, "succeeded", "pinned fixture has completed producers only");
    // Match real producer ownership: start one job outside its publication
    // transaction, insert its outputs, ANALYZE, finish, COMMIT. This preserves
    // lifecycle semantics, rather than manipulating layout to meet a ceiling.
    await insert("job_runs", [{ ...job, status: "running", counts: {}, finished_at: null, error_code: null }]);
    await writer.query("BEGIN");
    try {
      for (const table of outputs) await insert(table, grouped.get(table)!.get(job.job_id) ?? []);
      const analyzed = job.kind === "ingest"
        ? ["source_snapshots", "job_runs", ...outputs.filter(table => table.startsWith("norm_") && grouped.get(table)!.has(job.job_id))]
        : ["job_runs", "source_snapshots", "norm_schedule", "norm_player_game_stats", "norm_identity", "norm_participation", "feature_values", "outcome_labels", "feature_inputs", "label_inputs"];
      await writer.query("ANALYZE " + analyzed.map(table => "fs138." + table).join(","));
      await writer.query("UPDATE fs138.job_runs SET status='succeeded',counts=$2 WHERE job_id=$1", [job.job_id, job.counts]);
      await writer.query("COMMIT");
    } catch (error) { await writer.query("ROLLBACK"); throw error; }
  }
  for (const table of tables) assert.equal((await admin.query(`SELECT count(*)::integer AS n FROM fs138.${table}`)).rows[0].n, provisionedCounts[table]);
  assert.equal(manifest.counts.source_snapshots, 16);
  await writer.query("ANALYZE fs138.job_runs,fs138.source_snapshots,fs138.norm_schedule,fs138.norm_player_game_stats,fs138.norm_identity,fs138.norm_participation,fs138.feature_values,fs138.outcome_labels,fs138.feature_inputs,fs138.label_inputs");
  const at = (await admin.query("SELECT clock_timestamp()::text AS at")).rows[0].at as string;
  const spec: DatasetSpec = { mode: "retrospective-reconstruction-v1", featureVersion: FEATURE_VERSION,
    labelVersion: LABEL_VERSION, historyPolicy: HISTORY_POLICY, featuresAsOf: at, labelsAsOf: at,
    includeRetrospective: true, includeSuperseded: true };
  return { manifest: provisionedManifest, spec, counts: provisionedCounts };
};
