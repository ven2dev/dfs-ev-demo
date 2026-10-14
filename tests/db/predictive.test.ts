import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, utimes, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { expect, it } from "vitest";
import { createCatalogVerifier, loadCatalogContracts } from "../../scripts/db-migrations/contracts.mjs";
import { runScratchMigrations } from "../../scripts/db-migrations/core.mjs";
import { checkMigrationArtifacts } from "../../scripts/db-migrations/files.mjs";
import { ensureHarnessSession, ensurePredictiveRoles } from "../../scripts/predictive/harness.ts";
import { openArtifactStore } from "../../src/lib/predictive/artifacts.ts";
import { buildPassingYardsBundle, buildPassingYardsFromReplay } from "../../src/lib/predictive/passingYards.ts";
import { createLocalPredictiveStore, MEMBERSHIP_READ_SQL, retentionIdsDigest, SCHEDULE_READ_SQL } from "../../src/lib/predictive/persistence.ts";
import { ingestLocalDataset } from "../../src/lib/predictive/ingest.ts";
import { reconcileFact } from "../../src/lib/predictive/policies.ts";
import { markerHeadsAt, recordCompletion } from "../../src/lib/predictive/completion.ts";
import { participationHeadsAt, recordParticipation } from "../../src/lib/predictive/participation.ts";
import { recordSnapCompatibility } from "../../src/lib/predictive/snaps.ts";
import { executionDigest, FEATURE_CODE_VERSION, featureRunRequest } from "../../src/lib/predictive/featureRuns.ts";
import type { Label, RecordedRetentionEvent, RetentionEvent } from "../../src/lib/predictive/types.ts";
import { createReplay } from "../../src/lib/predictive/replay.ts";
import { runLocalProof } from "../../scripts/predictive/local.ts";
import { digest, instant, TEAM_IDS, validateDataset } from "../../src/lib/predictive/validation.ts";
import type { Dataset, Revision } from "../../src/lib/predictive/types.ts";
import { addCapture, CAPTURE_A, CAPTURE_B, completionMarkers, coverage, CUTOFF_B, emptyDataset, gameId, membership, passingYardsFixture,
  PLAYER, playerSnaps, playerStats, PRIOR, profile, PROFILE, request, revision, rights, schedule, TARGET, TEAM, teamSnaps } from "../predictive/fixtures/passingYards.ts";
import { backendPid, waitForBlocked } from "./leaseSupport";
import { createScratchHarness } from "./scratch.mjs";

const NOW = "2026-10-09T00:00:00.000Z";
const tables = ["predictive_source_profiles", "predictive_rights_decisions", "predictive_blobs", "predictive_ingestion_runs",
  "predictive_run_rights", "predictive_artifacts", "predictive_captures", "predictive_teams", "predictive_games",
  "predictive_observations", "predictive_artifact_observations"] as const;
