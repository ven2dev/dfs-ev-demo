import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import type { Client } from "pg";
import { assertFeatureStoreReplayTarget } from "./harness.ts";
import { sha256 } from "../../src/featureStore/objectStore.ts";

const repository = new URL("../../../../", import.meta.url);
const graphRoot = "services/pipeline/tests/feature-store/fixtures/job-visibility-work-v1";
const archive = "docs/evidence/feature-store-241/step-3-resumed-full-records-20261107T225754Z.tar.gz";
const pins: Readonly<Record<string, string>> = {
  [graphRoot + ".json.gz"]: "eff4457e5f5064634d2cee03e70d1d17ccfb97303362f15caa3fba14520af8fe",
  [graphRoot + ".manifest.json"]: "3d7763a4645ca3c55b2159016dd2eab72123e420db778a9e4eeda7a8d30779cc",
  [archive]: "4f9f27537817b644ccb6321c60a2e6c3bac49072964b01ff5996255af13d595c",
};
const members = {
  "step-3-resumed/standard-20261107T225550Z-work.json": "e0905f690dea9033e681cd3dabd6c5e6caf866253e720e70b17d4e98c33240e0",
  "step-3-resumed/opt-in-20261107T224935Z-full-plan.json": "0e06f0a22830c98989ab1aac7f2a8077e4c637afed2eed515f4e5b88d9c5492c",
};

type Row = Record<string, unknown>;
const restored = [
  { table: "source_profiles", id: "profile_id", trigger: "profile_clock", clocks: ["recorded_at"] },
  { table: "job_runs", id: "job_id", trigger: "job_clock", clocks: ["recorded_at", "finished_at"] },
  { table: "source_snapshots", id: "snapshot_id", trigger: "snapshot_clock", clocks: ["captured_at", "available_at", "ingested_at"] },
] as const;
const normalizedTables = ["norm_schedule", "norm_identity", "norm_player_game_stats", "norm_participation"] as const;
type Records = Record<typeof restored[number]["table"] | typeof normalizedTables[number] |
  "feature_values" | "outcome_labels" | "job_inputs" | "feature_inputs" | "label_inputs", Row[]>;

export const readReplayBaseline = async () => {
  const checked = async (path: string) => {
    const bytes = await readFile(new URL(path, repository));
    if (sha256(bytes) !== pins[path]) throw new Error(`replay-baseline-hash-mismatch: ${path}`);
    return bytes;
  };
  const packed = await checked(archive);
  for (const [member, digest] of Object.entries(members)) {
    const bytes = execFileSync("tar", ["-xOzf", "-", member], { input: packed, maxBuffer: 16 * 1024 ** 2 });
    if (sha256(bytes) !== digest) throw new Error(`replay-baseline-hash-mismatch: ${member}`);
  }
  const manifest = JSON.parse((await checked(graphRoot + ".manifest.json")).toString()) as {
    payload: { sha256: string; byteSize: number };
  };
  const compressed = await checked(graphRoot + ".json.gz");
  // One output allocation, with a spare byte so zlib does not allocate a
  // second full-size chunk at the exact output boundary.
  const graph = gunzipSync(compressed, {
    maxOutputLength: manifest.payload.byteSize, chunkSize: manifest.payload.byteSize + 1,
  });
  let records: Records;
  try {
    if (graph.byteLength !== manifest.payload.byteSize || sha256(graph) !== manifest.payload.sha256) {
      throw new Error("replay-baseline-graph-mismatch");
    }
    ({ records } = JSON.parse(graph.toString()) as { records: Records });
  } finally {
    if (graph.buffer instanceof ArrayBuffer) graph.buffer.transfer(0);
    if (compressed.buffer instanceof ArrayBuffer) compressed.buffer.transfer(0);
  }
  return { records, baselineHashes: { ...pins, ...members, inflatedGraph: manifest.payload.sha256 },
    memoryAfterBaseline: process.memoryUsage() };
};

export const restoreReplayMetadata = async (admin: Pick<Client, "query">, records: Records) => {
  // This assertion binds the active, checked scratch registration to its admin client.
  assertFeatureStoreReplayTarget(admin);
  const owners = new Set(records.source_snapshots.map(({ job_id }) => job_id));
  for (const table of normalizedTables) for (const { job_id } of records[table]) owners.add(job_id);
  const inputJobs = records.job_runs.filter(({ job_id }) => owners.has(job_id));
  if (inputJobs.length !== owners.size || inputJobs.some(({ status, finished_at }) => status !== "succeeded" || !finished_at)) {
    throw new Error("replay-baseline-owner-mismatch");
  }
  const rows = { source_profiles: records.source_profiles, job_runs: inputJobs, source_snapshots: records.source_snapshots };
  const triggerEnabled = async ({ table, trigger }: typeof restored[number]) => {
    const { rows: [result] } = await admin.query<{ enabled: boolean }>(
      "SELECT tgenabled='O' AS enabled FROM pg_trigger WHERE tgrelid=$1::regclass AND tgname=$2", [`fs138.${table}`, trigger],
    );
    if (!result?.enabled) throw new Error(`replay-clock-trigger-state: ${trigger}`);
  };
  const start = (await admin.query<{ at: string }>("SELECT clock_timestamp()::text AS at")).rows[0].at;
  await admin.query("BEGIN");
  try {
    for (const target of restored) {
      const { table, trigger } = target;
      await triggerEnabled(target);
      await admin.query(`ALTER TABLE fs138.${table} DISABLE TRIGGER ${trigger}`);
      await admin.query(`INSERT INTO fs138.${table} SELECT * FROM jsonb_populate_recordset(NULL::fs138.${table},$1)`,
        [JSON.stringify(rows[table])]);
      await admin.query(`ALTER TABLE fs138.${table} ENABLE TRIGGER ${trigger}`);
    }
    await admin.query("COMMIT");
  } catch (error) {
    await admin.query("ROLLBACK");
    throw error;
  }
  for (const target of restored) {
    const { table, id, clocks } = target;
    await triggerEnabled(target);
    const matches = clocks.map((field) => `actual.${field} IS NOT DISTINCT FROM expected.${field}`).join(" AND ");
    const { rows: [result] } = await admin.query<{ n: number }>(`
      SELECT count(*)::int AS n FROM jsonb_populate_recordset(NULL::fs138.${table},$1) expected
      JOIN fs138.${table} actual USING (${id}) WHERE ${matches}`, [JSON.stringify(rows[table])]);
    if (result.n !== rows[table].length) throw new Error(`replay-restored-clock-mismatch: ${table}`);
  }
  const end = (await admin.query<{ at: string }>("SELECT clock_timestamp()::text AS at")).rows[0].at;
  return { restoreStartedAt: start, restoreCheckedAt: end, profiles: rows.source_profiles.length,
    inputJobs: inputJobs.length, snapshots: rows.source_snapshots.length };
};
