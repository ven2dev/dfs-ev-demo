import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Client } from "pg";
import { parseReplayDatabaseTarget } from "@dfs-ev/db-tooling/test-support/target";
import { withFeatureStoreDatabase } from "./harness.ts";
import { replayDerivedJobs } from "./replay-derived.ts";
import { captureReplayAccess, stageReplayNormalization } from "./replay-normalized.ts";
import { readReplayBaseline, restoreReplayMetadata } from "./replay-restore.ts";
import { FEATURE_VERSION, HISTORY_POLICY, LABEL_VERSION, type CodeIdentity } from "../../src/featureStore/derived.ts";
import { sha256, type ObjectStore } from "../../src/featureStore/objectStore.ts";
import { NORMALIZER_VERSION } from "../../src/featureStore/source.ts";

const root = new URL("../../../../", import.meta.url);
const sourceFiles = [
  "package-lock.json", "packages/db/tooling/tests/target.mts",
  ...["harness", "replay-audit", "replay-derived", "replay-normalized", "replay-restore", "recompute-replay"]
    .map((name) => `services/pipeline/scripts/feature-store/${name}.ts`),
  ...["asOf", "derived", "ingest", "jobs", "localObjectStore", "normalize", "objectStore", "source", "verifiedWireAccess"]
    .map((name) => `services/pipeline/src/featureStore/${name}.ts`),
  ...["138_feature_store.sql", "138_dataset_governance.sql", "163_effective_rights.sql", "241_job_visibility.sql"]
    .map((name) => `packages/db/proposals/${name}`),
];

export const replayCodeIdentity = async (repository = root) => {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: fileURLToPath(repository), encoding: "utf8" }).trim();
  const trackedChanges = git("status", "--porcelain", "--untracked-files=no");
  const untrackedInputs = git("ls-files", "--others", "--exclude-standard", "--", "services/pipeline/", "packages/db/", "scripts/db/");
  if (trackedChanges || untrackedInputs) throw new Error("replay-dirty-code");

  const gitSha = git("rev-parse", "HEAD");
  const hashes = await Promise.all(sourceFiles.map(async (path) => [path, sha256(await readFile(new URL(path, repository)))]));
  return { gitSha, dirty: false, contentSha256: sha256(Buffer.from(JSON.stringify(hashes))) };
};

type Source = Pick<Client, "query">;
type Baseline = Awaited<ReturnType<typeof readReplayBaseline>>;
type Options = {
  source: Source; store: ObjectStore; receiptPath: string; rowLimit?: number;
  code: CodeIdentity & { dirty: boolean };
};

export const certifyReplay = async ({ source, store, receiptPath, rowLimit, code }: Options, baseline: Baseline) => {
  parseReplayDatabaseTarget(process.env);
  if (code.dirty) throw new Error("replay-dirty-code");
  const { records, baselineHashes, memoryAfterBaseline } = baseline;
  const snapshotIds = records.source_snapshots.map(({ snapshot_id }) => String(snapshot_id));
  const result = await withFeatureStoreDatabase(async (db) => {
    const restore = await restoreReplayMetadata(db.admin, records);
    const { initial, withdrawn, ...normalized } = await stageReplayNormalization(db, source, store, records, rowLimit);
    if (withdrawn) throw new Error(`replay-withdrawn-inputs: ${withdrawn}`);
    const derived = await replayDerivedJobs(db, records, code);
    const replayFinishedAt = (await db.admin.query<{ at: string }>("SELECT clock_timestamp()::text AS at")).rows[0].at;
    return { initial, restore, replayFinishedAt, normalized, derived };
  });
  const final = await captureReplayAccess(source, snapshotIds, result.initial.epochMicros);
  if (final.rightsChanged || BigInt(final.epochMicros) < BigInt(result.initial.epochMicros) ||
      final.stateSha256 !== result.initial.stateSha256) throw new Error("replay-source-state-changed");
  const { initial, ...checked } = result;
  const boundary = ({ checkedAt, epochMicros, stateSha256 }: typeof final) => ({ checkedAt, epochMicros, stateSha256 });
  const receipt = {
    issue: 244, schemaVersion: 1, status: "replay-verified", code, baselineHashes,
    versions: { normalizer: NORMALIZER_VERSION, features: FEATURE_VERSION, labels: LABEL_VERSION, history: HISTORY_POLICY },
    boundaries: { initial: boundary(initial), final: boundary(final) },
    ...checked, memoryAfterBaseline, scratchCleanup: true, peakRssBytes: process.resourceUsage().maxRSS * 1024,
  };
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  return receipt;
};