const keyColumn: Record<string, string> = { predictive_blobs: "sha256", predictive_run_rights: "run_id", predictive_artifact_observations: "artifact_id" };
const snapshot = async (client: Client) => {
  const rows: Record<string, unknown[]> = {};
  for (const table of tables) rows[table] = (await client.query(`SELECT * FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
  return rows;
};
const rowsOf = (dataset: Dataset) => dataset.artifacts.flatMap((artifact) => JSON.parse(artifact.bytes) as Revision[]);
const findRow = (dataset: Dataset, id: string) => rowsOf(dataset).find((row) => row.id === id)!;
// Direct SQL probes roll back even when an assertion fails. Valid controls force
// deferred checks before rollback, so unrelated publication errors cannot pass.
const sqlProbe = async (client: Client, probe: () => Promise<void>) => {
  await client.query("BEGIN");
  try { await probe(); } finally { await client.query("ROLLBACK"); }
};
// Inserts one observation directly, computing its keys the way publication does.
const insertObservation = (client: Client, id: string, kind: string, data: unknown, options: { predecessor?: string; sourceRecordId?: string; profileId?: string } = {}) => {
  const profileId = options.profileId ?? PROFILE; const record = options.sourceRecordId ?? "";
  return client.query(`INSERT INTO predictive_observations (id,kind,profile_id,source_record_id,data,entity_key,source_key,predecessor_id,correction_reason)
    VALUES ($1,$2,$3,$4,$5,predictive_entity_key($2,$5),predictive_entity_key($2,$5)||'|'||$3||'|'||$4,$6,$7)`,
  [id, kind, profileId, record, data, options.predecessor ?? null, options.predecessor ? "SQL constraint probe" : null]);
};
const withProof = async (run: (context: {
  client: Client; store: Awaited<ReturnType<typeof createLocalPredictiveStore>>; root: string;
  artifacts: Awaited<ReturnType<typeof openArtifactStore>>; target: { expected: object; assertTarget: (config: object) => void };
}) => Promise<void>, migrationCount?: number) => {
  const harness = await createScratchHarness(process.env);
  const root = await realpath(await mkdtemp(join(tmpdir(), "dfs-ev-predictive-db-")));
  try {
    const files = await checkMigrationArtifacts(); const contracts = await loadCatalogContracts(files);
    await harness.withDatabase(async (client: Client, expected: object) => {
      const target = { expected, assertTarget: harness.assertTarget };
      await ensurePredictiveRoles(client);
      await runScratchMigrations(client, { ...target, files: files.slice(0, migrationCount), verify: createCatalogVerifier(contracts) });
      await ensureHarnessSession(client);
      const artifacts = await openArtifactStore(root); const store = await createLocalPredictiveStore(client, target, artifacts);
      await run({ client, store, root, artifacts, target });
    });
  } finally { try { await harness.close(); } finally { await rm(root, { recursive: true, force: true }); } }
};

it("predictive PostgreSQL seeds exactly the application team identities, refuses others and publishes Rams replay inputs", async () => {
  await withProof(async ({ client, store }) => {
    expect(TEAM_IDS).toHaveLength(32); expect(TEAM_IDS).toContain("nfl:team:LA"); expect(TEAM_IDS).not.toContain("nfl:team:LAR");
    expect((await client.query("SELECT id FROM predictive_teams ORDER BY id COLLATE \"C\"")).rows.map((row) => row.id)).toEqual(TEAM_IDS);
    // The frozen SQL list must equal the app registry, so neither can drift alone.
    const definition = (await client.query(`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conrelid = 'public.predictive_teams'::regclass AND contype = 'c'`)).rows[0].definition as string;
    expect([...definition.matchAll(/'(nfl:team:[A-Z]+)'/g)].map((match) => match[1]).sort()).toEqual([...TEAM_IDS].sort());
    for (const [refusedId, code] of [["nfl:team:LAR", "23514"], ["nfl:team:XXX", "23514"], ["nfl:team:la", "23514"], ["nfl:team:PHI", "23505"]]) {
      await sqlProbe(client, async () => {
        await expect(client.query("INSERT INTO predictive_teams (id) VALUES ($1)", [refusedId])).rejects.toMatchObject({ code });
      });
    }
    const dataset = passingYardsFixture(false);
    dataset.artifacts = dataset.artifacts.map((artifact) => {
      const bytes = artifact.bytes.replaceAll('"nfl:team:PHI"', '"nfl:team:LA"').replaceAll('"PHI"', '"LA"');
      return { ...artifact, bytes, sha256: digest(bytes) };
    });
    const pure = buildPassingYardsBundle(dataset, request()); expect(pure.status).toBe("ready-inputs");
    expect(await ingestLocalDataset(store, "rams-A", dataset, NOW)).toMatchObject({ status: "published" });
    const replay = await store.replay(request()); expect(replay).toEqual(pure);
    expect(replay.teamId).toBe("nfl:team:LA");
    expect(replay.player[0]).toMatchObject({ observedGames: 4, attemptsSum: 100, passingYardsSum: 700, passingYardsPerAttempt: 7 });
  });
});
it("predictive PostgreSQL A/B replay preserves the earlier bundle and uses later corrections", async () => {
  await withProof(async ({ store }) => {
    const a = passingYardsFixture(false); await store.publish("A", a, NOW);
    const before = await store.replay(request()); expect(before).toEqual(buildPassingYardsBundle(a, request()));
    // These totals come from games 5,4,3,2: 40+10+30+20 attempts,
    // 300+90+210+100 yards. A shared pure-function bug cannot define the oracle.
    expect(before.status).toBe("ready-inputs");
    expect(before.player[0]).toMatchObject({ gameIds: [PRIOR[4], PRIOR[3], PRIOR[2], PRIOR[1]],
      observedGames: 4, attemptsSum: 100, passingYardsSum: 700, passingYardsPerAttempt: 7 });
    expect(before.team![0]).toMatchObject({ attemptsSum: 119, passingYardsSum: 869 });
    expect(before.opponent![0]).toMatchObject({ attemptsSum: 100, passingYardsSum: 700 });
    expect(before.scheduledRestHours).toBe(168);
    expect(before.player.flatMap((window) => window.gameIds)).not.toContain(TARGET);
    const b = passingYardsFixture(); const correction = { ...b, artifacts: b.artifacts.filter((artifact) => artifact.id.startsWith("B-")), captures: b.captures.filter((capture) => capture.artifactId.startsWith("B-")) };
    await store.publish("B", correction, NOW);
    expect(await store.replay(request())).toEqual(before);
    const later = await store.replay(request(CUTOFF_B));
    expect(later).toEqual(buildPassingYardsBundle(b, request(CUTOFF_B)));
    expect(later.status).toBe("ready-inputs");
    expect(later.player[0]).toMatchObject({ attemptsSum: 100, passingYardsSum: 720, passingYardsPerAttempt: 7.2 });
    expect(later.team![0].passingYardsSum).toBe(889);
    expect(later.dependencies.find((row) => row.observationId === "player-correction-B")).toMatchObject({
      predecessorId: "player-synthetic-game-5", artifactId: "B-player", availableAt: CAPTURE_B, ingestedAt: CAPTURE_B, profileId: PROFILE,
    });
    expect(later.inputDigest).not.toBe(before.inputDigest);
    const justBeforeB = await store.replay(request("2026-10-08T12:59:59.999Z"));
    expect(justBeforeB.player[0].passingYardsSum).toBe(700);
    const exactlyB = await store.replay(request(CAPTURE_B));
    expect(exactlyB.player[0].passingYardsSum).toBe(720);
    expect(exactlyB.dependencies.some((row) => row.observationId === "player-correction-B")).toBe(true);
  });
});
it("predictive scoped reads retain corrections that move evidence out of the indexed scope", async () => {
  await withProof(async ({ client, store }) => {
    const dataset = passingYardsFixture(false); await store.publish("A", dataset, NOW); const before = await store.replay(request());
    const member = findRow(dataset, "member-synthetic-game-5") as Revision<"membership">;
    const correction = emptyDataset();
    addCapture(correction, "moved-member", [revision("moved-member", "membership", { ...member.data,
      effectiveFrom: "2023-01-01T00:00:00.000Z", effectiveTo: "2023-02-01T00:00:00.000Z",
    }, member.id)], CAPTURE_B);
    await store.publish("moved", correction, NOW);
    const membershipRows = (await client.query(MEMBERSHIP_READ_SQL, [CUTOFF_B, PLAYER,
      "2026-10-11T17:00:00.000Z", "2024-01-01T00:00:00.000Z"])).rows;
    expect(membershipRows.map((row) => row.envelope.revision.id)).toContain("moved-member");
    expect((await client.query(MEMBERSHIP_READ_SQL, [request().cutoff, PLAYER,
      "2026-10-11T17:00:00.000Z", "2024-01-01T00:00:00.000Z"])).rows.map((row) => row.envelope.revision.id)).not.toContain("moved-member");
    const full = { ...dataset, artifacts: [...dataset.artifacts, ...correction.artifacts], captures: [...dataset.captures, ...correction.captures] };
    const membershipLater = await store.replay(request(CUTOFF_B));
    expect(membershipLater).toEqual(buildPassingYardsBundle(full, request(CUTOFF_B)));
    expect(membershipLater.player[0].exclusions).toContainEqual({ gameId: PRIOR[4], reason: "membership-inapplicable" });
    const movedSchedule = emptyDataset();
    const oldSchedule = findRow(dataset, "schedule-synthetic-game-5") as Revision<"schedule">;
    addCapture(movedSchedule, "moved-schedule", [revision("moved-schedule", "schedule", {
      ...oldSchedule.data, homeTeamId: "nfl:team:SEA", rawHomeTeam: "SEA",
    }, oldSchedule.id)], CAPTURE_B);
    await store.publish("moved-schedule", movedSchedule, NOW);
    const scheduleIds = (await client.query(SCHEDULE_READ_SQL, [CUTOFF_B, [TEAM], 2024, 2026])).rows.map((row) => row.envelope.revision.id);
    expect(scheduleIds).toContain("schedule-synthetic-game-5"); expect(scheduleIds).toContain("moved-schedule");
    expect(await store.replay(request())).toEqual(before);
    const fullWithSchedule = { ...full, artifacts: [...full.artifacts, ...movedSchedule.artifacts], captures: [...full.captures, ...movedSchedule.captures] };
    const later = await store.replay(request(CUTOFF_B));
    expect(later).toEqual(buildPassingYardsBundle(fullWithSchedule, request(CUTOFF_B)));
    expect(later.status).toBe("unavailable-inputs");
  });
});
it("predictive persistence retains former-team membership gaps and ignores unrelated schedule dependencies", async () => {
  await withProof(async ({ store }) => {
    await store.publish("A", passingYardsFixture(false), NOW);
    const before = await store.replay(request()); expect(before.status).toBe("ready-inputs");
    const unrelated = emptyDataset();
    addCapture(unrelated, "unrelated", [revision("unrelated", "schedule", schedule(77, "2026-09-14T00:15:00.000Z", "nfl:team:SEA", "nfl:team:ARI"))]);
    await store.publish("unrelated", unrelated, NOW);
    expect(await store.replay(request())).toEqual(before);
  });
  await withProof(async ({ store }) => {
    const dataset = passingYardsFixture(false); const former = schedule(40, "2025-12-07T17:00:00.000Z", "nfl:team:BUF", "nfl:team:NE", 2025);
    const gap = schedule(41, "2025-12-14T17:00:00.000Z", former.homeTeamId, former.awayTeamId, 2025);
    addCapture(dataset, "former-schedules", [revision("former-schedule", "schedule", former), revision("former-gap", "schedule", gap)]);
    addCapture(dataset, "former-member", [revision("former-member", "membership", membership(former, { teamId: former.homeTeamId, rawTeam: "BUF",
      effectiveFrom: "2025-09-01T00:00:00.000Z", effectiveTo: "2025-12-31T00:00:00.000Z" }))]);
    addCapture(dataset, "former-complete", completionMarkers(former));
    addCapture(dataset, "former-stats", [revision("former-stats", "player-game-stats", playerStats(former, 10, 60, former.homeTeamId, "BUF"))]);
    addCapture(dataset, "former-coverage", [revision("former-coverage", "schedule-coverage", coverage(former.homeTeamId, [gameId(20), former.gameId, gap.gameId]))]);
    await store.publish("A", dataset, NOW); const query = { ...request(), candidate: "stats-v1:player_pass_yds" as const };
    const before = await store.replay(query); expect(before).toEqual(buildPassingYardsBundle(dataset, query));
    expect(before.status).toBe("unavailable-inputs"); expect(before.player[1].exclusions).toContainEqual({ gameId: gap.gameId, reason: "membership-missing" });
    expect(before.player[1]).toMatchObject({ expectedGames: 7, observedGames: 6, excludedGames: 1, unknownGames: 1,
      gameIds: [...PRIOR].reverse().concat([gap.gameId, former.gameId]), attemptsSum: 120, passingYardsSum: 810 });
    const unrelated = emptyDataset();
    addCapture(unrelated, "unrelated", [revision("unrelated", "schedule", schedule(77, "2026-09-14T00:15:00.000Z", "nfl:team:SEA", "nfl:team:ARI"))]);
    await store.publish("unrelated", unrelated, NOW); expect(await store.replay(query)).toEqual(before);
  });
});
it("predictive retries and unchanged recaptures preserve immutable revisions and their earliest provenance", async () => {
  await withProof(async ({ client, store }) => {
    const dataset = passingYardsFixture(false); await store.publish("A", dataset, NOW); const before = await store.replay(request());
    const laterBefore = await store.replay(request(CUTOFF_B));
    const counts = (await client.query("SELECT (SELECT count(*) FROM predictive_observations)::integer AS revisions,(SELECT count(*) FROM predictive_captures)::integer AS captures")).rows;
    expect(await store.publish("A", dataset, NOW)).toMatchObject({ reused: true, status: "published" });
    expect((await client.query("SELECT (SELECT count(*) FROM predictive_observations)::integer AS revisions,(SELECT count(*) FROM predictive_captures)::integer AS captures")).rows).toEqual(counts);
    const recaptured = { ...dataset, captures: dataset.captures.map((capture) => ({ ...capture, id: "recaptured:" + capture.id, capturedAt: CAPTURE_B, availableAt: CAPTURE_B, ingestedAt: CAPTURE_B })) };
    await store.publish("recapture", recaptured, NOW); expect(await store.replay(request())).toEqual(before);
    expect(await store.replay(request(CUTOFF_B))).toEqual(laterBefore);
    expect((await client.query("SELECT count(*)::integer AS count FROM predictive_captures")).rows[0].count).toBe(2 * counts[0].captures);
    expect((await client.query("SELECT count(*)::integer AS count FROM predictive_observations")).rows[0].count).toBe(counts[0].revisions);
    const changedArtifact = { ...dataset, artifacts: dataset.artifacts.map((artifact) => {
      const bytes = JSON.stringify(JSON.parse(artifact.bytes), null, 2);
      return { ...artifact, id: "changed-bytes:" + artifact.id, bytes, sha256: digest(bytes) };
    }), captures: dataset.captures.map((capture) => ({ ...capture, id: "changed-bytes:" + capture.id,
      artifactId: "changed-bytes:" + capture.artifactId, capturedAt: CAPTURE_B, availableAt: CAPTURE_B, ingestedAt: CAPTURE_B })) };
    await store.publish("changed-bytes", changedArtifact, NOW);
    expect(await store.replay(request())).toEqual(before);
    expect(await store.replay(request(CUTOFF_B))).toEqual(laterBefore);
    expect((await client.query("SELECT count(*)::integer AS count FROM predictive_captures")).rows[0].count).toBe(3 * counts[0].captures);
    expect((await client.query("SELECT count(*)::integer AS count FROM predictive_artifacts")).rows[0].count).toBe(2 * dataset.artifacts.length);
    expect((await client.query("SELECT count(*)::integer AS count FROM predictive_blobs")).rows[0].count).toBe(2 * dataset.artifacts.length);
    expect((await client.query("SELECT count(*)::integer AS count FROM predictive_observations")).rows[0].count).toBe(counts[0].revisions);
  });
});
it("predictive publication is invisible until commit and concurrent retries publish one batch", async () => {
  await withProof(async ({ client, store, target, artifacts }) => {
    const observer = new Client(target.expected); const monitor = new Client(target.expected);
    const gate = Promise.withResolvers<void>(); const held = Promise.withResolvers<void>();
    let blocked = false;
    const observed = { query: async (sql: string, params?: unknown[]) => {
      const result = await client.query(sql, params);
      if (!blocked && sql.startsWith("INSERT INTO public.predictive_observations")) { blocked = true; held.resolve(); await gate.promise; }
      return result;
    } } as unknown as Client;
    let first: Promise<unknown> | undefined; let second: Promise<unknown> | undefined;
    try {
      await observer.connect(); await monitor.connect();
      const holderPid = await backendPid(client); const contenderPid = await backendPid(observer);
      expect(new Set([holderPid, contenderPid, await backendPid(monitor)]).size).toBe(3);
      const publisher = await createLocalPredictiveStore(observed, target, artifacts);
      const competitor = await createLocalPredictiveStore(observer, target, artifacts);
      const dataset = passingYardsFixture(false);
      // Attach rejection handlers immediately, including on assertion failures.
      first = publisher.publish("racing-A", dataset, NOW).then((value) => ({ value }), (error) => ({ error }));
      await Promise.race([held.promise, first.then(() => { throw new Error("Publisher finished before the held insertion"); })]);
      // Only the 32 migration-seeded teams are visible before commit.
      for (const [table, rows] of Object.entries(await snapshot(monitor))) expect(rows).toHaveLength(table === "predictive_teams" ? 32 : 0);
      second = competitor.publish("racing-A", dataset, NOW).then((value) => ({ value }), (error) => ({ error }));
      // Releasing immediately could turn this into two sequential calls. Require
      // PostgreSQL itself to observe the contender waiting behind the holder.
      await waitForBlocked(monitor, [contenderPid], holderPid);
      expect((await monitor.query("SELECT wait_event FROM pg_stat_activity WHERE pid=$1", [contenderPid])).rows[0].wait_event).toBe("advisory");
      gate.resolve();
      expect(await first).toMatchObject({ value: { status: "published", reused: false } });
      expect(await second).toMatchObject({ value: { status: "published", reused: true } });
      expect((await client.query("SELECT count(*)::integer AS count FROM predictive_ingestion_runs")).rows[0].count).toBe(1);
      expect((await store.replay(request())).status).toBe("ready-inputs");
    } finally {
      gate.resolve(); await Promise.allSettled([first, second]);
      await Promise.allSettled([observer.end(), monitor.end()]);
    }
  });
});
it("predictive failed and partial publication quarantine diagnostics without exposing partial inputs", async () => {
  await withProof(async ({ client, store, artifacts }) => {
    const partial = passingYardsFixture(false); partial.captures[0].state = "incomplete";
    expect(await ingestLocalDataset(store, "partial", partial, NOW)).toMatchObject({ status: "incomplete", failureCode: "partial-acquisition" });
    expect((await client.query("SELECT count(*)::integer AS count FROM predictive_observations")).rows[0].count).toBe(0);
    expect((await store.replay(request())).status).toBe("unavailable-inputs");
    expect((await client.query("SELECT state FROM predictive_captures")).rows).toEqual(partial.captures.map(() => ({ state: "incomplete" })));
    expect((await client.query("SELECT artifact_count,capture_count,row_count FROM predictive_ingestion_runs WHERE id='partial'")).rows[0])
      .toEqual({ artifact_count: partial.artifacts.length, capture_count: partial.captures.length, row_count: 0 });
    const bad = passingYardsFixture(false); const artifact = bad.artifacts[0]; const rows = JSON.parse(artifact.bytes); rows[0].data.extra = true;
    artifact.bytes = JSON.stringify(rows); artifact.sha256 = digest(artifact.bytes);
    expect(await ingestLocalDataset(store, "bad-schema", bad, NOW)).toMatchObject({ status: "refused", failureCode: "publication-refused" });
    expect((await client.query("SELECT count(*)::integer AS count FROM predictive_captures WHERE state='published'")).rows[0].count).toBe(0);
    expect((await client.query("SELECT count(*)::integer AS count FROM predictive_artifact_observations")).rows[0].count).toBe(0);
    expect((await client.query("SELECT artifact_count,capture_count,row_count FROM predictive_ingestion_runs WHERE id='bad-schema'")).rows[0])
      .toEqual({ artifact_count: bad.artifacts.length, capture_count: bad.captures.length, row_count: 0 });
    expect(await artifacts.database.read(artifact.sha256 + ".json", artifact.sha256, Buffer.byteLength(artifact.bytes))).toBe(artifact.bytes);
    await store.publish("A", passingYardsFixture(false), NOW);
    expect(await store.replay(request())).toEqual(buildPassingYardsBundle(passingYardsFixture(false), request()));
  });
});
it("predictive publication rolls back conflicts and invalid correction lineage while retaining the earlier replay", async () => {
  await withProof(async ({ client, store }) => {
    const dataset = passingYardsFixture(false); await store.publish("A", dataset, NOW); const before = await store.replay(request());
    const storedBefore = await snapshot(client);
    const changed = passingYardsFixture(false); const artifact = changed.artifacts.find((value) => value.id === "A-player-game-stats")!;
    const rows = JSON.parse(artifact.bytes); rows[0].data.passingYards = 777; artifact.bytes = JSON.stringify(rows); artifact.sha256 = digest(artifact.bytes);
    await expect(store.publish("conflict", changed, NOW)).rejects.toThrow("observation-id-conflict");
    expect(await snapshot(client)).toEqual(storedBefore);
    const valid = emptyDataset();
    const predecessor = JSON.parse(artifact.bytes).find((row: { id: string }) => row.id === "player-synthetic-game-5");
    addCapture(valid, "capture-conflict", [revision("new-correction", "player-game-stats", {
      ...predecessor.data, passingYards: 321,
    }, predecessor.id)], CAPTURE_B);
    valid.captures[0].id = "capture-A-player-game-stats";
    // This conflict occurs after run/artifact INSERTs, so equality of every
    // predictive table proves rollback rather than only refusal before writes.
    await expect(store.publish("late-conflict", valid, NOW)).rejects.toThrow("capture-id-conflict");
    expect(await snapshot(client)).toEqual(storedBefore);
    const retry = { ...dataset, captures: dataset.captures.map((capture) => ({ ...capture, id: "retry:" + capture.id })) };
    await expect(store.publish("A", retry, NOW)).rejects.toThrow("run-id-conflict");
    expect(await snapshot(client)).toEqual(storedBefore);
    const bad = passingYardsFixture(); const correction = bad.artifacts.find((value) => value.id === "B-player")!;
    const revisions = JSON.parse(correction.bytes); revisions[0].predecessorId = "missing"; correction.bytes = JSON.stringify(revisions); correction.sha256 = digest(correction.bytes);
    await expect(store.publish("bad-lineage", bad, NOW)).rejects.toThrow("invalid-correction-lineage");
    expect(await snapshot(client)).toEqual(storedBefore);
    expect(await store.replay(request())).toEqual(before);
  });
});
it("predictive immutable rows, typed evidence and source-chain keys are enforced by PostgreSQL", async () => {
  await withProof(async ({ client, store }) => {
    await store.publish("A", passingYardsFixture(false), NOW);
    const before = await snapshot(client);
    for (const table of tables) {
      const column = keyColumn[table] ?? "id";
      for (const sql of [`UPDATE ${table} SET ${column}=${column}`, `DELETE FROM ${table}`, `TRUNCATE ${table} CASCADE`]) {
        await expect(client.query(sql)).rejects.toMatchObject({ code: "23514", message: "predictive-append-only" });
      }
    }
    const originalRows = (await client.query(`SELECT DISTINCT ON (o.kind) o.kind,o.data,l.artifact_id FROM predictive_observations o
      JOIN predictive_artifact_observations l ON l.observation_id=o.id ORDER BY o.kind,o.id`)).rows;
    const originals = Object.fromEntries(originalRows.map((row) => [row.kind, row]));
    expect(originalRows).toHaveLength(7);
    // Valid controls must pass the same INSERT and deferred publication checks.
    const valid = async (kind: string, data: unknown, options: Parameters<typeof insertObservation>[4] = { sourceRecordId: "probe" }) => sqlProbe(client, async () => {
      await insertObservation(client, "sql-probe", kind, data, options);
      await client.query("INSERT INTO predictive_artifact_observations VALUES ($1,'sql-probe')", [originals[kind].artifact_id]);
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    });
    for (const row of originalRows) await valid(row.kind, row.data);
    const player = originals["player-game-stats"].data;
    for (const data of [{ ...player, attempts: 0, passingYards: 0 }, { ...player, passingYards: -5 },
      { ...player, attempts: null, passingYards: null, missing: { attempts: "source-blank", passingYards: "source-missing" } }]) await valid("player-game-stats", data);
    const invalid: [string, object][] = [
      ["schedule", { kickoff: "2026-02-30T17:00:00.000Z" }], ["schedule", { homeTeamId: originals.schedule.data.awayTeamId }],
      ["schedule", { rawGameday: "2026-10-11" }], ["membership", { effectiveTo: originals.membership.data.effectiveFrom }],
      ["player-game-stats", { extra: 1 }], ["player-game-stats", { attempts: -1 }], ["player-game-stats", { seasonType: null }],
      ["player-game-stats", { attempts: null }], ["player-game-stats", { passingYards: 0.5 }], ["player-game-stats", { completions: 11 }],
      ["player-game-stats", { missing: { attempts: "source-blank" } }], ["team-game-stats", { attempts: "10" }],
      ["event-state-marker", { markerType: "halftime" }], ["event-state-marker", { terminalPlayTimeOfDay: "20:00:00" }],
      ["availability", { rawDepthRank: 0 }], ["schedule-coverage", { gameIds: [TARGET, TARGET] }], ["schedule-coverage", { state: "assumed-complete" }],
    ];
    for (const [kind, changes] of invalid) await sqlProbe(client, async () => {
      const error = await insertObservation(client, "sql-probe", kind, { ...originals[kind].data, ...changes }, { sourceRecordId: "probe" }).then(() => null, (value) => value);
      expect(error).toMatchObject({ code: "23514" }); expect(error.constraint).toMatch(/^predictive_observations_check/);
    });
    const correctionData = (await client.query("SELECT data FROM predictive_observations WHERE id='player-synthetic-game-5'")).rows[0].data;
    // A predecessor from another fact, or the same fact under another provider's
    // source key, violates the source-chain foreign key.
    for (const options of [{ predecessor: "schedule-synthetic-game-5" }, { predecessor: "player-synthetic-game-1" },
      { predecessor: "player-synthetic-game-5", sourceRecordId: "other-record" }]) await sqlProbe(client, async () => {
      await insertObservation(client, "sql-probe", "player-game-stats", correctionData, options);
      await expect(client.query("SET CONSTRAINTS predictive_observations_predecessor_id_source_key_fkey IMMEDIATE"))
        .rejects.toMatchObject({ code: "23503", constraint: "predictive_observations_predecessor_id_source_key_fkey" });
    });
    await valid("player-game-stats", correctionData, { predecessor: "player-synthetic-game-5" });
    await sqlProbe(client, async () => {
      await insertObservation(client, "sql-probe", "player-game-stats", correctionData, { predecessor: "player-synthetic-game-5" });
      await expect(insertObservation(client, "sql-branch", "player-game-stats", { ...correctionData, passingYards: 1 }, { predecessor: "player-synthetic-game-5" }))
        .rejects.toMatchObject({ code: "23505", constraint: "predictive_observations_one_successor" });
    });
    await sqlProbe(client, async () => {
      await expect(client.query(`INSERT INTO predictive_observations (id,kind,profile_id,source_record_id,data,entity_key,source_key)
        VALUES ('bad-key','player-game-stats',$1,'',$2,'player-game-stats:wrong','player-game-stats:wrong|${PROFILE}|')`, [PROFILE, correctionData]))
        .rejects.toMatchObject({ code: "23514" });
    });
    expect(await snapshot(client)).toEqual(before);
    expect((await store.replay(request())).status).toBe("ready-inputs");
  });
});
it("predictive PostgreSQL enforces rights knowledge time, harness-only synthetic evidence and per-provider chains", async () => {
  await withProof(async ({ client, store, target }) => {
    // A rights decision recorded after the capture cannot authorize it, even
    // with a backdated effective date.
    const backdated = passingYardsFixture(false); backdated.rightsDecisions = [rights(PROFILE, { decidedAt: CAPTURE_B })];
    await expect(store.publish("backdated", backdated, NOW)).rejects.toMatchObject({ code: "23514" });
    const before = await snapshot(client);
    expect(before.predictive_rights_decisions).toHaveLength(0);
    await store.publish("A", passingYardsFixture(false), NOW);
    expect((await client.query("SELECT run_id,rights_decision_id FROM predictive_run_rights")).rows).toEqual([{ run_id: "A", rights_decision_id: "rights-" + PROFILE }]);
    // Two providers' claims for one fact coexist as separate chains and replay
    // as ambiguous until a reconciliation decision exists.
    const second = "synthetic-second-v1"; const secondSource = emptyDataset();
    secondSource.profiles.push(profile(second)); secondSource.rightsDecisions.push(rights(second));
    const original = findRow(passingYardsFixture(false), "player-synthetic-game-5") as Revision<"player-game-stats">;
    addCapture(secondSource, "second", [revision("second-player-5", "player-game-stats", { ...original.data, passingYards: 305 })], CAPTURE_A, second);
    await store.publish("second", secondSource, NOW);
    const ambiguous = await store.replay(request());
    expect(ambiguous.player[0].exclusions).toContainEqual({ gameId: PRIOR[4], reason: "player-stats-ambiguous" });
    // A later revocation keeps the audit record and blocks current use. Current
    // access uses the database clock, so an old caller-supplied computedAt (here
    // before the revocation's effective time) cannot bypass it.
    const revocation = emptyDataset();
    revocation.rightsDecisions.push(rights(PROFILE, { id: "revoked", predecessorId: "rights-" + PROFILE, allowedUses: [],
      effectiveFrom: "2026-10-09T12:00:00.000Z", decidedAt: "2026-10-09T12:00:00.000Z" }));
    addCapture(revocation, "noop", [revision("noop-unrelated", "schedule", schedule(78, "2026-09-14T00:15:00.000Z", "nfl:team:SEA", "nfl:team:ARI"))]);
    await store.publish("revocation", revocation, NOW);
    for (const computedAt of [request().computedAt, "2026-10-10T00:00:00.000Z"]) {
      const blocked = await store.replay({ ...request(), computedAt });
      expect(blocked.status).toBe("unavailable-inputs"); expect(blocked.reasons).toContain("rights-not-in-force");
    }
    expect((await client.query("SELECT count(*)::integer AS count FROM predictive_run_rights WHERE run_id='A'")).rows[0].count).toBe(1);
    await sqlProbe(client, async () => {
      // Branching and cross-profile chains are refused by keys, not by code.
      await expect(client.query(`INSERT INTO predictive_rights_decisions (id,profile_id,predecessor_id,allowed_uses,effective_from,decided_at,evidence_kind,evidence_reference)
        VALUES ('branch',$1,'rights-${PROFILE}','{}','2026-10-09T12:00:00Z','2026-10-09T12:00:00Z','synthetic','probe')`, [PROFILE]))
        .rejects.toMatchObject({ code: "23505" });
    });
    await sqlProbe(client, async () => {
      await expect(client.query(`INSERT INTO predictive_rights_decisions (id,profile_id,predecessor_id,allowed_uses,effective_from,decided_at,evidence_kind,evidence_reference)
        VALUES ('display',$1,'revoked','{public-display}','2026-10-09T13:00:00Z','2026-10-09T13:00:00Z','synthetic','probe')`, [PROFILE]))
        .rejects.toMatchObject({ code: "23514", message: "predictive-synthetic-rights-refused" });
    });
    // Synthetic evidence outside the harness role is refused before insertion.
    const outsider = new Client(target.expected);
    try {
      await outsider.connect();
      await outsider.query("CREATE ROLE predictive_outsider_probe NOLOGIN").catch(() => undefined);
      await outsider.query("GRANT ALL ON ALL TABLES IN SCHEMA public TO predictive_outsider_probe");
      await outsider.query("GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO predictive_outsider_probe");
      await outsider.query("BEGIN");
      try {
        await outsider.query("SET LOCAL SESSION AUTHORIZATION predictive_outsider_probe");
        // A settable flag cannot stand in for harness role membership.
        await outsider.query("SET LOCAL predictive.harness = 'on'");
        const runId = "outsider";
        await outsider.query(`INSERT INTO predictive_ingestion_runs (id,request_sha256,code_version,started_at,finished_at,status,failure_code,
          budget,requests,consumed_bytes,artifact_count,capture_count,row_count) VALUES ($1,$2,'probe',$3,$3,'refused','publication-refused','{}',0,0,0,1,0)`,
        [runId, "0".repeat(64), NOW]);
        await expect(outsider.query(`INSERT INTO predictive_captures (id,run_id,artifact_id,captured_at,available_at,ingested_at,state,body_complete,header_verified,parser_succeeded,parsed_rows)
          VALUES ('outsider-capture',$1,'A-schedule',$2,$2,$2,'incomplete',true,true,true,0)`, [runId, CAPTURE_A]))
          .rejects.toMatchObject({ code: "23514", message: "predictive-synthetic-outside-harness" });
      } finally { await outsider.query("ROLLBACK"); }
    } finally {
      await outsider.query("REVOKE ALL ON ALL TABLES IN SCHEMA public FROM predictive_outsider_probe").catch(() => undefined);
      await outsider.query("REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM predictive_outsider_probe").catch(() => undefined);
      await outsider.end();
    }
  });
});
it("predictive missing or tampered artifact bytes withhold replay without replacing stored evidence", async () => {
  await withProof(async ({ store, root, client, artifacts }) => {
    const dataset = passingYardsFixture(false); await store.publish("A", dataset, NOW);
    const artifact = dataset.artifacts.find((value) => value.id === "A-player-game-stats")!; const path = join(root, ".db-blobs", artifact.sha256 + ".json");
    const before = await store.replay(request()); expect(before.status).toBe("ready-inputs");
    const original = await readFile(path, "utf8"); const tampered = original.replace('"passingYards":50', '"passingYards":51');
    expect(tampered).not.toBe(original); expect(Buffer.byteLength(tampered)).toBe(Buffer.byteLength(original));
    await writeFile(path, tampered, { mode: 0o600 });
    expect(await store.safeReplay(request())).toEqual({ status: "unavailable", reason: "persisted-replay-unavailable" });
    await expect(artifacts.database.write(original, artifact.sha256)).rejects.toThrow("artifact-integrity-failed");
    expect(await readFile(path, "utf8")).toBe(tampered);
    await writeFile(path, original); expect(await store.replay(request())).toEqual(before);
    await rm(path); expect(await store.safeReplay(request())).toEqual({ status: "unavailable", reason: "persisted-replay-unavailable" });
    await writeFile(path, original, { mode: 0o600 });
    // Legal typed SQL alone cannot establish source-byte parity: this appended
    // revision is absent from the intact artifact. Runtime replay must refuse it.
    const data = JSON.parse(original)[0].data;
    await client.query("BEGIN");
    try {
      await insertObservation(client, "not-in-source", "player-game-stats", data, { sourceRecordId: "not-in-source" });
      await client.query("INSERT INTO predictive_artifact_observations VALUES ($1,'not-in-source')", [artifact.id]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    await expect(store.replay(request())).rejects.toThrow("stored-observation-mismatch");
    expect(await store.safeReplay(request())).toEqual({ status: "unavailable", reason: "persisted-replay-unavailable" });
  });
});
it("predictive indexed membership reads are player-scoped and read transactions remain read-only", async () => {
  await withProof(async ({ client, store, target, artifacts }) => {
    const dataset = passingYardsFixture(false);
    const member = findRow(dataset, "member-synthetic-game-1") as Revision<"membership">;
    addCapture(dataset, "other-player", [revision("other-player", "membership", { ...member.data, playerId: "00-0000002" })]);
    addCapture(dataset, "old-range", [revision("old-range", "membership", {
      ...member.data, gameId: gameId(77), effectiveFrom: "2023-01-01T00:00:00.000Z", effectiveTo: "2023-02-01T00:00:00.000Z",
    })]);
    await store.publish("A", dataset, NOW);
    const parameters = [request().cutoff, PLAYER, "2026-10-11T17:00:00.000Z", "2024-01-01T00:00:00.000Z"];
    const membershipRows = (await client.query(MEMBERSHIP_READ_SQL, parameters)).rows;
    expect(membershipRows).toHaveLength(6);
    expect(membershipRows.every((row) => row.envelope.revision.data.playerId === PLAYER)).toBe(true);
    expect(membershipRows.map((row) => row.envelope.revision.id)).not.toContain("old-range");
    expect((await client.query(MEMBERSHIP_READ_SQL, [parameters[0], "00-0000002", parameters[2], parameters[3]])).rows
      .map((row) => row.envelope.revision.id)).toEqual(["other-player"]);
    await client.query("BEGIN READ ONLY");
    try {
      await client.query("SET LOCAL enable_seqscan=off");
      // This proves index usability on the small fixture, not a production cost
      // claim or a requirement that the planner always choose it for tiny data.
      const plan = (await client.query("EXPLAIN (FORMAT JSON) " + MEMBERSHIP_READ_SQL, parameters)).rows[0]["QUERY PLAN"];
      expect(JSON.stringify(plan)).toContain("predictive_observations_membership_idx");
    } finally { await client.query("ROLLBACK"); }
    let probes = 0;
    const observed = { query: async (sql: string, params?: unknown[]) => {
      if (sql.startsWith("WITH keys AS") && probes++ === 0) {
        const settings = (await client.query(`SELECT current_setting('transaction_read_only') AS readonly,
          current_setting('transaction_isolation') AS isolation`)).rows[0];
        expect(settings).toEqual({ readonly: "on", isolation: "repeatable read" });
        await client.query("SAVEPOINT readonly_probe");
        try {
          await expect(client.query("INSERT INTO predictive_games (id) VALUES ('00000000-0000-4000-8000-000000000099')"))
            .rejects.toMatchObject({ code: "25006" });
        } finally { await client.query("ROLLBACK TO SAVEPOINT readonly_probe"); }
      }
      return client.query(sql, params);
    } } as unknown as Client;
    const reader = await createLocalPredictiveStore(observed, target, artifacts);
    expect((await reader.replay(request())).status).toBe("ready-inputs");
    expect(probes).toBeGreaterThan(0);
    expect((await client.query("SHOW transaction_read_only")).rows[0].transaction_read_only).toBe("off");
  });
});
it("predictive archive restoration recreates the same cutoff bundles in fresh scratch databases", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dfs-ev-predictive-restore-")));
  try {
    const captured = await runLocalProof(["demo", "--artifact-root", root], process.env);
    expect(captured).toMatchObject({ schemaVersion: 15, earlierReplayUnchanged: true, restoredReplayUnchanged: true });
    const restored = await runLocalProof(["restore", "--artifact-root", root, "--archive", captured.archive.reference,
      "--archive-bytes", String(captured.archive.byteSize)], process.env);
    expect(restored.capturedA).toEqual(captured.capturedA); expect(restored.laterB).toEqual(captured.laterB);
    expect(restored.unavailable).toEqual(captured.unavailable);
  } finally { await rm(root, { recursive: true, force: true }); }
});
it("predictive v2 upgrade preserves application rows and no-op migrations preserve the new history", async () => {
  const harness = await createScratchHarness(process.env); const files = await checkMigrationArtifacts(); const contracts = await loadCatalogContracts(files);
  try {
    await harness.withDatabase(async (client: Client, expected: object) => {
      const options = { expected, assertTarget: harness.assertTarget, files, verify: createCatalogVerifier(contracts) };
      await runScratchMigrations(client, { ...options, files: files.slice(0, 2) });
      await client.query("INSERT INTO creators (channel_name) VALUES ('Synthetic v2 survivor')");
      const before = (await client.query("SELECT * FROM creators")).rows;
      const historical = (await client.query("SELECT * FROM db_migrations ORDER BY version")).rows;
      expect(await runScratchMigrations(client, options)).toMatchObject({ schemaVersion: 15, executed: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] });
      expect((await client.query("SELECT * FROM creators")).rows).toEqual(before);
      const upgraded = (await client.query("SELECT * FROM db_migrations ORDER BY version")).rows;
      expect(upgraded.slice(0, 2)).toEqual(historical); expect(upgraded).toHaveLength(15);
      expect(upgraded[2]).toMatchObject({ version: 3, filename: "0003_predictive_evidence.sql", provenance: "executed" });
      expect(upgraded[3]).toMatchObject({ version: 4, filename: "0004_creator_corpus_projection.sql", provenance: "executed" });
      expect(upgraded[4]).toMatchObject({ version: 5, filename: "0005_predictive_source_claims.sql", provenance: "executed" });
      expect(upgraded[5]).toMatchObject({ version: 6, filename: "0006_predictive_source_bindings.sql", provenance: "executed" });
      expect(upgraded[6]).toMatchObject({ version: 7, filename: "0007_predictive_unavailable_bindings.sql", provenance: "executed" });
      expect(upgraded[7]).toMatchObject({ version: 8, filename: "0008_predictive_source_witnesses.sql", provenance: "executed" });
      expect(upgraded[8]).toMatchObject({ version: 9, filename: "0009_predictive_source_decisions.sql", provenance: "executed" });
      expect(await runScratchMigrations(client, options)).toMatchObject({ schemaVersion: 15, executed: [] });
      expect((await client.query("SELECT * FROM db_migrations ORDER BY version")).rows).toEqual(upgraded);
    });
  } finally { await harness.close(); }
});
it("predictive evidence reset refuses databases recording the removed synthetic migrations without repair", async () => {
  const harness = await createScratchHarness(process.env); const files = await checkMigrationArtifacts(); const contracts = await loadCatalogContracts(files);
  try {
    await harness.withDatabase(async (client: Client, expected: object) => {
      const options = { expected, assertTarget: harness.assertTarget, files, verify: createCatalogVerifier(contracts) };
      await runScratchMigrations(client, { ...options, files: files.slice(0, 2) });
      // The pre-reset synthetic v3 was only ever applied to disposable databases.
      // A database still recording it must be recreated, never relabelled.
      await client.query(`INSERT INTO db_migrations (version,filename,sha256,runner_version,provenance)
        VALUES (3,'0003_predictive_local_replay.sql','33c06dcc54dea80ab7e7cc9c6071f420dee184ca81608f618d7cff366b338bad',1,'executed')`);
      const history = (await client.query("SELECT * FROM db_migrations ORDER BY version")).rows;
      await expect(runScratchMigrations(client, options)).rejects.toThrow();
      expect((await client.query("SELECT * FROM db_migrations ORDER BY version")).rows).toEqual(history);
      expect((await client.query("SELECT to_regclass('public.predictive_observations') AS relation")).rows[0].relation).toBeNull();
    });
  } finally { await harness.close(); }
});
it("predictive roles hold only their granted privileges and PUBLIC cannot execute predictive functions", async () => {
  await withProof(async ({ client, store }) => {
    await store.publish("A", passingYardsFixture(false), NOW);
    const before = await snapshot(client);
    const functions = (await client.query(`SELECT p.proname, has_function_privilege('public', p.oid, 'EXECUTE') AS public_execute
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname LIKE 'predictive\\_%'`)).rows;
    expect(functions.length).toBeGreaterThan(10);
    expect(functions.filter((row) => row.public_execute).map((row) => row.proname)).toEqual([]);
    const as = (role: string, probe: () => Promise<void>) => sqlProbe(client, async () => { await client.query(`SET LOCAL ROLE ${role}`); await probe(); });
    const denied = { code: "42501" };
    // Ingest may append evidence through its grants alone, never change or remove it.
    const correctionData = (await client.query("SELECT data FROM predictive_observations WHERE id='player-synthetic-game-5'")).rows[0].data;
    await as("predictive_ingest", async () => {
      await client.query(`INSERT INTO predictive_ingestion_runs (id,request_sha256,code_version,started_at,finished_at,status,budget,requests,consumed_bytes,
        artifact_count,capture_count,row_count) VALUES ('ingest-role',$1,'probe',$2,$2,'published','{}',0,0,1,1,1)`, ["1".repeat(64), NOW]);
      await client.query("INSERT INTO predictive_blobs (sha256,byte_size,media_type,storage_ref) VALUES ($1,2,'application/json',$2)", ["a".repeat(64), "a".repeat(64) + ".json"]);
      await client.query(`INSERT INTO predictive_artifacts (id,blob_sha256,profile_id,retrieval_kind,origin,scope_kind)
        VALUES ('ingest-artifact',$1,$2,'full','fixture://ingest-role','manual')`, ["a".repeat(64), PROFILE]);
      await client.query(`INSERT INTO predictive_captures (id,run_id,artifact_id,captured_at,available_at,ingested_at,state,body_complete,header_verified,
        parser_succeeded,parsed_rows) VALUES ('ingest-capture','ingest-role','ingest-artifact',$1,$1,$1,'published',true,true,true,1)`, [CAPTURE_B]);
      await insertObservation(client, "ingest-correction", "player-game-stats", { ...correctionData, passingYards: 333 }, { predecessor: "player-synthetic-game-5" });
      await client.query("INSERT INTO predictive_artifact_observations (artifact_id,observation_id) VALUES ('ingest-artifact','ingest-correction')");
      await client.query("INSERT INTO predictive_run_rights (run_id,rights_decision_id) VALUES ('ingest-role',$1)", ["rights-" + PROFILE]);
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    });
    for (const sql of ["INSERT INTO predictive_teams (id) VALUES ('nfl:team:PHI')", "UPDATE predictive_observations SET id=id",
      "DELETE FROM predictive_observations", "TRUNCATE predictive_observations"]) {
      await as("predictive_ingest", async () => { await expect(client.query(sql)).rejects.toMatchObject(denied); });
    }
    // Replay reads and evaluates rights, and can write nothing.
    await as("predictive_replay", async () => {
      expect((await client.query("SELECT count(*)::integer AS count FROM predictive_observations")).rows[0].count).toBeGreaterThan(0);
      expect((await client.query("SELECT predictive_rights_allow($1,$2,$2,'model-input') AS allowed", [PROFILE, NOW])).rows[0].allowed).toBe(true);
    });
    for (const sql of ["INSERT INTO predictive_games (id) VALUES ('00000000-0000-4000-8000-000000000099')",
      "SELECT predictive_payload_valid('schedule', '{}'::jsonb)", "UPDATE predictive_captures SET id=id"]) {
      await as("predictive_replay", async () => { await expect(client.query(sql)).rejects.toMatchObject(denied); });
    }
    // A role with no grants can neither read evidence nor call validators.
    await client.query("DO $probe$ BEGIN CREATE ROLE predictive_outsider_probe NOLOGIN; EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL; END $probe$");
    for (const sql of ["SELECT * FROM predictive_observations", "SELECT predictive_entity_key('schedule', '{}'::jsonb)"]) {
      await as("predictive_outsider_probe", async () => { await expect(client.query(sql)).rejects.toMatchObject(denied); });
    }
    expect(await snapshot(client)).toEqual(before);
  });
});
it("predictive trial, research-only, cross-profile and out-of-order rights cannot authorize publication or current use", async () => {
  await withProof(async ({ client, store }) => {
    // Trial data carries adapter-testing only: it can never be published as evidence.
    const trial = passingYardsFixture(false); trial.rightsDecisions = [rights(PROFILE, { allowedUses: ["adapter-testing"] })];
    await expect(store.publish("trial", trial, NOW)).rejects.toMatchObject({ code: "23514" });
    expect((await client.query("SELECT count(*)::integer AS count FROM predictive_ingestion_runs")).rows[0].count).toBe(0);
    // Research-only rights publish, but current model use stays blocked.
    const research = passingYardsFixture(false); research.rightsDecisions = [rights(PROFILE, { allowedUses: ["internal-research"] })];
    await store.publish("research", research, NOW);
    const blocked = await store.replay(request());
    expect(blocked.status).toBe("unavailable-inputs"); expect(blocked.reasons).toContain("rights-not-in-force");
    const second = "synthetic-second-v1"; const other = emptyDataset();
    other.profiles.push(profile(second)); other.rightsDecisions = [{ ...rights(PROFILE), allowedUses: ["internal-research"] }, rights(second)];
    addCapture(other, "other", [revision("other-schedule", "schedule", schedule(79, "2026-09-14T00:15:00.000Z", "nfl:team:SEA", "nfl:team:ARI"))], CAPTURE_A, second);
    await store.publish("other", other, NOW);
    const insertDecision = (id: string, profileId: string, predecessor: string, decidedAt: string) => client.query(`INSERT INTO predictive_rights_decisions
      (id,profile_id,predecessor_id,allowed_uses,effective_from,decided_at,evidence_kind,evidence_reference)
      VALUES ($1,$2,$3,'{internal-research}',$4,$4,'synthetic','probe')`, [id, profileId, predecessor, decidedAt]);
    // A predecessor from another profile violates the same-profile chain key.
    await sqlProbe(client, async () => {
      await expect(insertDecision("crossed", second, "rights-" + PROFILE, NOW)).rejects.toMatchObject({ code: "23503" });
    });
    // Knowledge time never moves backwards along a chain.
    await sqlProbe(client, async () => {
      await expect(insertDecision("earlier", PROFILE, "rights-" + PROFILE, "2025-01-01T00:00:00.000Z"))
        .rejects.toMatchObject({ code: "23514", message: "predictive-rights-order-refused" });
    });
    // A later grant authorizes current use without rewriting the earlier audit row.
    const grant = emptyDataset(); grant.rightsDecisions = [{ ...rights(PROFILE), allowedUses: ["internal-research"] },
      rights(PROFILE, { id: "granted", predecessorId: "rights-" + PROFILE, decidedAt: "2026-10-08T23:00:00.000Z", effectiveFrom: "2026-10-08T23:00:00.000Z" })];
    addCapture(grant, "grant-noop", [revision("grant-noop", "schedule", schedule(80, "2026-09-14T00:15:00.000Z", "nfl:team:SEA", "nfl:team:ARI"))], CAPTURE_A);
    await store.publish("grant", grant, NOW);
    expect((await store.replay(request())).status).toBe("ready-inputs");
    expect((await client.query("SELECT rights_decision_id FROM predictive_run_rights WHERE run_id='research'")).rows).toEqual([{ rights_decision_id: "rights-" + PROFILE }]);
  });
});
it("predictive reconciliation decisions resolve only their exact provider heads and PostgreSQL refuses misstated evidence", async () => {
  await withProof(async ({ client, store }) => {
    const second = "synthetic-second-v1"; const fact = "player-game-stats:" + PRIOR[4] + ":" + PLAYER; const DECIDED = "2026-10-07T18:00:00.000Z";
    const dataset = passingYardsFixture(false); dataset.profiles.push(profile(second)); dataset.rightsDecisions.push(rights(second));
    const original = findRow(dataset, "player-synthetic-game-5") as Revision<"player-game-stats">;
    addCapture(dataset, "second-source", [revision("second-player-5", "player-game-stats", { ...original.data })], CAPTURE_A, second);
    await store.publish("A", dataset, NOW);
    expect((await store.replay(request())).status).toBe("unavailable-inputs");
    const heads = createReplay(dataset, CUTOFF_B, request().computedAt).heads(fact);
    const agree = reconcileFact("rec-agree", fact, heads, DECIDED, "synthetic-proof");
    const decisions = { ...emptyDataset(), profiles: dataset.profiles, rightsDecisions: dataset.rightsDecisions, decisions: [agree] };
    const partial = reconcileFact("rec-partial", fact, heads.slice(0, 1), DECIDED, "synthetic-proof");
    await expect(store.publish("partial-decision", { ...decisions, decisions: [partial] }, NOW))
      .rejects.toThrow("reconciliation-inputs-not-heads");
    await store.publish("decide", decisions, NOW);
    const withDecision = { ...dataset, decisions: [agree] };
    const resolved = await store.replay(request());
    expect(resolved).toEqual(buildPassingYardsBundle(withDecision, request()));
    expect(resolved.status).toBe("ready-inputs");
    expect(resolved.reconciliations).toEqual([{ decisionId: "rec-agree", entityKey: "reconciliation:" + fact, result: "selected", decidedAt: DECIDED }]);
    // Before its decision time the decision does not exist for replay.
    expect((await store.replay(request("2026-10-07T17:59:59.999Z"))).reconciliations).toEqual([]);
    const insertDecision = async (id: string, outcome: object, inputs: [string, string][], decidedAt = DECIDED, mode = "synthetic-proof", predecessor: string | null = null) => {
      await client.query(`INSERT INTO predictive_decisions (id,kind,entity_key,policy_id,mode,outcome,run_id,decided_at,predecessor_id)
        VALUES ($1,'reconciliation',$2,'reconciliation-v1',$3,$4,'decide',$5,$6)`, [id, "reconciliation:" + fact, mode, outcome, decidedAt, predecessor]);
      for (const [observation, role] of inputs) await client.query("INSERT INTO predictive_decision_inputs VALUES ($1,$2,$3)", [id, observation, role]);
    };
    const selected = { result: "selected", selectedObservationId: "player-synthetic-game-5", rule: "sources-agree" };
    const single = { result: "selected", selectedObservationId: "player-synthetic-game-5", rule: "single-source" };
    const pair: [string, string][] = [["player-synthetic-game-5", "selected"], ["second-player-5", "candidate"]];
    // Valid control under the same deferred checks.
    await sqlProbe(client, async () => { await insertDecision("probe-ok", selected, pair, DECIDED, "synthetic-proof", "rec-agree"); await client.query("SET CONSTRAINTS ALL IMMEDIATE"); });
    const refusals: [string, () => Promise<void>, string][] = [
      ["input usable only after the decision", () => insertDecision("probe", selected, pair, "2026-10-07T11:00:00.000Z"), "predictive-decision-invalid"],
      ["input from another fact", () => insertDecision("probe", selected, [["player-synthetic-game-5", "selected"], ["player-synthetic-game-4", "candidate"]]), "predictive-decision-invalid"],
      ["a reconciliation that omits a visible provider head", () => insertDecision("probe", single, [["player-synthetic-game-5", "selected"]]), "predictive-reconciliation-inputs-not-heads"],
      ["conflict claimed for agreeing sources", () => insertDecision("probe", { result: "conflict", selectedObservationId: null, rule: "material-discrepancy" },
        [["player-synthetic-game-5", "candidate"], ["second-player-5", "candidate"]]), "predictive-decision-rule-invalid"],
      ["selection naming an input not marked selected", () => insertDecision("probe", { ...selected, selectedObservationId: "second-player-5" }, pair), "predictive-decision-rule-invalid"],
      ["synthetic evidence under production mode", () => insertDecision("probe", selected, pair, DECIDED, "production-research"), "predictive-decision-mode-invalid"],
    ];
    for (const [, insert, message] of refusals) await sqlProbe(client, async () => {
      await insert();
      await expect(client.query("SET CONSTRAINTS ALL IMMEDIATE")).rejects.toMatchObject({ code: "23514", message });
    });
    await sqlProbe(client, async () => {
      await insertDecision("probe-a", selected, pair, DECIDED, "synthetic-proof", "rec-agree");
      await expect(insertDecision("probe-b", selected, pair, DECIDED, "synthetic-proof", "rec-agree")).rejects.toMatchObject({ code: "23505", constraint: "predictive_decisions_one_successor" });
    });
    // A later correction to one provider makes the decision stale for later cutoffs only.
    const correction = { ...emptyDataset(), profiles: dataset.profiles, rightsDecisions: dataset.rightsDecisions };
    addCapture(correction, "first-correction", [revision("first-correction", "player-game-stats", { ...original.data }, original.id)], CAPTURE_B);
    await store.publish("correction", correction, NOW);
    expect((await store.replay(request())).status).toBe("ready-inputs");
    const stale = await store.replay(request(CUTOFF_B));
    expect(stale.status).toBe("unavailable-inputs"); expect(stale.player[0].exclusions).toContainEqual({ gameId: PRIOR[4], reason: "player-stats-ambiguous" });
  });
});
it("predictive coverage-aware absences block later cutoffs only and PostgreSQL refuses unproven disappearance", async () => {
  await withProof(async ({ client, store }) => {
    const seasonFile = { scopeKind: "season-file" as const, scopeSeason: 2026 };
    const a = passingYardsFixture(false); Object.assign(a.artifacts.find((value) => value.id === "A-team-game-stats")!, seasonFile);
    await store.publish("A", a, NOW); const before = await store.replay(request());
    // A later complete season file no longer contains games 4 and 5; only game 5's absence is recorded here.
    const later = emptyDataset(); const teamRows = JSON.parse(a.artifacts.find((value) => value.id === "A-team-game-stats")!.bytes) as Revision[];
    addCapture(later, "covering-file", teamRows.filter((value) => !["team-synthetic-game-4", "team-synthetic-game-5"].includes(value.id)), CAPTURE_B);
    Object.assign(later.artifacts[0], seasonFile);
    const absenceFor = (priorId: string, number: number) => {
      const prior = findRow(a, priorId) as Revision<"team-game-stats">;
      return revision("absent-" + priorId, "source-row-absent", { priorObservationId: prior.id, priorEntityKey: "team-game-stats:" + gameId(number) + ":" + TEAM,
        coveringCaptureId: "capture-covering-file", scopeKind: "season-file", scopeSeason: 2026, scopeWeek: null, scopeGameId: null, scopeFilter: null,
        gameId: prior.data.gameId, teamId: prior.data.teamId, season: prior.data.season, seasonType: prior.data.seasonType }, prior.id);
    };
    const absence = absenceFor("team-synthetic-game-5", 5);
    addCapture(later, "absence-ledger", [absence], CAPTURE_B);
    await store.publish("absence", later, NOW);
    expect(await store.replay(request())).toEqual(before);
    const full = { ...a, artifacts: [...a.artifacts, ...later.artifacts], captures: [...a.captures, ...later.captures] };
    const blocked = await store.replay(request(CUTOFF_B));
    expect(blocked).toEqual(buildPassingYardsBundle(full, request(CUTOFF_B)));
    expect(blocked.reasons).toContain("required-input-disappeared");
    // Copied routing populates the indexed columns, so scoped reads find the absence head.
    expect((await client.query("SELECT team_id, game_id::text AS game_id, season FROM predictive_observations WHERE id=$1", [absence.id])).rows[0])
      .toEqual({ team_id: TEAM, game_id: PRIOR[4], season: 2026 });
    const probeData = absenceFor("team-synthetic-game-4", 4).data;
    const probe = (data: object) => sqlProbe(client, async () => {
      await insertObservation(client, "probe-absent", "source-row-absent", data, { predecessor: "team-synthetic-game-4" });
      await client.query("INSERT INTO predictive_artifact_observations (artifact_id,observation_id) VALUES ('absence-ledger','probe-absent')");
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    });
    await probe(probeData);
    for (const [change, label] of [[{ coveringCaptureId: "capture-unknown" }, "unknown covering capture"], [{ season: 2025 }, "routing that differs from the prior"],
      [{ priorObservationId: "team-synthetic-game-3" }, "prior that is not the predecessor"],
      [{ coveringCaptureId: "capture-A-team-game-stats" }, "covering capture that still contains the row"],
      [{ scopeKind: "all-seasons", scopeSeason: null }, "scope that misstates the covering artifact"]] as const) {
      await expect(probe({ ...probeData, ...change }), label).rejects.toMatchObject({ code: "23514", message: "predictive-absence-invalid" });
    }
    // A game-scoped capture proves absence only for that exact game. The season
    // alone cannot make a different game's empty capture cover this source row.
    const scopedGame = gameId(32); const original = findRow(a, "team-synthetic-game-5") as Revision<"team-game-stats">;
    const scopedPrior = emptyDataset();
    addCapture(scopedPrior, "game-scope-prior", [revision("game-scope-prior", "team-game-stats",
      { ...original.data, gameId: scopedGame, rawGameId: "synthetic-game-32" }, null, "game-scope-proof")], CAPTURE_A);
    Object.assign(scopedPrior.artifacts[0], { scopeKind: "game", scopeSeason: 2026, scopeGameId: scopedGame });
    await store.publish("game-scope-prior", scopedPrior, NOW);
    const coverings = emptyDataset();
    addCapture(coverings, "game-cover-same", [], CAPTURE_B);
    Object.assign(coverings.artifacts.at(-1)!, { scopeKind: "game", scopeSeason: 2026, scopeGameId: scopedGame });
    addCapture(coverings, "game-cover-other", [], CAPTURE_B);
    Object.assign(coverings.artifacts.at(-1)!, { scopeKind: "game", scopeSeason: 2026, scopeGameId: TARGET });
    await store.publish("game-scope-coverings", coverings, NOW);
    const gameScopeData = (coveringCaptureId: string, scopeGameId: string) => ({ priorObservationId: "game-scope-prior",
      priorEntityKey: "team-game-stats:" + scopedGame + ":" + TEAM, coveringCaptureId, scopeKind: "game", scopeSeason: 2026,
      scopeWeek: null, scopeGameId, scopeFilter: null, gameId: scopedGame, teamId: TEAM, season: 2026, seasonType: "REG" });
    const gameScopeProbe = (data: object) => sqlProbe(client, async () => {
      await insertObservation(client, "probe-game-absence", "source-row-absent", data,
        { predecessor: "game-scope-prior", sourceRecordId: "game-scope-proof" });
      await client.query("INSERT INTO predictive_artifact_observations (artifact_id,observation_id) VALUES ('absence-ledger','probe-game-absence')");
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    });
    await expect(gameScopeProbe(gameScopeData("capture-game-cover-other", TARGET)))
      .rejects.toMatchObject({ code: "23514", message: "predictive-absence-invalid" });
    await gameScopeProbe(gameScopeData("capture-game-cover-same", scopedGame));
    // The row reappears: the provider chain simply continues after the absence.
    const back = emptyDataset(); const prior = findRow(a, "team-synthetic-game-5") as Revision<"team-game-stats">;
    addCapture(back, "returned", [revision("team-5-returns", "team-game-stats", prior.data, absence.id)], "2026-10-08T15:00:00.000Z");
    await store.publish("returned", back, NOW);
    const returned = await store.replay(request("2026-10-08T16:00:00.000Z"));
    expect(returned.reasons).not.toContain("required-input-disappeared");
    expect(returned.team![0].games.map((game) => game.gameId)).toContain(PRIOR[4]);
  });
});
it("predictive completion records must cite exactly the marker heads known at their decision time and state the policy outcome", async () => {
  await withProof(async ({ client, store }) => {
    const a = passingYardsFixture(false); await store.publish("A", a, NOW);
    const recorded = recordCompletion("completion-5", PRIOR[4], markerHeadsAt(validateDataset(a).observations.values(), PRIOR[4], instant(CAPTURE_A)), CAPTURE_A, "synthetic-proof");
    await store.publish("decide", { ...emptyDataset(), profiles: a.profiles, rightsDecisions: a.rightsDecisions, decisions: [recorded] }, NOW);
    const replay = await store.replay(request());
    expect(replay).toEqual(buildPassingYardsBundle({ ...a, decisions: [recorded] }, request()));
    expect(replay.completions).toEqual([{ decisionId: "completion-5", gameId: PRIOR[4], state: "completed", decidedAt: CAPTURE_A }]);
    const insert = async (id: string, outcome: object, inputs: string[], options: { decidedAt?: string; mode?: string; predecessor?: string | null } = {}) => {
      await client.query(`INSERT INTO predictive_decisions (id,kind,entity_key,policy_id,mode,outcome,run_id,decided_at,predecessor_id)
        VALUES ($1,'completion',$2,'event-completion-v1',$3,$4,'decide',$5,$6)`,
      [id, "completion:" + PRIOR[4], options.mode ?? "synthetic-proof", outcome, options.decidedAt ?? CAPTURE_A, options.predecessor ?? null]);
      for (const observation of inputs) await client.query("INSERT INTO predictive_decision_inputs VALUES ($1,$2,'marker')", [id, observation]);
    };
    const completed = { state: "completed", completionObservedAt: CAPTURE_A, actualEnd: null };
    const markers = ["final-synthetic-game-5", "terminal-synthetic-game-5"];
    await sqlProbe(client, async () => { await insert("probe-ok", completed, markers, { predecessor: "completion-5" }); await client.query("SET CONSTRAINTS ALL IMMEDIATE"); });
    const refusals: [string, () => Promise<void>, string][] = [
      ["a cherry-picked marker set", () => insert("probe", completed, markers.slice(0, 1)), "predictive-completion-inputs-invalid"],
      ["a state the markers do not support", () => insert("probe", { state: "in-progress", completionObservedAt: null, actualEnd: null }, markers), "predictive-decision-rule-invalid"],
      ["an earlier observed time", () => insert("probe", { ...completed, completionObservedAt: "2026-10-07T11:00:00.000Z" }, markers), "predictive-decision-rule-invalid"],
      ["a decision before its markers were usable", () => insert("probe", completed, markers, { decidedAt: "2026-10-07T11:00:00.000Z" }), "predictive-completion-inputs-invalid"],
      ["synthetic markers under production mode", () => insert("probe", completed, markers, { mode: "production-research" }), "predictive-decision-mode-invalid"],
    ];
    for (const [label, run, message] of refusals) await sqlProbe(client, async () => {
      await run();
      await expect(client.query("SET CONSTRAINTS ALL IMMEDIATE"), label).rejects.toMatchObject({ code: "23514", message });
    });
    await sqlProbe(client, async () => {
      await expect(insert("probe", { ...completed, actualEnd: "2026-10-07T12:00:00.000Z" }, markers)).rejects.toMatchObject({ code: "23514" });
    });
    // A later suspension notice changes the heads: the record is no longer cited.
    const later = { ...emptyDataset(), profiles: a.profiles, rightsDecisions: a.rightsDecisions };
    addCapture(later, "late-suspension", [revision("late-suspension", "event-state-marker", { gameId: PRIOR[4], markerType: "suspension-notice", markerValue: "notice", terminalPlayTimeOfDay: null })], CAPTURE_B);
    await store.publish("suspension", later, NOW);
    expect((await store.replay(request())).completions).toHaveLength(1);
    const stale = await store.replay(request(CUTOFF_B));
    expect(stale.completions).toEqual([]);
    expect(stale.player[0].exclusions).toContainEqual({ gameId: PRIOR[4], reason: "completion-conflicting" });
  });
});
it("predictive participation records and outcome labels enforce all nine binding checks in PostgreSQL", async () => {
  await withProof(async ({ client, store }) => {
    const a = passingYardsFixture(false); await store.publish("A", a, NOW);
    const observations = validateDataset(a).observations; const t = instant(CAPTURE_A);
    const decisionsFor = (number: number) => {
      const game = gameId(number);
      return [recordCompletion("completion-" + number, game, markerHeadsAt(observations.values(), game, t), CAPTURE_A, "synthetic-proof"),
        recordParticipation("participation-" + number, game, PLAYER, participationHeadsAt(observations.values(), game, PLAYER, t), CAPTURE_A, "synthetic-proof"),
        reconcileFact("reconciliation-" + number, "player-game-stats:" + game + ":" + PLAYER,
          [...observations.values()].filter((value) => value.entityKey === "player-game-stats:" + game + ":" + PLAYER), CAPTURE_A, "synthetic-proof")];
    };
    const registrations = { profiles: a.profiles, rightsDecisions: a.rightsDecisions };
    await store.publish("decisions", { ...emptyDataset(), ...registrations, decisions: [...decisionsFor(5), ...decisionsFor(4)] }, NOW);
    expect((await client.query("SELECT outcome FROM predictive_decisions WHERE id='participation-5'")).rows[0].outcome).toEqual({ state: "offensive-participant" });
    const post = { ...emptyDataset(), ...registrations };
    addCapture(post, "post-window", JSON.parse(a.artifacts.find((value) => value.id === "A-player-game-stats")!.bytes), "2026-10-10T13:00:00.000Z");
    const AFTER_WINDOW = "2026-10-11T00:00:00.000Z";
    await store.publish("post-window", post, AFTER_WINDOW);
    // Roster-backed bridges and the link letting them resolve this stats profile's
    // GSIS identities. The other bridges exist only to be refused below.
    const bridge = (id: string, data: object) => revision(id, "player-bridge", { provider: "gsis", rawPlayerId: PLAYER, playerId: PLAYER,
      effectiveFrom: "2026-01-01T00:00:00.000Z", effectiveTo: "2027-01-01T00:00:00.000Z", ...data } as never);
    const bridges = { ...emptyDataset(), ...registrations,
      identityLinks: [{ id: "link-gsis", statsProfileId: PROFILE, bridgeProfileId: PROFILE, provider: "gsis", decidedAt: "2026-01-01T00:00:00.000Z" }] };
    addCapture(bridges, "roster-bridges", [bridge("bridge-gsis", {}), bridge("bridge-other", { rawPlayerId: "x-2", playerId: "00-0000002" }),
      bridge("bridge-old", { rawPlayerId: "old-id", effectiveFrom: "2025-01-01T00:00:00.000Z", effectiveTo: "2025-12-31T00:00:00.000Z" }),
      bridge("bridge-unlinked", { provider: "other-ns" })]);
    await store.publish("bridges", bridges, NOW);
    const provisional: Label = { id: "label-5-v1", playerId: PLAYER, gameId: PRIOR[4], seasonType: "REG", stat: "passing_yards", value: 300,
      state: "provisional", mode: "synthetic-proof", policyId: "canonical-label-finalization-v1", labelVersion: 1, predecessorId: null,
      completionDecisionId: "completion-5", participationDecisionId: "participation-5", reconciliationDecisionId: "reconciliation-5",
      selectedObservationId: "player-synthetic-game-5", eligibleFinalAt: null, postWindowCaptureId: null, finalizedAt: null, createdAt: "2026-10-07T13:00:00.000Z",
      playerBridgeObservationId: null };
    const final: Label = { ...provisional, id: "label-5-v2", state: "final", labelVersion: 2, predecessorId: "label-5-v1",
      eligibleFinalAt: "2026-10-10T12:00:00.000Z", postWindowCaptureId: "capture-post-window", finalizedAt: "2026-10-10T14:00:00.000Z", createdAt: "2026-10-10T14:00:00.000Z",
      playerBridgeObservationId: "bridge-gsis" };
    await expect(store.publish("labels-early", { ...emptyDataset(), ...registrations, labels: [provisional, final] }, NOW)).rejects.toThrow("publication-time-refused");
    await store.publish("labels", { ...emptyDataset(), ...registrations, labels: [provisional, final] }, AFTER_WINDOW);
    expect((await client.query("SELECT id, state, value FROM predictive_outcome_labels ORDER BY label_version")).rows)
      .toEqual([{ id: "label-5-v1", state: "provisional", value: 300 }, { id: "label-5-v2", state: "final", value: 300 }]);
    const insert = (label: Label) => client.query(`INSERT INTO predictive_outcome_labels (id,player_id,game_id,season_type,stat,value,state,mode,policy_id,
      label_version,predecessor_id,run_id,completion_decision_id,participation_decision_id,reconciliation_decision_id,selected_observation_id,
      eligible_final_at,post_window_capture_id,finalized_at,created_at,player_bridge_observation_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'labels',$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
    [label.id, label.playerId, label.gameId, label.seasonType, label.stat, label.value, label.state, label.mode, label.policyId, label.labelVersion,
      label.predecessorId, label.completionDecisionId, label.participationDecisionId, label.reconciliationDecisionId, label.selectedObservationId,
      label.eligibleFinalAt, label.postWindowCaptureId, label.finalizedAt, label.createdAt, label.playerBridgeObservationId]);
    const fresh = (label: Label): Label => ({ ...label, id: "probe", stat: "attempts", value: label.value === null ? null : 40 });
    // Valid control: a fresh attempts label under the same deferred checks.
    await sqlProbe(client, async () => { await insert(fresh(provisional)); await client.query("SET CONSTRAINTS ALL IMMEDIATE"); });
    const refusals: [number, Label][] = [
      [1, { ...fresh(provisional), completionDecisionId: "completion-4" }],
      [2, { ...fresh(provisional), state: "excluded", value: null, selectedObservationId: null, reconciliationDecisionId: null }],
      [3, { ...fresh(provisional), reconciliationDecisionId: "reconciliation-4" }],
      [4, { ...fresh(provisional), value: 41 }],
      [5, { ...fresh(provisional), state: "final", playerBridgeObservationId: "bridge-gsis", eligibleFinalAt: "2026-10-10T12:00:00.000Z", postWindowCaptureId: "capture-A-player-game-stats",
        finalizedAt: "2026-10-10T14:00:00.000Z", createdAt: "2026-10-10T14:00:00.000Z" }],
      [6, { ...fresh(provisional), state: "final", playerBridgeObservationId: "bridge-gsis", eligibleFinalAt: "2026-10-10T12:00:00.000Z", postWindowCaptureId: "capture-post-window",
        finalizedAt: "2026-10-10T12:30:00.000Z", createdAt: "2026-10-10T12:30:00.000Z" }],
      // Chained to the current head but for a different stat: not the same natural key.
      [7, { ...fresh(provisional), labelVersion: 3, predecessorId: "label-5-v2" }],
      [8, { ...fresh(provisional), mode: "production-research" }],
      [9, { ...fresh(provisional), playerBridgeObservationId: "bridge-other" }],
      [9, { ...fresh(provisional), playerBridgeObservationId: "bridge-old" }],
      [9, { ...fresh(provisional), playerBridgeObservationId: "bridge-unlinked" }],
    ];
    for (const [number, label] of refusals) await sqlProbe(client, async () => {
      await insert(label);
      await expect(client.query("SET CONSTRAINTS ALL IMMEDIATE"), "binding " + number).rejects.toMatchObject({ code: "23514", message: "predictive-label-binding-" + number });
    });
    await sqlProbe(client, async () => {
      await expect(insert({ ...final, id: "branch" })).rejects.toMatchObject({ code: "23505" });
    });
    await sqlProbe(client, async () => {
      await expect(insert({ ...fresh(provisional), state: "excluded", value: 0 })).rejects.toMatchObject({ code: "23514" });
    });
    // A final label must pin a bridge; a valid bridge on a provisional label is accepted.
    await sqlProbe(client, async () => {
      await expect(insert({ ...fresh(final), predecessorId: null, labelVersion: 1, playerBridgeObservationId: null })).rejects.toMatchObject({ code: "23514" });
    });
    await sqlProbe(client, async () => { await insert({ ...fresh(provisional), playerBridgeObservationId: "bridge-gsis" }); await client.query("SET CONSTRAINTS ALL IMMEDIATE"); });
    // A correction to the bridge makes it stale for labels created afterwards.
    await sqlProbe(client, async () => {
      await client.query(`INSERT INTO predictive_ingestion_runs (id,request_sha256,code_version,started_at,finished_at,status,budget,requests,consumed_bytes,
        artifact_count,capture_count,row_count) VALUES ('bridge-fix',$1,'probe',$2,$2,'published','{}',0,0,1,1,1)`, ["2".repeat(64), "2026-10-09T00:00:00.000Z"]);
      await client.query("INSERT INTO predictive_blobs (sha256,byte_size,media_type,storage_ref) VALUES ($1,2,'application/json',$2)", ["b".repeat(64), "b".repeat(64) + ".json"]);
      await client.query(`INSERT INTO predictive_artifacts (id,blob_sha256,profile_id,retrieval_kind,origin,scope_kind)
        VALUES ('bridge-fix-artifact',$1,$2,'full','fixture://bridge-fix','manual')`, ["b".repeat(64), PROFILE]);
      await client.query(`INSERT INTO predictive_captures (id,run_id,artifact_id,captured_at,available_at,ingested_at,state,body_complete,header_verified,
        parser_succeeded,parsed_rows) VALUES ('bridge-fix-capture','bridge-fix','bridge-fix-artifact',$1,$1,$1,'published',true,true,true,1)`, ["2026-10-09T00:00:00.000Z"]);
      await insertObservation(client, "bridge-gsis-fix", "player-bridge", { provider: "gsis", rawPlayerId: PLAYER, playerId: PLAYER,
        effectiveFrom: "2026-01-01T00:00:00.000Z", effectiveTo: "2027-06-01T00:00:00.000Z" }, { predecessor: "bridge-gsis" });
      await client.query("INSERT INTO predictive_artifact_observations (artifact_id,observation_id) VALUES ('bridge-fix-artifact','bridge-gsis-fix')");
      await client.query("INSERT INTO predictive_run_rights (run_id,rights_decision_id) VALUES ('bridge-fix',$1)", ["rights-" + PROFILE]);
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");
      // Constraints are immediate for the rest of this transaction, so the insert itself is refused.
      await expect(insert({ ...fresh(provisional), playerBridgeObservationId: "bridge-gsis", createdAt: "2026-10-10T14:00:00.000Z" }))
        .rejects.toMatchObject({ code: "23514", message: "predictive-label-binding-9" });
    });
  });
});
it("predictive feature runs are recorded after read-only computation with exact dependencies, digests and retention", async () => {
  await withProof(async ({ client, store, target, artifacts }) => {
    const a = passingYardsFixture(false); await store.publish("A", a, NOW);
    const observations = validateDataset(a).observations;
    const recorded = recordCompletion("completion-5", PRIOR[4], markerHeadsAt(observations.values(), PRIOR[4], instant(CAPTURE_A)), CAPTURE_A, "synthetic-proof");
    const participation = recordParticipation("participation-5", PRIOR[4], PLAYER,
      participationHeadsAt(observations.values(), PRIOR[4], PLAYER, instant(CAPTURE_A)), CAPTURE_A, "synthetic-proof");
    const registrations = { profiles: a.profiles, rightsDecisions: a.rightsDecisions };
    await store.publish("decide", { ...emptyDataset(), ...registrations, decisions: [recorded, participation] }, NOW);
    const pureDataset = { ...a, decisions: [recorded, participation] };
    const pure = buildPassingYardsFromReplay(createReplay(pureDataset, request().cutoff, request().computedAt), request());
    expect(await store.replay(request())).toEqual(pure);
    expect(pure.participations).toEqual([{ decisionId: "participation-5", gameId: PRIOR[4], state: "offensive-participant", decidedAt: CAPTURE_A }]);
    const first = await store.replayAndRecord(request());
    if (first.status !== "recorded") throw new Error("expected a recorded run");
    expect(first.bundle).toEqual(pure);
    const run = (await client.query("SELECT * FROM predictive_feature_runs WHERE id=$1", [first.featureRunId])).rows[0];
    // recorded_at is the database clock at recording, and the run ID is the
    // server's execution digest, which the TypeScript mirror reproduces.
    const stampedAt = (run.recorded_at as Date).toISOString();
    expect(Math.abs(Date.now() - new Date(stampedAt).getTime())).toBeLessThan(60_000);
    const policies = (await client.query("SELECT policy_id FROM predictive_feature_run_dependencies WHERE feature_run_id=$1 AND policy_id IS NOT NULL",
      [first.featureRunId])).rows.map((row) => row.policy_id as string);
    expect(first.executionDigest).toBe(executionDigest({ inputDigest: first.bundle.inputDigest, rightsDecisions: ["rights-" + PROFILE], policies,
      featureVersion: first.bundle.featureVersion, codeVersion: FEATURE_CODE_VERSION, computedAt: first.bundle.computedAt, recordedAt: stampedAt }));
    expect(run).toMatchObject({ input_digest: first.bundle.inputDigest, status: "ready-inputs", mode: "synthetic-proof", feature_version: "passing-yards-replay-v3" });
    const dependencies = (await client.query("SELECT * FROM predictive_feature_run_dependencies WHERE feature_run_id=$1", [first.featureRunId])).rows;
    expect(dependencies.filter((row) => row.observation_id).map((row) => row.observation_id).sort()).toEqual(first.bundle.dependencies.map((row) => row.observationId).sort());
    expect(dependencies.filter((row) => row.decision_id).map((row) => row.decision_id).sort()).toEqual(["completion-5", "participation-5"]);
    expect(dependencies.filter((row) => row.rights_decision_id).map((row) => row.rights_decision_id)).toEqual(["rights-" + PROFILE]);
    expect(dependencies.filter((row) => row.feature_definition_id).map((row) => row.feature_definition_id)).toEqual(["passing-yards-replay-v3"]);
    const blob = (await client.query("SELECT byte_size,storage_ref FROM predictive_blobs WHERE sha256=$1", [run.bundle_blob_sha256])).rows[0];
    expect(JSON.parse(await artifacts.database.read(blob.storage_ref, run.bundle_blob_sha256, blob.byte_size))).toEqual(first.bundle);
    // A renewed rights decision that still allows model input changes only the execution record.
    const renewal = { ...emptyDataset(), profiles: a.profiles, rightsDecisions: [...a.rightsDecisions,
      rights(PROFILE, { id: "rights-renewed", predecessorId: "rights-" + PROFILE, effectiveFrom: "2026-10-09T12:00:00.000Z", decidedAt: "2026-10-09T12:00:00.000Z" })] };
    addCapture(renewal, "renewal-noop", [revision("renewal-noop", "schedule", schedule(81, "2026-09-14T00:15:00.000Z", "nfl:team:SEA", "nfl:team:ARI"))]);
    await store.publish("renewal", renewal, NOW);
    const second = await store.replayAndRecord(request());
    if (second.status !== "recorded") throw new Error("expected a recorded run");
    expect(second.inputDigest).toBe(first.inputDigest); expect(second.executionDigest).not.toBe(first.executionDigest);
    expect((await client.query("SELECT rights_decision_id FROM predictive_feature_run_dependencies WHERE feature_run_id=$1 AND rights_decision_id IS NOT NULL",
      [second.featureRunId])).rows).toEqual([{ rights_decision_id: "rights-renewed" }]);
    // A run that cannot be recorded is reported unavailable, never returned as usable.
    const failing = { query: async (sql: string, params?: unknown[]) => {
      if (sql.includes("predictive_record_feature_run")) throw new Error("simulated recording failure");
      return client.query(sql, params);
    } } as unknown as Client;
    const broken = await createLocalPredictiveStore(failing, target, artifacts);
    expect(await broken.replayAndRecord(request())).toEqual({ status: "unavailable", reason: "feature-run-not-recorded" });
    expect((await client.query("SELECT count(*)::integer AS count FROM predictive_feature_runs")).rows[0].count).toBe(2);
    // The deferred checks, exercised as the recorder role on copies of a valid run.
    const correction = passingYardsFixture();
    await store.publish("B", { ...emptyDataset(), ...registrations, artifacts: correction.artifacts.filter((value) => value.id.startsWith("B-")),
      captures: correction.captures.filter((value) => value.artifactId.startsWith("B-")) }, NOW);
    // The recorder can't insert runs or manifests directly; the deferred checks
    // are the backstop beneath the recorder function, exercised as the table owner.
    for (const sql of ["INSERT INTO predictive_feature_runs (id) VALUES ('direct')",
      "INSERT INTO predictive_feature_run_dependencies (feature_run_id,policy_id) VALUES ('x','y-v1')"]) {
      await sqlProbe(client, async () => { await client.query("SET LOCAL ROLE predictive_recorder"); await expect(client.query(sql)).rejects.toMatchObject({ code: "42501" }); });
    }
    const copy = async (filter: string, overrides = "", extra: [string, string] | null = null, cutoff = "cutoff") => {
      await client.query(`INSERT INTO predictive_feature_runs (id,mode,feature_version,candidate,player_id,game_id,cutoff,computed_at,recorded_at,code_version,
        status,reasons,input_digest,execution_digest,bundle_blob_sha256) SELECT 'probe', ${overrides || "mode"},feature_version,candidate,player_id,game_id,${cutoff},
        computed_at,recorded_at,code_version,status,reasons,input_digest,execution_digest,bundle_blob_sha256 FROM predictive_feature_runs WHERE id=$1`, [second.featureRunId]);
      await client.query(`INSERT INTO predictive_feature_run_dependencies (feature_run_id,observation_id,decision_id,rights_decision_id,policy_id,feature_definition_id)
        SELECT 'probe',observation_id,decision_id,rights_decision_id,policy_id,feature_definition_id FROM predictive_feature_run_dependencies
        WHERE feature_run_id=$1 AND ${filter}`, [second.featureRunId]);
      if (extra) await client.query(`INSERT INTO predictive_feature_run_dependencies (feature_run_id,${extra[0]}) VALUES ('probe',$1)`, [extra[1]]);
    };
    await sqlProbe(client, async () => { await copy("true"); await client.query("SET CONSTRAINTS ALL IMMEDIATE"); });
    const refusals: [string, () => Promise<void>, string][] = [
      ["a dependency usable only after the cutoff", () => copy("true", "", ["observation_id", "player-correction-B"]), "predictive-feature-run-dependency-after-cutoff"],
      ["a decision made stale before the cutoff", () => copy("true", "", null, `'${CUTOFF_B}'::timestamptz`), "predictive-feature-run-decision-stale"],
      ["a decision whose inputs are not listed", () => copy("(observation_id IS NULL OR observation_id NOT LIKE 'terminal-%')"), "predictive-feature-run-inputs-incomplete"],
      ["a ready run without model-input rights", () => copy("rights_decision_id IS NULL"), "predictive-feature-run-rights-not-in-force"],
      ["no feature definition", () => copy("feature_definition_id IS NULL"), "predictive-feature-run-definition-missing"],
      ["synthetic evidence under production mode", () => copy("true", "'production-research'"), "predictive-feature-run-mode-invalid"],
    ];
    for (const [label, run, message] of refusals) await sqlProbe(client, async () => {
      await run();
      await expect(client.query("SET CONSTRAINTS ALL IMMEDIATE"), label).rejects.toMatchObject({ code: "23514", message });
    });
    // A recorded run is sealed: its manifest cannot be extended later.
    await sqlProbe(client, async () => {
      await expect(client.query("INSERT INTO predictive_feature_run_dependencies (feature_run_id,policy_id) VALUES ($1,'extra-v1')", [first.featureRunId]))
        .rejects.toMatchObject({ code: "23514", message: "predictive-feature-run-sealed" });
    });
    for (const [role, sql] of [["predictive_recorder", "INSERT INTO predictive_games (id) VALUES ('00000000-0000-4000-8000-000000000098')"],
      ["predictive_replay", "INSERT INTO predictive_feature_run_pins (id,feature_run_id,reason,pinned_at) VALUES ('x','y','owner',now())"]]) {
      await sqlProbe(client, async () => { await client.query(`SET LOCAL ROLE ${role}`); await expect(client.query(sql)).rejects.toMatchObject({ code: "42501" }); });
    }
    // Retention: unpinned runs expire after 90 days; a pin holds a run until unpinned.
    const expired = async (id: string, at: string) => (await client.query("SELECT predictive_feature_run_expired($1,$2) AS expired", [id, at])).rows[0].expired;
    const recordedAt = new Date(run.recorded_at).getTime();
    const day = (days: number) => new Date(recordedAt + days * 86_400_000).toISOString();
    expect(await expired(first.featureRunId, day(89))).toBe(false);
    expect(await expired(first.featureRunId, day(91))).toBe(true);
    await client.query("INSERT INTO predictive_feature_run_pins (id,feature_run_id,reason,pinned_at) VALUES ('pin-1',$1,'training',$2)", [first.featureRunId, day(1)]);
    expect(await expired(first.featureRunId, day(91))).toBe(false);
    await sqlProbe(client, async () => {
      await expect(client.query("INSERT INTO predictive_feature_run_unpins (pin_id,unpinned_at) VALUES ('pin-1',$1)", [day(0)]))
        .rejects.toMatchObject({ code: "23514", message: "predictive-unpin-before-pin" });
    });
    await client.query("INSERT INTO predictive_feature_run_unpins (pin_id,unpinned_at) VALUES ('pin-1',$1)", [day(95)]);
    expect(await expired(first.featureRunId, day(94))).toBe(false);
    expect(await expired(first.featureRunId, day(96))).toBe(true);
    await sqlProbe(client, async () => {
      await expect(client.query("INSERT INTO predictive_feature_run_unpins (pin_id,unpinned_at) VALUES ('pin-1',$1)", [day(97)])).rejects.toMatchObject({ code: "23505" });
    });
    // The recorder function refuses snapshot isolation: an older snapshot could
    // miss a revocation committed after the transaction began.
    const pending = featureRunRequest(await store.replay(request()), true);
    const recordCall = (target: Client) => target.query("SELECT predictive_record_feature_run($1,$2) AS result", [JSON.stringify(pending.run), JSON.stringify(pending.dependencies)]);
    await client.query("INSERT INTO predictive_blobs (sha256,byte_size,media_type,storage_ref) VALUES ($1,$2,'application/json',$3) ON CONFLICT DO NOTHING",
      [pending.bundleSha256, Buffer.byteLength(pending.bundleBytes), pending.bundleSha256 + ".json"]);
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    try {
      await client.query("SET LOCAL ROLE predictive_recorder");
      await expect(recordCall(client)).rejects.toMatchObject({ code: "25001", message: "predictive-recorder-isolation-refused" });
    } finally { await client.query("ROLLBACK"); }
    // A delayed recording cannot outrun a revocation: it waits on the profile lock
    // held by the uncommitted revocation, then stamps its own time, sees the
    // revocation and is refused at commit.
    const recorder = new Client(target.expected); const monitor = new Client(target.expected);
    try {
      await recorder.connect(); await monitor.connect();
      const recorderPid = await backendPid(recorder); const holderPid = await backendPid(client);
      await recorder.query("BEGIN"); await recorder.query("SET LOCAL ROLE predictive_recorder");
      await client.query("BEGIN");
      const now = (await client.query(`SELECT to_char(date_trunc('milliseconds', now()) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now`)).rows[0].now;
      await client.query(`INSERT INTO predictive_rights_decisions (id,profile_id,predecessor_id,allowed_uses,effective_from,effective_to,decided_at,evidence_kind,evidence_reference)
        VALUES ('rights-revoked',$1,'rights-renewed','{internal-research}',$2,NULL,$2,'synthetic','synthetic revocation')`, [PROFILE, now]);
      const call = recordCall(recorder).then((value) => ({ value }), (error) => ({ error }));
      await Promise.race([waitForBlocked(monitor, [recorderPid], holderPid),
        call.then((settled) => { throw new Error("recording did not wait: " + JSON.stringify(settled)); })]);
      await client.query("COMMIT");
      expect(await call).toMatchObject({ value: { rows: [{ result: { rightsDecisions: ["rights-revoked"] } }] } });
      await expect(recorder.query("COMMIT")).rejects.toMatchObject({ code: "23514", message: "predictive-feature-run-rights-not-in-force" });
    } finally {
      await Promise.allSettled([recorder.end(), monitor.end()]);
    }
  });
});
it("predictive identity bridges refuse same-source ambiguity at write and keep corrections in their chain", async () => {
  await withProof(async ({ client, store }) => {
    const bridges = emptyDataset();
    const playerBridge = (id: string, raw: string, playerId: string, from = "2026-01-01T00:00:00.000Z", to = "2027-01-01T00:00:00.000Z", predecessor: string | null = null) =>
      revision(id, "player-bridge", { provider: "provider-x", rawPlayerId: raw, playerId, effectiveFrom: from, effectiveTo: to }, predecessor);
    addCapture(bridges, "bridges", [playerBridge("bridge-a", "p123", PLAYER, "2026-01-01T00:00:00.000Z", "2026-05-01T00:00:00.000Z"),
      playerBridge("bridge-b", "p456", PLAYER, "2026-05-01T00:00:00.000Z"),
      revision("alias-lar", "team-alias", { provider: "provider-x", rawAlias: "LAR", teamId: "nfl:team:LA", effectiveFromSeason: 2016, effectiveToSeason: 2026 }),
      revision("alias-la", "team-alias", { provider: "provider-x", rawAlias: "LA", teamId: "nfl:team:LA", effectiveFromSeason: 2016, effectiveToSeason: 2026 }),
      revision("game-bridge", "game-bridge", { provider: "provider-x", rawGameId: "evt-9", gameId: TARGET }),
      revision("relation", "game-relation", { gameId: TARGET, predecessorGameId: gameId(99), relation: "replacement" })]);
    addCapture(bridges, "later-bridges", [revision("later-alias", "team-alias", { provider: "provider-x", rawAlias: "NE", teamId: "nfl:team:NE",
      effectiveFromSeason: 2026, effectiveToSeason: 2026 })], CAPTURE_B);
    await store.publish("bridges", bridges, NOW);
    expect((await client.query("SELECT entity_key, player_id, team_id FROM predictive_observations WHERE id IN ('bridge-a','alias-lar') ORDER BY id")).rows).toEqual([
      { entity_key: "team-alias:provider-x:LAR", player_id: null, team_id: "nfl:team:LA" },
      { entity_key: "player-bridge:provider-x:p123", player_id: PLAYER, team_id: null }]);
    expect((await client.query("SELECT count(*)::integer AS count FROM predictive_games WHERE id=$1", [gameId(99)])).rows[0].count).toBe(1);
    const probe = (row: Revision) => sqlProbe(client, async () => {
      await insertObservation(client, row.id, row.kind, row.data, row.predecessorId ? { predecessor: row.predecessorId } : {});
      await client.query("INSERT INTO predictive_artifact_observations (artifact_id,observation_id) VALUES ('bridges',$1)", [row.id]);
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    });
    // A third raw ID for the same player overlapping an existing mapping is refused,
    // as is a second raw game ID for one game. A further team alias is fine.
    await expect(probe(playerBridge("bridge-c", "p789", PLAYER, "2026-06-01T00:00:00.000Z"))).rejects.toMatchObject({ code: "23514", message: "predictive-bridge-ambiguous" });
    // The other direction: one raw ID cannot currently name two players.
    await expect(probe(playerBridge("same-raw", "p456", "00-0000002", "2026-06-01T00:00:00.000Z")))
      .rejects.toMatchObject({ code: "23514", message: "predictive-bridge-ambiguous" });
    // Adjacent effective windows are legitimate, even with the same raw ID.
    await probe(playerBridge("same-raw-old", "p456", "00-0000002", "2025-01-01T00:00:00.000Z", "2026-05-01T00:00:00.000Z"));
    await expect(probe(revision("game-bridge-2", "game-bridge", { provider: "provider-x", rawGameId: "evt-10", gameId: TARGET })))
      .rejects.toMatchObject({ code: "23514", message: "predictive-bridge-ambiguous" });
    await expect(probe(revision("same-raw-game", "game-bridge", { provider: "provider-x", rawGameId: "evt-9", gameId: gameId(99) })))
      .rejects.toMatchObject({ code: "23514", message: "predictive-bridge-ambiguous" });
    // A conflicting mapping and its later correction inserted together still
    // conflict at the earlier knowledge time. Do not merely compare final heads.
    await expect(sqlProbe(client, async () => {
      const bad = playerBridge("historical-bad", "p456", "00-0000002", "2026-05-01T00:00:00.000Z");
      const fix = playerBridge("historical-fix", "p456", PLAYER, "2026-05-01T00:00:00.000Z", "2027-01-01T00:00:00.000Z", bad.id);
      await insertObservation(client, bad.id, bad.kind, bad.data);
      await insertObservation(client, fix.id, fix.kind, fix.data, { predecessor: bad.id });
      await client.query("INSERT INTO predictive_artifact_observations (artifact_id,observation_id) VALUES ('bridges',$1),('later-bridges',$2)", [bad.id, fix.id]);
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    })).rejects.toMatchObject({ code: "23514", message: "predictive-bridge-ambiguous" });
    await probe(revision("alias-stl", "team-alias", { provider: "provider-x", rawAlias: "STL", teamId: "nfl:team:LA", effectiveFromSeason: 2016, effectiveToSeason: 2016 }));
    // Correcting a mapping stays inside its own chain and is accepted.
    await probe(playerBridge("bridge-b-fix", "p456", PLAYER, "2026-05-01T00:00:00.000Z", "2026-12-01T00:00:00.000Z", "bridge-b"));
    for (const bad of [{ rawPlayerId: "p:1" }, { effectiveTo: "2025-01-01T00:00:00.000Z" }]) {
      await sqlProbe(client, async () => {
        await expect(insertObservation(client, "bad", "player-bridge", { provider: "provider-x", rawPlayerId: "p1", playerId: PLAYER,
          effectiveFrom: "2026-01-01T00:00:00.000Z", effectiveTo: "2027-01-01T00:00:00.000Z", ...bad }, { sourceRecordId: "x" })).rejects.toMatchObject({ code: "23514" });
      });
    }
  });
});
const executeSql = "SELECT predictive_retention_execute($1,$2,$3,$4,$5,$6) AS result";
const executeParams = (event: RetentionEvent) => [event.id, event.reason, event.authority, event.decidedAt, JSON.stringify(event.scope), event.auditLevel];
it("predictive retention removes a source scope with chain descendants and derived rows, audits it and re-applies it to a restored backup", async () => {
  await withProof(async ({ client, store, artifacts }) => {
    const a = passingYardsFixture(false); await store.publish("A", a, NOW);
    const observations = validateDataset(a).observations; const t = instant(CAPTURE_A); const game = gameId(5);
    const registrations = { profiles: a.profiles, rightsDecisions: a.rightsDecisions };
    const statsKey = "player-game-stats:" + game + ":" + PLAYER;
    await store.publish("decisions", { ...emptyDataset(), ...registrations, decisions: [
      recordCompletion("completion-5", game, markerHeadsAt(observations.values(), game, t), CAPTURE_A, "synthetic-proof"),
      recordParticipation("participation-5", game, PLAYER, participationHeadsAt(observations.values(), game, PLAYER, t), CAPTURE_A, "synthetic-proof"),
      reconcileFact("reconciliation-5", statsKey, [...observations.values()].filter((value) => value.entityKey === statsKey), CAPTURE_A, "synthetic-proof")] }, NOW);
    const label: Label = { id: "label-5-v1", playerId: PLAYER, gameId: game, seasonType: "REG", stat: "passing_yards", value: 300,
      state: "provisional", mode: "synthetic-proof", policyId: "canonical-label-finalization-v1", labelVersion: 1, predecessorId: null,
      completionDecisionId: "completion-5", participationDecisionId: "participation-5", reconciliationDecisionId: "reconciliation-5",
      selectedObservationId: "player-synthetic-game-5", eligibleFinalAt: null, postWindowCaptureId: null, finalizedAt: null, createdAt: "2026-10-07T13:00:00.000Z",
      playerBridgeObservationId: null };
    await store.publish("labels", { ...emptyDataset(), ...registrations, labels: [label] }, NOW);
    const run = await store.replayAndRecord(request());
    if (run.status !== "recorded") throw new Error("expected a recorded run");
    const correction = passingYardsFixture();
    await store.publish("B", { ...emptyDataset(), ...registrations, artifacts: correction.artifacts.filter((value) => value.id.startsWith("B-")),
      captures: correction.captures.filter((value) => value.artifactId.startsWith("B-")) }, NOW);
    // Another profile's evidence is outside the scope and must survive.
    const OTHER = "synthetic-other-v1";
    const other = { ...emptyDataset(), profiles: [profile(OTHER)], rightsDecisions: [rights(OTHER)] };
    addCapture(other, "other", [revision("other-schedule", "schedule", schedule(81, "2026-09-14T00:15:00.000Z", "nfl:team:SEA", "nfl:team:ARI"))], CAPTURE_A, OTHER);
    await store.publish("other", other, NOW);
    const blobFor = async (artifact: string) => (await client.query("SELECT b.* FROM predictive_blobs b JOIN predictive_artifacts a ON a.blob_sha256=b.sha256 WHERE a.id=$1", [artifact])).rows[0];
    const aBlob = await blobFor("A-player-game-stats"); const bBlob = await blobFor("B-player");
    const event: RetentionEvent = { id: "retention-A", reason: "provider-request", authority: "synthetic provider removal notice", decidedAt: NOW,
      scope: { kind: "source", profileIds: [PROFILE], capturedFrom: null, capturedBefore: CAPTURE_B }, auditLevel: "full" };
    // The live removal, recorded and then rolled back: what remains is a backup
    // taken before the event, to which the recorded event is re-applied.
    let live: RecordedRetentionEvent | undefined;
    await sqlProbe(client, async () => {
      await client.query("SET LOCAL ROLE predictive_retention_owner");
      await client.query(executeSql, executeParams(event));
      await client.query("RESET ROLE");
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");
      [live] = await store.retentionEvents();
    });
    expect(live).toMatchObject({ id: "retention-A", scope: event.scope, auditLevel: "full" });
    expect(await store.retentionEvents()).toEqual([]);
    expect(await store.reapply([live!])).toEqual([{ eventId: "retention-A", status: "reapplied", matched: true }]);
    expect(await store.reapply([live!])).toEqual([{ eventId: "retention-A", status: "present", matched: true }]);
    // Every A row and every descendant in its source chains is gone, with the
    // decisions, label and feature run derived from them. B's artifacts and the
    // other profile's evidence remain.
    const ids = async (table: string) => (await client.query(`SELECT id FROM ${table} ORDER BY id COLLATE "C"`)).rows.map((row) => row.id);
    expect(await ids("predictive_observations")).toEqual(["other-schedule"]);
    expect(await ids("predictive_artifacts")).toEqual(["B-player", "B-team", "other"]);
    for (const table of ["predictive_decisions", "predictive_outcome_labels", "predictive_feature_runs"]) expect(await ids(table)).toEqual([]);
    expect((await client.query("SELECT count(*)::integer AS count FROM predictive_decision_inputs")).rows[0].count).toBe(0);
    const recorded = (await store.retentionEvents())[0];
    expect(recorded.removedCounts).toMatchObject({ observations: rowsOf(a).length + 2, artifacts: a.artifacts.length, captures: a.captures.length,
      decisions: 3, labels: 1, featureRuns: 1 });
    const tombstones = (await client.query("SELECT target_kind || ':' || target_id AS id FROM predictive_retention_tombstones ORDER BY target_kind || ':' || target_id COLLATE \"C\"")).rows.map((row) => row.id);
    expect(tombstones).toEqual(expect.arrayContaining(["observation:player-correction-B", "decision:completion-5", "label:label-5-v1", "feature-run:" + run.featureRunId]));
    const removed = (await client.query("SELECT target_kind AS kind, target_id AS id FROM predictive_retention_tombstones")).rows;
    expect(recorded.removedIdsDigest).toBe(retentionIdsDigest(removed));
    // Blob files go after commit; a blob still referenced elsewhere stays.
    await expect(artifacts.database.read(aBlob.storage_ref, aBlob.sha256, aBlob.byte_size)).rejects.toThrow();
    expect(await artifacts.database.read(bBlob.storage_ref, bBlob.sha256, bBlob.byte_size)).toContain("player-correction-B");
    // Replay never silently substitutes what was removed.
    const after = await store.replay(request());
    expect(after.status).toBe("unavailable-inputs"); expect(after.reasons).toContain("retained-evidence-removed");
  });
});
it("predictive retention expires unpinned feature runs with digest-only audit and admits deletion only through the owner function", async () => {
  await withProof(async ({ client, store, artifacts }) => {
    const a = passingYardsFixture(); await store.publish("A", a, NOW);
    const bundle = async (bytes: string) => {
      const sha256 = digest(bytes); await artifacts.database.write(bytes, sha256);
      await client.query("INSERT INTO predictive_blobs (sha256,byte_size,media_type,storage_ref) VALUES ($1,$2,'application/json',$3)", [sha256, Buffer.byteLength(bytes), sha256 + ".json"]);
      return sha256;
    };
    const shared = await bundle('{"bundle":"shared"}'); const own = await bundle('{"bundle":"own"}');
    const insertRun = async (id: string, blob: string, recordedAt: string) => {
      await client.query("BEGIN");
      await client.query(`INSERT INTO predictive_feature_runs (id,mode,feature_version,candidate,player_id,game_id,cutoff,computed_at,recorded_at,code_version,
        status,reasons,input_digest,execution_digest,bundle_blob_sha256) VALUES ($1,'production-research','passing-yards-replay-v3',$2,$3,$4,$5,$5,$5,'probe',
        'unavailable-inputs','{probe}',$6,$6,$7)`, [id, request().candidate, PLAYER, TARGET, recordedAt, "0".repeat(64), blob]);
      await client.query("INSERT INTO predictive_feature_run_dependencies (feature_run_id,feature_definition_id) VALUES ($1,'passing-yards-replay-v3')", [id]);
      await client.query("COMMIT");
    };
    await insertRun("old-unpinned", shared, "2026-01-02T00:00:00.000Z");
    await insertRun("old-pinned", shared, "2026-01-02T00:00:00.000Z");
    await insertRun("old-released", own, "2026-01-02T00:00:00.000Z");
    await insertRun("recent", own, "2026-10-01T00:00:00.000Z");
    await client.query("INSERT INTO predictive_feature_run_pins (id,feature_run_id,reason,pinned_at) VALUES ('pin-held','old-pinned','training','2026-01-03T00:00:00.000Z'),('pin-released','old-released','evaluation','2026-01-03T00:00:00.000Z')");
    await client.query("INSERT INTO predictive_feature_run_unpins (pin_id,unpinned_at) VALUES ('pin-released','2026-02-01T00:00:00.000Z')");
    const decidedAt = new Date(Date.now() - 60_000).toISOString();
    const expiry: RetentionEvent = { id: "expiry-1", reason: "expiry", authority: "feature-run-retention-v1", decidedAt,
      scope: { kind: "feature-run-expiry", asOf: decidedAt }, auditLevel: "digest-only" };
    const result = await store.retain(expiry);
    expect((await client.query("SELECT id FROM predictive_feature_runs ORDER BY id")).rows.map((row) => row.id)).toEqual(["old-pinned", "recent"]);
    expect(result.removedCounts).toMatchObject({ featureRuns: 2, pins: 1, unpins: 1, featureRunDependencies: 2, blobs: 0, observations: 0 });
    // The own blob is still used by the recent run and the shared one by the pinned run.
    expect(result.removedBlobRefs).toEqual([]);
    expect(result.removedIdsDigest).toBe(retentionIdsDigest([{ kind: "pin", id: "pin-released" }, { kind: "feature-run", id: "old-unpinned" },
      { kind: "feature-run", id: "old-released" }]));
    expect(retentionIdsDigest([])).toBe(digest("[]"));
    // Identifiers can't carry control characters, so no ID can imitate a separator.
    for (const id of ["a\nb", "a\u007fb"]) await sqlProbe(client, async () => {
      await expect(client.query("INSERT INTO predictive_feature_run_pins (id,feature_run_id,reason,pinned_at) VALUES ($1,'old-pinned','owner',now())", [id]))
        .rejects.toMatchObject({ code: "23514" });
    });
    // digest-only keeps counts, the digest and the descriptor, but no identifiers.
    expect((await client.query("SELECT count(*)::integer AS count FROM predictive_retention_tombstones")).rows[0].count).toBe(0);
    expect((await store.retentionEvents())[0]).toMatchObject({ id: "expiry-1", scope: expiry.scope, removedIdsDigest: result.removedIdsDigest });
    await expect(store.retain(expiry)).rejects.toMatchObject({ code: "23505" });
    // Once the last referencing run expires, the blob row and file go too.
    await client.query("INSERT INTO predictive_feature_run_unpins (pin_id,unpinned_at) VALUES ('pin-held','2026-02-01T00:00:00.000Z')");
    const second = await store.retain({ ...expiry, id: "expiry-2" });
    expect(second.removedBlobRefs).toEqual([shared + ".json"]);
    await expect(artifacts.database.read(shared + ".json", shared, 19)).rejects.toThrow();
    expect(await artifacts.database.read(own + ".json", own, Buffer.byteLength('{"bundle":"own"}'))).toBe('{"bundle":"own"}');
    // Malformed or premature events are refused before anything is removed.
    const invalid: RetentionEvent[] = [
      { ...expiry, id: "bad-reason", reason: "owner-request" },
      { ...expiry, id: "bad-time", decidedAt: "2999-01-01T00:00:00.000Z", scope: { kind: "feature-run-expiry", asOf: "2999-01-01T00:00:00.000Z" } },
      { ...expiry, id: "bad-profile", reason: "owner-request", scope: { kind: "source", profileIds: ["unknown-profile"], capturedFrom: null, capturedBefore: null } },
      { ...expiry, id: "bad-order", reason: "owner-request", scope: { kind: "source", profileIds: [PROFILE, "a-profile"], capturedFrom: null, capturedBefore: null } },
      { ...expiry, id: "bad-range", reason: "owner-request", scope: { kind: "source", profileIds: [PROFILE], capturedFrom: CAPTURE_B, capturedBefore: CAPTURE_A } },
    ];
    for (const event of invalid) await expect(store.retain(event), event.id).rejects.toMatchObject({ code: "23514", message: "predictive-retention-invalid" });
    // Only the retention owner may execute; it holds no table privilege itself.
    const denied = { code: "42501" };
    for (const role of ["predictive_ingest", "predictive_replay", "predictive_recorder"]) {
      await sqlProbe(client, async () => {
        await client.query(`SET LOCAL ROLE ${role}`);
        await expect(client.query(executeSql, executeParams({ ...expiry, id: "probe" })), role).rejects.toMatchObject(denied);
      });
      await sqlProbe(client, async () => {
        await client.query(`SET LOCAL ROLE ${role}`);
        await expect(client.query("INSERT INTO predictive_retention_authorizations (txid,retention_event_id) VALUES (pg_current_xact_id(),'probe')"), role).rejects.toMatchObject(denied);
      });
    }
    for (const sql of ["DELETE FROM predictive_observations", "SELECT * FROM predictive_retention_events", "UPDATE predictive_retention_events SET authority='x'"]) {
      await sqlProbe(client, async () => { await client.query("SET LOCAL ROLE predictive_retention_owner"); await expect(client.query(sql)).rejects.toMatchObject(denied); });
    }
    // No settable flag exists: a custom setting authorizes nothing, even for the owner.
    const appendOnly = { code: "23514", message: "predictive-append-only" };
    await sqlProbe(client, async () => {
      await client.query("SET LOCAL predictive.retention = 'authorized'");
      await expect(client.query("DELETE FROM predictive_observations WHERE id='player-correction-B'")).rejects.toMatchObject(appendOnly);
    });
    // Audit rows stay immutable even inside an authorized transaction.
    // Use a real event: the training hook validates the authorization's event
    // before the append-only/FK probes run. A nonexistent event is not a valid
    // authorization, even when the disposable harness is superuser.
    for (const sql of ["DELETE FROM predictive_retention_events", "UPDATE predictive_retention_events SET authority='x'"]) {
      await sqlProbe(client, async () => {
        await client.query("INSERT INTO predictive_retention_authorizations (txid,retention_event_id) VALUES (pg_current_xact_id(),'expiry-1')");
        await expect(client.query(sql)).rejects.toMatchObject(appendOnly);
      });
    }
    // The foreign keys are the backstop: an authorized deletion that omits a
    // chain descendant or a link fails.
    const predecessor = (await client.query("SELECT predecessor_id FROM predictive_observations WHERE id='team-correction-B'")).rows[0].predecessor_id;
    await sqlProbe(client, async () => {
      await client.query("INSERT INTO predictive_retention_authorizations (txid,retention_event_id) VALUES (pg_current_xact_id(),'expiry-1')");
      await expect(client.query("DELETE FROM predictive_observations WHERE id=$1", [predecessor])).rejects.toMatchObject({ code: "23503" });
    });
    await sqlProbe(client, async () => {
      await client.query("INSERT INTO predictive_retention_authorizations (txid,retention_event_id) VALUES (pg_current_xact_id(),'expiry-1')");
      await client.query("DELETE FROM predictive_artifact_observations WHERE observation_id=$1", [predecessor]);
      await client.query("DELETE FROM predictive_observations WHERE id=$1", [predecessor]);
      await expect(client.query("SET CONSTRAINTS ALL IMMEDIATE")).rejects.toMatchObject({ code: "23503" });
    });
  });
});
it("predictive snap evidence enforces counts and missingness and snap compatibility decisions cite the complete provider overlap", async () => {
  await withProof(async ({ client, store }) => {
    const OTHER = "synthetic-other-v1"; const a = passingYardsFixture(false);
    const game = (number: number) => findRow(a, "schedule-synthetic-game-" + number).data as Parameters<typeof teamSnaps>[0];
    const snaps = { ...emptyDataset(), profiles: [profile(), profile(OTHER)], rightsDecisions: [rights(), rights(OTHER)] };
    addCapture(snaps, "snaps-a", [revision("a-team-5", "team-game-snaps", teamSnaps(game(5), 60)), revision("a-player-5", "player-game-snaps", playerSnaps(game(5), 30)),
      revision("a-team-4", "team-game-snaps", teamSnaps(game(4), 50))]);
    addCapture(snaps, "snaps-b", [revision("b-team-5", "team-game-snaps", teamSnaps(game(5), 60)), revision("b-player-5", "player-game-snaps", playerSnaps(game(5), 30))], CAPTURE_A, OTHER);
    await store.publish("A", a, NOW); await store.publish("snaps", snaps, NOW);
    expect((await client.query("SELECT entity_key, team_id, game_id::text FROM predictive_observations WHERE id='a-team-5'")).rows[0])
      .toEqual({ entity_key: "team-game-snaps:" + PRIOR[4] + ":" + TEAM, team_id: TEAM, game_id: PRIOR[4] });
    const observations = validateDataset({ ...snaps }).observations;
    const decision = recordSnapCompatibility("compat-1", PROFILE, OTHER, observations.values(), CAPTURE_B, "synthetic-proof");
    expect(decision.outcome).toEqual({ result: "compatible", overlapGames: 1 });
    await store.publish("compat", { ...emptyDataset(), profiles: snaps.profiles, rightsDecisions: snaps.rightsDecisions, decisions: [decision] }, NOW);
    expect((await client.query("SELECT outcome FROM predictive_decisions WHERE id='compat-1'")).rows[0].outcome).toEqual({ result: "compatible", overlapGames: 1 });
    // Payloads: blanks need reasons, counts are bounded, flags are booleans.
    const base = playerSnaps(game(3), 20);
    for (const bad of [{ ...base, missing: {} }, { ...base, offenseSnaps: 301 }, { ...base, played: "yes" }, { ...base, offenseSnaps: null }]) {
      await sqlProbe(client, async () => {
        await expect(insertObservation(client, "bad-snap", "player-game-snaps", bad)).rejects.toMatchObject({ code: "23514" });
      });
    }
    const insertDecision = async (id: string, outcome: object, inputs: string[]) => {
      await client.query(`INSERT INTO predictive_decisions (id,kind,entity_key,policy_id,mode,outcome,run_id,decided_at,predecessor_id)
        VALUES ($1,'snap-source-compatibility',$2,'snap-compatibility-v1','synthetic-proof',$3,'compat',$4,NULL)`, [id, decision.entityKey, outcome, CAPTURE_B]);
      for (const observation of inputs) await client.query("INSERT INTO predictive_decision_inputs VALUES ($1,$2,'evidence')", [id, observation]);
    };
    const all = decision.inputs.map((input) => input.observationId);
    await sqlProbe(client, async () => { await insertDecision("probe-ok", decision.outcome, all); await client.query("SET CONSTRAINTS ALL IMMEDIATE"); });
    const refusals: [string, () => Promise<void>, string][] = [
      ["an overlap that omits a provider head", () => insertDecision("probe", decision.outcome, all.filter((id) => id !== "b-player-5")), "predictive-snap-compatibility-inputs-invalid"],
      ["a head outside the overlap", () => insertDecision("probe", decision.outcome, [...all, "a-team-4"]), "predictive-snap-compatibility-inputs-invalid"],
      ["a misstated result", () => insertDecision("probe", { result: "incompatible", overlapGames: 1 }, all), "predictive-decision-rule-invalid"],
      ["a misstated overlap count", () => insertDecision("probe", { result: "compatible", overlapGames: 2 }, all), "predictive-decision-rule-invalid"],
    ];
    for (const [label, insert, message] of refusals) await sqlProbe(client, async () => {
      await insert();
      await expect(client.query("SET CONSTRAINTS ALL IMMEDIATE"), label).rejects.toMatchObject({ code: "23514", message });
    });
    await sqlProbe(client, async () => {
      await expect(client.query(`INSERT INTO predictive_decisions (id,kind,entity_key,policy_id,mode,outcome,run_id,decided_at)
        VALUES ('unsorted','snap-source-compatibility',$1,'snap-compatibility-v1','synthetic-proof',$2,'compat',$3)`,
      ["snap-source-compatibility:" + PROFILE + ":" + OTHER, decision.outcome, CAPTURE_B])).rejects.toMatchObject({ code: "23514" });
    });
    // A provider disagreeing on a shared game makes a later decision incompatible.
    const disagree = { ...emptyDataset(), profiles: snaps.profiles, rightsDecisions: snaps.rightsDecisions };
    addCapture(disagree, "b-fix", [revision("b-player-5-fix", "player-game-snaps", playerSnaps(game(5), 31), "b-player-5")], "2026-10-08T15:00:00.000Z", OTHER);
    await store.publish("disagree", disagree, NOW);
    const later = recordSnapCompatibility("compat-2", PROFILE, OTHER, validateDataset({ ...snaps, artifacts: [...snaps.artifacts, ...disagree.artifacts],
      captures: [...snaps.captures, ...disagree.captures] }).observations.values(), "2026-10-08T16:00:00.000Z", "synthetic-proof", "compat-1");
    expect(later.outcome).toEqual({ result: "incompatible", overlapGames: 1 });
    await store.publish("compat-2", { ...emptyDataset(), profiles: snaps.profiles, rightsDecisions: snaps.rightsDecisions, decisions: [later] }, NOW);
    expect((await client.query("SELECT predictive_decision_current('compat-1', '2026-10-08T16:00:00Z') AS stale, predictive_decision_current('compat-2', '2026-10-08T16:00:00Z') AS current")).rows[0])
      .toEqual({ stale: false, current: true });
  });
});
it("predictive blob cleanup and publication serialize on the blob digest in both orders and cleanup resumes after a failed removal", async () => {
  await withProof(async ({ client, store, target, artifacts }) => {
    const OTHER = "synthetic-other-v1";
    const solo = (id: string) => {
      const dataset = { ...emptyDataset(), profiles: [profile(OTHER)], rightsDecisions: [rights(OTHER)] };
      addCapture(dataset, id, [revision("other-schedule", "schedule", schedule(81, "2026-09-14T00:15:00.000Z", "nfl:team:SEA", "nfl:team:ARI"))], CAPTURE_A, OTHER);
      return dataset;
    };
    const first = solo("solo"); const sha = first.artifacts[0].sha256; const reference = sha + ".json"; const size = Buffer.byteLength(first.artifacts[0].bytes);
    await store.publish("solo", first, NOW);
    const event = (id: string): RetentionEvent => ({ id, reason: "owner-request", authority: "synthetic cleanup proof", decidedAt: NOW,
      scope: { kind: "source", profileIds: [OTHER], capturedFrom: null, capturedBefore: null }, auditLevel: "full" });
    const publisherClient = new Client(target.expected); const monitor = new Client(target.expected);
    // Reads go through the monitor: a query on a blocked connection would queue
    // behind its lock wait.
    const queued = async () => (await monitor.query("SELECT storage_ref FROM predictive_blob_removals")).rows.map((row) => row.storage_ref);
    const blobRow = async () => (await monitor.query("SELECT count(*)::integer AS count FROM predictive_blobs WHERE sha256=$1", [sha])).rows[0].count;
    try {
      await publisherClient.connect(); await monitor.connect();
      const publisher = await createLocalPredictiveStore(publisherClient, target, artifacts);
      const cleanerPid = await backendPid(client); const publisherPid = await backendPid(publisherClient);
      const key = Number.parseInt(sha.slice(0, 8), 16) | 0;
      // Order 1: a publisher holding the digest lock (about to write the same bytes)
      // makes cleanup wait; it commits a new reference, so cleanup keeps the file.
      await publisherClient.query("SELECT pg_advisory_lock(520054,$1)", [key]);
      const retained = store.retain(event("cleanup-1")).then((value) => ({ value }), (error) => ({ error }));
      await Promise.race([waitForBlocked(monitor, [cleanerPid], publisherPid), retained.then((settled) => { throw new Error("cleanup did not wait: " + JSON.stringify(settled)); })]);
      expect(await queued()).toEqual([reference]);
      expect(await publisher.publish("again", solo("solo-again"), NOW)).toMatchObject({ status: "published" });
      await publisherClient.query("SELECT pg_advisory_unlock(520054,$1)", [key]);
      expect(await retained).toMatchObject({ value: { removedBlobRefs: [reference] } });
      expect(await blobRow()).toBe(1); expect(await artifacts.database.read(reference, sha, size)).toBe(first.artifacts[0].bytes); expect(await queued()).toEqual([]);
      // Order 2: cleanup holding the lock mid-unlink makes the publisher wait; the
      // publisher then rewrites the file, so its committed row has its bytes.
      const removing = Promise.withResolvers<void>(); const gate = Promise.withResolvers<void>();
      const gated = { ...artifacts, database: { ...artifacts.database, remove: async (ref: string, digest: string) => { removing.resolve(); await gate.promise; await artifacts.database.remove(ref, digest); } } };
      const cleaner = await createLocalPredictiveStore(client, target, gated);
      const removal = cleaner.retain(event("cleanup-2")).then((value) => ({ value }), (error) => ({ error }));
      await removing.promise;
      const republished = publisher.publish("third", solo("solo-third"), NOW).then((value) => ({ value }), (error) => ({ error }));
      await Promise.race([waitForBlocked(monitor, [publisherPid], cleanerPid), republished.then((settled) => { throw new Error("publisher did not wait: " + JSON.stringify(settled)); })]);
      gate.resolve();
      expect(await removal).toMatchObject({ value: { removedBlobRefs: [reference] } });
      expect(await republished).toMatchObject({ value: { status: "published" } });
      expect(await blobRow()).toBe(1); expect(await artifacts.database.read(reference, sha, size)).toBe(first.artifacts[0].bytes); expect(await queued()).toEqual([]);
      // Recovery: a failed unlink leaves the committed event and the queue row;
      // resuming removes the file once no row references it.
      const failing = await createLocalPredictiveStore(client, target, { ...artifacts, database: { ...artifacts.database, remove: async () => { throw new Error("simulated unlink failure"); } } });
      await expect(failing.retain(event("cleanup-3"))).rejects.toThrow("simulated unlink failure");
      expect((await store.retentionEvents()).map((row) => row.id)).toContain("cleanup-3");
      expect(await queued()).toEqual([reference]); expect(await blobRow()).toBe(0);
      expect(await artifacts.database.read(reference, sha, size)).toBe(first.artifacts[0].bytes);
      expect(await store.resumeBlobRemovals()).toEqual([reference]);
      expect(await queued()).toEqual([]);
      await expect(artifacts.database.read(reference, sha, size)).rejects.toThrow();
    } finally {
      await Promise.allSettled([publisherClient.end(), monitor.end()]);
    }
  });
});

