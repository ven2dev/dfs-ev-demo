import assert from "node:assert/strict";
import type { Client } from "pg";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createScratchHarness } from "../../tests/db/scratch.mjs";
import { assertNoApplicationCredentials } from "../../tests/db/target.mts";
import { checkMigrationArtifacts } from "../db-migrations/files.mjs";
import { createCatalogVerifier, loadCatalogContracts } from "../db-migrations/contracts.mjs";
import { runScratchMigrations } from "../db-migrations/core.mjs";
import { openArtifactStore } from "../../src/lib/predictive/artifacts.ts";
import { createLocalPredictiveStore } from "../../src/lib/predictive/persistence.ts";
import { ingestLocalDataset } from "../../src/lib/predictive/ingest.ts";
import { addCapture, CUTOFF_B, passingYardsFixture, PRIOR, request, revision } from "../../tests/predictive/fixtures/passingYards.ts";
import { archiveRuns, restoreRuns, type ArchivedRun, type ArchiveReference } from "./archive.ts";

export const runLocalProof = async (args: string[], environment: NodeJS.ProcessEnv) => {
  assertNoApplicationCredentials(environment);
  if (environment.NEON_API_KEY !== undefined) throw new Error("configuration-refused");
  const [mode, option, directory, ...extra] = args;
  if (!["demo", "restore"].includes(mode) || option !== "--artifact-root" || !directory ||
      (mode === "demo" ? extra.length !== 0 : extra.length !== 4 || extra[0] !== "--archive" || extra[2] !== "--archive-bytes")) throw new Error("arguments-refused");
  const artifacts = await openArtifactStore(directory);
  const files = await checkMigrationArtifacts(); const contracts = await loadCatalogContracts(files);
  const harness = await createScratchHarness(environment);
  let archive: ArchiveReference;
  let runs: ArchivedRun[];
  const now = "2026-10-09T00:00:00.000Z";
  try {
    if (mode === "demo") {
      const a = passingYardsFixture(false); const b = passingYardsFixture();
      const correction = { ...b, artifacts: b.artifacts.filter((artifact) => artifact.id.startsWith("B-")), captures: b.captures.filter((capture) => capture.artifactId.startsWith("B-")) };
      const unavailable = { formatVersion: 1 as const, artifacts: [], captures: [] };
      addCapture(unavailable, "unresolved-completion", [revision("completion-unresolved", "completion", {
        gameId: PRIOR[4], state: "unresolved", bound: null, boundKind: null, evidenceVersion: "synthetic-suspended-v1",
      }, "complete-synthetic-game-5")], "2026-10-08T13:30:00.000Z");
      runs = [{ id: "A", dataset: a }, { id: "B", dataset: correction }, { id: "unavailable", dataset: unavailable }];
      for (const run of runs) for (const artifact of run.dataset.artifacts) await artifacts.write(artifact.bytes, artifact.sha256);
      archive = await archiveRuns(artifacts, runs);
    } else {
      const sha256 = extra[1].replace(/\.json$/, "");
      archive = { reference: extra[1], sha256, byteSize: Number(extra[3]) };
      runs = await restoreRuns(artifacts, archive);
    }
    const install = async (client: Client, expected: object) => {
      const target = { expected, assertTarget: harness.assertTarget };
      await runScratchMigrations(client, { ...target, files, verify: createCatalogVerifier(contracts) });
      return createLocalPredictiveStore(client, target, artifacts);
    };
    const report = await harness.withDatabase(async (client: Client, expected: object) => {
      const store = await install(client, expected);
      assert.equal((await ingestLocalDataset(store, runs[0].id, runs[0].dataset, now)).status, "published");
      const capturedA = await store.replay(request());
      assert.equal((await ingestLocalDataset(store, runs[1].id, runs[1].dataset, now)).status, "published");
      const replayA = await store.replay(request()); const laterB = await store.replay(request(CUTOFF_B));
      assert.deepEqual(replayA, capturedA); assert.equal(capturedA.status, "ready-inputs"); assert.equal(laterB.status, "ready-inputs");
      assert.notEqual(laterB.inputDigest, capturedA.inputDigest);
      assert.equal((await ingestLocalDataset(store, runs[2].id, runs[2].dataset, now)).status, "published");
      const unavailable = await store.replay(request(CUTOFF_B)); assert.equal(unavailable.status, "unavailable-inputs");
      return { capturedA, replayA, laterB, unavailable };
    });
    const restored = await harness.withDatabase(async (client: Client, expected: object) => {
      const store = await install(client, expected);
      for (const run of await restoreRuns(artifacts, archive)) await store.publish(run.id, run.dataset, now);
      return store.replay(request());
    });
    assert.deepEqual(restored, report.capturedA);
    return { proof: "synthetic-postgres-cutoff-replay-v1", schemaVersion: files.length, earlierReplayUnchanged: true,
      restoredReplayUnchanged: true, archive, ...report, restored };
  } finally { await harness.close(); }
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await runLocalProof(process.argv.slice(2), process.env), null, 2)); }
  catch { console.error("Predictive local persistence proof refused or failed."); process.exitCode = 1; }
}
