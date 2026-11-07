import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { withFeatureStoreDatabase } from "../../scripts/feature-store/harness.ts";
import { ingestSource } from "../../src/featureStore/ingest.ts";
import { inspectRawScrubRange } from "../../src/featureStore/integrityScrub.ts";
import { openLocalObjectStore } from "../../src/featureStore/localObjectStore.ts";
import { objectKey, sha256 } from "../../src/featureStore/objectStore.ts";
import { profileId } from "../../src/featureStore/source.ts";
import { sourceFixture } from "./fixtures.ts";

test("#170 classifies and verifies bounded raw ranges with the restricted reader", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dfs170-scrub-")));
  try {
    const store = await openLocalObjectStore(root);
    const readKeys: string[] = [];
    const tracedStore = { ...store, getVerified: (key: string, maxBytes: number) => {
      readKeys.push(key);
      return store.getVerified(key, maxBytes);
    } };
    await withFeatureStoreDatabase(async ({ admin, writer, reader, queryCounts }) => {
      const { bytes, asset } = sourceFixture();
      const key = objectKey("raw", bytes);
      const profile = profileId(asset);
      const otherProfile = profile + ".withdrawn";
      await ingestSource(writer, store, asset, { gitSha: "a".repeat(40), contentSha256: sha256(bytes) }, {
        download: async () => ({ bytes, capturedAt: new Date().toISOString(), requests: 1 }),
      });
      await writer.query(`INSERT INTO fs138.rights_decisions(profile_id,allowed_uses,valid_from,rationale)
        VALUES ($1,ARRAY['research'],now()-interval '1 minute','test')`, [profile]);
      await admin.query(`INSERT INTO fs138.source_profiles(profile_id,provider,feed,parser_version,license)
        SELECT $2,provider,feed,parser_version,license FROM fs138.source_profiles WHERE profile_id=$1`, [profile, otherProfile]);
      await admin.query(`INSERT INTO fs138.source_snapshots
        (profile_id,job_id,sha256,byte_size,object_key,media_type,decoded_sha256,header_sha256,
         row_count,captured_at,available_at,evidence_basis,source_manifest)
        SELECT $2,job_id,sha256,byte_size,object_key,media_type,decoded_sha256,header_sha256,
         row_count,captured_at,available_at,evidence_basis,source_manifest
        FROM fs138.source_snapshots WHERE profile_id=$1`, [profile, otherProfile]);

      await t.test("reads a shared address once under the eligible profile", async () => {
        const before = queryCounts.reader;
        const result = await inspectRawScrubRange(reader, tracedStore);
        assert.equal(queryCounts.reader - before, 1);
        assert.deepEqual(result.counts, { listed: 1, snapshotReferences: 2, withdrawnReferences: 1,
          verifiedObjects: 1, verifiedReferences: 1, verifiedWireBytes: bytes.length });
        assert.deepEqual(result.findings, []);
        assert.deepEqual(readKeys.splice(0), [key]);
      });
      await t.test("refuses snapshot and byte overflow before any payload read", async () => {
        await assert.rejects(inspectRawScrubRange(reader, tracedStore, { snapshotLimit: 1 }), /snapshot-budget/);
        await assert.rejects(inspectRawScrubRange(reader, tracedStore, { wireByteLimit: bytes.length - 1 }), /wire-budget/);
        assert.deepEqual(readKeys, []);
      });
      await t.test("reports an orphan without reading it across cursor ranges", async () => {
        const orphan = Buffer.from("orphan");
        const orphanKey = objectKey("raw", orphan);
        await store.putIfAbsent(orphanKey, orphan);
        const first = await inspectRawScrubRange(reader, tracedStore, { inventoryLimit: 1 });
        assert.ok(first.range.nextStartAfter);
        const last = await inspectRawScrubRange(reader, tracedStore, { startAfter: first.range.nextStartAfter });
        assert.equal(last.range.nextStartAfter, null);
        assert.deepEqual([...first.findings, ...last.findings], [{ key: orphanKey, kind: "orphan" }]);
        assert.deepEqual(readKeys.splice(0), [key]);
        await store.delete(orphanKey);
      });
      await t.test("reports byte corruption and a missing object on an empty terminal page", async () => {
        await writeFile(join(root, key), Buffer.alloc(bytes.length, 0));
        assert.deepEqual((await inspectRawScrubRange(reader, tracedStore)).findings, [{ key, kind: "corrupt" }]);
        assert.deepEqual(readKeys.splice(0), [key]);
        await store.delete(key);
        const result = await inspectRawScrubRange(reader, tracedStore);
        assert.equal(result.range.lastListedKey, null);
        assert.deepEqual(result.findings, [{ key, kind: "missing" }]);
        assert.deepEqual(readKeys, []);
      });
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