// This login has the exact production retention membership, never superuser or
// table privileges. Synthetic publication is performed separately by the harness.
it("predictive retention drains and resumes blob removals through an execute-only non-superuser login", async () => {
  await withProof(async ({ client, store, artifacts, target }) => {
    const a = passingYardsFixture(false); await store.publish("owner-A", a, NOW);
    const csv = "player_id,yards\n00-0000001,300\n"; const csvSha = digest(csv); const csvRef = csvSha + ".csv";
    // Register a schema-valid CSV source blob directly: real CSV parsers remain
    // PR B work, but the complete existing storage/retention contract must work.
    const registerCsv = async (runId: string) => {
      expect(await artifacts.database.write(csv, csvSha, "text/csv")).toBe(csvRef);
      await client.query("INSERT INTO predictive_blobs (sha256,byte_size,media_type,storage_ref) VALUES ($1,$2,'text/csv',$3)", [csvSha, Buffer.byteLength(csv), csvRef]);
      await client.query(`INSERT INTO predictive_artifacts (id,blob_sha256,profile_id,retrieval_kind,origin,scope_kind)
        VALUES ('csv-retention-proof',$1,$2,'full','fixture://csv-retention','manual')`, [csvSha, PROFILE]);
      await client.query(`INSERT INTO predictive_captures (id,run_id,artifact_id,captured_at,available_at,ingested_at,state,
        body_complete,header_verified,parser_succeeded,parsed_rows)
        VALUES ('csv-retention-capture',$1,'csv-retention-proof',$2,$2,$2,'incomplete',true,false,false,0)`, [runId, NOW]);
      const stored = (await client.query("SELECT storage_ref,byte_size FROM predictive_blobs WHERE sha256=$1", [csvSha])).rows[0];
      expect(await artifacts.database.read(stored.storage_ref, csvSha, stored.byte_size)).toBe(csv);
    };
    await registerCsv("owner-A");
    const login = "dfs52_retention_" + randomBytes(8).toString("hex");
    await client.query(`CREATE ROLE ${login} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD 'disposable-owner-test'`);
    await client.query(`GRANT predictive_retention_owner TO ${login}`);
    const expected = { ...target.expected, user: login, password: "disposable-owner-test" };
    const owner = new Client(expected);
    const ownerTarget = { expected, assertTarget: (config: object) => { expect(config).toEqual(expected); target.assertTarget(target.expected); } };
    try {
      await owner.connect();
      expect((await owner.query("SELECT rolsuper FROM pg_roles WHERE rolname=session_user")).rows[0].rolsuper).toBe(false);
      await owner.query("SET ROLE predictive_retention_owner");
      for (const sql of ["SELECT * FROM public.predictive_blobs", "SELECT * FROM public.predictive_blob_removals",
        "DELETE FROM public.predictive_blob_removals"]) await expect(owner.query(sql)).rejects.toMatchObject({ code: "42501" });
      await owner.query("RESET ROLE");
      const sha = a.artifacts[0].sha256; const ref = sha + ".json";
      await expect(owner.query("SELECT public.predictive_blob_referenced($1)", [ref])).rejects.toMatchObject({ code: "55000" });
      await expect(owner.query("SELECT public.predictive_blob_lock_guard($1)", [sha])).rejects.toMatchObject({ code: "55000" });
      await expect(owner.query("SELECT public.predictive_blob_lock_guard($1)", [sha + ".json"])).rejects.toMatchObject({ code: "23514" });
      await expect(owner.query("SELECT public.predictive_blob_referenced($1)", ["../" + ref])).rejects.toMatchObject({ code: "23514" });
      await expect(owner.query("SELECT public.predictive_ack_blob_removal($1)", [ref])).rejects.toMatchObject({ code: "55000" });
      const key = Number.parseInt(sha.slice(0, 8), 16) | 0;
      await owner.query("SELECT pg_advisory_lock(520054,$1)", [key]);
      try {
        await owner.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
        await expect(owner.query("SELECT public.predictive_blob_referenced($1)", [ref])).rejects.toMatchObject({ code: "25001" });
      } finally { await owner.query("ROLLBACK"); await owner.query("SELECT pg_advisory_unlock(520054,$1)", [key]); }
      const ownerStore = await createLocalPredictiveStore(owner, ownerTarget, artifacts);
      const event: RetentionEvent = { id: "owner-delete", reason: "provider-request", authority: "synthetic provider request", decidedAt: NOW,
        scope: { kind: "source", profileIds: [PROFILE], capturedFrom: null, capturedBefore: null }, auditLevel: "full" };
      // Journals can contain identical bytes, but DB retention never deletes them.
      await artifacts.write(a.artifacts[0].bytes, sha);
      await artifacts.write(csv, csvSha, "text/csv");
      const result = await ownerStore.retain(event);
      expect(result.removedBlobRefs).toHaveLength(a.artifacts.length + 1);
      expect(result.removedBlobRefs).toContain(csvRef);
      expect((await client.query("SELECT count(*)::integer AS count FROM predictive_blob_removals")).rows[0].count).toBe(0);
      await expect(artifacts.database.read(ref, sha, Buffer.byteLength(a.artifacts[0].bytes))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await artifacts.read(ref, sha, Buffer.byteLength(a.artifacts[0].bytes))).toBe(a.artifacts[0].bytes);
      await expect(artifacts.database.read(csvRef, csvSha, Buffer.byteLength(csv))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await artifacts.read(csvRef, csvSha, Buffer.byteLength(csv))).toBe(csv);
      expect((await ownerStore.retentionEvents()).map((row) => row.id)).toEqual([event.id]);
      await store.publish("owner-B", a, NOW);
      await registerCsv("owner-B");
      const failed = await createLocalPredictiveStore(owner, ownerTarget, { ...artifacts, database: { ...artifacts.database,
        remove: async () => { throw new Error("owner unlink interrupted"); } } });
      await expect(failed.retain({ ...event, id: "owner-resume" })).rejects.toThrow("owner unlink interrupted");
      expect((await client.query("SELECT count(*)::integer AS count FROM predictive_blob_removals")).rows[0].count).toBe(a.artifacts.length + 1);
      expect(await artifacts.database.read(csvRef, csvSha, Buffer.byteLength(csv))).toBe(csv);
      const resumed = await ownerStore.resumeBlobRemovals();
      expect(resumed).toHaveLength(a.artifacts.length + 1); expect(resumed).toContain(csvRef);
      await expect(artifacts.database.read(csvRef, csvSha, Buffer.byteLength(csv))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await ownerStore.resumeBlobRemovals()).toEqual([]);
      expect((await ownerStore.retentionEvents()).map((row) => row.id)).toEqual(["owner-delete", "owner-resume"]);
    } finally { await owner.end(); await client.query(`DROP ROLE ${login}`); }
  });
});

