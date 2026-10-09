import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { expect, it } from "vitest";
import { createCatalogVerifier, loadCatalogContracts } from "../../scripts/db-migrations/contracts.mjs";
import { runScratchMigrations } from "../../scripts/db-migrations/core.mjs";
import { checkMigrationArtifacts } from "../../scripts/db-migrations/files.mjs";
import { openArtifactStore } from "../../src/lib/predictive/artifacts.ts";
import { buildPassingYardsBundle } from "../../src/lib/predictive/passingYards.ts";
import { createLocalPredictiveStore, MEMBERSHIP_READ_SQL, SCHEDULE_READ_SQL } from "../../src/lib/predictive/persistence.ts";
import { ingestLocalDataset } from "../../src/lib/predictive/ingest.ts";
import { runLocalProof } from "../../scripts/predictive/local.ts";
import { digest } from "../../src/lib/predictive/validation.ts";
import type { Dataset } from "../../src/lib/predictive/types.ts";
import { addCapture, CAPTURE_B, CUTOFF_B, coverage, gameId, passingYardsFixture, PLAYER, PRIOR, request, revision, schedule, TARGET, TEAM } from "../predictive/fixtures/passingYards.ts";
import { backendPid, waitForBlocked } from "./leaseSupport";
import { createScratchHarness } from "./scratch.mjs";

const NOW = "2026-10-09T00:00:00.000Z";
const tables = ["predictive_ingestion_runs", "predictive_artifacts", "predictive_captures", "predictive_teams",
  "predictive_games", "predictive_observations", "predictive_artifact_observations"] as const;
