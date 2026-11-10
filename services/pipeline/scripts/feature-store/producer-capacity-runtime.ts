import { execFileSync } from "node:child_process";
import { mkdir, open, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { Client } from "pg";
import { openLocalObjectStore } from "../../src/featureStore/localObjectStore.ts";
import { sha256, type ObjectStore } from "../../src/featureStore/objectStore.ts";
import type { Cleanup, SourcePin } from "./producer-capacity-contract.ts";
import type { SourceAsset } from "../../src/featureStore/source.ts";

const repository = new URL("../../../../", import.meta.url);
export const PRODUCER_CAPACITY_SOURCES = [
  "services/pipeline/scripts/feature-store/producer-capacity-contract.ts", "services/pipeline/scripts/feature-store/producer-capacity-runtime.ts",
  "services/pipeline/scripts/feature-store/producer-capacity-worker.ts", "services/pipeline/scripts/feature-store/producer-capacity-bootstrap.mjs",
  "services/pipeline/scripts/feature-store/producer-capacity-process.ts", "services/pipeline/scripts/feature-store/producer-capacity-observe.ts",
  "services/pipeline/scripts/feature-store/producer-capacity-benchmark.ts", "services/pipeline/scripts/feature-store/harness.ts",
  "services/pipeline/scripts/feature-store/producer-capacity-evidence.ts", "services/pipeline/scripts/feature-store/artifact-governance-evidence.ts",
  "services/pipeline/scripts/feature-store/evidence-bundle.ts",
  "services/pipeline/scripts/feature-store/live-download.ts", "services/pipeline/scripts/feature-store/transfer-fixture.ts",
  "services/pipeline/src/featureStore/ingest.ts", "services/pipeline/src/featureStore/derived.ts", "services/pipeline/src/featureStore/jobs.ts",
  "services/pipeline/src/featureStore/source.ts", "services/pipeline/src/featureStore/sourceTransfer.ts", "services/pipeline/src/featureStore/normalize.ts",
  "services/pipeline/src/featureStore/objectStore.ts", "services/pipeline/src/featureStore/localObjectStore.ts", "services/pipeline/src/featureStore/verifiedWireAccess.ts",
  "packages/db/proposals/138_feature_store.sql", "packages/db/proposals/138_dataset_governance.sql",
  "packages/db/proposals/163_effective_rights.sql", "packages/db/proposals/241_job_visibility.sql",
  "docs/evidence/feature-store-138/step-3-source-manifest.json", "docs/evidence/feature-store-138/step-3-real-ingestion.json",
  "scripts/db/test-db.mjs", "scripts/db/db-test-disk.mjs", "packages/db/tooling/tests/startup.mts",
  "packages/db/tooling/tests/target.mts", "packages/db/tooling/tests/scratch.mjs", "compose.test.yml",
  "packages/db/tooling/tests/templates.mts", "packages/db/tooling/package.json",
  "packages/db/src/assets.mjs", "scripts/db/db-test-workers.mjs", "scripts/db/db-test-lanes.mjs", "scripts/db/db-test-contract.mjs",
  "packages/db/migration-manifest.json", "packages/db/schema.sql", "packages/db/catalog-contracts/ledger.json",
  "compose.feature-store-spike.yml", "package.json", "package-lock.json", "services/pipeline/package.json", "packages/db/package.json",
] as const;

export const pinProducerSources = async (extra: string[] = []) => {
  const databaseFiles = execFileSync("git", ["ls-files", "packages/db/migrations", "packages/db/catalog-contracts", "packages/db/migration-manifest.json",
    "packages/db/schema.sql", "packages/db/tooling/scripts/db-migrations", "packages/db/tooling/scripts/db-catalog.mjs",
    "packages/db/tooling/scripts/compare-db-catalog.mjs"], { cwd: repository, encoding: "utf8" }).trim().split("\n");
  const paths = [...new Set([...PRODUCER_CAPACITY_SOURCES, ...databaseFiles, ...extra])].sort();
  const source = [];
  for (const path of paths) {
    const bytes = await readFile(new URL(path, repository));
    const committed = execFileSync("git", ["show", "HEAD:" + path], { cwd: repository, maxBuffer: 16 * 1024 * 1024 });
    if (!bytes.equals(committed)) throw new Error("capacity-uncommitted-source: " + path);
    source.push({ path, sha256: sha256(bytes), gitBlobId: execFileSync("git", ["rev-parse", "HEAD:" + path], { cwd: repository, encoding: "utf8" }).trim() });
  }
  return { gitSha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim(), source,
    contentSha256: sha256(Buffer.from(JSON.stringify(source))) };
};

// Freeze exact source bytes alongside their inventory before starting any lane.
// This permits durable SHA-256 and git-blob audits without Git history or today's
// working files, including when a later source-change check stops the run.
export const producerSourceBytes = async (inventory: Awaited<ReturnType<typeof pinProducerSources>>) => {
  const bytes: Record<string, string> = {};
  for (const source of inventory.source) {
    const body = await readFile(new URL(source.path, repository));
    if (sha256(body) !== source.sha256) throw new Error("producer-source-changed-before-run");
    bytes[source.path] = body.toString("base64");
  }
  return bytes;
};

export const loadProducerPins = async (sourceRoot: string) => {
  const manifest = JSON.parse(await readFile(new URL("docs/evidence/feature-store-138/step-3-source-manifest.json", repository), "utf8")) as { assets: { asset: SourceAsset }[] };
  const prior = JSON.parse(await readFile(new URL("docs/evidence/feature-store-138/step-3-real-ingestion.json", repository), "utf8")) as { results: { name: string; objectKey: string; wireSha256: string }[] };
  const store = await openLocalObjectStore(await realpath(sourceRoot)), pins: SourcePin[] = [];
  if (manifest.assets.length !== 16) throw new Error("producer-source-population-refused");
  for (const { asset } of manifest.assets) {
    const entry = prior.results.find(r => r.name === asset.name);
    if (!entry || entry.objectKey !== "raw/" + asset.sha256 || entry.wireSha256 !== asset.sha256) throw new Error("producer-source-pin-refused");
    const bytes = await store.get(entry.objectKey);
    if (bytes.length !== asset.wire_bytes || sha256(bytes) !== asset.sha256) throw new Error("producer-source-bytes-refused");
    pins.push({ asset, key: entry.objectKey });
  }
  // Preparation requires schedule first; no change to the pinned input identity.
  pins.sort((a, b) => a.asset.feed === "schedules" ? -1 : b.asset.feed === "schedules" ? 1 : a.asset.name.localeCompare(b.asset.name));
  return { store, pins };
};

export const cleanupProducerRaw = async (store: ObjectStore): Promise<Cleanup> => {
  const objects = await store.list("raw");
  // Verify all bytes before removing any, retaining the failure's objects if a
  // destination is corrupt. Every access remains through ObjectStore.
  for (const object of objects) {
    const bytes = await store.get(object.key);
    if (bytes.length !== object.byteSize || sha256(bytes) !== object.sha256) throw new Error("producer-cleanup-integrity-refused");
  }
  for (const object of objects) {
    await store.delete(object.key);
    if (await store.head(object.key)) throw new Error("producer-cleanup-delete-failed");
  }
  if ((await store.list("raw")).length) throw new Error("producer-cleanup-incomplete");
  return { objects, verified: true, deleted: true };
};

export const producerFeatureParity = async (admin: Client, jobId: string) => {
  const rows = (await admin.query(`SELECT player_id,game_id,cutoff::text,state,reasons,flags,sample_size,history,history_gaps
    FROM fs138.feature_values WHERE job_id=$1 ORDER BY player_id,game_id`, [jobId])).rows;
  const lineage = Number((await admin.query(`SELECT count(*) AS n FROM fs138.feature_inputs i
    JOIN fs138.feature_values f USING(feature_id) WHERE f.job_id=$1`, [jobId])).rows[0].n);
  return { rows: rows.length, lineage, historicalFlags: rows.every(r =>
    JSON.stringify(r.flags) === JSON.stringify(["historical-availability-unverified"])), sha256: sha256(Buffer.from(JSON.stringify(rows))) };
};

export const openProducerJournal = async (directory: string) => {
  if (!isAbsolute(directory)) throw new Error("producer-output-absolute-path-required");
  await mkdir(directory, { recursive: false, mode: 0o700 });
  const handle = await open(resolve(directory, "events.jsonl"), "ax", 0o600);
  let pending = Promise.resolve(), failure: unknown;
  return {
    record: (name: string, value: unknown) => {
      if (!/^[a-zA-Z0-9_.-]+\.json$/.test(name)) throw new Error("producer-journal-name-refused");
      return writeFile(resolve(directory, name), JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    },
    event: (value: unknown) => {
      const line = JSON.stringify(value) + "\n";
      pending = pending.then(() => handle.writeFile(line)).then(() => {}).catch(e => { failure ??= e; });
    },
    flush: async () => { await pending; await handle.sync(); if (failure) throw failure; },
    close: async () => { try { await pending; await handle.sync(); if (failure) throw failure; } finally { await handle.close(); } },
  };
};