it("predictive rollback removes unpublished bytes and orphan recovery preserves committed blobs and journals", async () => {
  await withProof(async ({ client, store, artifacts, target, root }) => {
    const a = passingYardsFixture(false); await store.publish("A", a, NOW);
    const conflict = passingYardsFixture(false);
    const changed = conflict.artifacts.find((artifact) => artifact.id === "A-player-game-stats")!;
    const rows = JSON.parse(changed.bytes) as Revision[];
    const player = rows.find((row) => row.id === "player-synthetic-game-5")!;
    if (player.kind !== "player-game-stats") throw new Error("fixture player missing");
    player.data.passingYards = 301; changed.bytes = JSON.stringify(rows); changed.sha256 = digest(changed.bytes);
    await expect(store.publish("conflict", conflict, NOW)).rejects.toThrow("observation-id-conflict");
    await expect(artifacts.database.read(changed.sha256 + ".json", changed.sha256, Buffer.byteLength(changed.bytes))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await client.query("SELECT count(*)::integer AS count FROM predictive_blobs WHERE sha256=$1", [changed.sha256])).rows[0].count).toBe(0);
    // Failure after a file write but before the write transaction (crash analogue).
    conflict.artifacts = [changed, ...conflict.artifacts.filter((artifact) => artifact !== changed)];
    const crashing = await createLocalPredictiveStore(client, target, { ...artifacts, database: { ...artifacts.database,
      write: async (bytes, sha) => { await artifacts.database.write(bytes, sha); throw new Error("after file write"); } } });
    await expect(crashing.publish("write-fail", conflict, NOW)).rejects.toThrow("after file write");
    const failedDiagnostic = { ...conflict, profiles: conflict.profiles.map((profile) => ({ ...profile, license: "conflicting registration" })) };
    await expect(store.recordRefusal("diagnostic-fail", failedDiagnostic, NOW)).rejects.toThrow("profile-id-conflict");
    await expect(artifacts.database.read(changed.sha256 + ".json", changed.sha256, Buffer.byteLength(changed.bytes))).rejects.toMatchObject({ code: "ENOENT" });
    // Feature-run file survives neither recorder failure nor the return of an unavailable result.
    const unavailable = await crashing.replayAndRecord(request());
    expect(unavailable).toEqual({ status: "unavailable", reason: "feature-run-not-recorded" });
    expect((await readdir(join(root, ".db-blobs"))).filter((name) => name.endsWith(".json")).sort())
      .toEqual(a.artifacts.map((artifact) => artifact.sha256 + ".json").sort());
    // A crash can skip all application finally blocks: recreate orphan content
    // and a partial temp file, then age them beyond the documented 24h grace.
    const orphan = "orphan diagnostic bytes"; const sha = digest(orphan); const ref = sha + ".json";
    await artifacts.database.write(orphan, sha); await artifacts.write(orphan, sha);
    const temporary = ".capture-" + sha + "-00000000-0000-4000-8000-000000000000.tmp";
    await writeFile(join(root, ".db-blobs", temporary), "partial", { mode: 0o600 });
    const committedTemporary = ".capture-" + a.artifacts[0].sha256 + "-00000000-0000-4000-8000-000000000001.tmp";
    await writeFile(join(root, ".db-blobs", committedTemporary), "partial recapture", { mode: 0o600 });
    const recentTemporary = ".capture-" + a.artifacts[0].sha256 + "-00000000-0000-4000-8000-000000000002.tmp";
    await writeFile(join(root, ".db-blobs", recentTemporary), "active recapture", { mode: 0o600 });
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    for (const name of [ref, temporary, committedTemporary, a.artifacts[0].sha256 + ".json"]) await utimes(join(root, ".db-blobs", name), old, old);
    const fresh = "recent uncommitted file"; const freshSha = digest(fresh); await artifacts.database.write(fresh, freshSha);
    const csv = "id,yards\n1,300\n"; const csvSha = digest(csv); const csvRef = await artifacts.database.write(csv, csvSha, "text/csv");
    await artifacts.write(csv, csvSha, "text/csv"); await utimes(join(root, ".db-blobs", csvRef), old, old);
    // An aged schema-valid committed CSV survives, just like committed JSON.
    const committedCsv = "id,yards\n2,320\n"; const committedCsvSha = digest(committedCsv);
    const committedCsvRef = await artifacts.database.write(committedCsv, committedCsvSha, "text/csv");
    await client.query("INSERT INTO predictive_blobs (sha256,byte_size,media_type,storage_ref) VALUES ($1,$2,'text/csv',$3)",
      [committedCsvSha, Buffer.byteLength(committedCsv), committedCsvRef]);
    await utimes(join(root, ".db-blobs", committedCsvRef), old, old);
    expect((await store.sweepOrphanBlobs()).sort()).toEqual([ref, temporary, committedTemporary, csvRef].sort());
    expect(await store.sweepOrphanBlobs()).toEqual([]);
    expect(await readFile(join(root, ".db-blobs", recentTemporary), "utf8")).toBe("active recapture");
    expect(await artifacts.read(ref, sha, Buffer.byteLength(orphan))).toBe(orphan);
    expect(await artifacts.read(csvRef, csvSha, Buffer.byteLength(csv))).toBe(csv);
    expect(await artifacts.database.read(committedCsvRef, committedCsvSha, Buffer.byteLength(committedCsv))).toBe(committedCsv);
    expect(await artifacts.database.read(freshSha + ".json", freshSha, Buffer.byteLength(fresh))).toBe(fresh);
    expect(await artifacts.database.read(a.artifacts[0].sha256 + ".json", a.artifacts[0].sha256, Buffer.byteLength(a.artifacts[0].bytes))).toBe(a.artifacts[0].bytes);
    await expect(store.sweepOrphanBlobs(0)).rejects.toThrow("blob-grace-refused");
  });
});