const snapshot = async (client: Client) => {
  const rows: Record<string, unknown[]> = {};
  for (const table of tables) rows[table] = (await client.query(`SELECT * FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
  return rows;
};
// Direct SQL probes roll back even when an assertion fails. Valid controls force
// deferred checks before rollback, so unrelated publication errors cannot pass.
const sqlProbe = async (client: Client, probe: () => Promise<void>) => {
  await client.query("BEGIN");
  try { await probe(); } finally { await client.query("ROLLBACK"); }
};
const withProof = async (run: (context: {
  client: Client; store: Awaited<ReturnType<typeof createLocalPredictiveStore>>; root: string;
  artifacts: Awaited<ReturnType<typeof openArtifactStore>>; target: { expected: object; assertTarget: (config: object) => void };
}) => Promise<void>) => {
  const harness = await createScratchHarness(process.env);
  const root = await realpath(await mkdtemp(join(tmpdir(), "dfs-ev-predictive-db-")));
  try {
    const files = await checkMigrationArtifacts(); const contracts = await loadCatalogContracts(files);
    await harness.withDatabase(async (client: Client, expected: object) => {
      const target = { expected, assertTarget: harness.assertTarget };
      await runScratchMigrations(client, { ...target, files, verify: createCatalogVerifier(contracts) });
      const artifacts = await openArtifactStore(root); const store = await createLocalPredictiveStore(client, target, artifacts);
      await run({ client, store, root, artifacts, target });
    });
  } finally { try { await harness.close(); } finally { await rm(root, { recursive: true, force: true }); } }
};

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
      predecessorId: "player-synthetic-game-5", artifactId: "B-player", availableAt: CAPTURE_B, ingestedAt: CAPTURE_B,
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
    const membership = dataset.artifacts.flatMap((artifact) => JSON.parse(artifact.bytes)).find((row) => row.id === "member-synthetic-game-5");
    const correction = { formatVersion: 1 as const, artifacts: [], captures: [] };
    addCapture(correction, "moved-member", [revision("moved-member", "membership", { ...membership.data,
      effectiveFrom: "2023-01-01T00:00:00.000Z", effectiveTo: "2023-02-01T00:00:00.000Z",
    }, membership.id)], CAPTURE_B);
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
    const movedSchedule = { formatVersion: 1 as const, artifacts: [], captures: [] };
    const oldSchedule = dataset.artifacts.flatMap((artifact) => JSON.parse(artifact.bytes)).find((row) => row.id === "schedule-synthetic-game-5");
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
    const unrelated = { formatVersion: 1 as const, artifacts: [], captures: [] };
    addCapture(unrelated, "unrelated", [revision("unrelated", "schedule", schedule(77, "2026-09-14T00:15:00.000Z", "nfl:team:SEA", "nfl:team:ARI"))]);
    await store.publish("unrelated", unrelated, NOW);
    expect(await store.replay(request())).toEqual(before);
  });
  await withProof(async ({ store }) => {
    const dataset = passingYardsFixture(false); const former = schedule(40, "2025-12-07T17:00:00.000Z", "nfl:team:BUF", "nfl:team:NE", 2025);
    const gap = schedule(41, "2025-12-14T17:00:00.000Z", former.homeTeamId, former.awayTeamId, 2025);
    addCapture(dataset, "former-schedules", [revision("former-schedule", "schedule", former), revision("former-gap", "schedule", gap)]);
    addCapture(dataset, "former-member", [revision("former-member", "membership", { gameId: former.gameId, playerId: PLAYER, rawPlayerId: PLAYER,
      teamId: former.homeTeamId, rawTeam: "BUF", position: "QB", effectiveFrom: "2025-09-01T00:00:00.000Z", effectiveTo: "2025-12-31T00:00:00.000Z", mappingVersion: "synthetic-v1" })]);
    addCapture(dataset, "former-complete", [revision("former-complete", "completion", { gameId: former.gameId, state: "confirmed", bound: "2026-10-07T12:00:00.000Z", boundKind: "completion-observed-at", evidenceVersion: "synthetic-v1" })]);
    addCapture(dataset, "former-participant", [revision("former-participant", "participation", { gameId: former.gameId, playerId: PLAYER, state: "confirmed", evidenceVersion: "synthetic-v1" })]);
    addCapture(dataset, "former-stats", [revision("former-stats", "player-passing", { gameId: former.gameId, rawGameId: former.rawGameId, teamId: former.homeTeamId,
      rawTeam: "BUF", season: 2025, seasonType: "REG", playerId: PLAYER, rawPlayerId: PLAYER, attempts: 10, passingYards: 60, missingReason: null })]);
    addCapture(dataset, "former-coverage", [revision("former-coverage", "schedule-coverage", coverage(former.homeTeamId, [gameId(20), former.gameId, gap.gameId]))]);
    await store.publish("A", dataset, NOW); const query = { ...request(), candidate: "stats-v1:player_pass_yds" as const };
    const before = await store.replay(query); expect(before).toEqual(buildPassingYardsBundle(dataset, query));
    expect(before.status).toBe("unavailable-inputs"); expect(before.player[1].exclusions).toContainEqual({ gameId: gap.gameId, reason: "membership-missing" });
    expect(before.player[1]).toMatchObject({ expectedGames: 7, observedGames: 6, excludedGames: 1, unknownGames: 1,
      gameIds: [...PRIOR].reverse().concat([gap.gameId, former.gameId]), attemptsSum: 120, passingYardsSum: 810 });
    const unrelated = { formatVersion: 1 as const, artifacts: [], captures: [] };
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
      for (const rows of Object.values(await snapshot(monitor))) expect(rows).toHaveLength(0);
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
    expect(await artifacts.read(artifact.sha256 + ".json", artifact.sha256, Buffer.byteLength(artifact.bytes))).toBe(artifact.bytes);
    await store.publish("A", passingYardsFixture(false), NOW);
    expect(await store.replay(request())).toEqual(buildPassingYardsBundle(passingYardsFixture(false), request()));
  });
});
it("predictive publication rolls back conflicts and invalid correction lineage while retaining the earlier replay", async () => {
  await withProof(async ({ client, store }) => {
    const dataset = passingYardsFixture(false); await store.publish("A", dataset, NOW); const before = await store.replay(request());
    const storedBefore = await snapshot(client);
    const changed = passingYardsFixture(false); const artifact = changed.artifacts.find((artifact) => artifact.feed === "player-passing")!;
    const rows = JSON.parse(artifact.bytes); rows[0].data.passingYards = 777; artifact.bytes = JSON.stringify(rows); artifact.sha256 = digest(artifact.bytes);
    await expect(store.publish("conflict", changed, NOW)).rejects.toThrow("observation-id-conflict");
    expect(await snapshot(client)).toEqual(storedBefore);
    const valid: Dataset = { formatVersion: 1, artifacts: [], captures: [] };
    const predecessor = JSON.parse(artifact.bytes).find((row: { id: string }) => row.id === "player-synthetic-game-5");
    addCapture(valid, "capture-conflict", [revision("new-correction", "player-passing", {
      ...predecessor.data, passingYards: 321,
    }, predecessor.id)], CAPTURE_B);
    valid.captures[0].id = "capture-A-player-passing";
    // This conflict occurs after run/artifact INSERTs, so equality of all seven
    // tables proves rollback rather than only refusal before any writes.
    await expect(store.publish("late-conflict", valid, NOW)).rejects.toThrow("capture-id-conflict");
    expect(await snapshot(client)).toEqual(storedBefore);
    const retry = { ...dataset, captures: dataset.captures.map((capture) => ({ ...capture, id: "retry:" + capture.id })) };
    await expect(store.publish("A", retry, NOW)).rejects.toThrow("run-id-conflict");
    expect(await snapshot(client)).toEqual(storedBefore);
    const bad = passingYardsFixture(); const correction = bad.artifacts.find((artifact) => artifact.id === "B-player")!;
    const revisions = JSON.parse(correction.bytes); revisions[0].predecessorId = "missing"; correction.bytes = JSON.stringify(revisions); correction.sha256 = digest(correction.bytes);
    await expect(store.publish("bad-lineage", bad, NOW)).rejects.toThrow("invalid-correction-lineage");
    expect(await snapshot(client)).toEqual(storedBefore);
    expect(await store.replay(request())).toEqual(before);
  });
});
it("predictive immutable rows, typed evidence and correction keys are enforced by PostgreSQL", async () => {
  await withProof(async ({ client, store }) => {
    await store.publish("A", passingYardsFixture(false), NOW);
    const before = await snapshot(client);
    for (const table of tables) {
      const column = table === "predictive_artifact_observations" ? "artifact_id" : "id";
      for (const sql of [`UPDATE ${table} SET ${column}=${column}`, `DELETE FROM ${table}`, `TRUNCATE ${table} CASCADE`]) {
        await expect(client.query(sql)).rejects.toMatchObject({ code: "23514", message: "predictive-append-only" });
      }
    }
    const originalRows = (await client.query(`SELECT DISTINCT ON (o.kind) o.kind,o.data,l.artifact_id FROM predictive_observations o
      JOIN predictive_artifact_observations l ON l.observation_id=o.id ORDER BY o.kind,o.id`)).rows;
    const originals = Object.fromEntries(originalRows.map((row) => [row.kind, row]));
    expect(originalRows).toHaveLength(8);
    const insert = (kind: string, data: unknown, predecessor: string | null = null) => client.query(
      "INSERT INTO predictive_observations (id,kind,data,predecessor_id,correction_reason) VALUES ('sql-probe',$1,$2,$3,$4)",
      [kind, data, predecessor, predecessor ? "SQL constraint probe" : null]);
    // Valid controls must pass the same INSERT and deferred publication checks.
    for (const row of originalRows) await sqlProbe(client, async () => {
      await insert(row.kind, row.data);
      await client.query("INSERT INTO predictive_artifact_observations VALUES ($1,'sql-probe')", [row.artifact_id]);
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    });
    const player = originals["player-passing"].data;
    for (const data of [{ ...player, attempts: 0, passingYards: 0 }, { ...player, passingYards: -5 },
      { ...player, attempts: null, passingYards: null, missingReason: "source-blank" }]) await sqlProbe(client, async () => {
      await insert("player-passing", data);
      await client.query("INSERT INTO predictive_artifact_observations VALUES ($1,'sql-probe')", [originals["player-passing"].artifact_id]);
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    });
    const invalid: [string, object][] = [
      ["schedule", { kickoff: "2026-02-30T17:00:00.000Z" }], ["schedule", { homeTeamId: originals.schedule.data.awayTeamId }],
      ["membership", { effectiveTo: originals.membership.data.effectiveFrom }],
      ["player-passing", { extra: 1 }], ["player-passing", { attempts: -1 }], ["player-passing", { seasonType: null }],
      ["player-passing", { attempts: null }], ["player-passing", { passingYards: 0.5 }], ["team-passing", { attempts: "10" }],
      ["completion", { boundKind: null }], ["participation", { state: "inactive" }], ["availability", { injury: "probable" }],
      ["schedule-coverage", { gameIds: [TARGET, TARGET] }], ["schedule-coverage", { state: "assumed-complete" }],
    ];
    for (const [kind, changes] of invalid) await sqlProbe(client, async () => {
      await expect(insert(kind, { ...originals[kind].data, ...changes })).rejects.toMatchObject({
        code: "23514", constraint: "predictive_observations_check",
      });
    });
    const correctionData = (await client.query("SELECT data FROM predictive_observations WHERE id='player-synthetic-game-5'")).rows[0].data;
    for (const predecessor of ["schedule-synthetic-game-5", "player-synthetic-game-1"]) await sqlProbe(client, async () => {
      await insert("player-passing", correctionData, predecessor);
      await expect(client.query("SET CONSTRAINTS predictive_observations_predecessor_id_kind_natural_key_fkey IMMEDIATE"))
        .rejects.toMatchObject({ code: "23503", constraint: "predictive_observations_predecessor_id_kind_natural_key_fkey" });
    });
    await sqlProbe(client, async () => {
      await insert("player-passing", correctionData, "player-synthetic-game-5");
      await client.query("INSERT INTO predictive_artifact_observations VALUES ($1,'sql-probe')", [originals["player-passing"].artifact_id]);
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    });
    expect(await snapshot(client)).toEqual(before);
    expect((await store.replay(request())).status).toBe("ready-inputs");
  });
});
it("predictive missing or tampered artifact bytes withhold replay without replacing stored evidence", async () => {
  await withProof(async ({ store, root, client, artifacts }) => {
    const dataset = passingYardsFixture(false); await store.publish("A", dataset, NOW);
    const artifact = dataset.artifacts.find((artifact) => artifact.feed === "player-passing")!; const path = join(root, artifact.sha256 + ".json");
    const before = await store.replay(request()); expect(before.status).toBe("ready-inputs");
    const original = await readFile(path, "utf8"); const tampered = original.replace('"passingYards":50', '"passingYards":51');
    expect(tampered).not.toBe(original); expect(Buffer.byteLength(tampered)).toBe(Buffer.byteLength(original));
    await writeFile(path, tampered, { mode: 0o600 });
    expect(await store.safeReplay(request())).toEqual({ status: "unavailable", reason: "persisted-replay-unavailable" });
    await expect(artifacts.write(original, artifact.sha256)).rejects.toThrow("artifact-integrity-failed");
    expect(await readFile(path, "utf8")).toBe(tampered);
    await writeFile(path, original); expect(await store.replay(request())).toEqual(before);
    await rm(path); expect(await store.safeReplay(request())).toEqual({ status: "unavailable", reason: "persisted-replay-unavailable" });
    await writeFile(path, original, { mode: 0o600 });
    // Legal typed SQL alone cannot establish source-byte parity: this appended
    // revision is absent from the intact artifact. Runtime replay must refuse it.
    const data = JSON.parse(original)[0].data;
    await client.query("BEGIN");
    try {
      await client.query("INSERT INTO predictive_observations (id,kind,data) VALUES ('not-in-source','player-passing',$1)", [data]);
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
    const member = dataset.artifacts.flatMap((artifact) => JSON.parse(artifact.bytes)).find((row) => row.id === "member-synthetic-game-1");
    addCapture(dataset, "other-player", [revision("other-player", "membership", {
      ...member.data, playerId: "00-0000002", rawPlayerId: "00-0000002",
    })]);
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
    expect(captured).toMatchObject({ schemaVersion: 3, earlierReplayUnchanged: true, restoredReplayUnchanged: true });
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
      expect(await runScratchMigrations(client, options)).toMatchObject({ schemaVersion: 3, executed: [3] });
      expect((await client.query("SELECT * FROM creators")).rows).toEqual(before);
      const upgraded = (await client.query("SELECT * FROM db_migrations ORDER BY version")).rows;
      expect(upgraded.slice(0, 2)).toEqual(historical); expect(upgraded).toHaveLength(3);
      expect(await runScratchMigrations(client, options)).toMatchObject({ schemaVersion: 3, executed: [] });
      expect((await client.query("SELECT * FROM db_migrations ORDER BY version")).rows).toEqual(upgraded);
    });
  } finally { await harness.close(); }
});
