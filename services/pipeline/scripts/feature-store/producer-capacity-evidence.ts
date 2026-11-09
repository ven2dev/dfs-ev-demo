import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { sha256, type ObjectStore } from "../../src/featureStore/objectStore.ts";
import { deterministicEvidenceBundle } from "./evidence-bundle.ts";
import { INGEST_LIMITS, type SourceAsset } from "../../src/featureStore/source.ts";
import { attemptId, capacitySchedule, clockOffset, PRODUCER_CAPACITY_FORMAT, producerAttemptVerdict,
  type Attempt, type ClockPreflight, type DiskSample, type SourcePin, type ProcessMeasurement, type StatementTime } from "./producer-capacity-contract.ts";
import { PRODUCER_CAPACITY_SOURCES } from "./producer-capacity-runtime.ts";

export type ProducerBenchmark = { kind: "producer-capacity-benchmark"; issue: 169; schemaVersion: 1;
  records: Record<string, unknown>; events: { id: string; at: string; kind: string; [key: string]: unknown }[] };
type SourceInventory = { gitSha: string; contentSha256: string; source: { path: string; sha256: string; gitBlobId: string }[] };
type Header = { format: string; issue: number; source: SourceInventory; runtime: string; loader: string;
  lane: string; tier: string; port: number; parentPid: number; schedule: ReturnType<typeof capacitySchedule>; quietWindow: string };
type End = { format: string; issue: number; verdict: "pass" | "fail"; completed: number; containerAbsent: boolean; error?: string };
type Block = { clock: ClockPreflight; container: string; identity: { started: string; version: string }; admission: DiskSample; restart: string };
type RecordedAttempt = Attempt & { verdict: ReturnType<typeof producerAttemptVerdict> };
const manifestPath = "docs/evidence/feature-store-138/step-3-source-manifest.json";
const manifestBytes = readFileSync(new URL("../../../../" + manifestPath, import.meta.url));
const originalPins = (JSON.parse(manifestBytes.toString()) as { assets: { asset: SourceAsset }[] }).assets
  .map(({ asset }) => ({ asset, key: "raw/" + asset.sha256 })).sort((a, b) =>
    a.asset.feed === "schedules" ? -1 : b.asset.feed === "schedules" ? 1 : a.asset.name.localeCompare(b.asset.name));
const number = (n: number) => assert(typeof n === "number" && Number.isFinite(n) && n >= 0, "producer-invalid-number");
const date = (value: string) => assert(typeof value === "string" && Number.isFinite(Date.parse(value)), "producer-invalid-clock");
const near = (a: number, b: number) => assert(Math.abs(a - b) <= 1e-6, "producer-timing-arithmetic");
const record = <T>(full: ProducerBenchmark, name: string): T => {
  const value = full.records[name];
  assert(value && typeof value === "object" && !Array.isArray(value), "producer-missing-record: " + name);
  return value as T;
};
const verifyClock = (clock: ClockPreflight) => assert.deepEqual(clock, clockOffset(clock.observations), "producer-clock-recomputation");
const verifyDisk = (d: DiskSample) => {
  date(d.at);
  for (const n of [d.mountBytes, d.usedBytes, d.availableBytes, d.walBytes]) number(n);
  assert.equal(d.mountBytes, 2_147_483_648, "producer-wrong-disk-tier");
  assert(d.usedBytes <= d.mountBytes && d.availableBytes <= d.mountBytes && d.walBytes <= d.mountBytes);
  assert(Array.isArray(d.tempFiles) && Array.isArray(d.databases));
};
const verifyPreflight = (value: { diskPreflight: Record<string, unknown> }) => {
  const p = value.diskPreflight;
  assert.equal(p.project, "dfs-ev-demo-test-lane-3"); assert.equal(p.tier, "large");
  assert.equal(p.capacityBytes, 2_147_483_648); assert.equal(p.requiredFreeBytes, 608 * 1024 ** 2);
  number(p.availableBytes as number); number(p.retainedWalBytes as number);
  assert((p.availableBytes as number) >= (p.requiredFreeBytes as number), "producer-disk-admission");
};

