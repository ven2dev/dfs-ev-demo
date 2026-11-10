import type { Client } from "pg";
import { assertFeatureStoreReplayTarget } from "./harness.ts";
import { canonicalReplayTimestamp } from "./replay-normalized.ts";
import type { readReplayBaseline } from "./replay-restore.ts";
import { FEATURE_VERSION, HISTORY_POLICY, LABEL_VERSION, runDerivedJob, type CodeIdentity, type DerivedRequest } from "../../src/featureStore/derived.ts";
import { sha256 } from "../../src/featureStore/objectStore.ts";
import { NORMALIZER_VERSION } from "../../src/featureStore/source.ts";

type Records = Awaited<ReturnType<typeof readReplayBaseline>>["records"];
type Row = Record<string, unknown>;
type Database = Pick<Client, "query">;
type Kind = "features" | "labels";
const layout = {
  features: { table: "feature_values", links: "feature_inputs", id: "feature_id", clock: "checkpoint",
    key: ["player_id", "game_id", "stat", "season", "feature_version", "history_policy", "evidence_mode"],
    values: ["cutoff", "state", "reasons", "flags", "sample_size", "history", "history_gaps"] },
  labels: { table: "outcome_labels", links: "label_inputs", id: "label_id", clock: "label_cutoff",
    key: ["player_id", "game_id", "stat", "season", "label_version", "evidence_mode"],
    values: ["label_cutoff", "state", "reasons", "flags", "value"] },
} as const;
const hash = (value: unknown) => sha256(Buffer.from(JSON.stringify(value)));

const canonical = (value: unknown, field: string): unknown => {
  if (value === undefined) throw new Error("replay-derived-field-missing");
  if (value === null || typeof value !== "object") {
    return value !== null && ["cutoff", "label_cutoff", "kickoff"].includes(field) ? canonicalReplayTimestamp(value) : value;
  }
  if (Array.isArray(value)) return value.map((entry) => canonical(entry, field));
  const row = value as Row;
  return Object.fromEntries(Object.keys(row).sort().map((key) => [key, canonical(row[key], key)]));
};

const hashDerivedRows = (kind: Kind, rows: Row[]) => {
  const spec = layout[kind];
  const keyed = new Map<string, unknown[]>();
  for (const row of rows) {
    if (spec.key.some((field) => row[field] === null || row[field] === undefined)) throw new Error("replay-derived-key-refused");
    const key = JSON.stringify(spec.key.map((field) => row[field]));
    if (keyed.has(key)) throw new Error("replay-derived-duplicate-key");
    keyed.set(key, spec.values.map((field) => canonical(row[field], field)));
  }
  const keys = [...keyed.keys()].sort();
  return { rows: keys.length, keySha256: hash(keys), valueSha256: hash(keys.map((key) => keyed.get(key))) };
};

export const assertDerivedParity = (kind: Kind, original: Row[], replayed: Row[]) => {
  const expected = hashDerivedRows(kind, original);
  const actual = hashDerivedRows(kind, replayed);
  if (expected.rows !== actual.rows || expected.keySha256 !== actual.keySha256 || expected.valueSha256 !== actual.valueSha256) {
    throw new Error("replay-derived-value-mismatch");
  }
  return actual;
};

const groupRows = (rows: Row[], key: string) => {
  const groups = new Map<unknown, Row[]>();
  for (const row of rows) {
    const group = groups.get(row[key]) ?? [];
    group.push(row);
    groups.set(row[key], group);
  }
  return groups;
};

