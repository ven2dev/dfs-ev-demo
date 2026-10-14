import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir, cpus, platform, arch } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { Client } from "pg";
import { expect, it } from "vitest";
import { checkMigrationArtifacts } from "../../scripts/db-migrations/files.mjs";
import { createCatalogVerifier, loadCatalogContracts } from "../../scripts/db-migrations/contracts.mjs";
import { runScratchMigrations } from "../../scripts/db-migrations/core.mjs";
import { ensureHarnessSession, ensurePredictiveRoles } from "../../scripts/predictive/harness.ts";
import { openArtifactStore, type PrivateArtifactStore } from "../../src/lib/predictive/artifacts.ts";
import { createLocalPredictiveStore } from "../../src/lib/predictive/persistence.ts";
import { canonical, digest } from "../../src/lib/predictive/validation.ts";
import { createReplay } from "../../src/lib/predictive/replay.ts";
import { recordCompletion } from "../../src/lib/predictive/completion.ts";
import { compressedSourceAsset, COMPRESSED_SOURCE_PROFILE_VERSION } from "../../src/lib/predictive/compressedPublication.ts";
import { TRAINING_SELECTION_SQL, trainingSelectionParameters } from "../../src/lib/predictive/trainingSql.ts";
import { sourceDecisionPlan, type SourceDecisionRecord } from "../../src/lib/predictive/sourceDecisions.ts";
import { sourceFactSnapshot } from "../../src/lib/predictive/sourceFacts.ts";
import { sourceFactWitness } from "../../src/lib/predictive/sourceWitness.ts";
import { buildSourcePassingYards, buildSourceFinalLabel, sourceConsumerInputDigest, type SourceConsumerBody, type SourceConsumerFact } from "../../src/lib/predictive/sourceConsumers.ts";
import { TRAINING_HISTORY_POLICY, TRAINING_HISTORY_SHA256, type FittingRunRequest, type TrainingSlot } from "../../src/lib/predictive/training.ts";
import type { TrainingRunInventory } from "../../src/lib/predictive/trainingRuns.ts";
import type { TrainingDatasetManifest } from "../../src/lib/predictive/trainingDatasets.ts";
import type { Dataset, Revision, Schedule } from "../../src/lib/predictive/types.ts";
import { addCapture, completionMarkers, coverage, membership, profile, revision, rights, schedule } from "../predictive/fixtures/passingYards.ts";
import { sourceClaimFixture } from "../predictive/fixtures/sourceClaims.ts";
import { sourceCsv } from "../predictive/fixtures/source.ts";
import { createScratchHarness } from "./scratch.mjs";

type Store = Awaited<ReturnType<typeof createLocalPredictiveStore>>;
type Target = { expected: object; assertTarget: (config: object) => void };
const NATIVE = "capacity-context";
const CAPTURED = "2026-10-11T12:00:00.000Z";
const KICKOFF = "2026-10-18T17:00:00.000Z";
const pairs = [["PHI", "CAR"], ["DAL", "NYG"], ["BUF", "NE"], ["KC", "LV"],
  ["SF", "SEA"], ["BAL", "CIN"], ["CHI", "GB"], ["HOU", "TEN"]];
type Example = { playerId: string; prior: Schedule; target: Schedule; targetObservationId: string; profileId: string;
  passingYards: number; attempts: number; featureId: string; labelId: string };