const verifySources = (full: ProducerBenchmark, source: SourceInventory) => {
  assert(/^[a-f0-9]{40}$/.test(source.gitSha));
  assert.equal(source.contentSha256, sha256(Buffer.from(JSON.stringify(source.source))), "producer-source-inventory-hash");
  const paths = source.source.map(s => s.path);
  assert.deepEqual(paths, [...new Set(paths)].sort(), "producer-source-population");
  for (const path of PRODUCER_CAPACITY_SOURCES) assert(paths.includes(path), "producer-missing-source: " + path);
  const bodies = record<Record<string, string>>(full, "sources.json");
  assert.deepEqual(Object.keys(bodies).sort(), paths, "producer-source-bytes-population");
  for (const s of source.source) {
    assert(/^[a-zA-Z0-9][a-zA-Z0-9_./-]*$/.test(s.path) && s.path.split("/").every(p => p && p !== "." && p !== ".."));
    assert(typeof bodies[s.path] === "string");
    const bytes = Buffer.from(bodies[s.path], "base64");
    assert.equal(bytes.toString("base64"), bodies[s.path], "producer-invalid-source-encoding");
    assert.equal(sha256(bytes), s.sha256, "producer-source-sha256");
    const blob = createHash("sha1").update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest("hex");
    assert.equal(blob, s.gitBlobId, "producer-source-blob");
    if (s.path === manifestPath) assert(bytes.equals(manifestBytes), "producer-fixture-repinned");
  }
  const migrations = JSON.parse(Buffer.from(bodies["packages/db/migration-manifest.json"], "base64").toString()) as { migrations: { filename: string; version: number; sha256: string }[] };
  assert(Array.isArray(migrations.migrations) && migrations.migrations.length);
  for (const m of migrations.migrations) {
    assert(/^\d{4}_[a-z0-9_]+\.sql$/.test(m.filename) && Number.isInteger(m.version) && m.version > 0);
    const sql = source.source.find(s => s.path === "packages/db/migrations/" + m.filename);
    assert(sql?.sha256 === m.sha256, "producer-missing-migration-pin");
    assert(paths.includes("packages/db/catalog-contracts/" + String(m.version).padStart(4, "0") + ".json"), "producer-missing-catalog-pin");
  }
};

const verifyLive = (a: Attempt, asset: SourceAsset) => {
  const m = a.measurement, live = m.result?.live;
  if (!live) { assert(m.censored, "producer-missing-live-transfer"); return; }
  assert.deepEqual(live.expected, { wire_bytes: asset.wire_bytes, sha256: asset.sha256, provider_digest: asset.provider_digest }, "producer-live-pin");
  number(live.elapsedMs); assert(live.elapsedMs <= m.liveMs + 1e-6, "producer-omitted-network-time");
  number(live.observed.wireBytes);
  assert(live.observed.wireBytes <= INGEST_LIMITS.wireBytes);
  assert(Number.isInteger(live.redirects) && live.redirects >= 0 && live.redirects <= 4);
  assert(Array.isArray(live.requests) && live.requests.length <= 4);
  for (const [i, request] of live.requests.entries()) {
    assert((i === 0 ? ["github.com"] : ["github.com", "release-assets.githubusercontent.com"]).includes(request.host), "producer-live-host");
    if (request.contentLength !== null) number(request.contentLength);
    if (request.status !== null) assert(Number.isInteger(request.status) && request.status >= 100 && request.status <= 599);
  }
  if (live.status === "completed") {
    assert(live.requests.length > 0); assert.equal(live.requests.at(-1)!.status, 200);
    assert.equal(live.redirects, live.requests.length - 1);
    assert(live.requests.slice(0, -1).every(r => [301, 302, 303, 307, 308].includes(r.status!)));
    const length = live.requests.at(-1)!.contentLength;
    if (length !== null) assert.equal(length, live.observed.wireBytes, "producer-live-protocol-size");
    assert(/^[a-f0-9]{64}$/.test(live.observed.sha256)); assert.equal(live.error, null);
    assert.deepEqual(live.changed, { wireBytes: live.observed.wireBytes !== asset.wire_bytes,
      sha256: live.observed.sha256 !== asset.sha256,
      providerDigest: asset.provider_digest === null ? null : "sha256:" + live.observed.sha256 !== asset.provider_digest }, "producer-live-drift");
  } else {
    assert.equal(live.status, "failed"); assert.equal(live.observed.sha256, null); assert.equal(live.changed, null);
    assert(live.error.censored && typeof live.error.code === "string"); assert(m.censored);
  }
};

