import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { withFeatureStoreDatabase } from "../../scripts/feature-store/harness.ts";
import { readNormalizedAsOf } from "../../src/featureStore/asOf.ts";
import { deleteSources,cleanupDeletedObjects,sweepOrphanObjects } from "../../src/featureStore/governance.ts";
import { ingestSource } from "../../src/featureStore/ingest.ts";
import { openLocalObjectStore } from "../../src/featureStore/localObjectStore.ts";
import { sha256 } from "../../src/featureStore/objectStore.ts";
import { NORMALIZER_VERSION } from "../../src/featureStore/source.ts";
import { csvFixture, sourceFixture, STAT_HEADER, STAT_ROW } from "./fixtures.ts";

const code = { gitSha: "a".repeat(40), contentSha256: sha256(Buffer.from("synthetic code")) };
const probes: { name: string; verdict: string }[] = [];
test("#138 ingestion and bitemporal selection", { timeout: 120_000 }, async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dfs138-ingestion-")));
  const store = await openLocalObjectStore(root);
  try {
    await withFeatureStoreDatabase(async ({ admin, writer, reader, queryCounts }) => {
      const initial = sourceFixture();
      const download = async () => ({ bytes: initial.bytes, capturedAt: new Date().toISOString(), requests: 1 });
      let first: Awaited<ReturnType<typeof ingestSource>>;
      const check = async (name: string, run: () => Promise<void>) => {
        await t.test(name, async () => { await run(); probes.push({ name, verdict: "pass" }); });
      };
      await check("trusted pipeline ingests atomically and retry does not republish", async () => {
        const before = queryCounts.writer;
        first = await ingestSource(writer, store, initial.asset, code, { download });
        assert.equal(first.status, "ingested");
        assert.equal(queryCounts.writer - before, 12);
        assert.equal((await reader.query("SELECT passing_yards FROM fs138.norm_player_game_stats")).rows[0].passing_yards, 0);
        assert.equal((await ingestSource(writer, store, initial.asset, code, { download })).status, "already-processed");
        assert.equal((await reader.query("SELECT count(*)::int AS n FROM fs138.source_snapshots")).rows[0].n, 1);
      });

      await check("raw upload is outside the transaction and a cleaner-winning race cannot publish",async()=>{
        const row=[...STAT_ROW];row[8]='456';const fixture=sourceFixture(csvFixture(STAT_HEADER,[row]));
        const writerPid=(await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        let observedIdle=false;
        const racing={...store,putIfAbsent:async(key:string,bytes:Uint8Array)=>{
          observedIdle=(await admin.query('SELECT state FROM pg_stat_activity WHERE pid=$1',[writerPid])).rows[0].state==='idle';
          const result=await store.putIfAbsent(key,bytes);await store.delete(key);return result;
        }};
        await assert.rejects(ingestSource(writer,racing,fixture.asset,code,{download:async()=>({bytes:fixture.bytes,capturedAt:new Date().toISOString(),requests:1})}),/ingest-object-missing/);
        assert(observedIdle);
        assert.equal((await reader.query('SELECT count(*)::integer AS n FROM fs138.source_snapshots')).rows[0].n,1);
      });
      await check("strict cutoff is inclusive for both clocks and refuses either future clock", async () => {
        const times = (await reader.query("SELECT ingested_at::text AS ingested FROM fs138.source_snapshots")).rows[0];
        const before = (await admin.query("SELECT ($1::timestamptz - interval '1 microsecond')::text AS before", [times.ingested])).rows[0].before;
        const checkpoint = (await admin.query("SELECT clock_timestamp()::text AS clock")).rows[0].clock;
        assert.equal((await readNormalizedAsOf(reader, { cutoff: before, checkpoint, mode: "strict-point-in-time-v1" })).length, 0);
        assert.equal((await readNormalizedAsOf(reader, { cutoff: times.ingested, checkpoint, mode: "strict-point-in-time-v1" })).length, 1);
        // Owner-only synthetic clock fixture isolates provider availability.
        await admin.query("UPDATE fs138.source_snapshots SET available_at = $1::timestamptz + interval '1 day'", [checkpoint]);
        assert.equal((await readNormalizedAsOf(reader, { cutoff: checkpoint, checkpoint, mode: "strict-point-in-time-v1" })).length, 0);
        await admin.query("UPDATE fs138.source_snapshots SET available_at = $1", [initial.asset.asset_updated_at]);
      });

      await check("reconstruction keeps its warning and never admits knowledge after its checkpoint", async () => {
        const checkpoint = (await admin.query("SELECT clock_timestamp()::text AS clock")).rows[0].clock;
        const rows = await readNormalizedAsOf(reader, { cutoff: "2021-01-01T00:00:00Z", checkpoint, mode: "retrospective-reconstruction-v1" });
        assert.deepEqual(rows[0].flags, ["historical-availability-unverified"]);
        const earliest = "2021-01-02T00:00:00Z";
        assert.equal((await readNormalizedAsOf(reader, { cutoff: "2021-01-01T00:00:00Z", checkpoint: earliest, mode: "retrospective-reconstruction-v1" })).length, 0);
        const priorQueries = queryCounts.reader;
        await assert.rejects(readNormalizedAsOf(reader, { cutoff: earliest, checkpoint, mode: "unknown" as "strict-point-in-time-v1" }), /as-of-request-refused/);
        await assert.rejects(readNormalizedAsOf(reader, { cutoff: "2021-01-01T00:00:00", checkpoint, mode: "strict-point-in-time-v1" }), /as-of-request-refused/);
        assert.equal(queryCounts.reader, priorQueries);
      });

      await check("corrupt download never replaces a valid snapshot or stores refused bytes", async () => {
        const gzip = sourceFixture(undefined, { gzip: true });
        const bytes = Buffer.from(gzip.bytes); bytes[bytes.length - 8] ^= 1;
        const asset = { ...gzip.asset, sha256: sha256(bytes), provider_digest: null };
        await assert.rejects(ingestSource(writer, store, asset, code, { download: async () => ({ bytes, capturedAt: new Date().toISOString(), requests: 1 }) }));
        assert.equal((await store.list("raw")).length, 1);
        assert.equal((await reader.query("SELECT count(*)::int AS n FROM fs138.source_snapshots")).rows[0].n, 1);
        assert.equal((await reader.query("SELECT passing_yards FROM fs138.norm_player_game_stats")).rows[0].passing_yards, 0);
      });

      await check("later correction changes current selection but not the earlier checkpoint", async () => {
        const checkpoint = (await admin.query("SELECT clock_timestamp()::text AS clock")).rows[0].clock;
        const changed = [...STAT_ROW]; changed[8] = "250";
        const second = sourceFixture(csvFixture(STAT_HEADER, [changed]));
        second.asset.asset_updated_at = "2021-01-02T00:00:00Z";
        await ingestSource(writer, store, second.asset, code, { download: async () => ({ bytes: second.bytes, capturedAt: new Date().toISOString(), requests: 1 }) });
        const oldRows = await readNormalizedAsOf(reader, { cutoff: "2021-01-01T00:00:00Z", checkpoint, mode: "retrospective-reconstruction-v1" });
        assert.equal(oldRows[0].data?.passing_yards, 0);
        const now = (await admin.query("SELECT clock_timestamp()::text AS clock")).rows[0].clock;
        const before = queryCounts.reader;
        const newRows = await readNormalizedAsOf(reader, { cutoff: "2021-01-01T00:00:00Z", checkpoint: now, mode: "retrospective-reconstruction-v1" });
        assert.equal(newRows[0].data?.passing_yards, 250);
        assert.equal(queryCounts.reader - before, 1);
        assert.equal(newRows[0].snapshotIds.length, 1);
      });

      await check("equal-time rivals are ambiguous and unknown normalizer versions are excluded", async () => {
        const oldTimes = (await admin.query("SELECT snapshot_id, available_at, ingested_at FROM fs138.source_snapshots ORDER BY ingested_at")).rows;
        await admin.query("UPDATE fs138.source_snapshots SET available_at = '2021-01-01', ingested_at = statement_timestamp()");
        const tiedCheckpoint = (await admin.query("SELECT clock_timestamp()::text AS clock")).rows[0].clock;
        const rows = await readNormalizedAsOf(reader, { cutoff: tiedCheckpoint, checkpoint: tiedCheckpoint, mode: "strict-point-in-time-v1" });
        assert.equal(rows[0].state, "ambiguous"); assert.equal(rows[0].data, null); assert.equal(rows[0].snapshotIds.length, 2);
        for (const time of oldTimes) await admin.query("UPDATE fs138.source_snapshots SET available_at=$2, ingested_at=$3 WHERE snapshot_id=$1", [time.snapshot_id, time.available_at, time.ingested_at]);
        await admin.query("UPDATE fs138.norm_player_game_stats SET normalizer_version = 'future-unknown'");
        const now = (await admin.query("SELECT clock_timestamp()::text AS clock")).rows[0].clock;
        assert.equal((await readNormalizedAsOf(reader, { cutoff: now, checkpoint: now, mode: "strict-point-in-time-v1" })).length, 0);
        await admin.query("UPDATE fs138.norm_player_game_stats SET normalizer_version = $1", [NORMALIZER_VERSION]);
      });

      await check("failed publication rolls back normalized/snapshot rows and records a failed job", async () => {
        const third = [...STAT_ROW]; third[8] = "300";
        const fixture = sourceFixture(csvFixture(STAT_HEADER, [third]));
        await admin.query("REVOKE INSERT ON fs138.norm_player_game_stats FROM fs138_pipeline_writer");
        try {
          await assert.rejects(ingestSource(writer, store, fixture.asset, code, { download: async () => ({ bytes: fixture.bytes, capturedAt: new Date().toISOString(), requests: 1 }) }), { code: "42501" });
        } finally { await admin.query("GRANT INSERT ON fs138.norm_player_game_stats TO fs138_pipeline_writer"); }
        assert.equal((await reader.query("SELECT count(*)::int AS n FROM fs138.source_snapshots")).rows[0].n, 2);
        assert.equal((await reader.query("SELECT count(*)::int AS n FROM fs138.norm_player_game_stats")).rows[0].n, 2);
        assert.equal((await reader.query("SELECT count(*)::int AS n FROM fs138.job_runs WHERE status = 'failed'")).rows[0].n, 2);
        // The orphan is discoverable for grace-period cleanup, never deleted
        // immediately while another successful publication could reference it.
        assert.equal((await store.list("raw")).length, 3);
        const retry = await ingestSource(writer, store, fixture.asset, code, { download: async () => ({ bytes: fixture.bytes, capturedAt: new Date().toISOString(), requests: 1 }) });
        assert.equal(retry.status, "job-unavailable");
        assert.equal("jobStatus" in retry && retry.jobStatus, "failed");
      });
      await check("SQL work stays fixed when normalized row count increases", async () => {
        const records = Array.from({ length: 64 }, (_, index) => {
          const row = [...STAT_ROW]; row[0] = "00-" + String(index + 1).padStart(7, "0"); return row;
        });
        const fixture = sourceFixture(csvFixture(STAT_HEADER, records));
        const before = queryCounts.writer;
        const result = await ingestSource(writer, store, fixture.asset, code, { download: async () => ({ bytes: fixture.bytes, capturedAt: new Date().toISOString(), requests: 1 }) });
        assert.equal(result.status, "ingested");
        assert.equal(queryCounts.writer - before, 12);
        assert.equal((await reader.query("SELECT count(*)::int AS n FROM fs138.norm_player_game_stats WHERE snapshot_id = $1", [result.snapshotId])).rows[0].n, 64);
      });
      await check("deletion tombstones prevent retry reintroducing bytes and failed writes are swept", async()=>{
        const snapshot=(await reader.query('SELECT snapshot_id,object_key FROM fs138.source_snapshots WHERE sha256=$1',[sha256(initial.bytes)])).rows[0];
        await deleteSources(writer,[snapshot.snapshot_id],'synthetic deletion/retry probe',0);
        await cleanupDeletedObjects(writer,store);assert.equal(await store.head(snapshot.object_key),null);
        const retry=await ingestSource(writer,store,initial.asset,code,{download});assert.equal(retry.status,'job-unavailable');
        assert.equal(await store.head(snapshot.object_key),null);
        await assert.rejects(ingestSource(writer,store,initial.asset,{...code,contentSha256:sha256(Buffer.from('changed implementation'))},{download}),/object-address-deleted/);
        await cleanupDeletedObjects(writer,store);
        assert.equal(await store.head(snapshot.object_key),null);
        const before=await store.list('raw');const swept=await sweepOrphanObjects(writer,store,0);
        assert(swept.removed.length>0);assert((await store.list('raw')).length<before.length);
      });
    });
  } finally {
    await rm(root, { recursive: true, force: true });
    if (process.env.FEATURE_STORE_EVIDENCE_PATH) await writeFile(process.env.FEATURE_STORE_EVIDENCE_PATH,
      JSON.stringify({ issue: 138, step: 3, workload: "synthetic ingestion/as-of probes", probes,
        verdict: probes.length === 10 ? "pass" : "fail" }, null, 2) + "\n");
  }
});
