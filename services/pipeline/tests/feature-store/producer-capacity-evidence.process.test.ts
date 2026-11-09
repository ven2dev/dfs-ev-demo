import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compactProducerBenchmark, collectProducerBenchmark, publishProducerEvidence, verifyProducerBenchmark } from "../../scripts/feature-store/producer-capacity-evidence.ts";
import { verifyEvidenceBundle, verifyEvidenceReceipt } from "../../scripts/feature-store/artifact-governance-evidence.ts";
import { deterministicEvidenceBundle } from "../../scripts/feature-store/evidence-bundle.ts";
import { attemptId, capacitySchedule, producerAttemptVerdict, type Attempt } from "../../scripts/feature-store/producer-capacity-contract.ts";
import { openLocalObjectStore } from "../../src/featureStore/localObjectStore.ts";
import { producerEvidenceFixture, stopProducerEvidence } from "./producer-capacity-evidence-fixture.ts";

const first = attemptId(capacitySchedule()[0]), last = attemptId(capacitySchedule().at(-1)!);
const a = (f: ReturnType<typeof producerEvidenceFixture>, id = first) => f.records[id + ".result.json"] as Attempt & { verdict: ReturnType<typeof producerAttemptVerdict> };
describe("#169 durable evidence recomputation", () => {
  it("recomputes 30 attempts, 15 restarts and 12/8 work from exact source bytes", () => {
    const result = verifyProducerBenchmark(producerEvidenceFixture());
    expect(result).toMatchObject({ qualification: "pass", started: 30, completed: 30 });
    expect(result.attempts.map(a => a.sql)).toEqual([...Array(24).fill(12), ...Array(6).fill(8)]);
  });
  for (const [name, mutate] of Object.entries({
    "unknown schema": f => { f.schemaVersion = 2 as 1; },
    "unknown format": f => { (f.records["run-started.json"] as { format: string }).format = "future"; },
    "missing #241 source": f => { const s = f.records["run-started.json"] as { source: { source: { path: string }[] } }; s.source.source = s.source.source.filter(s => !s.path.endsWith("241_job_visibility.sql")); },
    "source byte tampering": f => { (f.records["sources.json"] as Record<string, string>)["package.json"] = Buffer.from("tampered").toString("base64"); },
    "source blob tampering": f => { (f.records["run-started.json"] as { source: { source: { gitBlobId: string }[] } }).source.source[0].gitBlobId = "b".repeat(40); },
    "missing attempt": f => { delete f.records[first + ".result.json"]; },
    "missing started marker": f => { delete f.records[first + ".started.json"]; },
    "replacement sample": f => { f.records["replacement.result.json"] = f.records[first + ".result.json"]; },
    "changed schedule": f => { (f.records["run-started.json"] as { schedule: unknown[] }).schedule.reverse(); },
    "missing measurement": f => { delete f.records[first + ".measurement.json"]; },
    "omitted network time": f => { a(f).measurement.liveMs = 100; },
    "forged verdict": f => { a(f).verdict = { pass: false, errors: [] }; },
    "wrong SQL count": f => { a(f).measurement.result!.sql.pop(); },
    "no cleanup": f => { a(f).cleanup.deleted = false; },
    "wrong destination pin": f => { a(f).cleanup.objects[0].sha256 = "f".repeat(64); },
    "wrong loopback origin": f => { a(f).measurement.result!.loopback!.origin = "https://github.com"; },
    "wrong loopback pin": f => { a(f).measurement.result!.loopback!.wireBytes++; },
    "undisclosed drift": f => { a(f).measurement.result!.live!.observed.wireBytes++; },
    "wrong live host": f => { a(f).measurement.result!.live!.requests[0].host = "127.0.0.1"; },
    "clock pass forged": f => { a(f).clock.observations[0].databaseMs = 1000; },
    "clock bound forged": f => { a(f).clock.observations[0].lowerMs++; },
    "server reused": f => { const b = f.records["games.csv.gz-b2.json"] as { container: string }; b.container = (f.records["games.csv.gz-b1.json"] as { container: string }).container; },
    "process reused": f => { a(f, last).measurement.pid = a(f).measurement.pid; },
    "scratch database reused": f => { (f.records[last + ".context.json"] as { database: string }).database = (f.records[first + ".context.json"] as { database: string }).database; },
    "destination was not empty": f => { (f.records[first + ".context.json"] as { initialRawObjects: number }).initialRawObjects = 1; },
    "teardown omitted": f => { delete f.records["games.csv.gz-b1.down.json"]; },
    "wrong tier": f => { (f.records["run-started.json"] as { tier: string }).tier = "standard"; },
    "preflight omitted": f => { delete f.records[first + ".work-preflight.json"]; },
    "below admission": f => { (f.records[first + ".work-preflight.json"] as { diskPreflight: { availableBytes: number } }).diskPreflight.availableBytes = 0; },
    "warm setup omitted": f => { delete f.records[attemptId(capacitySchedule()[1]) + ".setup.json"]; },
    "warm startup charged": f => { a(f, attemptId(capacitySchedule()[1])).measurement.startupMs++; },
    "feature preparation replaced": f => { a(f, last).preparation[0].sha256 = "f".repeat(64); },
    "feature content replaced": f => { a(f, last).featureParity!.sha256 = "f".repeat(64); },
    "feature diagnostics omitted": f => { delete a(f, last).diagnostics; },
    "late event": f => { f.events.push(f.events[0]); },
    "duplicate statement": f => { f.events.splice(3, 0, f.events[3]); },
    "negative duration": f => { a(f).measurement.totalMs = -1; },
    "nonfinite duration": f => { a(f).measurement.result!.handlerMs = Infinity; },
  } satisfies Record<string, (f: ReturnType<typeof producerEvidenceFixture>) => void>)) it(`refuses ${name}`, () => {
    const full = producerEvidenceFixture(); mutate(full); expect(() => verifyProducerBenchmark(full)).toThrow();
  });
  it("keeps upstream byte changes as observations when protocol and pinned ingestion pass", () => {
    const f = producerEvidenceFixture(), attempt = a(f), live = attempt.measurement.result!.live!;
    if (live.status !== "completed") throw new Error("test");
    live.observed.sha256 = "b".repeat(64); live.changed.sha256 = true;
    if (live.changed.providerDigest !== null) live.changed.providerDigest = true;
    f.records[first + ".measurement.json"] = structuredClone(attempt.measurement);
    f.events.find(e => e.id === first && e.kind === "live-complete")!.live = live;
    expect(verifyProducerBenchmark(f).qualification).toBe("pass");
  });
  for (const code of ["ingest-http-refused", "ingest-transport-failed", "ingest-wire-size-mismatch", "ingest-deadline-exceeded"]) it(`retains ${code} as a stopped, unqualified run`, () => {
    const f = producerEvidenceFixture(); stopProducerEvidence(f, 0); const attempt = a(f), m = attempt.measurement;
    const original = m.result!.live!;
    m.censored = true; m.error = code;
    m.result = { status: "failed", sql: [], handlerMs: 0, live: { ...original, status: "failed", observed: { wireBytes: 10, sha256: null },
      changed: null, error: { code, censored: true } } };
    attempt.cleanup.objects = []; attempt.verdict = producerAttemptVerdict(attempt);
    f.records[first + ".measurement.json"] = structuredClone(m);
    f.records[first + ".error.json"] = { error: code, censored: true };
    f.events = f.events.filter(e => e.kind === "bootstrap" || e.kind === "ready" || e.kind === "live-complete");
    f.events.at(-1)!.live = m.result.live;
    expect(verifyProducerBenchmark(f)).toMatchObject({ qualification: "not-qualified", completed: 1, attempts: [{ censored: true }] });
    f.schemaVersion = 9 as 1; expect(() => verifyProducerBenchmark(f)).toThrow();
  });
  it("rejects attempts appended after a failed attempt", () => {
    const f = producerEvidenceFixture(), attempt = a(f); attempt.measurement.censored = true; attempt.verdict = producerAttemptVerdict(attempt);
    expect(() => verifyProducerBenchmark(f)).toThrow();
  });
  it("keeps partial started attempts unqualified instead of replacing them", () => {
    const f = producerEvidenceFixture(); stopProducerEvidence(f, 0);
    delete f.records[first + ".result.json"]; (f.records["run-ended.json"] as { completed: number }).completed = 0;
    f.events = f.events.filter(e => ["bootstrap", "ready"].includes(e.kind));
    expect(verifyProducerBenchmark(f)).toMatchObject({ qualification: "not-qualified", started: 1, completed: 0,
      interrupted: [{ id: first, totalMs: 1000, liveMs: 400, pinnedMs: 600 }] });
  });
  it("hashes before parsing and compares the entire compact projection", () => {
    const bytes = Buffer.from(JSON.stringify(producerEvidenceFixture())), receipt = compactProducerBenchmark(bytes, "records.tar.gz#run.json");
    expect(() => verifyEvidenceReceipt(receipt, Buffer.from("not JSON"))).toThrow(/sha256/);
    expect(() => verifyEvidenceReceipt({ ...receipt, verification: { ...receipt.verification, started: 29 } }, bytes)).toThrow(/receipt-mismatch/);
    verifyEvidenceReceipt(receipt, bytes);
  });
  // Repeated fsync, gzip and archive audits use the process-class liveness budget.
  it("publishes deterministic ObjectStore records/mirrors without overwriting and uses the common auditor", async () => {
    const { realpath } = await import("node:fs/promises");
    const root = await realpath(await mkdtemp(join(tmpdir(), "dfs169-evidence-")));
    try {
      const store = await openLocalObjectStore(root), evidence = join(root, "evidence"), full = producerEvidenceFixture();
      const receipt = await publishProducerEvidence(full, store, evidence, "20261109T040000Z");
      const bytes = await store.get(receipt.objectStore.objectKey);
      expect((await verifyEvidenceBundle(evidence)).length).toBe(1);
      const archive = await readFile(join(evidence, "records-20261109T040000Z.tar.gz"));
      expect(archive.equals(deterministicEvidenceBundle([{ member: "run-20261109T040000Z.json", bytes }]))).toBe(true);
      await expect(publishProducerEvidence(full, store, evidence, "20261109T040000Z")).rejects.toThrow(/EEXIST/);
      expect((await readFile(join(evidence, "records-20261109T040000Z.tar.gz")))).toEqual(archive);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("collects a journal and refuses a truncated event line", async () => {
    const root = await mkdtemp(join(tmpdir(), "dfs169-collect-"));
    try {
      const f = producerEvidenceFixture();
      for (const [name, body] of Object.entries(f.records)) await writeFile(join(root, name), JSON.stringify(body));
      await writeFile(join(root, "events.jsonl"), f.events.map(e => JSON.stringify(e)).join("\n") + "\n");
      expect(await collectProducerBenchmark(root)).toEqual(f);
      await writeFile(join(root, "events.jsonl"), "{}");
      await expect(collectProducerBenchmark(root)).rejects.toThrow(/truncated/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
