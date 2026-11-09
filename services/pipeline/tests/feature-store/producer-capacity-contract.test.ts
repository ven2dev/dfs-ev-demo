import { describe, expect, it } from "vitest";
import { clockOffset, producerAttemptVerdict, FEATURE_OUTPUT_SHA256, type Attempt } from "../../scripts/feature-store/producer-capacity-contract.ts";

const attempt = (feature = false): Attempt => {
  const digest = "a".repeat(64), key = "raw/" + digest;
  return { workload: feature ? "features-2025" : "games.csv.gz", block: 1, temperature: "cold", id: "test",
    clock: clockOffset(Array.from({ length: 10 }, () => ({ hostBeforeMs: 1, hostAfterMs: 1, databaseMs: 1 }))),
    admissionUsedBytes: 40_000_000,
    disk: [{ at: "test", mountBytes: 2_147_483_648, usedBytes: 100_000_000, availableBytes: 2_047_483_648, walBytes: 0, tempFiles: [], databases: [] }],
    cleanup: { verified: true, deleted: true, objects: [{ key, sha256: digest, byteSize: 10 }] },
    preparation: feature ? Array.from({ length: 16 }, (_, i) => ({ name: String(i), sha256: digest, sql: 12 })) : [],
    featureParity: feature ? { rows: 1948, lineage: 31168, historicalFlags: true, sha256: FEATURE_OUTPUT_SHA256 } : undefined,
    measurement: { totalMs: feature ? 84_000 : 42_000, liveMs: feature ? 0 : 20_000, pinnedMs: feature ? 0 : 22_000,
      startupMs: 10, spawnMs: 1, bootstrapMs: 2, importMs: 5, connectMs: 3, setupMs: 0, censored: false,
      result: { status: "completed", handlerMs: 100, sql: Array.from({ length: feature ? 8 : 12 }, (_, index) =>
        ({ index: index + 1, sqlSha256: digest, kind: "statement", elapsedMs: 1, status: "completed" })),
      ...(feature ? { features: { status: "succeeded", jobId: "job", rows: 1948, materializations: 1, perExampleQueries: 0, sourceByteReads: 0 } }
        : { live: { status: "completed", elapsedMs: 20_000, expected: { wire_bytes: 10, sha256: digest, provider_digest: null },
          observed: { wireBytes: 11, sha256: "b".repeat(64) }, changed: { wireBytes: true, sha256: true, providerDigest: null }, requests: [], redirects: 0, error: null },
        loopback: { kind: "test-only-loopback", origin: "http://127.0.0.1:1234", pathname: "/fixture/0", sourceUrl: "https://github.com/original", key, sha256: digest, wireBytes: 10, reads: 1, requests: 1 },
        ingestion: { status: "ingested", wireBytes: 10, sha256: digest, bulkInserts: 1 } }) } },
  };
};
describe("#169 shared verdict", () => {
  for (const feature of [false, true]) {
    it(`accepts equality at the ${feature ? 84 : 42}s target`, () => expect(producerAttemptVerdict(attempt(feature))).toEqual({ pass: true, errors: [] }));
    it(`refuses just above the ${feature ? 84 : 42}s target`, () => {
      const a = attempt(feature); a.measurement.totalMs += .001; if (!feature) a.measurement.pinnedMs += .001;
      expect(producerAttemptVerdict(a).errors).toContain("capacity-target");
    });
    it(`refuses timeout/refusal despite otherwise valid ${feature ? "feature" : "ingestion"} work`, () => {
      const a = attempt(feature); a.measurement.censored = true;
      expect(producerAttemptVerdict(a).errors).toContain("failed-or-censored");
    });
  }
  it("upstream drift is observation; pinned transport or missing cleanup fails", () => {
    const a = attempt(); expect(producerAttemptVerdict(a).pass).toBe(true);
    a.measurement.result!.loopback!.reads = 0;
    expect(producerAttemptVerdict(a).errors).toContain("pinned-ingestion");
    a.cleanup.deleted = false; expect(producerAttemptVerdict(a).errors).toContain("raw-cleanup");
  });
  it("requires exact 8/12 work and the established full feature content identity", () => {
    const a = attempt(true); a.measurement.result!.sql.pop(); a.featureParity!.sha256 = "b".repeat(64);
    expect(producerAttemptVerdict(a).errors).toEqual(["sql-budget", "feature-work-or-parity"]);
  });
  it("diagnostic observations never change the verdict", () => {
    const a = attempt(true); const before = producerAttemptVerdict(a);
    a.diagnostics = { before: { wal: { wal_bytes: 99999 } }, after: { wal: { wal_bytes: 0 } }, autovacuum: [{ at: "now", activity: [{ query: "autovacuum" }] }] };
    expect(producerAttemptVerdict(a)).toEqual(before);
  });
});