// Independent player identities, games, source rows/captures and native files.
// Eight QBs share each team's one-game synthetic history. This deliberately
// falls short of a real population, a full 16-game history or opponent context.
// Fixture preparation uses the same checked SQL recorders, plus one independently
// byte-verified full snapshot. It avoids reopening/decoding the entire population
// hundreds of times merely to seed a read benchmark. Measured APIs are untouched.
const recordCapacityBody = async (client: Client, artifacts: PrivateArtifactStore, id: string, body: SourceConsumerBody) => {
  const bytes = canonical(body), sha = digest(bytes), key = Buffer.from(sha, "hex").readInt32BE(0);
  await client.query("SELECT pg_advisory_lock(520054,$1)", [key]);
  try {
    await artifacts.database.write(bytes, sha);
    await client.query("BEGIN");
    try {
      await client.query("INSERT INTO predictive_blobs VALUES ($1,$2,'application/json',$3) ON CONFLICT DO NOTHING", [sha, Buffer.byteLength(bytes), sha + ".json"]);
      await client.query("SELECT predictive_record_source_consumer($1,NULL,$2)", [id, body]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      if (!(await client.query("SELECT 1 FROM predictive_blobs WHERE storage_ref=$1", [sha + ".json"])).rows.length) await artifacts.database.remove(sha + ".json", sha);
      throw error;
    }
  } finally { await client.query("SELECT pg_advisory_unlock(520054,$1)", [key]); }
};
const seedCapacity = async (store: Store, client: Client, artifacts: PrivateArtifactStore, size: number) => {
  const context: Dataset = { formatVersion: 2, profiles: [profile(NATIVE)], rightsDecisions: [rights(NATIVE)],
    artifacts: [], captures: [], decisions: [], labels: [], identityLinks: [] };
  const examples: Example[] = [];
  const publications = [];
  const groups = Math.ceil(size / 8);
  for (let group = 0; group < groups; group++) {
    const [home, away] = pairs[group], teamId = "nfl:team:" + home, opponentId = "nfl:team:" + away;
    const rawGameId = `2026_06_${away}_${home}`;
    const prior = { ...schedule(600 + group, "2026-10-04T17:00:00.000Z", teamId, opponentId), rawGameId, week: 6 };
    const target = { ...schedule(700 + group, KICKOFF, teamId, opponentId), rawGameId: `2026_07_${away}_${home}`, week: 7 };
    const players = Array.from({ length: Math.min(8, size - group * 8) }, (_, i) => {
      const index = group * 8 + i;
      return { playerId: "00-" + String(100 + index).padStart(7, "0"), attempts: 10 + index, passingYards: 80 + index * 3 };
    });
    const csv = sourceCsv("player", players.map((player) => ({ player_id: player.playerId, position: "QB", game_id: rawGameId,
      season: "2026", week: "6", season_type: "REG", team: home, opponent_team: away,
      attempts: String(player.attempts), passing_yards: String(player.passingYards) })));
    const input = sourceClaimFixture("capacity-source-" + group, "player", csv), compressed = group % 2 === 1;
    input.profile.id = "capacity-stats-" + group; input.artifact.profileId = input.profile.id;
    input.capturedAt = CAPTURED;
    input.rightsDecisions = [rights(input.profile.id)];
    if (compressed) {
      const asset = compressedSourceAsset("player", 2026);
      input.profile = { ...input.profile, parserVersion: COMPRESSED_SOURCE_PROFILE_VERSION, assetPattern: asset.name };
    }
    publications.push({ input, compressed });
    context.profiles.push(input.profile); context.rightsDecisions.push(...input.rightsDecisions);
    context.identityLinks.push({ id: "capacity-identity-" + group, statsProfileId: input.profile.id,
      bridgeProfileId: NATIVE, provider: "gsis", decidedAt: "2026-01-01T00:00:00.000Z" });
    const rows: Revision[] = [
      revision("capacity-map-" + group, "game-bridge", { provider: "nflverse", rawGameId, gameId: prior.gameId }),
      ...[home, away].map((alias) => revision("capacity-alias-" + alias, "team-alias", { provider: "nflverse", rawAlias: alias,
        teamId: "nfl:team:" + alias, effectiveFromSeason: 2026, effectiveToSeason: 2026 })),
      revision("capacity-prior-" + group, "schedule", prior), revision("capacity-target-" + group, "schedule", target),
      revision("capacity-coverage-" + group, "schedule-coverage", coverage(teamId, [prior.gameId, target.gameId])),
      ...completionMarkers(prior),
    ];
    for (const player of players) {
      rows.push(revision("capacity-player-map-" + player.playerId, "player-bridge", { provider: "gsis", rawPlayerId: player.playerId,
        playerId: player.playerId, effectiveFrom: "2026-01-01T00:00:00.000Z", effectiveTo: "2027-01-01T00:00:00.000Z" }),
      ...[prior, target].map((game) => revision("capacity-member-" + game.gameId + "-" + player.playerId, "membership",
        membership(game, { playerId: player.playerId, rawPlayerId: player.playerId, teamId, rawTeam: home }))));
      examples.push({ ...player, prior, target, targetObservationId: "capacity-target-" + group, profileId: input.profile.id,
        featureId: "capacity-feature-" + player.playerId, labelId: "capacity-label-" + player.playerId });
    }
    addCapture(context, "capacity-native-" + group, rows, "2026-10-07T12:00:00.000Z", NATIVE);
    Object.assign(context.artifacts.at(-1)!, { scopeKind: "season-file", scopeSeason: 2026 });
  }
  const replay = createReplay(context, "2026-10-12T12:00:00.000Z", "2026-10-12T12:00:00.000Z", "internal-research");
  context.decisions = examples.filter((_, i) => i % 8 === 0).map(({ prior }) => recordCompletion("capacity-complete-" + prior.gameId,
    prior.gameId, replay.completion(prior.gameId).inputs, "2026-10-08T12:00:00.000Z", "synthetic-proof"));
  for (const { input, compressed } of publications) {
    if (compressed) {
      const { bytes, ...artifact } = input.artifact, wire = gzipSync(bytes), asset = compressedSourceAsset("player", 2026);
      await store.publishCompressedSource(wire, { ...input, artifact: { ...artifact, origin: asset.url,
        sha256: createHash("sha256").update(wire).digest("hex"), wireBytes: wire.length } });
    } else await store.publishSourceStats(input);
  }
  expect(await store.publish("capacity-context-run", context, "2026-10-12T12:00:00.000Z")).toMatchObject({ status: "published" });
  const profiles = publications.map(({ input }) => input.profile.id).sort();
  for (const [index, example] of examples.entries()) {
    const raw = { profileId: example.profileId, rawGameId: example.prior.rawGameId, rawTeam: example.prior.rawHomeTeam,
      rawPlayerId: example.playerId };
    const normalize = Math.floor(index / 8) % 2 ? store.recordCompressedSourceNormalization : store.recordSourceNormalization;
    await normalize("capacity-binding-" + example.playerId, raw, null);
    if ((index + 1) % 16 === 0 || index + 1 === size) process.stdout.write("capacity bindings " + (index + 1) + "\n");
  }
  const clock = async () => (await client.query("SELECT predictive_source_time(clock_timestamp()) AS time")).rows[0].time as string;
  const entityKeys = examples.map((example) => "player-game-stats:" + example.prior.gameId + ":" + example.playerId).sort();
  const snapshot = await store.replaySourceStatsFacts({ profileIds: profiles, entityKeys, cutoff: await clock() });
  expect(snapshot.reason).toBeNull();
  const decisions = new Map<string, { rec: SourceDecisionRecord; part: SourceDecisionRecord }>();
  for (const example of examples) {
    const entityKey = "player-game-stats:" + example.prior.gameId + ":" + example.playerId;
    const record = async (kind: "reconciliation" | "participation") => {
      const plan = sourceDecisionPlan(snapshot, { kind, profileIds: profiles, entityKey, cutoff: snapshot.request.cutoff }, [], "synthetic-proof");
      return (await client.query("SELECT predictive_record_source_decision($1,NULL,$2) AS record", ["capacity-" + kind + "-" + example.playerId, plan])).rows[0].record as SourceDecisionRecord;
    };
    decisions.set(entityKey, { rec: await record("reconciliation"), part: await record("participation") });
  }
  const cutoff = await clock();
  expect(snapshot.withheld).toEqual([]); expect(snapshot.heads).toHaveLength(size);
  const facts = new Map<string, SourceConsumerFact>(entityKeys.map((key) => [key, {
    // The label builder requires one target, while source verification above
    // checks the entire population before any canonical filtering.
    snapshot: sourceFactSnapshot({ ...snapshot.request, entityKeys: [key], cutoff },
      snapshot.heads.filter((head) => head.entityKey === key), [], null),
    reconciliation: decisions.get(key)!.rec, participation: decisions.get(key)!.part, reconciliationReason: null, participationReason: null }]));
  process.stdout.write("capacity decisions " + size * 2 + "\n");
  for (const example of examples) {
    // Replay records cited decisions; each independent consumer starts fresh.
    const native = createReplay(context, cutoff, cutoff, "model-input");
    const body = buildSourcePassingYards(native, { playerId: example.playerId, gameId: example.target.gameId,
      cutoff, computedAt: cutoff, candidate: "stats-v1:player_pass_yds" }, profiles, facts);
    expect(body.bundle.status).toBe("ready-inputs");
    expect(body.bundle.player[0]).toMatchObject({ passingYardsSum: example.passingYards, attemptsSum: example.attempts });
    await recordCapacityBody(client, artifacts, example.featureId, body);
    const fact = facts.get("player-game-stats:" + example.prior.gameId + ":" + example.playerId)!;
    const witness = sourceFactWitness(fact.snapshot, ["player-game-stats:" + example.prior.gameId + ":" + example.playerId]);
    expect([fact.reconciliation, fact.participation].map((record) => ({ kind: record!.plan.kind, entityKey: record!.plan.entityKey,
      digest: record!.plan.witness.evidenceDigest, visible: Date.parse(record!.recordedAt) <= Date.parse(witness.cutoff) }))).toEqual([
      { kind: "reconciliation", entityKey: witness.entityKeys[0], digest: witness.evidenceDigest, visible: true },
      { kind: "participation", entityKey: witness.entityKeys[0], digest: witness.evidenceDigest, visible: true }]);
    const label = buildSourceFinalLabel(fact,
      { id: "capacity-complete-" + example.prior.gameId, completionObservedAt: "2026-10-07T12:00:00.000Z" }, profiles);
    label.manifest.observations = native.completion(example.prior.gameId).inputs.map((row) => row.revision.id).sort();
    label.inputDigest = sourceConsumerInputDigest(label);
    expect(label.value).toBe(example.passingYards);
    await recordCapacityBody(client, artifacts, example.labelId, label);
  }
  return { examples, profiles, cutoff };
};

const runRequest = (seed: Awaited<ReturnType<typeof seedCapacity>>, count: number, labelsAsOf: string): FittingRunRequest => {
  const slots: TrainingSlot[] = seed.examples.slice(0, count).map((example) => ({ datasetId: "capacity-dataset-" + count,
    partition: "evaluation", playerId: example.playerId, gameId: example.target.gameId, season: 2026, seasonType: "REG", kickoff: KICKOFF,
    kickoffObservationId: example.targetObservationId, featureCutoff: seed.cutoff, labelsAsOf, featureRef: null, labelRef: null }));
  return { version: "qb-training-read-v1", fittingRunId: "capacity-run-" + count, evaluationPlanId: "capacity-plan-" + count,
    foldId: "capacity-fold", fitCutoff: seed.cutoff,
    selection: { market: "player_pass_yds", stat: "passing_yards", candidate: "stats-v1:player_pass_yds", featureVersion: "passing-yards-source-v1",
      labelVersion: "source-final-label-v1", historyPolicy: TRAINING_HISTORY_POLICY, historyPolicySha256: TRAINING_HISTORY_SHA256, profileIds: seed.profiles },
    modelIdentity: { modelVersion: "capacity-proof", codeCommit: "a".repeat(40), configurationSha256: "b".repeat(64) },
    splitPolicy: { version: "target-event-disjoint-v1", evaluationMode: "walk-forward", aggregationPolicyId: "unique-events-v1", aggregationPolicySha256: "c".repeat(64) },
    population: { status: "unqualified", enumerationOrigin: "synthetic-capacity-slots", enumerationSha256: digest(canonical(slots)) }, slots };
};

type Measurement = { operation: string; count: number; status: "completed" | "refused"; reason: string | null; wallMs: number;
  statements: number; consumerCheckStatements: number; uniqueFiles: number; fileReads: number; wireBytes: number; responseBytes: number;
  sampledPeakRssBytes: number; sampledPeakHeapBytes: number; processHighWaterRssBytes: number; verification: unknown };
const capacityRefusals = new Set(["training-deadline-exceeded", "source-verification-byte-bounds-refused", "training-page-byte-bounds-refused",
  "training-evidence-bounds-refused", "compressed-batch-work-budget-exceeded", "sql-statement-timeout"]);

const measure = async <T>(client: Client, target: Target, artifacts: PrivateArtifactStore, operation: string, count: number,
  work: (store: Store) => Promise<T>, measurements: Measurement[]) => {
  const login = "dfs118_capacity_" + randomBytes(8).toString("hex");
  await client.query(`CREATE ROLE ${login} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD 'disposable-capacity'`);
  await client.query(`GRANT predictive_recorder,predictive_replay TO ${login}`);
  const expected = { ...target.expected, user: login, password: "disposable-capacity" }, connection = new Client(expected);
  const sql: string[] = [], reads: { ref: string; bytes: number }[] = [];
  const observed = new Proxy(connection, { get: (object, key) => {
    if (key === "query") return (...args: unknown[]) => {
      sql.push(typeof args[0] === "string" ? args[0] : "");
      return Reflect.apply(object.query, object, args);
    };
    const value = Reflect.get(object, key); return typeof value === "function" ? value.bind(object) : value;
  } });
  const files = { ...artifacts, database: { ...artifacts.database,
    read: async (...args: Parameters<typeof artifacts.database.read>) => {
      reads.push({ ref: args[0], bytes: args[2] }); return artifacts.database.read(...args);
    }, readBinary: async (...args: Parameters<typeof artifacts.database.readBinary>) => {
      reads.push({ ref: args[0], bytes: args[2] }); return artifacts.database.readBinary(...args);
    } } };
  try {
    await connection.connect();
    expect((await connection.query("SELECT rolsuper FROM pg_roles WHERE rolname=session_user")).rows[0].rolsuper).toBe(false);
    const store = await createLocalPredictiveStore(observed, { expected, assertTarget: (config) => {
      expect(config).toEqual(expected); target.assertTarget(target.expected);
    } }, files);
    sql.length = 0;
    let peakRss = process.memoryUsage().rss, peakHeap = process.memoryUsage().heapUsed;
    const sample = () => { const m = process.memoryUsage(); peakRss = Math.max(peakRss, m.rss); peakHeap = Math.max(peakHeap, m.heapUsed); };
    const timer = setInterval(sample, 10), started = performance.now();
    let result: T | null = null, reason: string | null = null;
    try { result = await work(store); }
    catch (error) {
      reason = error instanceof Error && "code" in error && error.code === "57014" ? "sql-statement-timeout" :
        error instanceof Error ? error.message : "unknown-error";
      if (!capacityRefusals.has(reason)) throw error;
    } finally { sample(); clearInterval(timer); }
    measurements.push({ operation, count, status: reason ? "refused" : "completed", reason,
      wallMs: Math.round(performance.now() - started), statements: sql.length,
      consumerCheckStatements: sql.filter((statement) => statement.includes("predictive_source_consumer_check")).length,
      uniqueFiles: new Set(reads.map(({ ref }) => ref)).size, fileReads: reads.length,
      wireBytes: [...new Map(reads.map((row) => [row.ref, row.bytes])).values()].reduce((a, b) => a + b, 0),
      responseBytes: result === null ? 0 : Buffer.byteLength(canonical(result)), sampledPeakRssBytes: peakRss, sampledPeakHeapBytes: peakHeap,
      processHighWaterRssBytes: process.resourceUsage().maxRSS * 1024,
      verification: result && typeof result === "object" && "verification" in result ? result.verification : null });
    if (result !== null) {
      expect(new Set(reads.map(({ ref }) => ref)).size).toBe(reads.length);
      expect((await connection.query("SELECT count(*)::integer AS n FROM pg_locks WHERE pid=pg_backend_pid() AND mode='ShareLock'")).rows[0].n).toBe(0);
    }
    return result;
  } finally { await connection.end(); await client.query(`DROP OWNED BY ${login}`); await client.query(`DROP ROLE ${login}`); }
};

it("measures independent QB training records with default budgets and exact evidence", async () => {
  const max = Number(process.env.PREDICTIVE_CAPACITY_MAX_ROWS ?? 64);
  if (![1, 16, 64].includes(max)) throw new Error("capacity-size-refused");
  const harness = await createScratchHarness(process.env), root = await realpath(await mkdtemp(join(tmpdir(), "dfs118-capacity-")));
  const measurements: Measurement[] = [], plans: unknown[] = [];
  try {
    await harness.withDatabase(async (client: Client, expected: object) => {
      const target = { expected, assertTarget: harness.assertTarget };
      const files = await checkMigrationArtifacts(), contracts = await loadCatalogContracts(files);
      await ensurePredictiveRoles(client);
      await runScratchMigrations(client, { ...target, files, verify: createCatalogVerifier(contracts) });
      await ensureHarnessSession(client);
      const artifacts = await openArtifactStore(root, 8_000_000), store = await createLocalPredictiveStore(client, target, artifacts);
      const seedStarted = performance.now(), seed = await seedCapacity(store, client, artifacts, max);
      process.stdout.write("capacity seed " + JSON.stringify({ rows: max, wallMs: Math.round(performance.now() - seedStarted) }) + "\n");
      await client.query("ANALYZE");
      const labelsAsOf = (await client.query("SELECT predictive_source_time(clock_timestamp()) AS time")).rows[0].time as string;
      for (const count of [1, 16, 64].filter((n) => n <= max)) {
        const request = runRequest(seed, count, labelsAsOf);
        const explain = async (name: string, sql: string, values: unknown[]) => {
          try {
            const plan = (await client.query("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + sql, values)).rows[0]["QUERY PLAN"][0];
            plans.push({ name, count, plan });
          } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "57014")) throw error;
            plans.push({ name, count, status: "refused", reason: "sql-statement-timeout", statementCeilingMs: 15_000 });
          }
        };
        await explain("run-selection", TRAINING_SELECTION_SQL, [...trainingSelectionParameters(request, labelsAsOf)]);
        await explain("consumer-check-function", "SELECT public.predictive_source_consumer_check(id) FROM unnest($1::text[]) id",
          [seed.examples.slice(0, count).map((row) => row.featureId)]);
        const inventory = await measure<TrainingRunInventory>(client, target, artifacts, "prepare-run", count,
          (reader) => reader.prepareFittingRun(request), measurements);
        if (inventory) {
          expect(inventory.rows).toHaveLength(count);
          const datasetRequest = { version: "qb-training-read-v1" as const, fittingRunId: inventory.request.fittingRunId,
            inventorySha256: inventory.inventorySha256, datasetId: request.slots[0].datasetId, pinId: "capacity-pin-" + count };
          const manifest = await measure<TrainingDatasetManifest>(client, target, artifacts, "prepare-dataset", count,
            (reader) => reader.prepareDataset(datasetRequest), measurements);
          if (manifest) {
            expect(manifest.rows).toHaveLength(count);
            plans.push({ name: "retained-closure", count, references: manifest.closure.references.length, blobs: manifest.closure.blobs.length,
              chargedWireBytes: manifest.closure.blobs.reduce((sum, row) => sum + Number(row.byteSize), 0),
              serializedManifestBytes: Buffer.byteLength(canonical(manifest)),
              chargedBytes: (await client.query("SELECT charged_bytes FROM predictive_training_datasets WHERE id=$1", [manifest.datasetId])).rows[0].charged_bytes });
            for (const rows of [...new Set([1, Math.min(count, 16), count])]) {
              const page = await measure(client, target, artifacts, "page-" + rows, count, (reader) => reader.readDatasetPage({
                version: datasetRequest.version, fittingRunId: datasetRequest.fittingRunId, inventorySha256: datasetRequest.inventorySha256,
                datasetId: datasetRequest.datasetId, manifestSha256: manifest.manifestSha256, cursor: null, limits: { rows, bytes: 8_000_000 } }), measurements);
              if (page) {
                expect(page.rows).toHaveLength(rows);
                for (const row of page.rows) {
                  const example = seed.examples.find((value) => value.playerId === row.slot.playerId)!;
                  expect(row.feature.state).toBe("usable"); expect(row.feature.bundle?.player[0]).toMatchObject({ passingYardsSum: example.passingYards });
                  expect(row.label.state).toBe("missing"); expect(row.label.outcome).toBeNull();
                }
                expect(page.fittingReady).toBe(false);
              }
            }
          }
        }
        const labels = await measure(client, target, artifacts, "current-labels", count, (reader) => reader.readCurrentLabels({
          version: "qb-training-read-v1", selection: { market: "player_pass_yds", stat: "passing_yards", labelVersion: "source-final-label-v1", profileIds: seed.profiles },
          keys: seed.examples.slice(0, count).map((row) => ({ playerId: row.playerId, gameId: row.prior.gameId, seasonType: "REG" as const, labelRef: null })),
          limits: { rows: count, bytes: 8_000_000 } }), measurements);
        if (labels) {
          expect(labels.counts.usable).toBe(count);
          for (const row of labels.rows) expect(row.outcome?.value).toBe(seed.examples.find((value) => value.playerId === row.key.playerId)!.passingYards);
        }
        process.stdout.write("capacity checkpoint " + JSON.stringify({ count, measurements: measurements.filter((m) => m.count === count) }) + "\n");
      }
      if (max === 1) expect(measurements.every((row) => row.status === "completed")).toBe(true);
      expect(measurements.some((row) => row.status === "completed")).toBe(true);
      process.stdout.write("training capacity evidence " + JSON.stringify({ version: "synthetic-training-capacity-v1", measuredAt: new Date().toISOString(),
        runtime: { node: process.version, postgres: (await client.query("SHOW server_version")).rows[0].server_version, platform: platform(), arch: arch(),
          logicalCpus: cpus().length, cpu: cpus()[0]?.model },
        scope: { players: max, groups: Math.ceil(max / 8), sourceProfiles: seed.profiles.length, historySlots: 1, candidate: "stats-v1:player_pass_yds",
          compressedGroups: Math.floor(Math.ceil(max / 8) / 2), populationCoverage: "unqualified", datasetLabels: "missing", labelsReadSeparately: true },
        migrations: files.map((file: { version: number; sha256: string }) => ({ version: file.version, sha256: file.sha256 })), measurements, plans }) + "\n");
    });
  } finally { try { await harness.close(); } finally { await rm(root, { recursive: true, force: true }); } }
});
