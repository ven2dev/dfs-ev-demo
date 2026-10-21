import assert from "node:assert/strict";
import { mkdtemp, realpath, readFile, mkdir, writeFile } from "node:fs/promises";
import { evaluateQbBaseline, serializeQbEvaluation, type QbExample, type QbCoverage } from "@dfs-ev/domain/qb-evaluation";
import { openLocalObjectStore } from "../../src/featureStore/localObjectStore.ts";
import { sha256, objectKey } from "../../src/featureStore/objectStore.ts";

// Synthetic feasibility only. This file never opens the real cohort or a DB.
const root = new URL("../../../../", import.meta.url);
const storageRoot = await realpath(await mkdtemp("/private/tmp/dfs164-math-"));
const store = await openLocalObjectStore(storageRoot);
const examples: QbExample[] = Array.from({ length: 2504 }, (_, i) => {
  const season = 2022 + i % 4, n = [2, 5, 9, 16][Math.floor(i / 4) % 4];
  return { playerId: `synthetic-qb-${i % 64}`, gameId: `synthetic-game-${i}`, season,
    cutoff: `${season}-09-01T17:00:00Z`, sampleSize: n, label: 100 + i % 350,
    history: Array.from({ length: n }, (_, j) => ({ gameId: `prior-${j}`, kickoff: "2021-09-01T18:00:00Z", yards: -10 + (i * 31 + j * 17) % 420 })),
    flags: ["historical-availability-unverified"] };
});
const coverage: QbCoverage[] = examples.map(e => ({ playerId: e.playerId, gameId: e.gameId, season: e.season, sampleSize: e.sampleSize,
  featureAvailable: true, labelAvailable: true, featureReasons: [], labelReasons: [], historyGaps: [], flags: e.flags,
  zeroAttempts: false, policyExclusions: [] }));
const files = ["packages/domain/src/projection/qb-evaluation.ts", "packages/domain/src/projection/empirical.ts",
  "packages/domain/src/projection/baseline.ts", "packages/domain/src/projection/evaluation.ts", "packages/domain/package.json",
  "services/pipeline/scripts/feature-store/evaluation-math-spike.ts"];
const codeHashes = Object.fromEntries(await Promise.all(files.map(async path => [path, sha256(await readFile(new URL(path, root)))])));
const trials = [];
let lastBytes = Buffer.alloc(0);
for (let trial = 1; trial <= 6; trial++) {
  const started = performance.now();
  const report = evaluateQbBaseline(examples, { mode: "retrospective-reconstruction-v1", historyPolicy: "synthetic-registered-policy", coverage });
  const calculated = performance.now();
  const bytes = Buffer.from(serializeQbEvaluation(report));
  const serialized = performance.now();
  assert.equal(report.folds.length, 2504); assert.equal(report.cases.length, 12520); assert.equal(report.groups.length, 25);
  trials.push({ trial, calculationMs: calculated - started, serializationMs: serialized - calculated,
    totalMs: serialized - started, logicalSha256: sha256(bytes), byteSize: bytes.byteLength });
  lastBytes = bytes;
}
assert.equal(new Set(trials.map(t => t.logicalSha256)).size, 1);
const detailed = Buffer.from(JSON.stringify({ fixture: "synthetic-only", report: JSON.parse(lastBytes.toString()) }) + "\n");
const detailedKey = objectKey("audits", detailed);
await store.putIfAbsent(detailedKey, detailed);
const receipt = { schemaVersion: 1, issue: 164, step: 2, realDataEvaluationRun: false, runtime: process.version,
  fixture: "synthetic-only: 2504 folds, 12520 cases, four seasons and n=2/5/9/16 crossed", codeHashes,
  boundary: "pure evaluation plus logical JSON serialization; no database, source reads, connection setup or ObjectStore writes in timing",
  cacheState: "six repeated in-process runs; first run has unprimed scorer/JIT; OS caches unflushed; no result reuse",
  interpretation: "partial-path feasibility and deterministic output only; not the completed-report timing gate",
  work: { statements: 0, databaseReads: 0, rawEvidenceReads: 0, folds: 2504, cases: 12520, groups: 25 }, trials, storageRoot,
  fullReport: { objectKey: detailedKey, sha256: sha256(detailed), byteSize: detailed.byteLength },
  verdict: "synthetic-reproducibility-pass" };
const receiptBytes = Buffer.from(JSON.stringify(receipt) + "\n");
await store.putIfAbsent(objectKey("audits", receiptBytes), receiptBytes);
await mkdir(new URL("docs/evidence/feature-store-164/", root), { recursive: true });
await writeFile(new URL("docs/evidence/feature-store-164/step-2-synthetic-math.json", root), JSON.stringify(receipt, null, 2) + "\n");
console.log(JSON.stringify({ verdict: receipt.verdict, trials, storageRoot }));