const verifyAttempt = (full: ProducerBenchmark, a: RecordedAttempt, block: Block, pins: SourcePin[]) => {
  const id = attemptId(a), feature = a.workload === "features-2025", m = a.measurement, r = m.result;
  assert.equal(a.id, id); assert.deepEqual(a.clock, block.clock); verifyClock(a.clock);
  assert.equal(a.admissionUsedBytes, block.admission.usedBytes);
  for (const n of [m.totalMs, m.liveMs, m.pinnedMs, m.startupMs, m.spawnMs, m.bootstrapMs, m.importMs, m.connectMs, m.setupMs]) number(n);
  assert(typeof m.censored === "boolean");
  if (m.pid !== undefined) assert(Number.isSafeInteger(m.pid) && m.pid > 0);
  if (m.error) { assert(m.censored); if (m.sqlState !== undefined) assert(/^[0-9A-Z]{5}$/.test(m.sqlState)); }
  if (a.temperature === "warm") {
    assert.equal(m.startupMs, 0);
    const setup = record<Record<string, number>>(full, id + ".setup.json");
    for (const key of ["pid", "setupMs", "spawnMs", "bootstrapMs", "importMs", "connectMs"] as const) assert.equal(setup[key], m[key]);
  } else {
    assert.equal(m.setupMs, 0); assert(m.startupMs <= m.totalMs);
    assert(m.bootstrapMs <= m.startupMs || m.censored);
  }
  assert.deepEqual(record(full, id + ".measurement.json"), m, "producer-measurement-copy");
  const diagnostics = record<{ diagnostics?: Attempt["diagnostics"]; disk: DiskSample[] }>(full, id + ".diagnostics.json");
  assert.deepEqual(diagnostics, { ...(a.diagnostics ? { diagnostics: a.diagnostics } : {}), disk: a.disk }, "producer-diagnostics-copy");
  assert(a.disk.length >= 4); a.disk.forEach(verifyDisk);
  const preparationDisk = full.records[id + ".preparation-disk.json"] as DiskSample[];
  assert(Array.isArray(preparationDisk) && preparationDisk.length >= 2);
  assert.deepEqual(a.disk.slice(0, preparationDisk.length), preparationDisk);
  assert.deepEqual(a.verdict, producerAttemptVerdict(a), "producer-verdict-recomputation");
  if (r) {
    number(r.handlerMs);
    if (!m.censored) assert(r.handlerMs <= (feature ? m.totalMs - m.startupMs : m.pinnedMs) + 1e-6, "producer-handler-time-omitted");
    const sql = r.sql;
    assert(Array.isArray(sql));
    sql.forEach((q, i) => {
      assert.equal(q.index, i + 1); assert(/^[a-f0-9]{64}$/.test(q.sqlSha256)); number(q.elapsedMs);
      assert(["running", "completed", "failed"].includes(q.status));
    });
    if (!m.censored) assert(sql.reduce((sum, q) => sum + q.elapsedMs, 0) <= r.handlerMs + 1e-6, "producer-overlapping-sql-times");
  }
  const objects = a.cleanup.objects;
  assert(Array.isArray(objects)); assert.equal(new Set(objects.map(o => o.key)).size, objects.length);
  const selected = feature ? pins : pins.filter(p => p.asset.name === a.workload);
  for (const o of objects) {
    const pin = selected.find(p => p.key === o.key);
    assert(pin && o.sha256 === pin.asset.sha256 && o.byteSize === pin.asset.wire_bytes, "producer-cleanup-pin");
  }
  if (a.verdict.pass) assert.deepEqual(objects.map(o => o.key).sort(), selected.map(p => p.key).sort(), "producer-missing-cleanup-object");
  if (feature) {
    assert.equal(m.liveMs, 0); assert.equal(m.pinnedMs, 0);
    assert.deepEqual(a.preparation, pins.map(p => ({ name: p.asset.name, sha256: p.asset.sha256, sql: 12 })), "producer-preparation-population");
    assert(a.diagnostics?.before.checkpointer && a.diagnostics.before.wal && Array.isArray(a.diagnostics.before.tables));
    assert(a.diagnostics.after.checkpointer && a.diagnostics.after.wal && Array.isArray(a.diagnostics.after.tables));
    assert(Array.isArray(a.diagnostics.autovacuum) && a.diagnostics.autovacuum.length >= 2);
    a.diagnostics.autovacuum.forEach(s => { date(s.at); assert(Array.isArray(s.activity)); });
  } else {
    near(m.totalMs, m.liveMs + m.pinnedMs); assert.equal(a.preparation.length, 0);
    assert(selected.length === 1); const { asset, key } = selected[0]; verifyLive(a, asset);
    if (r?.loopback) assert.deepEqual({ ...r.loopback, origin: "origin" }, { kind: "test-only-loopback", origin: "origin", pathname: "/fixture/0",
      sourceUrl: asset.url, key, sha256: asset.sha256, wireBytes: asset.wire_bytes, reads: 1, requests: 1 }, "producer-loopback-pin");
  }
};