it.each(["application/json", "text/csv"] as const)("predictive blob reference identity preserves committed %s and removes its unreferenced sibling", async (mediaType) => {
  await withProof(async ({ client, store, artifacts, target, root }) => {
    await store.publish("suffix-A", passingYardsFixture(false), NOW);
    // A numeric scalar is valid JSON and a one-column CSV record. Identical
    // bytes deliberately produce the same digest; ownership is a file address.
    const bytes = "123\n"; const sha = digest(bytes); const size = Buffer.byteLength(bytes);
    const siblingType = mediaType === "application/json" ? "text/csv" : "application/json";
    const ref = await artifacts.database.write(bytes, sha, mediaType);
    const sibling = await artifacts.database.write(bytes, sha, siblingType);
    const register = async (type: typeof mediaType, reference: string) => {
      await client.query("INSERT INTO predictive_blobs (sha256,byte_size,media_type,storage_ref) VALUES ($1,$2,$3,$4)", [sha, size, type, reference]);
      await client.query(`INSERT INTO predictive_artifacts (id,blob_sha256,profile_id,retrieval_kind,origin,scope_kind)
        VALUES ('suffix-proof',$1,$2,'full','fixture://suffix-proof','manual')`, [sha, PROFILE]);
      await client.query(`INSERT INTO predictive_captures (id,run_id,artifact_id,captured_at,available_at,ingested_at,state,
        body_complete,header_verified,parser_succeeded,parsed_rows)
        VALUES ('suffix-capture','suffix-A','suffix-proof',$1,$1,$1,'incomplete',true,false,false,0)`, [NOW]);
    };
    await register(mediaType, ref);
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    const temporary = ".capture-" + sha + "-00000000-0000-4000-8000-000000000003.tmp";
    await writeFile(join(root, ".db-blobs", temporary), "partial recapture", { mode: 0o600 });
    for (const name of [ref, sibling, temporary]) await utimes(join(root, ".db-blobs", name), old, old);
    await artifacts.write(bytes, sha, mediaType); await artifacts.write(bytes, sha, siblingType);
    const login = "dfs52_suffix_" + randomBytes(8).toString("hex");
    await client.query(`CREATE ROLE ${login} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD 'disposable-owner-test'`);
    await client.query(`GRANT predictive_retention_owner TO ${login}`);
    const expected = { ...target.expected, user: login, password: "disposable-owner-test" };
    const owner = new Client(expected);
    const ownerTarget = { expected, assertTarget: (config: object) => { expect(config).toEqual(expected); target.assertTarget(target.expected); } };
    try {
      await owner.connect();
      const key = Number.parseInt(sha.slice(0, 8), 16) | 0;
      await owner.query("SELECT pg_advisory_lock(520054,$1)", [key]);
      try {
        expect((await owner.query(`SELECT public.predictive_blob_referenced($1) AS committed,
          public.predictive_blob_referenced($2) AS sibling`, [ref, sibling])).rows[0]).toEqual({ committed: true, sibling: false });
      } finally { await owner.query("SELECT pg_advisory_unlock(520054,$1)", [key]); }
      const ownerStore = await createLocalPredictiveStore(owner, ownerTarget, artifacts);
      expect((await ownerStore.sweepOrphanBlobs()).sort()).toEqual([sibling, temporary].sort());
      expect(await artifacts.database.read(ref, sha, size)).toBe(bytes);
      await expect(artifacts.database.read(sibling, sha, size)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await artifacts.read(ref, sha, size)).toBe(bytes); expect(await artifacts.read(sibling, sha, size)).toBe(bytes);
      if (mediaType === "text/csv") {
        // Current publication writes JSON only. A committed CSV digest must
        // survive a refused JSON diagnostic, while its new JSON file is removed.
        const diagnostic = passingYardsFixture(false); const original = diagnostic.artifacts[0];
        diagnostic.artifacts = [{ ...original, bytes, sha256: sha }];
        diagnostic.captures = diagnostic.captures.filter((capture) => capture.artifactId === original.id);
        await expect(store.recordRefusal("suffix-rollback", diagnostic, NOW)).rejects.toThrow("blob-conflict");
        await expect(artifacts.database.read(sibling, sha, size)).rejects.toMatchObject({ code: "ENOENT" });
        expect(await artifacts.database.read(ref, sha, size)).toBe(bytes);
      }
      // Retention commits but unlink fails. Republishing the same digest under
      // the other media type must not protect the queued, previous address.
      const failed = await createLocalPredictiveStore(owner, ownerTarget, { ...artifacts, database: { ...artifacts.database,
        remove: async () => { throw new Error("suffix unlink interrupted"); } } });
      await expect(failed.retain({ id: "suffix-retain", reason: "provider-request", authority: "synthetic provider request", decidedAt: NOW,
        scope: { kind: "source", profileIds: [PROFILE], capturedFrom: NOW, capturedBefore: null }, auditLevel: "full" })).rejects.toThrow("suffix unlink interrupted");
      expect((await owner.query("SELECT public.predictive_pending_blob_removals() AS ref")).rows).toContainEqual({ ref });
      await artifacts.database.write(bytes, sha, siblingType); await register(siblingType, sibling);
      expect(await ownerStore.resumeBlobRemovals()).toContain(ref);
      await expect(artifacts.database.read(ref, sha, size)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await artifacts.database.read(sibling, sha, size)).toBe(bytes);
      expect(await ownerStore.resumeBlobRemovals()).toEqual([]);
    } finally { await owner.end(); await client.query(`DROP ROLE ${login}`); }
  });
});

