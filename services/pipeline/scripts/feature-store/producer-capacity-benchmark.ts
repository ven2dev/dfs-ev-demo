import { execFileSync } from "node:child_process";
import { mkdir, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { arch, cpus, platform } from "node:os";
import { pathToFileURL } from "node:url";
import { Client } from "pg";
import { startDatabaseTestRun } from "@dfs-ev/db-tooling/test-support/lifecycle";
import { assertNoApplicationCredentials, parseTestDatabaseUrl } from "@dfs-ev/db-tooling/test-support/target";
import { withFeatureStoreDatabase } from "./harness.ts";
import { openLocalObjectStore } from "../../src/featureStore/localObjectStore.ts";
import { ingestSource } from "../../src/featureStore/ingest.ts";
import { openTransferFixture } from "./transfer-fixture.ts";
import { createProducerProcess } from "./producer-capacity-process.ts";
import { checkCapacityClock, observeCapacityTrial, sampleCapacityDisk } from "./producer-capacity-observe.ts";
import { capacitySchedule, attemptId, PRODUCER_CAPACITY_FORMAT, producerAttemptVerdict, type Attempt, type Coordinate } from "./producer-capacity-contract.ts";
import { cleanupProducerRaw, loadProducerPins, openProducerJournal, pinProducerSources, producerFeatureParity, producerSourceBytes } from "./producer-capacity-runtime.ts";

const repository = new URL("../../../../", import.meta.url);
const container = "dfs-ev-demo-test-lane-3-postgres-1";
const laneCommand = (command: string) => execFileSync(process.execPath, ["scripts/db/test-db.mjs", command], { cwd: repository,
  env: { ...process.env, DB_TEST_LANE: "lane-3", DB_TEST_TIER: "large" }, encoding: "utf8", timeout: 90_000 });
const containerPresent = () => execFileSync("docker", ["ps", "-aq", "--filter", "name=^/" + container + "$"], { encoding: "utf8" }).trim() !== "";

// Opt-in only. Tests exercise workers/observers separately on standard lane-3.
export const qualifyProducerCapacity = async () => {
  assertNoApplicationCredentials(process.env);
  if (process.env.DB_TEST_LANE !== "lane-3" || process.env.DB_TEST_TIER !== "large" ||
      !process.env.FS169_QUIET_WINDOW || !process.env.FS169_OUTPUT || !process.env.FS169_SOURCE_ROOT)
    throw new Error("producer-capacity-explicit-window-and-paths-required");
  if (Number(process.versions.node.split(".")[0]) !== 24) throw new Error("producer-capacity-node24-required");
  if (containerPresent()) throw new Error("producer-capacity-lane-already-reserved");
  const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=all", "--", ".", ":(exclude)codex-briefs/**"], { cwd: repository, encoding: "utf8" });
  if (dirty.trim()) throw new Error("producer-capacity-clean-committed-sources-required");
  const source = await pinProducerSources();
  const sourceRoot = await realpath(process.env.FS169_SOURCE_ROOT), output = resolve(process.env.FS169_OUTPUT);
  // A new output root prevents cleanup from touching original input objects.
  if (output === sourceRoot || output.startsWith(sourceRoot + "/") || sourceRoot.startsWith(output + "/")) throw new Error("producer-capacity-output-overlaps-source");
  const journal = await openProducerJournal(output);
  const signal = new AbortController();
  const abort = () => signal.abort(new Error("producer-capacity-interrupted"));
  process.once("SIGINT", abort); process.once("SIGTERM", abort);
  let failed: unknown, ownLane = false;
  const attempts: (Attempt & { verdict: ReturnType<typeof producerAttemptVerdict> })[] = [];
  const code = { gitSha: source.gitSha, contentSha256: source.contentSha256 };
  await journal.record("run-started.json", { format: PRODUCER_CAPACITY_FORMAT, issue: 169, source,
    lane: "lane-3", tier: "large", port: 54349, parentPid: process.pid,
    at: new Date().toISOString(), quietWindow: process.env.FS169_QUIET_WINDOW, runtime: process.version,
    machine: { arch: arch(), platform: platform(), cpus: cpus().length }, schedule: capacitySchedule(),
    loader: "Node 24 native type stripping", reset: "full down/up once per cold/warm block; fresh database/destination per attempt",
    cache: "tmpfs; preparation warms shared pages; OS/Docker/DNS/CDN uncontrolled", diagnosticsOnly: true });
  try {
    await journal.record("sources.json", await producerSourceBytes(source));
    const { store: originals, pins } = await loadProducerPins(sourceRoot);
    await journal.record("inputs.json", { pins });
    // Derive from CLI rather than carrying a literal port or unrelated URL.
    const environment = { ...process.env }; delete environment.TEST_DATABASE_URL;
    process.env.TEST_DATABASE_URL = execFileSync(process.execPath, ["scripts/db/test-db.mjs", "url"], { cwd: repository, env: environment, encoding: "utf8" }).trim();
    for (const c of capacitySchedule().filter(c => c.temperature === "cold")) {
      signal.signal.throwIfAborted();
      ownLane = true; laneCommand("up");
      const lease = await startDatabaseTestRun(process.env);
      const blockSignal = AbortSignal.any([signal.signal, lease.failureSignal]);
      const observer = new Client(parseTestDatabaseUrl(process.env.TEST_DATABASE_URL, "lane-3"));
      try {
        await observer.connect();
        const clock = await checkCapacityClock(observer);
        const identity = (await observer.query("SELECT pg_postmaster_start_time()::text AS started,version() AS version")).rows[0];
        const admission = await sampleCapacityDisk(observer);
        await journal.record(`${c.workload}-b${c.block}.json`, { clock, identity, admission,
          container: JSON.parse(execFileSync("docker", ["inspect", container], { encoding: "utf8" }))[0].Id,
          restart: "new server once before this cold/warm block" });
        if (!clock.pass) throw new Error("producer-capacity-environment-clock-refused");
        for (const temperature of ["cold", "warm"] as const) {
          const coordinate: Coordinate = { ...c, temperature }, id = attemptId(coordinate), feature = c.workload === "features-2025";
          await journal.record(id + ".started.json", { ...coordinate, id, at: new Date().toISOString(), clock });
          const preflight = (stage: string) => journal.record(id + "." + stage + "-preflight.json", JSON.parse(laneCommand("preflight").trim()));
          // Preflight directly before fixture/preparation, then again at dispatch.
          await preflight("fixture"); blockSignal.throwIfAborted();
          const destinationRoot = resolve(output, id + "-objects");
          await mkdir(destinationRoot, { mode: 0o700 });
          const destination = await openLocalObjectStore(await realpath(destinationRoot));
          const initialRawObjects = (await destination.list("raw")).length;
          if (initialRawObjects !== 0) throw new Error("producer-destination-not-empty");
          const setupMonitor = await observeCapacityTrial(observer, false);
          let censored = true;
          try {
            await withFeatureStoreDatabase(async db => {
              const preparation: Attempt["preparation"] = [];
              if (feature) {
                const fixture = await openTransferFixture(originals, pins, { testOnlyLoopback: true });
                try {
                  await preflight("preparation");
                  for (const pin of pins) {
                    blockSignal.throwIfAborted();
                    const before = db.queryCounts.writer;
                    const result = await ingestSource(db.writer, destination, pin.asset, code, { download: fixture.download });
                    if (result.status !== "ingested" || db.queryCounts.writer - before !== 12) throw new Error("producer-feature-preparation-refused");
                    preparation.push({ name: pin.asset.name, sha256: result.wireSha256, sql: db.queryCounts.writer - before });
                  }
                } finally { await fixture.close(); }
              }
              const token = "fs169_" + id;
              const config = { ...await db.createWriterConfig(), application_name: token };
              await journal.record(id + ".context.json", { database: config.database, user: config.user,
                destination: id + "-objects", initialRawObjects });
              const pin = feature ? undefined : pins.find(p => p.asset.name === c.workload);
              if (!feature && !pin) throw new Error("producer-representative-missing");
              const worker = createProducerProcess({ worker: { config, sourceRoot, destinationRoot, code, pin }, signal: blockSignal,
                onEvent: event => journal.event({ id, at: new Date().toISOString(), ...event }) });
              let diagnostics: Attempt["diagnostics"], measurement: Attempt["measurement"] | undefined;
              let monitor: Awaited<ReturnType<typeof observeCapacityTrial>> | undefined;
              try {
                if (temperature === "warm") await journal.record(id + ".setup.json", await worker.prepare());
                await setupMonitor.finish();
                await preflight("work"); blockSignal.throwIfAborted();
                monitor = await observeCapacityTrial(db.admin, feature);
                measurement = await worker.measure(temperature);
                censored = measurement.censored;
                await journal.record(id + ".measurement.json", measurement);
              } finally {
                await worker.close();
                // Killing a Node process alone need not interrupt a running
                // backend immediately. Owner cancellation completes before DB cleanup.
                await db.admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name=$1 AND pid<>pg_backend_pid()", [token]);
                diagnostics = await monitor?.finish();
              }
              if (!measurement || !monitor) throw new Error("producer-measurement-missing");
              await journal.record(id + ".diagnostics.json", { diagnostics, disk: [...setupMonitor.disk, ...monitor.disk] });
              const jobId = measurement.result?.features?.jobId;
              const featureParity = jobId && measurement.result?.features?.status === "succeeded" ? await producerFeatureParity(db.admin, jobId) : undefined;
              const cleanup = await cleanupProducerRaw(destination);
              const attempt: Attempt = { ...coordinate, id, clock, measurement, cleanup, disk: [...setupMonitor.disk, ...monitor.disk],
                admissionUsedBytes: admission.usedBytes, preparation, featureParity, diagnostics };
              const verdict = producerAttemptVerdict(attempt);
              attempts.push({ ...attempt, verdict });
              await journal.record(id + ".result.json", attempts.at(-1)); await journal.flush();
              console.log(JSON.stringify({ id, totalMs: measurement.totalMs, sql: measurement.result?.sql.length, verdict }));
              if (!verdict.pass) throw new Error("producer-capacity-attempt-failed-stop");
            });
          } catch (error) {
            const cleanup = await cleanupProducerRaw(destination).catch(e => ({ error: String(e) }));
            await journal.record(id + ".error.json", { id, error: String(error), cleanup, at: new Date().toISOString(), censored });
            throw error;
          } finally {
            await setupMonitor.finish();
            await journal.record(id + ".preparation-disk.json", setupMonitor.disk);
          }
        }
      } finally {
        await observer.end(); await lease.close();
        laneCommand("down"); ownLane = false;
        if (containerPresent()) throw new Error("producer-capacity-lane-teardown-unverified");
        await journal.record(`${c.workload}-b${c.block}.down.json`, { at: new Date().toISOString(), containerAbsent: true });
      }
    }
    const finalSource = await pinProducerSources();
    await journal.record("source-ended.json", finalSource);
    if (JSON.stringify(finalSource) !== JSON.stringify(source)) throw new Error("producer-capacity-source-changed-during-run");
  } catch (error) { failed = error; }
  finally {
    try {
      if (ownLane) laneCommand("down");
      await journal.record("run-ended.json", { format: PRODUCER_CAPACITY_FORMAT, issue: 169, at: new Date().toISOString(),
        verdict: !failed && attempts.length === 30 ? "pass" : "fail", completed: attempts.length,
        ...(failed ? { error: String(failed) } : {}), containerAbsent: !containerPresent() });
      await journal.close();
    } finally { process.removeListener("SIGINT", abort); process.removeListener("SIGTERM", abort); }
  }
  if (failed) throw failed;
};

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] !== "--qualify") throw new Error("producer-capacity-qualify-opt-in-required");
  await qualifyProducerCapacity();
}