// Check exact bytes first in the containing auditor. This projection uses saved
// observations only; it never runs a workload, measures the host or contacts GitHub.
export const verifyProducerBenchmark = (full: ProducerBenchmark) => {
  assert.equal(full.kind, "producer-capacity-benchmark"); assert.equal(full.issue, 169); assert.equal(full.schemaVersion, 1);
  const header = record<Header>(full, "run-started.json"), end = record<End>(full, "run-ended.json");
  for (const r of [header, end]) { assert.equal(r.format, PRODUCER_CAPACITY_FORMAT); assert.equal(r.issue, 169); }
  assert(/^v24\./.test(header.runtime)); assert.equal(header.loader, "Node 24 native type stripping");
  assert.equal(header.lane, "lane-3"); assert.equal(header.tier, "large"); assert.equal(header.port, 54349);
  assert(Number.isSafeInteger(header.parentPid) && header.parentPid > 0);
  assert(typeof header.quietWindow === "string" && header.quietWindow.trim());
  assert.deepEqual(header.schedule, capacitySchedule(), "producer-schedule");
  verifySources(full, header.source);
  assert(["pass", "fail"].includes(end.verdict)); assert(typeof end.containerAbsent === "boolean");
  const pins = full.records["inputs.json"] ? record<{ pins: SourcePin[] }>(full, "inputs.json").pins : [];
  if (pins.length) assert.deepEqual(pins, originalPins, "producer-input-pins");
  const allowed = new Set(["run-started.json", "run-ended.json", "sources.json", "inputs.json", "source-ended.json"]);
  const started: string[] = [], results: RecordedAttempt[] = [], containers = new Set<string>(), pids = new Set<number>(), databases = new Set<string>();
  let stopped = false, incomplete = false;
  const presentBlocks = capacitySchedule().filter(c => c.temperature === "cold").filter(c => !!full.records[`${c.workload}-b${c.block}.json`]);
  assert.deepEqual(presentBlocks, capacitySchedule().filter(c => c.temperature === "cold").slice(0, presentBlocks.length), "producer-block-prefix");
  for (const c of presentBlocks) {
    const base = `${c.workload}-b${c.block}`, block = record<Block>(full, base + ".json");
    allowed.add(base + ".json"); allowed.add(base + ".down.json");
    verifyClock(block.clock); verifyDisk(block.admission);
    assert(block.admission.availableBytes >= 608 * 1024 ** 2, "producer-block-admission");
    assert(/^[a-f0-9]{64}$/.test(block.container) && !containers.has(block.container), "producer-server-not-restarted"); containers.add(block.container);
    date(block.identity.started); assert(typeof block.identity.version === "string");
    assert.equal(block.restart, "new server once before this cold/warm block");
    if (!block.clock.pass) { assert(!stopped); stopped = true; }
    if (full.records[base + ".down.json"]) assert.equal(record<{ containerAbsent: boolean }>(full, base + ".down.json").containerAbsent, true);
    else assert.equal(end.verdict, "fail", "producer-missing-teardown");
    for (const temperature of ["cold", "warm"] as const) {
      const coordinate = { ...c, temperature }, id = attemptId(coordinate);
      const suffixes = ["started", "context", "setup", "measurement", "diagnostics", "preparation-disk", "result", "error", "fixture-preflight", "preparation-preflight", "work-preflight"];
      suffixes.forEach(s => allowed.add(id + "." + s + ".json"));
      if (!full.records[id + ".started.json"]) {
        assert(suffixes.every(s => !(id + "." + s + ".json" in full.records)), "producer-orphan-attempt-record"); continue;
      }
      assert(!stopped && !incomplete, "producer-attempt-after-stop");
      const s = record<Record<string, unknown>>(full, id + ".started.json");
      assert.deepEqual({ workload: s.workload, block: s.block, temperature: s.temperature, id: s.id }, { ...coordinate, id });
      date(s.at as string); assert.deepEqual(s.clock, block.clock); started.push(id);
      const result = full.records[id + ".result.json"] as RecordedAttempt | undefined;
      if (result) {
        assert(pins.length === 16, "producer-missing-inputs");
        const context = record<{ database: string; user: string; destination: string; initialRawObjects: number }>(full, id + ".context.json");
        assert(/^dfs_ev_test_[a-f0-9]{20}$/.test(context.database) && !databases.has(context.database), "producer-database-reused"); databases.add(context.database);
        assert(/^fs138_job_[a-f0-9]{16}$/.test(context.user)); assert.equal(context.destination, id + "-objects"); assert.equal(context.initialRawObjects, 0);
        const pid = result.measurement.pid;
        if (pid !== undefined) { assert(pid !== header.parentPid && !pids.has(pid), "producer-process-reused"); pids.add(pid); }
        else assert(!result.verdict.pass, "producer-missing-process-identity");
        verifyPreflight(record(full, id + ".fixture-preflight.json")); verifyPreflight(record(full, id + ".work-preflight.json"));
        if (c.workload === "features-2025") verifyPreflight(record(full, id + ".preparation-preflight.json"));
        else assert(!full.records[id + ".preparation-preflight.json"]);
        assert.equal(attemptId(result), id); verifyAttempt(full, result, block, pins); results.push(result);
        if (!result.verdict.pass) stopped = true;
      } else incomplete = true;
      if (full.records[id + ".error.json"]) { assert.equal(end.verdict, "fail"); stopped = true; }
      if (temperature === "cold") assert(!full.records[id + ".setup.json"], "producer-cold-setup-excluded");
    }
  }
  assert.deepEqual(started, capacitySchedule().slice(0, started.length).map(attemptId), "producer-attempt-prefix");
  for (const name of Object.keys(full.records)) assert(allowed.has(name), "producer-unexpected-record: " + name);
  assert.equal(end.completed, results.length, "producer-result-count");
  const events = full.events; assert(Array.isArray(events));
  let last = -1;
  for (const event of events) {
    const i = started.indexOf(event.id); assert(i >= last && i >= 0, "producer-event-order"); last = i; date(event.at);
    assert(["bootstrap", "ready", "live-complete", "statement", "result", "error"].includes(event.kind), "producer-event-kind");
  }
  for (const a of results) {
    const events = full.events.filter(e => e.id === a.id);
    if (a.measurement.censored) {
      assert(!events.some(e => e.kind === "result"), "producer-late-result-after-interruption");
      const errors = events.filter(e => e.kind === "error"); assert(errors.length <= 1);
      if (errors.length) { assert.equal(events.at(-1), errors[0]); assert.equal(errors[0].error, a.measurement.error); }
      continue;
    }
    const sql = a.measurement.result!.sql;
    assert.deepEqual(events.map(e => e.kind), ["bootstrap", "ready", ...(a.workload === "features-2025" ? [] : ["live-complete"]),
      ...sql.flatMap(() => ["statement", "statement"]), "result"], "producer-protocol-trace");
    const statements = events.filter(e => e.kind === "statement").map(e => e.statement as StatementTime);
    sql.forEach((q, i) => { assert.deepEqual(statements[i * 2], { ...q, elapsedMs: 0, status: "running" }); assert.deepEqual(statements[i * 2 + 1], q); });
    if (a.measurement.result?.live) assert.deepEqual(events.find(e => e.kind === "live-complete")!.live, a.measurement.result.live);
    const result = events.at(-1)!.result as NonNullable<ProcessMeasurement["result"]>;
    const { live: _live, ...worker } = a.measurement.result!; void _live;
    assert.deepEqual(result, worker, "producer-worker-result-copy");
  }
  const qualified = results.length === 30 && results.every(a => a.verdict.pass) && !stopped && !incomplete && end.containerAbsent;
  if (end.verdict === "pass") {
    assert(qualified, "producer-false-qualification"); assert.equal(presentBlocks.length, 15);
    assert.deepEqual(record(full, "source-ended.json"), header.source, "producer-source-changed");
    assert(!end.error);
  }
  return { qualification: end.verdict === "pass" ? "pass" : "not-qualified", started: started.length, completed: results.length,
    attempts: results.map(a => ({ id: a.id, totalMs: a.measurement.totalMs, liveMs: a.measurement.liveMs, pinnedMs: a.measurement.pinnedMs,
      sql: a.measurement.result?.sql.length ?? 0, censored: a.measurement.censored, verdict: a.verdict,
      ...(a.measurement.error ? { error: a.measurement.error, sqlState: a.measurement.sqlState } : {}),
      peakBytes: Math.max(...a.disk.map(d => d.usedBytes)), growthBytes: Math.max(...a.disk.map(d => d.usedBytes)) - a.admissionUsedBytes })),
    interrupted: started.filter(id => !results.some(r => r.id === id)).map(id => {
      const m = full.records[id + ".measurement.json"] as ProcessMeasurement | undefined;
      const error = full.records[id + ".error.json"] as { error: string; censored: boolean } | undefined;
      return { id, qualification: "not-qualified", ...(m ? { totalMs: m.totalMs, liveMs: m.liveMs, pinnedMs: m.pinnedMs, censored: m.censored } : {}),
        error: error?.error ?? m?.error ?? end.error ?? "interrupted-before-result" };
    }),
    sourceCount: header.source.source.length, diagnostics: "observations only; no causal inference or capacity gate" };
};

