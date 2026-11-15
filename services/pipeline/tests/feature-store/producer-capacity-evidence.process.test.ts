import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sha256 } from "../../src/featureStore/objectStore.ts";
import { compactProducerBenchmark, collectProducerBenchmark, publishProducerEvidence, verifyProducerBenchmark } from "../../scripts/feature-store/producer-capacity-evidence.ts";
import { verifyEvidenceBundle, verifyEvidenceReceipt } from "../../scripts/feature-store/artifact-governance-evidence.ts";
import { deterministicEvidenceBundle } from "../../scripts/feature-store/evidence-bundle.ts";
import { attemptId, capacitySchedule, producerAttemptVerdict, type Attempt } from "../../scripts/feature-store/producer-capacity-contract.ts";
import { openLocalObjectStore } from "../../src/featureStore/localObjectStore.ts";
import { producerEvidenceFixture, stopProducerEvidence } from "./producer-capacity-evidence-fixture.ts";

const first = attemptId(capacitySchedule()[0]), last = attemptId(capacitySchedule().at(-1)!);
const a = (f: ReturnType<typeof producerEvidenceFixture>, id = first) => f.records[id + ".result.json"] as Attempt & { verdict: ReturnType<typeof producerAttemptVerdict> };
type Fixture = ReturnType<typeof producerEvidenceFixture>;
// Keep redundant observations consistent so a test reaches the named safeguard,
// rather than passing because an earlier copy/checksum comparison rejected it.
const editAttempt = (f: Fixture, edit: (attempt: ReturnType<typeof a>) => void, id = first) => {
  const attempt = a(f, id); edit(attempt);
  f.records[id + ".measurement.json"] = structuredClone(attempt.measurement);
  f.records[id + ".diagnostics.json"] = { ...(attempt.diagnostics ? { diagnostics: attempt.diagnostics } : {}), disk: attempt.disk };
};
const editSources = (f: Fixture, edit: (source: { path: string; sha256: string; gitBlobId: string }[]) => void) => {
  const header = f.records["run-started.json"] as { source: { contentSha256: string; source: { path: string; sha256: string; gitBlobId: string }[] } };
  edit(header.source.source);
  header.source.contentSha256 = sha256(Buffer.from(JSON.stringify(header.source.source)));
  f.records["source-ended.json"] = structuredClone(header.source);
};
describe("#169 durable evidence recomputation", () => {
  it("recomputes 30 attempts, 15 restarts and 12/8 work from exact source bytes", () => {
    const result = verifyProducerBenchmark(producerEvidenceFixture());
    expect(result).toMatchObject({ qualification: "pass", started: 30, completed: 30 });
    expect(result.attempts.map(a => a.sql)).toEqual([...Array(24).fill(12), ...Array(6).fill(8)]);
  });
  for (const [name, mutate] of Object.entries({
    "unknown schema": f => { f.schemaVersion = 2 as 1; },
    "unknown format": f => { (f.records["run-started.json"] as { format: string }).format = "future"; },
    "missing #241 source": f => {
      const path = "packages/db/proposals/241_job_visibility.sql";
      editSources(f, sources => { sources.splice(sources.findIndex(s => s.path === path), 1); });
      delete (f.records["sources.json"] as Record<string, string>)[path];
    },
    "source byte tampering": f => { (f.records["sources.json"] as Record<string, string>)["package.json"] = Buffer.from("tampered").toString("base64"); },
    "source blob tampering": f => { editSources(f, sources => { sources[0].gitBlobId = "b".repeat(40); }); },
    "missing attempt": f => { delete f.records[first + ".result.json"]; },
    "missing started marker": f => { delete f.records[first + ".started.json"]; },
    "replacement sample": f => { f.records["replacement.result.json"] = f.records[first + ".result.json"]; },
    "changed schedule": f => { (f.records["run-started.json"] as { schedule: unknown[] }).schedule.reverse(); },
    "missing measurement": f => { delete f.records[first + ".measurement.json"]; },
    "omitted network time": f => { editAttempt(f, a => { a.measurement.liveMs = 100; a.measurement.pinnedMs = 900; }); },
    "forged verdict": f => { a(f).verdict = { pass: false, errors: [] }; },
    "wrong SQL count": f => { editAttempt(f, a => { a.measurement.result!.sql.pop(); }); },
    "no cleanup": f => { a(f).cleanup.deleted = false; },
    "wrong destination pin": f => { a(f).cleanup.objects[0].sha256 = "f".repeat(64); },
    "wrong loopback origin": f => { editAttempt(f, a => { a.measurement.result!.loopback!.origin = "https://github.com"; }); },
    "wrong loopback pin": f => { editAttempt(f, a => { a.measurement.result!.loopback!.sourceUrl = "https://github.com/changed"; }); },
    "undisclosed drift": f => { editAttempt(f, a => { a.measurement.result!.live!.changed!.sha256 = true; }); },
    "wrong live host": f => { editAttempt(f, a => { a.measurement.result!.live!.requests[0].host = "127.0.0.1"; }); },
    "clock pass forged": f => { (f.records["games.csv.gz-b1.json"] as { clock: Attempt["clock"] }).clock.observations[0].databaseMs = 1000; },
    "clock bound forged": f => { (f.records["games.csv.gz-b1.json"] as { clock: Attempt["clock"] }).clock.observations[0].lowerMs++; },
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
    "feature diagnostics omitted": f => { editAttempt(f, a => { delete a.diagnostics; }, last); },
    "late event": f => { f.events.push(f.events[0]); },
    "duplicate statement": f => { f.events.splice(3, 0, f.events[3]); },
    "negative duration": f => { a(f).measurement.totalMs = -1; },
    "nonfinite duration": f => { editAttempt(f, a => { a.measurement.result!.handlerMs = Infinity; }); },
  } satisfies Record<string, (f: ReturnType<typeof producerEvidenceFixture>) => void>)) it(`refuses ${name}`, () => {
    const full = producerEvidenceFixture(); mutate(full);
    const expected: Record<string, string | { actual?: unknown; expected?: unknown; operator?: string }> = {
      "unknown schema": { actual: 2, expected: 1, operator: "strictEqual" },
      "unknown format": { actual: "future", expected: "producer-capacity-v1", operator: "strictEqual" },
      "missing #241 source": "producer-missing-source: packages/db/proposals/241_job_visibility.sql",
      "source byte tampering": "producer-source-sha256", "source blob tampering": "producer-source-blob",
      "missing attempt": "producer-attempt-after-stop", "missing started marker": "producer-orphan-attempt-record",
      "replacement sample": "producer-unexpected-record: replacement.result.json", "changed schedule": "producer-schedule",
      "missing measurement": `producer-missing-record: ${first}.measurement.json`,
      "omitted network time": "producer-omitted-network-time", "forged verdict": "producer-verdict-recomputation",
      "wrong SQL count": "producer-verdict-recomputation", "no cleanup": "producer-verdict-recomputation",
      "wrong destination pin": "producer-verdict-recomputation", "wrong loopback origin": "producer-verdict-recomputation",
      "wrong loopback pin": "producer-loopback-pin", "undisclosed drift": "producer-live-drift", "wrong live host": "producer-live-host",
      "clock pass forged": "producer-clock-recomputation", "clock bound forged": "producer-clock-recomputation",
      "server reused": "producer-server-not-restarted", "process reused": "producer-process-reused",
      "scratch database reused": "producer-database-reused", "destination was not empty": { actual: 1, expected: 0, operator: "strictEqual" },
      "teardown omitted": "producer-missing-teardown", "wrong tier": { actual: "standard", expected: "large", operator: "strictEqual" },
      "preflight omitted": `producer-missing-record: ${first}.work-preflight.json`, "below admission": "producer-disk-admission",
      "warm setup omitted": "producer-missing-record: games.csv.gz-b1-warm.setup.json",
      "warm startup charged": { actual: 1, expected: 0, operator: "strictEqual" },
      "feature preparation replaced": "producer-preparation-population", "feature content replaced": "producer-verdict-recomputation",
      "feature diagnostics omitted": { actual: undefined, expected: true, operator: "==" },
      "late event": "producer-event-order", "duplicate statement": "producer-protocol-trace",
      "negative duration": "producer-invalid-number", "nonfinite duration": "producer-invalid-number",
    };
    const verdictErrors: Record<string, string[]> = {
      "wrong SQL count": ["sql-budget"], "no cleanup": ["raw-cleanup"],
      "wrong destination pin": ["pinned-ingestion"], "wrong loopback origin": ["pinned-ingestion"],
      "feature content replaced": ["feature-work-or-parity"],
    };
    if (verdictErrors[name]) {
      expect(producerAttemptVerdict(a(full, name === "feature content replaced" ? last : first)))
        .toEqual({ pass: false, errors: verdictErrors[name] });
    }
    const error = (() => { try { verifyProducerBenchmark(full); } catch (error) { return error; } })();
    expect(error).toMatchObject({ code: "ERR_ASSERTION" });
    if (typeof expected[name] === "string") expect((error as Error).message.split("\n")[0]).toBe(expected[name]);
    else expect(error).toMatchObject(expected[name]);
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
    const f = producerEvidenceFixture();
    editAttempt(f, attempt => { attempt.measurement.censored = true; attempt.verdict = producerAttemptVerdict(attempt); });
    expect(() => verifyProducerBenchmark(f)).toThrow("producer-attempt-after-stop");
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