const pinnedJobs = (records: Records) => {
  const snapshots = new Map(records.source_snapshots.map((row) => [row.snapshot_id, row]));
  const jobInputs = groupRows(records.job_inputs, "job_id");
  const jobs = new Map(records.job_runs.map((row) => [row.job_id, row]));
  const contexts = [];
  for (const kind of ["features", "labels"] as const) {
    const spec = layout[kind];
    const rowLinks = groupRows(records[spec.links], spec.id);
    for (const [id, rows] of groupRows(records[spec.table], "job_id")) {
      const job = jobs.get(id);
      const first = rows[0];
      const mode = first.evidence_mode;
      const season = Number(first.season);
      const checkpoint = String(first[spec.clock]);
      if (!job || job.kind !== kind || job.status !== "succeeded" ||
          (mode !== "retrospective-reconstruction-v1" && mode !== "strict-point-in-time-v1") ||
          rows.some((row) => row.season !== first.season || row.evidence_mode !== mode || row[spec.clock] !== checkpoint ||
            (kind === "features" ? row.feature_version !== FEATURE_VERSION || row.history_policy !== HISTORY_POLICY :
              row.label_version !== LABEL_VERSION))) throw new Error("replay-derived-pin-mismatch");
      const inputIds = (jobInputs.get(id) ?? []).map(({ snapshot_id }) => String(snapshot_id)).sort();
      const stableSources = inputIds.map((snapshotId) => {
        const source = snapshots.get(snapshotId);
        if (!source) throw new Error("replay-derived-lineage-mismatch");
        return JSON.stringify([source.profile_id, source.sha256]);
      }).sort();
      const originalInputs = inputIds.map((snapshotId) => ({ sha256: snapshots.get(snapshotId)!.sha256, snapshot_id: snapshotId }));
      if (hash(originalInputs) !== job.input_set_sha256 || rows.some((row) =>
        JSON.stringify((rowLinks.get(row[spec.id]) ?? []).map(({ snapshot_id }) => String(snapshot_id)).sort()) !== JSON.stringify(inputIds))) {
        throw new Error("replay-derived-lineage-mismatch");
      }
      contexts.push({ kind, request: { season, mode, checkpoint } satisfies DerivedRequest,
        rows, inputIds, inputSetSha256: String(job.input_set_sha256), originalPolicySha256: String(job.policy_sha256),
        lineageSha256: hash(stableSources) });
    }
  }
  contexts.sort((a, b) => a.request.season - b.request.season ||
    a.request.mode.localeCompare(b.request.mode) || a.kind.localeCompare(b.kind));
  if (contexts.length !== 20) throw new Error("replay-derived-context-budget");
  return contexts;
};

export const replayDerivedJobs = async (db: { admin: Database; writer: Database; reader: Database }, records: Records, code: CodeIdentity) => {
  assertFeatureStoreReplayTarget(db.admin, db.writer);
  const contexts = pinnedJobs(records);
  await db.writer.query(`ANALYZE fs138.job_runs,fs138.source_snapshots,fs138.norm_schedule,
    fs138.norm_identity,fs138.norm_player_game_stats,fs138.norm_participation`);
  // Check every pinned context before dispatch. Separate bounded job queries let
  // PostgreSQL plan each season and purpose rather than use one lateral plan.
  for (const { kind, request, inputIds } of contexts) {
    const { rows: [selected] } = await db.writer.query<{ ids: string[] }>(`
      SELECT ARRAY(SELECT snapshot_id FROM fs138.qb_job_snapshot_ids($1,$2,$3,$4)
        ORDER BY snapshot_id) AS ids`, [request.season, request.checkpoint, kind, NORMALIZER_VERSION]);
    if (!selected || JSON.stringify(selected.ids) !== JSON.stringify(inputIds)) {
      throw new Error("replay-derived-input-selection-mismatch");
    }
  }

  const results = [];
  for (const context of contexts) {
    const { kind, request, inputIds } = context;
    const job = await runDerivedJob(db.writer, kind, request, code);
    if (job.status !== "succeeded" || job.work.materializations !== 1 || job.work.perExampleQueries !== 0) {
      throw new Error("replay-derived-work-mismatch");
    }
    const spec = layout[kind];
    const { rows: [output] } = await db.reader.query<{ values: Row[]; validLineage: boolean }>(`
      WITH output AS MATERIALIZED (SELECT * FROM fs138.${spec.table} WHERE job_id=$1),
      links AS MATERIALIZED (
        SELECT l.snapshot_id FROM fs138.${spec.links} l JOIN output d USING(${spec.id})
      )
      SELECT coalesce((SELECT jsonb_agg(to_jsonb(d)) FROM output d),'[]') AS "values",
        ARRAY(SELECT snapshot_id FROM fs138.job_inputs WHERE job_id=$1 ORDER BY snapshot_id)=$2::uuid[]
        AND (SELECT count(*) FROM links)=(SELECT count(*) FROM output)*cardinality($2::uuid[])
        AND NOT EXISTS(SELECT FROM links WHERE NOT(snapshot_id=ANY($2::uuid[]))) AS "validLineage"`, [job.jobId, inputIds]);
    if (!output.validLineage) throw new Error("replay-derived-lineage-mismatch");
    const parity = assertDerivedParity(kind, context.rows, output.values);
    results.push({ kind, ...request, ...parity, inputs: inputIds.length, lineageSha256: context.lineageSha256,
      inputSetSha256: context.inputSetSha256, originalPolicySha256: context.originalPolicySha256 });
  }
  return { derivedParity: results, selectionQueries: contexts.length, materializations: results.length, perExampleQueries: 0 };
};
