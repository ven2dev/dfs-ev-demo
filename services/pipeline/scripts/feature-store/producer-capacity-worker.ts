import { Client, type ClientConfig } from "pg";
import { assertNoApplicationCredentials, getTestDatabaseLane } from "@dfs-ev/db-tooling/test-support/target";
import { openLocalObjectStore } from "../../src/featureStore/localObjectStore.ts";
import { runDerivedJob, type CodeIdentity } from "../../src/featureStore/derived.ts";
import { ingestSource } from "../../src/featureStore/ingest.ts";
import { observeLiveDownload } from "./live-download.ts";
import { openTransferFixture } from "./transfer-fixture.ts";
import { timeProducerQueries } from "./producer-capacity-observe.ts";
import type { SourcePin, StatementTime, WorkerResult } from "./producer-capacity-contract.ts";

export type ProducerWorkerOptions = { config: ClientConfig; sourceRoot: string; destinationRoot: string;
  pin?: SourcePin; code: CodeIdentity };
export const createProducerWorker = async (options: ProducerWorkerOptions, notify: (q: StatementTime) => void) => {
  assertNoApplicationCredentials(process.env);
  const c = options.config;
  const lane = getTestDatabaseLane(process.env.DB_TEST_LANE);
  if (!["127.0.0.1", "::1"].includes(String(c.host)) ||
      c.port !== lane.port || !/^dfs_ev_test_[a-f0-9]+$/.test(String(c.database)) ||
      !/^fs138_job_[a-f0-9]+$/.test(String(c.user)) || c.password !== "fs138_throwaway" || c.ssl !== false || c.connectionString)
    throw new Error("producer-worker-target-refused");
  const client = new Client(c);
  client.on("error", () => {}); // Pending queries report failure; owner always closes.
  let fixture: Awaited<ReturnType<typeof openTransferFixture>> | undefined, reads = 0, closed = false;
  const measured = timeProducerQueries(client, notify);
  try {
    const destination = await openLocalObjectStore(options.destinationRoot);
    if (options.pin) {
      const source = await openLocalObjectStore(options.sourceRoot);
      fixture = await openTransferFixture({ ...source, get: async key => { reads++; return source.get(key); } },
        [options.pin], { testOnlyLoopback: true });
    }
    const started = performance.now();
    await client.connect();
    const connectMs = performance.now() - started;
    // No setup SQL: the owner identifies/cancels this dedicated backend by its
    // unique application_name, through a separate admin connection.
    return { connectMs,
      live: () => {
        if (!options.pin || closed) throw new Error("producer-live-state-refused");
        return observeLiveDownload(options.pin.asset);
      },
      run: async (): Promise<WorkerResult> => {
        if (closed) throw new Error("producer-worker-closed");
        const started = performance.now();
        if (options.pin && fixture) {
          const result = await ingestSource(measured.client, destination, options.pin.asset, options.code, { download: fixture.download });
          const mapping = fixture.mappings[0];
          return { status: "completed", sql: measured.statements, handlerMs: performance.now() - started,
            ingestion: result.status === "ingested" ? { status: result.status, wireBytes: result.wireBytes,
              sha256: result.wireSha256, bulkInserts: result.work.bulkNormalizedInserts }
              : { status: result.status, wireBytes: 0, sha256: "", bulkInserts: 0 },
            loopback: { kind: "test-only-loopback", origin: fixture.origin, pathname: mapping.pathname,
              sourceUrl: options.pin.asset.url, key: options.pin.key, sha256: options.pin.asset.sha256!,
              wireBytes: options.pin.asset.wire_bytes, reads, requests: result.status === "ingested" ? result.work.downloadRequests : 0 } };
        }
        const result = await runDerivedJob(measured.client, "features", { season: 2025, mode: "retrospective-reconstruction-v1" }, options.code);
        return { status: "completed", sql: measured.statements, handlerMs: performance.now() - started,
          features: result.status === "succeeded" ? { status: result.status, jobId: result.jobId, rows: result.counts.rows, ...result.work }
            : { status: result.status, jobId: result.jobId, rows: 0, materializations: 0, perExampleQueries: 0, sourceByteReads: 0 } };
      },
      close: async () => {
        if (closed) return;
        closed = true; measured.stop();
        try { await client.end(); } finally { await fixture?.close(); }
      },
    };
  } catch (error) { measured.stop(); await client.end().catch(() => {}); await fixture?.close(); throw error; }
};
