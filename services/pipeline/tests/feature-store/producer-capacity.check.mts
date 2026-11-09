import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { withFeatureStoreDatabase } from "../../scripts/feature-store/harness.ts";
import { createProducerWorker } from "../../scripts/feature-store/producer-capacity-worker.ts";
import { createProducerProcess } from "../../scripts/feature-store/producer-capacity-process.ts";
import { observeCapacityTrial, checkCapacityClock } from "../../scripts/feature-store/producer-capacity-observe.ts";
import { cleanupProducerRaw } from "../../scripts/feature-store/producer-capacity-runtime.ts";
import { openLocalObjectStore } from "../../src/featureStore/localObjectStore.ts";
import { objectKey, sha256 } from "../../src/featureStore/objectStore.ts";
import { sourceFixture } from "./fixtures.ts";

test("#169 standard-tier worker budgets, separate diagnostics and cleanup", { timeout: 90_000 }, async () => {
  // The shared harness validates the selected lane; CI uses its unset default.
  assert.notEqual(process.env.DB_TEST_TIER, "large");
  const root = await realpath(await mkdtemp(join(tmpdir(), "dfs169-worker-")));
  const source = await openLocalObjectStore(root), pin = sourceFixture();
  const key = objectKey("raw", pin.bytes); await source.putIfAbsent(key, pin.bytes);
  const destinationRoot = await realpath(await mkdtemp(join(tmpdir(), "dfs169-destination-")));
  const destination = await openLocalObjectStore(destinationRoot);
  const code = { gitSha: "a".repeat(40), contentSha256: sha256(Buffer.from("#169 synthetic standard-tier check")) };
  try {
    await withFeatureStoreDatabase(async db => {
      const clock = await checkCapacityClock(db.admin); assert.equal(clock.observations.length, 10);
      const ingestion = await createProducerWorker({ config: await db.createWriterConfig(), sourceRoot: root,
        destinationRoot, code, pin: { asset: pin.asset, key } }, () => {});
      try {
        const result = await ingestion.run();
        assert.equal(result.ingestion?.status, "ingested"); assert.equal(result.sql.length, 12);
        assert.equal(result.loopback?.reads, 1); assert.equal(result.loopback?.requests, 1);
        assert.equal(result.loopback?.sourceUrl, pin.asset.url);
        assert.match(result.loopback!.origin, /^http:\/\/127\.0\.0\.1:/);
        assert(result.sql.every(q => q.status === "completed" && q.elapsedMs >= 0));
      } finally { await ingestion.close(); }
      assert.equal((await cleanupProducerRaw(destination)).objects.length, 1);
      assert.deepEqual(await source.get(key), pin.bytes);
      // The small fixture verifies work/diagnostic wiring, not season capacity.
      const features = await createProducerWorker({ config: await db.createWriterConfig(), sourceRoot: root, destinationRoot, code }, () => {});
      // Exercise real PostgreSQL diagnostics with the existing disk-sampler seam.
      // The opt-in Docker capacity sampler requires lane-3; these zero-valued
      // placeholders are not disk measurements or a capacity qualification.
      let diskSamples = 0;
      const monitor = await observeCapacityTrial(db.admin, true, async () => {
        diskSamples++;
        return { at: new Date().toISOString(), mountBytes: 0, usedBytes: 0,
          availableBytes: 0, walBytes: 0, tempFiles: [], databases: [] };
      });
      try {
        const result = await features.run();
        assert.equal(result.features?.status, "succeeded"); assert.equal(result.sql.length, 8);
        assert.equal(result.features?.materializations, 1); assert.equal(result.features?.sourceByteReads, 0);
      } finally { await features.close(); }
      const diagnostics = await monitor.finish();
      assert(diagnostics?.before.checkpointer); assert(diagnostics?.after.checkpointer);
      assert(diagnostics?.before.wal); assert(diagnostics?.after.wal);
      assert(diagnostics.autovacuum.length >= 2); assert(monitor.disk.length >= 2);
      assert.equal(monitor.disk.length, diskSamples);
      for (const temperature of ["cold", "warm"] as const) {
        const child = createProducerProcess({ worker: { config: await db.createWriterConfig(), sourceRoot: root, destinationRoot, code }, onEvent: () => {} });
        try {
          if (temperature === "warm") await child.prepare();
          const result = await child.measure(temperature);
          assert.equal(result.censored, false); assert.equal(result.result?.features?.status, "succeeded");
          assert.equal(result.result.sql.length, 8); assert.notEqual(result.pid, process.pid);
        } finally { await child.close(); }
      }
    });
  } finally {
    await cleanupProducerRaw(destination);
    await rm(destinationRoot, { recursive: true, force: true }); await rm(root, { recursive: true, force: true });
  }
});
