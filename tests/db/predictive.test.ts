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
import { createLocalPredictiveStore, MEMBERSHIP_READ_SQL } from "../../src/lib/predictive/persistence.ts";
import { ingestLocalDataset } from "../../src/lib/predictive/ingest.ts";
import { runLocalProof } from "../../scripts/predictive/local.ts";
import { digest } from "../../src/lib/predictive/validation.ts";
import { addCapture, CAPTURE_B, CUTOFF_B, coverage, gameId, passingYardsFixture, PLAYER, PRIOR, request, revision, schedule } from "../predictive/fixtures/passingYards.ts";
import { createScratchHarness } from "./scratch.mjs";

const NOW = "2026-10-09T00:00:00.000Z";
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
  } finally { await harness.close(); await rm(root, { recursive: true, force: true }); }
};

it("predictive PostgreSQL A/B replay preserves the earlier bundle and uses later corrections", async () => {
  await withProof(async ({ store }) => {
    const a = passingYardsFixture(false); await store.publish("A", a, NOW);
    const before = await store.replay(request()); expect(before).toEqual(buildPassingYardsBundle(a, request()));
    const b = passingYardsFixture(); const correction = { ...b, artifacts: b.artifacts.filter((artifact) => artifact.id.startsWith("B-")), captures: b.captures.filter((capture) => capture.artifactId.startsWith("B-")) };
    await store.publish("B", correction, NOW);
    expect(await store.replay(request())).toEqual(before);
    expect(await store.replay(request(CUTOFF_B))).toEqual(buildPassingYardsBundle(b, request(CUTOFF_B)));
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
    const full = { ...dataset, artifacts: [...dataset.artifacts, ...correction.artifacts], captures: [...dataset.captures, ...correction.captures] };
    expect(await store.replay(request())).toEqual(before);
    expect(await store.replay(request(CUTOFF_B))).toEqual(buildPassingYardsBundle(full, request(CUTOFF_B)));
    expect((await store.replay(request(CUTOFF_B))).player[0].exclusions).toContainEqual({ gameId: PRIOR[4], reason: "membership-inapplicable" });
  });
});
it("predictive persistence retains former-team membership gaps and ignores unrelated schedule dependencies", async () => {
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
    const unrelated = { formatVersion: 1 as const, artifacts: [], captures: [] };
    addCapture(unrelated, "unrelated", [revision("unrelated", "schedule", schedule(77, "2026-09-14T00:15:00.000Z", "nfl:team:SEA", "nfl:team:ARI"))]);
    await store.publish("unrelated", unrelated, NOW); expect(await store.replay(query)).toEqual(before);
  });
});
it("predictive retries and unchanged recaptures preserve immutable revisions and their earliest provenance", async () => {
  await withProof(async ({ client, store }) => {
    const dataset = passingYardsFixture(false); await store.publish("A", dataset, NOW); const before = await store.replay(request());
    const counts = (await client.query("SELECT (SELECT count(*) FROM predictive_observations)::integer AS revisions,(SELECT count(*) FROM predictive_captures)::integer AS captures")).rows;
    expect(await store.publish("A", dataset, NOW)).toMatchObject({ reused: true, status: "published" });
    expect((await client.query("SELECT (SELECT count(*) FROM predictive_observations)::integer AS revisions,(SELECT count(*) FROM predictive_captures)::integer AS captures")).rows).toEqual(counts);
    const recaptured = { ...dataset, captures: dataset.captures.map((capture) => ({ ...capture, id: "recaptured:" + capture.id, capturedAt: CAPTURE_B, availableAt: CAPTURE_B, ingestedAt: CAPTURE_B })) };
    await store.publish("recapture", recaptured, NOW); expect(await store.replay(request())).toEqual(before);
    expect((await client.query("SELECT count(*)::integer AS count FROM predictive_observations")).rows[0].count).toBe(counts[0].revisions);
    const changedArtifact = { ...dataset, artifacts: dataset.artifacts.map((artifact) => {
      const bytes = JSON.stringify(JSON.parse(artifact.bytes), null, 2);
      return { ...artifact, id: "changed-bytes:" + artifact.id, bytes, sha256: digest(bytes) };
    }), captures: dataset.captures.map((capture) => ({ ...capture, id: "changed-bytes:" + capture.id,
      artifactId: "changed-bytes:" + capture.artifactId, capturedAt: CAPTURE_B, availableAt: CAPTURE_B, ingestedAt: CAPTURE_B })) };
    await store.publish("changed-bytes", changedArtifact, NOW);
    expect(await store.replay(request())).toEqual(before);
    expect((await client.query("SELECT count(*)::integer AS count FROM predictive_observations")).rows[0].count).toBe(counts[0].revisions);
  });
});
it("predictive publication is invisible until commit and concurrent retries publish one batch", async () => {
  await withProof(async ({ client, store, target, artifacts }) => {
    const observer = new Client(target.expected); await observer.connect();
    let release!: () => void; let reached!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; }); const held = new Promise<void>((resolve) => { reached = resolve; });
    let blocked = false;
    const observed = { query: async (sql: string, params?: unknown[]) => {
      const result = await client.query(sql, params);
      if (!blocked && sql.startsWith("INSERT INTO public.predictive_observations")) { blocked = true; reached(); await gate; }
      return result;
    } } as unknown as Client;
    const publisher = await createLocalPredictiveStore(observed, target, artifacts);
    const competitor = await createLocalPredictiveStore(observer, target, artifacts);
    const dataset = passingYardsFixture(false); const first = publisher.publish("racing-A", dataset, NOW);
    try {
      await held;
      expect((await observer.query("SELECT count(*)::integer AS count FROM predictive_ingestion_runs")).rows[0].count).toBe(0);
      expect((await observer.query("SELECT count(*)::integer AS count FROM predictive_observations")).rows[0].count).toBe(0);
      const second = competitor.publish("racing-A", dataset, NOW); release();
      const results = await Promise.all([first, second]); expect(results.map((result) => result.reused).sort()).toEqual([false, true]);
      expect((await client.query("SELECT count(*)::integer AS count FROM predictive_ingestion_runs")).rows[0].count).toBe(1);
      expect((await store.replay(request())).status).toBe("ready-inputs");
    } finally { release(); await first; await observer.end(); }
  });
});
it("predictive failed and partial publication quarantine diagnostics without exposing partial inputs", async () => {
  await withProof(async ({ client, store }) => {
    const partial = passingYardsFixture(false); partial.captures[0].state = "incomplete";
    expect(await ingestLocalDataset(store, "partial", partial, NOW)).toMatchObject({ status: "incomplete" });
    expect((await client.query("SELECT count(*)::integer AS count FROM predictive_observations")).rows[0].count).toBe(0);
    expect((await store.replay(request())).status).toBe("unavailable-inputs");
    const bad = passingYardsFixture(false); const artifact = bad.artifacts[0]; const rows = JSON.parse(artifact.bytes); rows[0].data.extra = true;
    artifact.bytes = JSON.stringify(rows); artifact.sha256 = digest(artifact.bytes);
    expect(await ingestLocalDataset(store, "bad-schema", bad, NOW)).toMatchObject({ status: "refused", failureCode: "publication-refused" });
    expect((await client.query("SELECT count(*)::integer AS count FROM predictive_captures WHERE state='published'")).rows[0].count).toBe(0);
    await store.publish("A", passingYardsFixture(false), NOW);
    expect(await store.replay(request())).toEqual(buildPassingYardsBundle(passingYardsFixture(false), request()));
  });
});
it("predictive publication rolls back conflicts and invalid correction lineage while retaining the earlier replay", async () => {
  await withProof(async ({ client, store }) => {
    const dataset = passingYardsFixture(false); await store.publish("A", dataset, NOW); const before = await store.replay(request());
    const changed = passingYardsFixture(false); const artifact = changed.artifacts.find((artifact) => artifact.feed === "player-passing")!;
    const rows = JSON.parse(artifact.bytes); rows[0].data.passingYards = 777; artifact.bytes = JSON.stringify(rows); artifact.sha256 = digest(artifact.bytes);
    await expect(store.publish("conflict", changed, NOW)).rejects.toThrow();
    expect((await client.query("SELECT id FROM predictive_ingestion_runs ORDER BY id")).rows).toEqual([{ id: "A" }]);
    const bad = passingYardsFixture(); const correction = bad.artifacts.find((artifact) => artifact.id === "B-player")!;
    const revisions = JSON.parse(correction.bytes); revisions[0].predecessorId = "missing"; correction.bytes = JSON.stringify(revisions); correction.sha256 = digest(correction.bytes);
    await expect(store.publish("bad-lineage", bad, NOW)).rejects.toThrow("invalid-correction-lineage");
    expect(await store.replay(request())).toEqual(before);
  });
});
it("predictive immutable rows, typed evidence and correction keys are enforced by PostgreSQL", async () => {
  await withProof(async ({ client, store }) => {
    await store.publish("A", passingYardsFixture(false), NOW);
    for (const sql of ["UPDATE predictive_captures SET ingested_at=ingested_at+interval '1 second'", "DELETE FROM predictive_observations", "UPDATE predictive_artifacts SET sha256=repeat('0',64)", "TRUNCATE predictive_observations CASCADE"]) {
      await expect(client.query(sql)).rejects.toMatchObject({ code: "23514" });
    }
    const original = (await client.query("SELECT data FROM predictive_observations WHERE kind='player-passing' LIMIT 1")).rows[0].data;
    for (const data of [{ ...original, extra: 1 }, { ...original, attempts: -1 }, { ...original, seasonType: null }, {}, { ...original, attempts: null }]) {
      await expect(client.query("INSERT INTO predictive_observations (id,kind,data) VALUES ('invalid','player-passing',$1)", [data])).rejects.toThrow();
    }
    await expect(client.query("INSERT INTO predictive_observations (id,kind,data,predecessor_id,correction_reason) VALUES ('wrong-key','player-passing',$1,'schedule-synthetic-game-1','wrong kind')", [original])).rejects.toThrow();
  });
});
it("predictive missing or tampered artifact bytes withhold replay without replacing stored evidence", async () => {
  await withProof(async ({ store, root }) => {
    const dataset = passingYardsFixture(false); await store.publish("A", dataset, NOW);
    const artifact = dataset.artifacts.find((artifact) => artifact.feed === "player-passing")!; const path = join(root, artifact.sha256 + ".json");
    const original = await readFile(path, "utf8"); await writeFile(path, "{}", { mode: 0o600 });
    expect(await store.safeReplay(request())).toEqual({ status: "unavailable", reason: "persisted-replay-unavailable" });
    await writeFile(path, original); expect((await store.replay(request())).status).toBe("ready-inputs");
    await rm(path); expect((await store.safeReplay(request())).status).toBe("unavailable");
  });
});
it("predictive indexed membership reads are player-scoped and read transactions remain read-only", async () => {
  await withProof(async ({ client, store }) => {
    await store.publish("A", passingYardsFixture(false), NOW);
    await client.query("BEGIN READ ONLY");
    try {
      await client.query("SET LOCAL enable_seqscan=off");
      const plan = (await client.query("EXPLAIN (FORMAT JSON) " + MEMBERSHIP_READ_SQL, [request().cutoff, request().playerId, "2026-10-11T17:00:00.000Z", "2024-01-01T00:00:00.000Z"])).rows[0]["QUERY PLAN"];
      expect(JSON.stringify(plan)).toContain("predictive_observations_membership_idx");
    } finally { await client.query("ROLLBACK"); }
    await client.query("BEGIN READ ONLY");
    try { await expect(client.query("INSERT INTO predictive_games (id) VALUES ('00000000-0000-4000-8000-000000000099')")).rejects.toMatchObject({ code: "25006" }); }
    finally { await client.query("ROLLBACK"); }
    expect((await store.replay(request())).status).toBe("ready-inputs");
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
      expect(await runScratchMigrations(client, options)).toMatchObject({ schemaVersion: 3, executed: [3] });
      expect((await client.query("SELECT * FROM creators")).rows).toEqual(before);
      expect(await runScratchMigrations(client, options)).toMatchObject({ schemaVersion: 3, executed: [] });
    });
  } finally { await harness.close(); }
});