export const compactProducerBenchmark = (bytes: Buffer, path: string) => {
  const full = JSON.parse(bytes.toString()) as ProducerBenchmark;
  const verification = verifyProducerBenchmark(full);
  const header = record<Header>(full, "run-started.json");
  const source = { gitSha: header.source.gitSha, contentSha256: header.source.contentSha256,
    hashes: Object.fromEntries(header.source.source.map(s => [s.path, s.sha256])),
    blobIds: Object.fromEntries(header.source.source.map(s => [s.path, s.gitBlobId])) };
  return { schemaVersion: 2, issue: 169, kind: full.kind, format: PRODUCER_CAPACITY_FORMAT, verification, source,
    objectStore: { objectKey: "audits/" + sha256(bytes), sha256: sha256(bytes), byteSize: bytes.length },
    fullRecord: { path, sha256: sha256(bytes), byteSize: bytes.length, format: "exact uncompressed producer-capacity JSON" } };
};

export const publishProducerEvidence = async (full: ProducerBenchmark, store: ObjectStore, directory: string, stamp: string) => {
  assert(/^\d{8}T\d{6}Z$/.test(stamp), "producer-evidence-name-refused");
  const bytes = Buffer.from(JSON.stringify(full, null, 2) + "\n"), member = "run-" + stamp + ".json", archive = "records-" + stamp + ".tar.gz";
  const receipt = compactProducerBenchmark(bytes, archive + "#" + member);
  const object = await store.putIfAbsent(receipt.objectStore.objectKey, bytes);
  assert.equal(object.object.sha256, receipt.objectStore.sha256); assert.equal(object.object.byteSize, bytes.length);
  assert((await store.get(receipt.objectStore.objectKey)).equals(bytes), "producer-evidence-object-mismatch");
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, archive), deterministicEvidenceBundle([{ member, bytes }]), { flag: "wx" });
  await writeFile(resolve(directory, "benchmark-" + stamp + ".json"), JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" });
  return receipt;
};

export const collectProducerBenchmark = async (directory: string): Promise<ProducerBenchmark> => {
  const records: Record<string, unknown> = {};
  for (const name of (await readdir(directory)).filter(n => n.endsWith(".json")).sort()) records[name] = JSON.parse(await readFile(resolve(directory, name), "utf8"));
  const lines = (await readFile(resolve(directory, "events.jsonl"), "utf8")).split("\n");
  assert.equal(lines.pop(), "", "producer-truncated-event-journal");
  const full: ProducerBenchmark = { kind: "producer-capacity-benchmark", issue: 169, schemaVersion: 1, records, events: lines.map(line => JSON.parse(line)) };
  verifyProducerBenchmark(full); return full;
};

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert.equal(process.argv[2], "check-journal"); assert(process.argv[3]);
  console.log(JSON.stringify(verifyProducerBenchmark(await collectProducerBenchmark(process.argv[3]))));
}
