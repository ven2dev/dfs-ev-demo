import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openTransferFixture } from "../../scripts/feature-store/transfer-fixture.ts";
import { withFeatureStoreDatabase } from "../../scripts/feature-store/harness.ts";
import { ingestSource } from "../../src/featureStore/ingest.ts";
import { openLocalObjectStore } from "../../src/featureStore/localObjectStore.ts";
import { objectKey, sha256 } from "../../src/featureStore/objectStore.ts";
import { sourceFixture, csvFixture, STAT_HEADER, STAT_ROW } from "./fixtures.ts";

test("#251 real loopback ingestion preserves work, provenance and cleanup", { timeout: 60_000 }, async t => {
  const sourceRoot = await realpath(await mkdtemp(join(tmpdir(), "dfs251-source-")));
  const destinationRoot = await realpath(await mkdtemp(join(tmpdir(), "dfs251-destination-")));
  const source = await openLocalObjectStore(sourceRoot), destination = await openLocalObjectStore(destinationRoot);
  const code = { gitSha: "b".repeat(40), contentSha256: sha256(Buffer.from("#251 synthetic code")) };
  const fixtures = [1, 64].map(n => {
    const fixture = sourceFixture(csvFixture(STAT_HEADER, Array.from({ length: n }, (_, i) => {
      const row = [...STAT_ROW]; row[0] = "00-" + String(i + 1).padStart(7, "0"); return row;
    })));
    fixture.asset.url = fixture.asset.url.replace("fixture.csv", `fixture-${n}.csv`);
    return { ...fixture, n };
  });
  const corrupt = sourceFixture(undefined, { gzip: true });
  corrupt.bytes[corrupt.bytes.length - 8] ^= 1;
  corrupt.asset = { ...corrupt.asset, url: corrupt.asset.url + "-corrupt", sha256: sha256(corrupt.bytes), provider_digest: null };
  const mappings = [...fixtures, corrupt].map(fixture => ({ asset: fixture.asset, key: objectKey("raw", fixture.bytes) }));
  let server: Awaited<ReturnType<typeof openTransferFixture>> | undefined;
  try {
    for (const [i, mapping] of mappings.entries()) await source.putIfAbsent(mapping.key, [...fixtures, corrupt][i].bytes);
    server = await openTransferFixture(source, mappings, { testOnlyLoopback: true });
    const download = server.download;
    await withFeatureStoreDatabase(async ({ writer, reader, queryCounts }) => {
      for (const fixture of fixtures) await t.test(`${fixture.n} normalized rows use exactly 12 SQL`, async () => {
        const before = queryCounts.writer;
        try {
          const result = await ingestSource(writer, destination, fixture.asset, code, { download });
          assert.equal(result.status, "ingested");
          assert.equal(queryCounts.writer - before, 12);
          if (result.status !== "ingested") throw new Error("synthetic ingestion unavailable");
          assert.equal(result.normalizedRows, fixture.n);
          assert.equal(result.work.downloadRequests, 1); assert.equal(result.work.bulkNormalizedInserts, 1);
          const stored = await destination.get(result.objectKey);
          assert.equal(sha256(stored), fixture.asset.sha256); assert.equal(stored.length, fixture.asset.wire_bytes);
          const row = (await reader.query(`SELECT source_manifest->>'url' AS url,
            (SELECT count(*)::integer FROM fs138.norm_player_game_stats WHERE snapshot_id=$1) AS n
            FROM fs138.source_snapshots WHERE snapshot_id=$1`, [result.snapshotId])).rows[0];
          assert.equal(row.url, fixture.asset.url); assert.equal(row.n, fixture.n);
        } finally {
          const key = objectKey("raw", fixture.bytes);
          await destination.delete(key); assert.equal(await destination.head(key), null);
        }
        assert.deepEqual(await source.get(objectKey("raw", fixture.bytes)), fixture.bytes);
      });
      await t.test("wrong pins and corrupt gzip refuse before any producer SQL or publication", async () => {
        const before = queryCounts.writer;
        await assert.rejects(ingestSource(writer, destination, { ...fixtures[0].asset, sha256: "0".repeat(64), provider_digest: null },
          code, { download }), /ingest-wire-digest-mismatch/);
        await assert.rejects(ingestSource(writer, destination, corrupt.asset, code, { download }));
        assert.equal(queryCounts.writer, before);
        assert.equal((await destination.list("raw")).length, 0);
      });
    });
  } finally {
    await server?.close();
    for (const object of await destination.list("raw")) await destination.delete(object.key);
    assert.equal((await destination.list("raw")).length, 0);
    await rm(destinationRoot, { recursive: true, force: true });
    await rm(sourceRoot, { recursive: true, force: true });
  }
});
