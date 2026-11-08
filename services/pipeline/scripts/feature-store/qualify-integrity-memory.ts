import assert from "node:assert/strict";
import { readFile, realpath } from "node:fs/promises";
import type { Client } from "pg";
import { inspectRawScrubRange } from "../../src/featureStore/integrityScrub.ts";
import { openLocalObjectStore } from "../../src/featureStore/localObjectStore.ts";

const root = process.argv[2];
if (!root) throw new Error("pass the preserved #138 object root");
const pin = "../../../../docs/evidence/feature-store-138/step-3-real-ingestion.json";
const { results } = JSON.parse(await readFile(new URL(pin, import.meta.url), "utf8")) as {
  results: { objectKey: string; profileId: string; wireBytes: number }[];
};
const snapshots = results.map((row, index) => ({
  key: row.objectKey, profileId: row.profileId, byteSize: String(row.wireBytes), snapshotId: String(index), eligible: true,
}));
assert.equal(snapshots.length, 16);
const database = {
  query: async () => ({ rows: [{ snapshots, removals: [] }] }),
} as unknown as Pick<Client, "query">;
const store = await openLocalObjectStore(await realpath(root), { maxObjectBytes: 64 * 1024 * 1024 });
const samples: { key: string; bytes: number; beforeRead: number; afterRead: number }[] = [];
const arrayBuffers = () => process.memoryUsage().arrayBuffers;
global.gc?.();
const baseline = arrayBuffers();
const measuredStore = {
  ...store,
  getVerified: async (key: string, maxBytes: number) => {
    global.gc?.();
    const beforeRead = arrayBuffers();
    const wire = await store.getVerified(key, maxBytes);
    samples.push({ key, bytes: wire.byteSize, beforeRead, afterRead: arrayBuffers() });
    return wire;
  },
};
const result = await inspectRawScrubRange(database, measuredStore);
const afterLastRelease = arrayBuffers();
assert.deepEqual(result.findings, []);
assert.equal(result.counts.verifiedObjects, 16);
assert.equal(result.counts.verifiedWireBytes, 246304787);
const largest = Math.max(...samples.map(({ bytes }) => bytes));
const slack = 8 * 1024 * 1024;
const peakArrayBuffers = Math.max(baseline, afterLastRelease, ...samples.flatMap(({ beforeRead, afterRead }) => [beforeRead, afterRead]));
assert.ok(peakArrayBuffers <= largest + slack, "peak arrayBuffers exceeds largest object plus slack");
assert.ok(samples.every(({ beforeRead }) => beforeRead <= baseline + slack), "previous payload still allocated");
assert.ok(afterLastRelease <= baseline + slack, "last payload still allocated");
console.log(JSON.stringify({
  node: process.version, gcBetweenReads: Boolean(global.gc), baseline, samples, afterLastRelease,
  peakArrayBuffers, peakRssBytes: process.resourceUsage().maxRSS * 1024, largest, slack,
}, null, 2));