it("predictive final labels bind exact raw identity and retaining their bridge removes later label versions", async () => {
  await withProof(async ({ client, store }) => {
    const dataset = passingYardsFixture(false);
    // Model the reported parser error exactly: raw X was attributed to A, while
    // a genuine roster bridge Y -> A exists in the permitted bridge profile.
    for (const artifact of dataset.artifacts) {
      const rows = JSON.parse(artifact.bytes) as Revision[];
      for (const row of rows) if (row.kind === "player-game-stats" && row.id === "player-synthetic-game-5") row.data.rawPlayerId = "raw-X";
      artifact.bytes = JSON.stringify(rows); artifact.sha256 = digest(artifact.bytes);
    }
    const observed = validateDataset(dataset).observations; const at = instant(CAPTURE_A); const game = PRIOR[4];
    dataset.decisions.push(recordCompletion("complete-5", game, markerHeadsAt(observed.values(), game, at), CAPTURE_A, "synthetic-proof"),
      recordParticipation("participate-5", game, PLAYER, participationHeadsAt(observed.values(), game, PLAYER, at), CAPTURE_A, "synthetic-proof"),
      reconcileFact("reconcile-5", "player-game-stats:" + game + ":" + PLAYER,
        [...observed.values()].filter((row) => row.entityKey === "player-game-stats:" + game + ":" + PLAYER), CAPTURE_A, "synthetic-proof"));
    const bridgeProfile = "synthetic-roster-identity";
    dataset.profiles.push(profile(bridgeProfile)); dataset.rightsDecisions.push(rights(bridgeProfile));
    dataset.identityLinks.push({ id: "linked-roster", statsProfileId: PROFILE, bridgeProfileId: bridgeProfile, provider: "gsis", decidedAt: CAPTURE_A });
    const bridge = (id: string, raw: string) => revision(id, "player-bridge", { provider: "gsis", rawPlayerId: raw, playerId: PLAYER,
      effectiveFrom: "2026-01-01T00:00:00.000Z", effectiveTo: "2027-01-01T00:00:00.000Z" });
    addCapture(dataset, "wrong-raw-roster", [bridge("bridge-Y", PLAYER)], CAPTURE_A, bridgeProfile);
    addCapture(dataset, "post-window", JSON.parse(dataset.artifacts.find((artifact) => artifact.id === "A-player-game-stats")!.bytes), "2026-10-10T13:00:00.000Z");
    const after = "2026-10-11T00:00:00.000Z"; await store.publish("raw-identity", dataset, after);
    const provisional: Label = { id: "identity-v1", playerId: PLAYER, gameId: game, seasonType: "REG", stat: "passing_yards", value: 300,
      state: "provisional", mode: "synthetic-proof", policyId: "canonical-label-finalization-v1", labelVersion: 1, predecessorId: null,
      completionDecisionId: "complete-5", participationDecisionId: "participate-5", reconciliationDecisionId: "reconcile-5",
      selectedObservationId: "player-synthetic-game-5", eligibleFinalAt: null, postWindowCaptureId: null, finalizedAt: null,
      createdAt: "2026-10-07T13:00:00.000Z", playerBridgeObservationId: null };
    const final: Label = { ...provisional, id: "identity-v2", predecessorId: provisional.id, labelVersion: 2, state: "final",
      eligibleFinalAt: "2026-10-10T12:00:00.000Z", postWindowCaptureId: "capture-post-window", finalizedAt: "2026-10-10T14:00:00.000Z",
      createdAt: "2026-10-10T14:00:00.000Z", playerBridgeObservationId: "bridge-Y" };
    const registrations = { profiles: dataset.profiles, rightsDecisions: dataset.rightsDecisions, identityLinks: dataset.identityLinks };
    const labels = (items: Label[]) => ({ ...emptyDataset(), ...registrations, labels: items });
    await expect(store.publish("wrong-raw-label", labels([provisional, final]), after))
      .rejects.toMatchObject({ code: "23514", message: "predictive-label-binding-9" });
    expect((await client.query("SELECT id FROM predictive_outcome_labels")).rows).toEqual([]);
    const deletion: RetentionEvent = { id: "remove-wrong-bridge", reason: "owner-request", authority: "synthetic identity evidence replacement", decidedAt: after,
      scope: { kind: "source", profileIds: [bridgeProfile], capturedFrom: null, capturedBefore: null }, auditLevel: "full" };
    await store.retain(deletion);
    const correct = { ...emptyDataset(), ...registrations }; addCapture(correct, "correct-roster", [bridge("bridge-X", "raw-X")], CAPTURE_A, bridgeProfile);
    await store.publish("correct-roster", correct, after);
    const bound = { ...final, playerBridgeObservationId: "bridge-X" };
    // The successor cites a different, surviving bridge. Its removal therefore
    // proves label-lineage closure, rather than merely direct bridge references.
    const survivingProfile = "synthetic-surviving-roster"; const surviving = emptyDataset();
    surviving.profiles.push(profile(survivingProfile)); surviving.rightsDecisions.push(rights(survivingProfile));
    surviving.identityLinks.push({ id: "surviving-link", statsProfileId: PROFILE, bridgeProfileId: survivingProfile, provider: "gsis", decidedAt: CAPTURE_A });
    addCapture(surviving, "surviving-roster", [bridge("surviving-bridge-X", "raw-X")], CAPTURE_A, survivingProfile);
    await store.publish("surviving-roster", surviving, after);
    const successor = { ...bound, id: "identity-v3", predecessorId: bound.id, labelVersion: 3, createdAt: "2026-10-10T14:00:01.000Z",
      playerBridgeObservationId: "surviving-bridge-X" };
    await store.publish("correct-label", labels([provisional, bound, successor]), after);
    expect((await client.query("SELECT id FROM predictive_outcome_labels ORDER BY label_version")).rows.map((row) => row.id))
      .toEqual(["identity-v1", "identity-v2", "identity-v3"]);
    const result = await store.retain({ ...deletion, id: "remove-cited-bridge" });
    expect(result.removedCounts).toMatchObject({ observations: 1, labels: 2 });
    expect((await client.query("SELECT id FROM predictive_outcome_labels")).rows).toEqual([{ id: "identity-v1" }]);
    expect((await client.query("SELECT id FROM predictive_observations WHERE id='surviving-bridge-X'")).rows).toEqual([{ id: "surviving-bridge-X" }]);
  });
});
