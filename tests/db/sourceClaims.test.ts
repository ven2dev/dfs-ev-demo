import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { expect, it } from "vitest";
import { checkMigrationArtifacts } from "../../scripts/db-migrations/files.mjs";
import { createCatalogVerifier, loadCatalogContracts } from "../../scripts/db-migrations/contracts.mjs";
import { runScratchMigrations } from "../../scripts/db-migrations/core.mjs";
import { ensureHarnessSession, ensurePredictiveRoles } from "../../scripts/predictive/harness.ts";
import { openArtifactStore } from "../../src/lib/predictive/artifacts.ts";
import { createLocalPredictiveStore, retentionIdsDigest } from "../../src/lib/predictive/persistence.ts";
import type { RecordedRetentionEvent } from "../../src/lib/predictive/types.ts";
import { canonical, digest } from "../../src/lib/predictive/validation.ts";
import { sourceNormalizationBasis } from "../../src/lib/predictive/persistence.ts";
import { prepareSourceClaims, projectSourceClaim } from "../../src/lib/predictive/sourceClaims.ts";
import { sourceClaimFixture } from "../predictive/fixtures/sourceClaims.ts";
import { sourceCsv, sourceGameId, sourceSamples } from "../predictive/fixtures/source.ts";
import { passingYardsFixture } from "../predictive/fixtures/passingYards.ts";
import { addCapture, gameId, profile, revision, rights } from "../predictive/fixtures/passingYards.ts";
import { BRIDGE_PROFILE, normalizationFixture, NORMALIZATION_GAME, rewriteNormalizationRows } from "../predictive/fixtures/sourceNormalization.ts";
import { createScratchHarness } from "./scratch.mjs";

type Store = Awaited<ReturnType<typeof createLocalPredictiveStore>>;
type Artifacts = Awaited<ReturnType<typeof openArtifactStore>>;
type Target = { expected: object; assertTarget: (config: object) => void };
const withProof = async (work: (context: { client: Client; store: Store; artifacts: Artifacts; root: string; target: Target }) => Promise<void>, migrationCount?: number) => {
  const harness = await createScratchHarness(process.env);
  const root = await realpath(await mkdtemp(join(tmpdir(), "dfs52-csv-db-")));
  try {
    const files = await checkMigrationArtifacts(); const contracts = await loadCatalogContracts(files);
    await harness.withDatabase(async (client: Client, expected: object) => {
      const target = { expected, assertTarget: harness.assertTarget };
      await ensurePredictiveRoles(client);
      await runScratchMigrations(client, { ...target, files: files.slice(0, migrationCount), verify: createCatalogVerifier(contracts) });
      await ensureHarnessSession(client);
      const artifacts = await openArtifactStore(root, 8_000_000);
      await work({ client, artifacts, root, target, store: await createLocalPredictiveStore(client, target, artifacts) });
    });
  } finally { try { await harness.close(); } finally { await rm(root, { recursive: true, force: true }); } }
};
const captureTime = async (client: Client, id: string) => (await client.query(`SELECT to_char(ingested_at AT TIME ZONE 'UTC',
  'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS time FROM predictive_captures WHERE id=$1`, [id])).rows[0].time as string;
const replayRequest = (cutoff: string, player = true) => ({ profileId: "csv-synthetic-" + (player ? "player" : "team"),
  rawGameId: sourceGameId, rawTeam: "PHI", rawPlayerId: player ? "00-0000001" : null, cutoff });
const probe = async (client: Client, work: () => Promise<void>) => {
  await client.query("BEGIN"); try { await work(); } finally { await client.query("ROLLBACK"); }
};
const withLogin = async (client: Client, target: Target, roles: string[], work: (connection: Client, loginTarget: Target) => Promise<void>) => {
  const login = "dfs52_csv_" + randomBytes(8).toString("hex");
  await client.query(`CREATE ROLE ${login} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD 'disposable-csv-test'`);
  await client.query(`GRANT ${roles.join(",")} TO ${login}`);
  const expected = { ...target.expected, user: login, password: "disposable-csv-test" }; const connection = new Client(expected);
  try {
    await connection.connect();
    expect((await connection.query("SELECT rolsuper FROM pg_roles WHERE rolname=session_user")).rows[0].rolsuper).toBe(false);
    await work(connection, { expected, assertTarget: (config) => { expect(config).toEqual(expected); target.assertTarget(target.expected); } });
  } finally { await connection.end(); await client.query(`DROP OWNED BY ${login}`); await client.query(`DROP ROLE ${login}`); }
};

it("CSV source persistence stamps import time, is idempotent and preserves A/B cutoff replay", async () => {
  await withProof(async ({ client, store, artifacts }) => {
    const a = sourceClaimFixture();
    expect(await store.publishSourceStats(a)).toMatchObject({ status: "published", reused: false });
    const atA = await captureTime(client, a.captureId);
    expect(atA > a.capturedAt).toBe(true);
    const before = await store.replaySourceStats(replayRequest(atA));
    expect(before.status).toBe("observed-source-claim");
    expect(before.evidence.rows[0].projection?.values).toMatchObject({ attempts: 10, passingYards: 80 });
    expect(before).toMatchObject({ featuresPublished: false, labelsFinalized: false, populationCoverage: "unqualified" });
    const oneMsBefore = new Date(Date.parse(atA) - 1).toISOString();
    expect(await store.replaySourceStats(replayRequest(oneMsBefore))).toMatchObject({ reason: "source-capture-missing" });
    expect(await store.publishSourceStats(a)).toMatchObject({ reused: true });
    expect(await captureTime(client, a.captureId)).toBe(atA);
    expect((await client.query("SELECT count(*)::integer AS n FROM predictive_source_stats_rows")).rows[0].n).toBe(1);
    const b = sourceClaimFixture("source-B", "player", sourceCsv("player", [{ ...sourceSamples().player[0], passing_yards: "95" }]));
    b.capturedAt = atA; // A later synthetic capture, imported after A.
    await client.query("SELECT pg_sleep(0.005)");
    await store.publishSourceStats(b); const atB = await captureTime(client, b.captureId);
    expect(atB > atA).toBe(true);
    expect(await store.replaySourceStats(replayRequest(atA))).toEqual(before);
    expect((await store.replaySourceStats(replayRequest(atB))).evidence.rows[0].projection?.values.passingYards).toBe(95);
    const raw = (await client.query("SELECT storage_ref,media_type FROM predictive_blobs WHERE sha256=$1", [a.artifact.sha256])).rows[0];
    expect(raw).toEqual({ storage_ref: a.artifact.sha256 + ".csv", media_type: "text/csv" });
    expect(await artifacts.database.read(raw.storage_ref, a.artifact.sha256, Buffer.byteLength(a.artifact.bytes))).toBe(a.artifact.bytes);
    expect((await client.query("SELECT count(*)::integer AS n FROM predictive_observations")).rows[0].n).toBe(0);
  });
});

it("CSV source replay exposes missing, refused and ambiguous rows without inventing zero", async () => {
  await withProof(async ({ client, store }) => {
    const row = sourceSamples().player[0];
    const a = sourceClaimFixture("duplicate", "player", sourceCsv("player", [row, { ...row, passing_yards: "81" }, { ...row, player_id: "00-0000002", attempts: "bad" }]));
    await store.publishSourceStats(a); const cutoff = await captureTime(client, a.captureId);
    expect(await store.replaySourceStats(replayRequest(cutoff))).toMatchObject({ reason: "source-row-ambiguous" });
    const refused = await store.replaySourceStats({ ...replayRequest(cutoff), rawPlayerId: "00-0000002" });
    expect(refused.reason).toBe("source-row-refused"); expect(refused.evidence.rows[0]).toMatchObject({ projection: null, failureCode: "source-number-refused" });
    expect(await store.replaySourceStats({ ...replayRequest(cutoff), rawPlayerId: "00-0000003" })).toMatchObject({ reason: "source-row-missing" });
    const b = sourceClaimFixture("disappeared", "player", sourceCsv("player", [{ ...row, player_id: "00-0000004", attempts: "0", passing_yards: "0" }]));
    b.capturedAt = cutoff; await client.query("SELECT pg_sleep(0.005)"); await store.publishSourceStats(b);
    const atB = await captureTime(client, b.captureId);
    expect(await store.replaySourceStats(replayRequest(atB))).toMatchObject({ reason: "source-row-missing" });
    const zero = await store.replaySourceStats({ ...replayRequest(atB), rawPlayerId: "00-0000004" });
    expect(zero.status).toBe("observed-source-claim"); expect(zero.evidence.rows[0].projection?.values.attempts).toBe(0);
    expect(await store.replaySourceStats(replayRequest(cutoff))).toMatchObject({ reason: "source-row-ambiguous" });
  });
});

it("CSV source replay refuses tampered raw files and forged selected-row projections", async () => {
  await withProof(async ({ client, store, root }) => {
    const a = sourceClaimFixture(); await store.publishSourceStats(a); const cutoff = await captureTime(client, a.captureId);
    const path = join(root, ".db-blobs", a.artifact.sha256 + ".csv");
    const original = await readFile(path);
    await writeFile(path, a.artifact.bytes.replace('"80"', '"81"'), { mode: 0o600 });
    await expect(store.replaySourceStats(replayRequest(cutoff))).rejects.toThrow("artifact-integrity-failed");
    await writeFile(path, original, { mode: 0o600 });
    // A privileged corruption probe proves replay independently recomputes rows.
    await client.query("ALTER TABLE predictive_source_stats_rows DISABLE TRIGGER predictive_source_rows_immutable");
    try {
      await client.query("UPDATE predictive_source_stats_rows SET selected_sha256=repeat('0',64)");
      await expect(store.replaySourceStats(replayRequest(cutoff))).rejects.toThrow("stored-source-row-mismatch");
    } finally { await client.query("ALTER TABLE predictive_source_stats_rows ENABLE TRIGGER predictive_source_rows_immutable"); }
  });
});

it("CSV source publication rolls back files and refuses run conflicts and revoked current rights", async () => {
  await withProof(async ({ client, store, artifacts }) => {
    const a = sourceClaimFixture(); await store.publishSourceStats(a);
    const changed = sourceClaimFixture(a.id, "player", sourceCsv("player", [{ ...sourceSamples().player[0], passing_yards: "90" }]));
    await expect(store.publishSourceStats(changed)).rejects.toThrow("run-id-conflict");
    await expect(artifacts.database.read(changed.artifact.sha256 + ".csv", changed.artifact.sha256, Buffer.byteLength(changed.artifact.bytes))).rejects.toMatchObject({ code: "ENOENT" });
    const capConflict = sourceClaimFixture("capture-conflict", "player", changed.artifact.bytes); capConflict.captureId = a.captureId;
    await expect(store.publishSourceStats(capConflict)).rejects.toThrow("capture-id-conflict");
    expect((await client.query("SELECT id FROM predictive_ingestion_runs ORDER BY id")).rows).toEqual([{ id: a.id }]);
    // Append a later rights head independently of the publication API; an old
    // capture's historical authorization must not bypass current revocation.
    await client.query(`INSERT INTO predictive_rights_decisions (id,profile_id,predecessor_id,allowed_uses,effective_from,decided_at,evidence_kind,evidence_reference)
      VALUES ('revoked',$1,$2,'{}','2026-10-10T00:00:00Z','2026-10-10T00:00:00Z','synthetic','fixture revocation')`, [a.profile.id, a.rightsDecisions[0].id]);
    expect(await store.replaySourceStats(replayRequest(await captureTime(client, a.captureId)))).toMatchObject({ reason: "rights-not-in-force" });
    const refused = sourceClaimFixture("revoked-publication", "player", changed.artifact.bytes);
    await expect(store.publishSourceStats(refused)).rejects.toMatchObject({ code: "23514", message: "predictive-source-claim-envelope-invalid" });
    await expect(artifacts.database.read(refused.artifact.sha256 + ".csv", refused.artifact.sha256, Buffer.byteLength(refused.artifact.bytes))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

it("CSV source SQL enforces complete row ordinals, strict projection shape and the canonical binding boundary", async () => {
  await withProof(async ({ client, store }) => {
    const a = sourceClaimFixture(); await store.publishSourceStats(a); const prepared = await prepareSourceClaims(a);
    for (const sql of ["UPDATE predictive_source_stats_rows SET selected_sha256=repeat('0',64)", "DELETE FROM predictive_source_stats_rows", "TRUNCATE predictive_source_stats_rows CASCADE"]) {
      await probe(client, async () => { await expect(client.query(sql)).rejects.toMatchObject({ code: "23514", message: "predictive-append-only" }); });
    }
    for (const data of [{ ...prepared.rows[0].projection, seasonType: null }, { ...prepared.rows[0].projection, unexpected: "prohibited" },
      { ...prepared.rows[0].projection, rawPlayerId: "raw-1" }, { ...prepared.rows[0].projection, rawOpponent: "PHI" },
      { ...prepared.rows[0].projection, values: { ...prepared.rows[0].projection!.values, completions: 11 } }])
      expect((await client.query("SELECT predictive_source_projection_valid($1) AS valid", [data])).rows[0].valid).toBe(false);
    for (const mode of ["missing", "ordinal", "key", "valid"] as const) await probe(client, async () => {
      await client.query(`INSERT INTO predictive_captures (id,run_id,artifact_id,captured_at,available_at,ingested_at,state,body_complete,header_verified,parser_succeeded,parsed_rows)
        SELECT 'probe',run_id,artifact_id,captured_at,available_at,ingested_at,state,body_complete,header_verified,parser_succeeded,1 FROM predictive_captures WHERE id=$1`, [a.captureId]);
      if (mode !== "missing") {
        const row = projectSourceClaim("probe", "player", sourceSamples().player[0], mode === "ordinal" ? 2 : 1);
        await client.query(`INSERT INTO predictive_source_stats_rows VALUES ($1,'probe',$2,$3,$4,$5,NULL)`,
          [row.id, row.rowOrdinal, mode === "key" ? "0".repeat(64) : row.rawKeySha256, row.selectedSha256, row.projection]);
      }
      if (mode === "valid") {
        await client.query("SET CONSTRAINTS ALL IMMEDIATE");
        // The SELECT copied the earlier ingested_at, but SQL stamps this insert.
        expect(await captureTime(client, "probe") > await captureTime(client, a.captureId)).toBe(true);
      } else await expect(client.query("SET CONSTRAINTS ALL IMMEDIATE")).rejects.toMatchObject({ code: "23514",
        message: mode === "key" ? "predictive-source-claim-key-invalid" : "predictive-source-claim-coverage-invalid" });
    });
    await store.publish("canonical-proof", passingYardsFixture(false), "2026-10-09T00:00:00.000Z");
    await probe(client, async () => {
      await expect(client.query("INSERT INTO predictive_artifact_observations VALUES ($1,'player-synthetic-game-5')", [a.artifact.id]))
        .rejects.toMatchObject({ code: "23514", message: "predictive-source-canonical-binding-required" });
    });
  });
});

it("CSV source replay keeps equal-time conflicts ambiguous and late older imports cannot replace a newer snapshot", async () => {
  await withProof(async ({ client, store }) => {
    const a = sourceClaimFixture(); await store.publishSourceStats(a); const firstCutoff = await captureTime(client, a.captureId);
    const b = sourceClaimFixture("equal-time", "player", sourceCsv("player", [{ ...sourceSamples().player[0], passing_yards: "90" }]));
    await store.publishSourceStats(b); const conflictAt = await captureTime(client, b.captureId);
    expect(await store.replaySourceStats(replayRequest(conflictAt))).toMatchObject({ reason: "source-capture-ambiguous" });
    const newer = sourceClaimFixture("newer", "player", sourceCsv("player", [{ ...sourceSamples().player[0], passing_yards: "100" }]));
    newer.capturedAt = firstCutoff; await store.publishSourceStats(newer); const newestAt = await captureTime(client, newer.captureId);
    expect((await store.replaySourceStats(replayRequest(newestAt))).evidence.rows[0].projection?.values.passingYards).toBe(100);
    const old = sourceClaimFixture("late-old", "player", sourceCsv("player", [{ ...sourceSamples().player[0], passing_yards: "70" }]));
    old.capturedAt = "2026-10-08T12:00:00.000Z"; await store.publishSourceStats(old);
    expect((await store.replaySourceStats(replayRequest(await captureTime(client, old.captureId)))).evidence.rows[0].projection?.values.passingYards).toBe(100);
    expect(await store.replaySourceStats(replayRequest(conflictAt))).toMatchObject({ reason: "source-capture-ambiguous" });
  });
});

it("CSV source migration upgrades released v3 without changing existing evidence or its recorded checksum", async () => {
  await withProof(async ({ client, store, target }) => {
    await store.publish("released-v3-proof", passingYardsFixture(false), "2026-10-09T00:00:00.000Z");
    const evidence = (await client.query("SELECT * FROM predictive_observations ORDER BY id")).rows;
    const ledger = (await client.query("SELECT * FROM db_migrations ORDER BY version")).rows;
    expect(ledger).toHaveLength(3);
    const files = await checkMigrationArtifacts(); const contracts = await loadCatalogContracts(files);
    const options = { ...target, files, verify: createCatalogVerifier(contracts) };
    expect(await runScratchMigrations(client, options)).toMatchObject({ executed: files.slice(3).map((file) => file.version), schemaVersion: files.length });
    expect((await client.query("SELECT * FROM db_migrations ORDER BY version")).rows.slice(0, 3)).toEqual(ledger);
    expect((await client.query("SELECT * FROM predictive_observations ORDER BY id")).rows).toEqual(evidence);
    expect(await runScratchMigrations(client, options)).toMatchObject({ executed: [], schemaVersion: files.length });
    await store.publishSourceStats(sourceClaimFixture("after-upgrade"));
  }, 3);
});

it("CSV source ingest and replay work without superuser and retention removes rows and resumes files with execute-only access", async () => {
  await withProof(async ({ client, artifacts, target }) => {
    const a = sourceClaimFixture("non-superuser", "team");
    await withLogin(client, target, ["predictive_ingest", "predictive_replay", "predictive_harness"], async (writer, writerTarget) => {
      const store = await createLocalPredictiveStore(writer, writerTarget, artifacts);
      await store.publishSourceStats(a);
      expect((await store.replaySourceStats(replayRequest(await captureTime(client, a.captureId), false))).evidence.rows[0].projection?.values.passingYards).toBe(80);
      await expect(writer.query("DELETE FROM predictive_source_stats_rows")).rejects.toMatchObject({ code: "42501" });
    });
    const cutoff = await captureTime(client, a.captureId);
    await withLogin(client, target, ["predictive_retention_owner"], async (owner, ownerTarget) => {
      await expect(owner.query("SELECT * FROM predictive_source_stats_rows")).rejects.toMatchObject({ code: "42501" });
      const normal = await createLocalPredictiveStore(owner, ownerTarget, artifacts);
      const broken = await createLocalPredictiveStore(owner, ownerTarget, { ...artifacts, database: { ...artifacts.database,
        remove: async () => { throw new Error("interrupted CSV unlink"); } } });
      await expect(broken.retain({ id: "csv-retention", reason: "provider-request", authority: "synthetic test", decidedAt: a.capturedAt,
        scope: { kind: "source", profileIds: [a.profile.id], capturedFrom: null, capturedBefore: null }, auditLevel: "full" }))
        .rejects.toThrow("interrupted CSV unlink");
      expect((await client.query("SELECT count(*)::integer AS n FROM predictive_source_stats_rows")).rows[0].n).toBe(0);
      const history = await normal.retentionEvents();
      expect(history[0].removedCounts.sourceStatsRows).toBe(1);
      const tombstones = (await client.query("SELECT target_kind AS kind,target_id AS id FROM predictive_retention_tombstones")).rows;
      expect(history[0].removedIdsDigest).toBe(retentionIdsDigest(tombstones));
      expect(await normal.resumeBlobRemovals()).toEqual([a.artifact.sha256 + ".csv"]);
      await expect(artifacts.database.read(a.artifact.sha256 + ".csv", a.artifact.sha256, Buffer.byteLength(a.artifact.bytes))).rejects.toMatchObject({ code: "ENOENT" });
    });
    const replay = await createLocalPredictiveStore(client, target, artifacts);
    expect(await replay.replaySourceStats(replayRequest(cutoff, false))).toMatchObject({ reason: "retained-evidence-removed" });
  });
});

it("CSV source retention re-applies identical row deletion after re-importing retained files into a fresh database", async () => {
  const a = sourceClaimFixture("backup-A");
  const row = sourceSamples().player[0];
  const b = sourceClaimFixture("backup-B", "player", sourceCsv("player", [
    { ...row, passing_yards: "95" }, { ...row, player_id: "00-0000002", attempts: "bad" },
  ]));
  b.capturedAt = "2026-10-10T12:00:00.000Z";
  let history: RecordedRetentionEvent[] = []; let originalImport = "";
  await withProof(async ({ client, store }) => {
    await store.publishSourceStats(a); await store.publishSourceStats(b);
    originalImport = await captureTime(client, a.captureId);
    const removed = await store.retain({ id: "csv-backup-deletion", reason: "provider-request", authority: "synthetic retention proof",
      decidedAt: a.capturedAt, scope: { kind: "source", profileIds: [a.profile.id], capturedFrom: null, capturedBefore: null }, auditLevel: "digest-only" });
    expect(removed.removedCounts).toMatchObject({ sourceStatsRows: 3, artifacts: 2, captures: 2, blobs: 2 });
    history = await store.retentionEvents();
    expect((await client.query("SELECT count(*)::integer AS n FROM predictive_retention_tombstones")).rows[0].n).toBe(0);
    expect((await client.query("SELECT count(*)::integer AS n FROM predictive_source_stats_rows")).rows[0].n).toBe(0);
  });
  // Re-import the same immutable files/capture IDs into a fresh registered DB.
  // Its new import time must not change the removal ID set or its audit digest.
  await withProof(async ({ client, store, artifacts }) => {
    await store.publishSourceStats(a); await store.publishSourceStats(b);
    expect(await captureTime(client, a.captureId) > originalImport).toBe(true);
    expect(await store.reapply(history)).toEqual([{ eventId: "csv-backup-deletion", status: "reapplied", matched: true }]);
    expect(await store.reapply(history)).toEqual([{ eventId: "csv-backup-deletion", status: "present", matched: true }]);
    expect((await client.query("SELECT count(*)::integer AS n FROM predictive_source_stats_rows")).rows[0].n).toBe(0);
    for (const input of [a, b])
      await expect(artifacts.database.read(input.artifact.sha256 + ".csv", input.artifact.sha256, Buffer.byteLength(input.artifact.bytes)))
        .rejects.toMatchObject({ code: "ENOENT" });
  });
});

it("CSV normalization plans verify raw rows and exact bridges in a read-only snapshot through a replay-only login", async () => {
  await withProof(async ({ client, store, artifacts, target }) => {
    const { input, context } = await normalizationFixture();
    await store.publishSourceStats(input); await store.publish("normalization-context", context, "2026-10-11T00:00:00.000Z");
    const cutoff = await captureTime(client, input.captureId); const request = replayRequest(cutoff);
    const expected = await store.planSourceStatsNormalization(request);
    expect(expected).toMatchObject({ status: "planned-source-normalization", candidate: { kind: "player-game-stats",
      data: { gameId: NORMALIZATION_GAME, playerId: "00-0000001", rawPlayerId: "00-0000001", attempts: 10, passingYards: 80 } }, observationsPublished: false });
    expect(expected.binding.dependencies.map((row) => row.observationId).sort()).toEqual(["game-map", "game-schedule", "opponent-map", "player-map", "team-map"]);
    expect((await client.query("SELECT count(*)::integer AS n FROM predictive_observations WHERE kind IN ('player-game-stats','team-game-stats')")).rows[0].n).toBe(0);
    await withLogin(client, target, ["predictive_replay"], async (reader, readerTarget) => {
      let probes = 0;
      const observed = { query: async (sql: string, params?: unknown[]) => {
        if (sql.includes("predictive_profile_identity_links") && sql.includes("stats_profile_id=$1")) {
          const settings = (await reader.query("SELECT current_setting('transaction_read_only') AS ro,current_setting('transaction_isolation') AS isolation")).rows[0];
          expect(settings).toEqual({ ro: "on", isolation: "repeatable read" }); probes++;
        }
        return reader.query(sql, params);
      } } as unknown as Client;
      const replayOnly = await createLocalPredictiveStore(observed, readerTarget, artifacts);
      expect(await replayOnly.planSourceStatsNormalization(request)).toEqual(expected); expect(probes).toBe(1);
      await expect(reader.query("INSERT INTO predictive_source_stats_rows (id) VALUES ('denied')")).rejects.toMatchObject({ code: "42501" });
    });
    const missing = await store.planSourceStatsNormalization({ ...request, cutoff: new Date(Date.parse(cutoff) - 1).toISOString() });
    expect(missing).toMatchObject({ status: "unavailable-source-normalization", reason: "source-capture-missing", candidate: null });
    await store.retain({ id: "remove-normalization-bridges", reason: "provider-request", authority: "synthetic test",
      decidedAt: input.capturedAt, scope: { kind: "source", profileIds: [BRIDGE_PROFILE], capturedFrom: null, capturedBefore: null }, auditLevel: "digest-only" });
    // Links and profile registrations survive retention, but cannot replace
    // their removed bridge evidence or cause missing profile metadata to throw.
    expect(await store.planSourceStatsNormalization(request)).toMatchObject({ reason: "game-bridge-missing", candidate: null });
  });
});

it("CSV normalization scoped reads include reverse identity conflicts without importing unrelated correction chains", async () => {
  await withProof(async ({ client, store }) => {
    const { input, context, bridgeRows } = await normalizationFixture();
    // This ancestor lives in a different artifact from its unrelated correction.
    // Reading only the target must not rebuild/validate the whole mixed artifact.
    addCapture(context, "unrelated-ancestor", [revision("unrelated-root", "game-bridge", {
      provider: "nflverse", rawGameId: "unrelated-game", gameId: gameId(99) })], "2026-10-08T12:00:00.000Z", BRIDGE_PROFILE);
    rewriteNormalizationRows(context, [...bridgeRows, revision("unrelated-correction", "game-bridge", {
      provider: "nflverse", rawGameId: "unrelated-game", gameId: gameId(98) }, "unrelated-root")]);
    await store.publishSourceStats(input); await store.publish("mixed-normalization-context", context, "2026-10-11T00:00:00.000Z");
    const request = replayRequest(await captureTime(client, input.captureId));
    const planned = await store.planSourceStatsNormalization(request);
    expect(planned.status).toBe("planned-source-normalization");
    expect(planned.binding.dependencies.some((row) => row.observationId.startsWith("unrelated"))).toBe(false);
    const other = "normalization-reverse-rival";
    const rival = { formatVersion: 2 as const, profiles: [profile(other)], rightsDecisions: [rights(other)],
      artifacts: [], captures: [], decisions: [], labels: [], identityLinks: [] };
    addCapture(rival, "reverse-rival", [revision("reverse-player", "player-bridge", {
      provider: "gsis", rawPlayerId: "00-0000002", playerId: "00-0000001",
      effectiveFrom: "2026-01-01T00:00:00.000Z", effectiveTo: "2027-01-01T00:00:00.000Z" })], "2026-10-09T12:00:00.000Z", other);
    await store.publish("reverse-rival", rival, "2026-10-11T00:00:00.000Z");
    const conflict = await store.planSourceStatsNormalization(request);
    expect(conflict).toMatchObject({ reason: "player-bridge-conflict", candidate: null });
    expect(conflict.binding.dependencies.some((row) => row.observationId === "reverse-player")).toBe(true);
  });
});

it("CSV normalization refuses tampered raw files before proposing a canonical payload", async () => {
  await withProof(async ({ client, store, root }) => {
    const { input, context } = await normalizationFixture();
    await store.publishSourceStats(input); await store.publish("tamper-normalization-context", context, "2026-10-11T00:00:00.000Z");
    await writeFile(join(root, ".db-blobs", input.artifact.sha256 + ".csv"), input.artifact.bytes.replace('"80"', '"81"'), { mode: 0o600 });
    await expect(store.planSourceStatsNormalization(replayRequest(await captureTime(client, input.captureId)))).rejects.toThrow("artifact-integrity-failed");
  });
});

it("CSV normalization scoped reads retain schedule alias conflicts outside the mapped canonical game", async () => {
  await withProof(async ({ client, store }) => {
    const { input, context, bridgeRows } = await normalizationFixture();
    await store.publishSourceStats(input); await store.publish("alias-normalization-context", context, "2026-10-11T00:00:00.000Z");
    const request = replayRequest(await captureTime(client, input.captureId));
    expect((await store.planSourceStatsNormalization(request)).status).toBe("planned-source-normalization");
    const other = "normalization-schedule-rival";
    const rival = { formatVersion: 2 as const, profiles: [profile(other)], rightsDecisions: [rights(other)],
      artifacts: [], captures: [], decisions: [], labels: [], identityLinks: [] };
    const schedule = bridgeRows.find((row) => row.kind === "schedule")!;
    addCapture(rival, "schedule-rival", [revision("rival-schedule", "schedule", { ...schedule.data, gameId: gameId(77) })],
      "2026-10-09T12:00:00.000Z", other);
    await store.publish("schedule-rival", rival, "2026-10-11T00:00:00.000Z");
    const conflict = await store.planSourceStatsNormalization(request);
    expect(conflict).toMatchObject({ reason: "normalization-schedule-ambiguous", candidate: null });
    expect(conflict.binding.dependencies.filter((row) => row.role === "schedule").map((row) => row.observationId).sort())
      .toEqual(["game-schedule", "rival-schedule"]);
  });
});

const seedBinding = async (store: Store, feed: "player" | "team" = "player") => {
  const fixture = await normalizationFixture(feed);
  if (feed === "team") {
    fixture.context.identityLinks = [];
    rewriteNormalizationRows(fixture.context, fixture.bridgeRows.filter((row) => row.kind !== "player-bridge"));
  }
  await store.publishSourceStats(fixture.input);
  await store.publish("source-binding-context", fixture.context, "2026-10-11T00:00:00.000Z");
  return { ...fixture, request: { profileId: fixture.input.profile.id, rawGameId: sourceGameId, rawTeam: "PHI", rawPlayerId: feed === "player" ? "00-0000001" : null } };
};
const rehashPlan = (plan: Awaited<ReturnType<Store["planSourceStatsNormalization"]>>) => {
  plan.dataDigest = plan.candidate ? digest(canonical(plan.candidate)) : null;
  plan.planDigest = digest(canonical({ reason: plan.reason, candidate: plan.candidate, binding: plan.binding }));
  return plan;
};

it("CSV binding recorder uses database time and execute-only writes while replay remains read-only research staging", async () => {
  await withProof(async ({ client, store, artifacts, target }) => {
    const { request } = await seedBinding(store);
    await withLogin(client, target, ["predictive_recorder", "predictive_replay", "predictive_harness"], async (writer, writerTarget) => {
      const restricted = await createLocalPredictiveStore(writer, writerTarget, artifacts);
      const before = Date.now(); const a = await restricted.recordSourceNormalization("bound-A", request, null); const after = Date.now();
      expect(Date.parse(a.event.recordedAt)).toBeGreaterThanOrEqual(before);
      expect(Date.parse(a.event.recordedAt)).toBeLessThanOrEqual(after);
      expect(a.event.plan.binding.cutoff <= a.event.recordedAt).toBe(true);
      expect(a).toMatchObject({ reused: false, observationsPublished: false, featuresPublished: false, labelsFinalized: false });
      for (const table of ["predictive_source_bindings", "predictive_source_stats_revisions", "predictive_source_binding_rows"])
        await expect(writer.query(`INSERT INTO ${table} DEFAULT VALUES`)).rejects.toMatchObject({ code: "42501" });
      expect(await restricted.recordSourceNormalization("bound-A", request, null)).toEqual({ ...a, reused: true });
      await withLogin(client, target, ["predictive_replay"], async (reader, readerTarget) => {
        const tracked = { query: async (sql: string, params?: unknown[]) => {
          if (sql.includes("FROM public.predictive_source_bindings b LEFT JOIN"))
            expect((await reader.query("SELECT current_setting('transaction_read_only') AS ro,current_setting('transaction_isolation') AS isolation")).rows[0])
              .toEqual({ ro: "on", isolation: "repeatable read" });
          return reader.query(sql, params);
        } } as unknown as Client;
        const replay = await createLocalPredictiveStore(tracked, readerTarget, artifacts);
        expect(await replay.replaySourceNormalization({ ...request, cutoff: a.event.recordedAt })).toMatchObject({ status: "observed-source-normalization",
          head: { id: "bound-A", revision: { data: { passingYards: 80, playerId: "00-0000001" } } }, observationsPublished: false });
        expect(await replay.replaySourceNormalization({ ...request, cutoff: new Date(Date.parse(a.event.recordedAt) - 1).toISOString() }))
          .toMatchObject({ reason: "source-binding-missing", head: null });
        await expect(reader.query("SELECT predictive_record_source_binding('denied',NULL,'{}')")).rejects.toMatchObject({ code: "42501" });
      });
    });
    expect((await client.query("SELECT count(*)::integer AS n FROM predictive_observations WHERE kind IN ('player-game-stats','team-game-stats')")).rows[0].n).toBe(0);
    expect((await client.query("SELECT count(*)::integer AS n FROM predictive_feature_runs")).rows[0].n).toBe(0);
    expect((await client.query("SELECT count(*)::integer AS n FROM predictive_outcome_labels")).rows[0].n).toBe(0);
  });
});

it("CSV bindings preserve numeric corrections, unchanged recaptures and player A to B to A canonical chains", async () => {
  await withProof(async ({ client, store }) => {
    const { request, input } = await seedBinding(store);
    const a = await store.recordSourceNormalization("bound-A", request, null);
    const atA = await store.replaySourceNormalization({ ...request, cutoff: a.event.recordedAt });
    const next = sourceClaimFixture("numeric-B", "player", sourceCsv("player", [{ ...sourceSamples().player[0], passing_yards: "95" }]));
    next.capturedAt = a.event.recordedAt; await store.publishSourceStats(next);
    const b = await store.recordSourceNormalization("bound-B", request, "bound-A");
    expect(b.event.revision).toMatchObject({ predecessorId: a.event.revision!.id, data: { passingYards: 95 } });
    expect(await store.replaySourceNormalization({ ...request, cutoff: a.event.recordedAt })).toEqual(atA);
    const same = sourceClaimFixture("same-C", "player", next.artifact.bytes); same.capturedAt = b.event.recordedAt;
    await store.publishSourceStats(same); const c = await store.recordSourceNormalization("bound-C", request, "bound-B");
    expect(c.event.revision).toEqual(b.event.revision);
    const correctPlayer = async (id: string, playerId: string, predecessor: string, time: string) => {
      await client.query("SELECT pg_sleep(0.005)");
      time = new Date().toISOString();
      const context = { formatVersion: 2 as const, profiles: [profile(BRIDGE_PROFILE)], rightsDecisions: [], artifacts: [], captures: [], decisions: [], labels: [], identityLinks: [] };
      addCapture(context, id, [revision(id, "player-bridge", { provider: "gsis", rawPlayerId: "00-0000001", playerId,
        effectiveFrom: "2026-01-01T00:00:00.000Z", effectiveTo: "2027-01-01T00:00:00.000Z" }, predecessor)], time, BRIDGE_PROFILE);
      await store.publish(id, context, time);
    };
    await correctPlayer("player-B", "00-0000002", "player-map", c.event.recordedAt);
    const routedB = await store.recordSourceNormalization("bound-player-B", request, "bound-C");
    expect(routedB.event.revision).toMatchObject({ predecessorId: null, data: { playerId: "00-0000002", passingYards: 95 } });
    await correctPlayer("player-A-again", "00-0000001", "player-B", routedB.event.recordedAt);
    const routedA = await store.recordSourceNormalization("bound-player-A", request, "bound-player-B");
    expect(routedA.event.revision).toEqual(b.event.revision);
    expect((await store.replaySourceNormalization({ ...request, cutoff: routedB.event.recordedAt })).head?.revision?.data)
      .toMatchObject({ playerId: "00-0000002" });
    expect((await store.replaySourceNormalization({ ...request, cutoff: routedA.event.recordedAt })).head?.revision?.data)
      .toMatchObject({ playerId: "00-0000001" });
    expect((await client.query("SELECT count(*)::integer AS n FROM predictive_source_stats_revisions")).rows[0].n).toBe(3);
    expect(input.profile.id).toBe(request.profileId);
  });
});

it("CSV bindings withhold disappearing, refused and conflicting raw rows and allow evidenced reappearance", async () => {
  await withProof(async ({ store }) => {
    const { request } = await seedBinding(store);
    const a = await store.recordSourceNormalization("visible", request, null);
    const other = { ...sourceSamples().player[0], player_id: "00-0000002" };
    const missing = sourceClaimFixture("missing", "player", sourceCsv("player", [other])); missing.capturedAt = a.event.recordedAt;
    await store.publishSourceStats(missing); const b = await store.recordSourceNormalization("withheld", request, "visible");
    expect(b.event).toMatchObject({ revision: null, plan: { reason: "source-row-missing", candidate: null } });
    expect(await store.replaySourceNormalization({ ...request, cutoff: b.event.recordedAt })).toMatchObject({ reason: "source-row-missing", head: null });
    const refused = sourceClaimFixture("refused", "player", sourceCsv("player", [{ ...sourceSamples().player[0], attempts: "bad" }])); refused.capturedAt = b.event.recordedAt;
    await store.publishSourceStats(refused); const r = await store.recordSourceNormalization("refused-binding", request, "withheld");
    expect(r.event.plan.reason).toBe("source-row-refused"); expect(r.event.revision).toBeNull();
    const ambiguous = sourceClaimFixture("ambiguous", "player", sourceCsv("player", [sourceSamples().player[0], { ...sourceSamples().player[0], passing_yards: "81" }])); ambiguous.capturedAt = r.event.recordedAt;
    await store.publishSourceStats(ambiguous); const conflict = await store.recordSourceNormalization("conflict-binding", request, "refused-binding");
    expect(conflict.event.plan.reason).toBe("source-row-ambiguous"); expect(conflict.event.revision).toBeNull();
    const again = sourceClaimFixture("again"); again.capturedAt = conflict.event.recordedAt; await store.publishSourceStats(again);
    const c = await store.recordSourceNormalization("reappearance", request, "conflict-binding");
    expect(c.event.revision).toEqual(a.event.revision);
    expect((await store.replaySourceNormalization({ ...request, cutoff: a.event.recordedAt })).head?.revision).toEqual(a.event.revision);
  });
});

it("CSV binding SQL rejects rehashed payload, row, dependency and raw identity forgeries and malformed plans", async () => {
  await withProof(async ({ client, store }) => {
    const { input } = await seedBinding(store);
    const plan = await store.planSourceStatsNormalization(replayRequest(await captureTime(client, input.captureId)));
    const alterations = [
      (copy: typeof plan) => { if (copy.candidate) copy.candidate.data.passingYards = 999; },
      (copy: typeof plan) => { copy.binding.sourceRows[0].selectedSha256 = "f".repeat(64); },
      (copy: typeof plan) => { copy.binding.dependencies.pop(); },
      (copy: typeof plan) => { copy.binding.sourceRequest.rawPlayerId = "00-0000002"; },
      (copy: typeof plan) => { copy.binding.sourceRequest.rawGameId = "2026_00_CAR_PHI"; },
      (copy: typeof plan) => { copy.binding.sourceRequest.rawTeam = "BUF"; },
      (copy: typeof plan) => { Object.assign(copy, { extra: "unreviewed-data" }); },
      (copy: typeof plan) => { Object.assign(copy.binding, { extra: "unreviewed-data" }); },
      (copy: typeof plan) => { Object.assign(copy.binding, { dependencies: null }); },
      (copy: typeof plan) => { Object.assign(copy.binding.sourceRequest, { rawPlayerId: null }); },
      (copy: typeof plan) => { copy.binding.identityLinks = []; },
      (copy: typeof plan) => { copy.binding.rightsDecisionIds = []; },
    ];
    for (const change of alterations) await probe(client, async () => {
      const copy = structuredClone(plan); change(copy); rehashPlan(copy);
      await expect(client.query("SELECT predictive_record_source_binding('forged',NULL,$1)", [JSON.stringify(copy)])).rejects.toMatchObject({ code: "23514" });
    });
    expect((await client.query("SELECT count(*)::integer AS n FROM predictive_source_bindings")).rows[0].n).toBe(0);
    expect((await client.query("SELECT count(*)::integer AS n FROM predictive_source_stats_revisions")).rows[0].n).toBe(0);
  });
});

it("CSV binding stale source or bridge evidence withholds replay and SQL refuses stale heads and proposals", async () => {
  await withProof(async ({ client, store }) => {
    const { request, bridgeRows } = await seedBinding(store);
    const a = await store.recordSourceNormalization("bound-A", request, null);
    const old = await store.replaySourceNormalization({ ...request, cutoff: a.event.recordedAt });
    const next = sourceClaimFixture("raw-change", "player", sourceCsv("player", [{ ...sourceSamples().player[0], passing_yards: "91" }])); next.capturedAt = a.event.recordedAt;
    await store.publishSourceStats(next); const atB = await captureTime(client, next.captureId);
    expect(await store.replaySourceNormalization({ ...request, cutoff: atB })).toMatchObject({ reason: "source-binding-stale", head: null });
    await probe(client, async () => {
      await expect(client.query("SELECT predictive_record_source_binding('stale','bound-A',$1)", [JSON.stringify(a.event.plan)])).rejects.toThrow("predictive-source-plan-stale");
    });
    await expect(store.recordSourceNormalization("bad-head", request, null)).rejects.toThrow("predictive-source-binding-head-conflict");
    const b = await store.recordSourceNormalization("bound-B", request, "bound-A");
    const correction = { formatVersion: 2 as const, profiles: [profile(BRIDGE_PROFILE)], rightsDecisions: [], artifacts: [], captures: [], decisions: [], labels: [], identityLinks: [] };
    addCapture(correction, "changed-schedule", [revision("changed-schedule", "schedule", {
      ...bridgeRows.find((row) => row.kind === "schedule")!.data, kickoff: "2026-10-18T18:00:00.000Z" }, "game-schedule")], b.event.recordedAt, BRIDGE_PROFILE);
    await store.publish("changed-schedule", correction, b.event.recordedAt);
    const clock = (await client.query("SELECT predictive_source_time(clock_timestamp()) AS now")).rows[0].now;
    expect(await store.replaySourceNormalization({ ...request, cutoff: clock })).toMatchObject({ reason: "source-binding-stale", head: null });
    await probe(client, async () => {
      await expect(client.query("SELECT predictive_record_source_binding('stale-bridge','bound-B',$1)", [JSON.stringify(b.event.plan)])).rejects.toThrow("predictive-source-plan-stale");
    });
    expect(await store.replaySourceNormalization({ ...request, cutoff: a.event.recordedAt })).toEqual(old);
  });
});

it("CSV binding hydration refuses altered associations and source bytes and current rights revocation blocks reads and retries", async () => {
  await withProof(async ({ client, store, root }) => {
    const { request, input } = await seedBinding(store);
    const a = await store.recordSourceNormalization("bound-A", request, null);
    await client.query("ALTER TABLE predictive_source_binding_dependencies DISABLE TRIGGER USER");
    await client.query("DELETE FROM predictive_source_binding_dependencies WHERE binding_id='bound-A' AND role='player-bridge'");
    await expect(store.replaySourceNormalization({ ...request, cutoff: a.event.recordedAt })).rejects.toThrow("stored-source-binding-associations-mismatch");
    const dep = a.event.plan.binding.dependencies.find((row) => row.role === "player-bridge")!;
    await client.query("INSERT INTO predictive_source_binding_dependencies VALUES ($1,$2,$3,$4,$5)", [a.event.id, dep.observationId, dep.role, dep.captureId, dep.artifactId]);
    await client.query("ALTER TABLE predictive_source_binding_dependencies ENABLE TRIGGER USER");
    await writeFile(join(root, ".db-blobs", input.artifact.sha256 + ".csv"), input.artifact.bytes.replace('"80"', '"81"'), { mode: 0o600 });
    await expect(store.replaySourceNormalization({ ...request, cutoff: a.event.recordedAt })).rejects.toThrow("artifact-integrity-failed");
    await writeFile(join(root, ".db-blobs", input.artifact.sha256 + ".csv"), input.artifact.bytes, { mode: 0o600 });
    await client.query("SELECT pg_sleep(0.005)");
    const revokedAt = new Date().toISOString();
    await client.query(`INSERT INTO predictive_rights_decisions(id,profile_id,predecessor_id,allowed_uses,effective_from,effective_to,decided_at,evidence_kind,evidence_reference)
      VALUES ('binding-revoked',$1,$2,'{}',$3,NULL,$3,'synthetic','fixture revocation')`, [BRIDGE_PROFILE, "rights-" + BRIDGE_PROFILE, revokedAt]);
    expect(await store.replaySourceNormalization({ ...request, cutoff: a.event.recordedAt })).toMatchObject({ reason: "rights-not-in-force", head: null });
    await expect(store.recordSourceNormalization("bound-A", request, null)).rejects.toThrow("predictive-source-plan-rights-profile-invalid");
    // Current access refuses before attempting to hydrate revoked bytes.
    await writeFile(join(root, ".db-blobs", input.artifact.sha256 + ".csv"), "damaged", { mode: 0o600 });
    expect(await store.replaySourceNormalization({ ...request, cutoff: a.event.recordedAt })).toMatchObject({ reason: "rights-not-in-force", head: null });
  });
});

it("CSV binding retention removes entire cited raw lineages through execute-only access and preserves unrelated evidence", async () => {
  await withProof(async ({ client, store, artifacts, target }) => {
    const { request, input } = await seedBinding(store);
    const a = await store.recordSourceNormalization("bound-A", request, null);
    const next = sourceClaimFixture("raw-B", "player", sourceCsv("player", [{ ...sourceSamples().player[0], passing_yards: "95" }])); next.capturedAt = a.event.recordedAt;
    await store.publishSourceStats(next); await store.recordSourceNormalization("bound-B", request, "bound-A");
    const team = { input: sourceClaimFixture("unrelated-team", "team") }; await store.publishSourceStats(team.input);
    // Remove only the older raw capture. Its successor's raw file remains, but
    // retaining the whole binding chain prevents old/new canonical fallback.
    await withLogin(client, target, ["predictive_retention_owner"], async (owner, ownerTarget) => {
      const retained = await createLocalPredictiveStore(owner, ownerTarget, artifacts);
      const result = await retained.retain({ id: "bound-retention", reason: "provider-request", authority: "synthetic test", decidedAt: input.capturedAt,
        scope: { kind: "source", profileIds: [input.profile.id], capturedFrom: null, capturedBefore: "2026-10-10T00:00:00.000Z" }, auditLevel: "full" });
      expect(result.removedCounts).toMatchObject({ sourceBindings: 2, sourceStatsRevisions: 2, sourceStatsRows: 1 });
      const tombstones = (await client.query("SELECT target_kind AS kind,target_id AS id FROM predictive_retention_tombstones")).rows;
      expect(result.removedIdsDigest).toBe(retentionIdsDigest(tombstones));
      expect((await retained.retentionEvents())[0].removedCounts).toEqual(result.removedCounts);
    });
    expect((await client.query("SELECT count(*)::integer AS n FROM predictive_source_bindings")).rows[0].n).toBe(0);
    expect((await client.query("SELECT count(*)::integer AS n FROM predictive_source_stats_revisions")).rows[0].n).toBe(0);
    expect((await store.replaySourceStats({ ...request, cutoff: await captureTime(client, next.captureId) })).evidence.rows[0].projection?.values.passingYards).toBe(95);
    expect((await store.replaySourceStats(replayRequest(await captureTime(client, team.input.captureId), false))).status).toBe("observed-source-claim");
    expect(await store.replaySourceNormalization({ ...request, cutoff: await captureTime(client, next.captureId) })).toMatchObject({ reason: "source-binding-missing", head: null });
  });
});

it("CSV binding team statistics persist independently and cutoff-only changes do not mark a binding stale", async () => {
  await withProof(async ({ client, store }) => {
    const { request } = await seedBinding(store, "team");
    const a = await store.recordSourceNormalization("team-binding", request, null);
    expect(a.event.revision).toMatchObject({ kind: "team-game-stats", data: { passingYards: 80, teamId: "nfl:team:PHI" } });
    const clock = (await client.query("SELECT predictive_source_time(clock_timestamp()) AS now")).rows[0].now;
    const replay = await store.replaySourceNormalization({ ...request, cutoff: clock });
    expect(replay.status).toBe("observed-source-normalization");
    expect(sourceNormalizationBasis(replay.currentPlan)).toBe(sourceNormalizationBasis(a.event.plan));
  });
});

it("CSV binding concurrent recorders serialize and exactly one expected-head proposal commits", async () => {
  await withProof(async ({ client, store, artifacts, target }) => {
    const { request } = await seedBinding(store);
    const a = await store.recordSourceNormalization("race-A", request, null);
    await withLogin(client, target, ["predictive_recorder", "predictive_replay", "predictive_harness"], async (one, oneTarget) => {
      await withLogin(client, target, ["predictive_recorder", "predictive_replay", "predictive_harness"], async (two, twoTarget) => {
        const first = await createLocalPredictiveStore(one, oneTarget, artifacts);
        const second = await createLocalPredictiveStore(two, twoTarget, artifacts);
        await client.query("BEGIN"); await client.query("SELECT pg_advisory_xact_lock(520052,1)");
        const pending = [first.recordSourceNormalization("race-B", request, a.event.id), second.recordSourceNormalization("race-C", request, a.event.id)];
        const settled = Promise.allSettled(pending);
        try {
          let blocked = false;
          for (let n = 0; n < 50; n++) {
            const waiting = (await client.query(`SELECT count(*)::integer AS n FROM pg_stat_activity
              WHERE datname=current_database() AND wait_event_type='Lock' AND pid<>pg_backend_pid()`)).rows[0].n;
            if (waiting >= 2) { blocked = true; break; }
            await client.query("SELECT pg_sleep(0.01)");
          }
          expect(blocked).toBe(true);
        } finally { await client.query("COMMIT"); }
        const result = await settled;
        expect(result.filter((row) => row.status === "fulfilled")).toHaveLength(1);
        const failed = result.find((row) => row.status === "rejected");
        expect(failed?.status === "rejected" && failed.reason.message).toBe("predictive-source-binding-head-conflict");
        expect((await client.query("SELECT count(*)::integer AS n FROM predictive_source_bindings")).rows[0].n).toBe(2);
        expect((await client.query("SELECT count(*)::integer AS n FROM predictive_source_stats_revisions")).rows[0].n).toBe(1);
      });
    });
  });
});

it("CSV binding unrecorded bridge conflicts withhold the current raw contribution without poisoning earlier cutoffs", async () => {
  await withProof(async ({ client, store }) => {
    const { request } = await seedBinding(store);
    const a = await store.recordSourceNormalization("before-rival", request, null);
    const before = await store.replaySourceNormalization({ ...request, cutoff: a.event.recordedAt });
    await client.query("SELECT pg_sleep(0.005)"); const later = new Date().toISOString();
    const other = "binding-rival-profile";
    const rival = { formatVersion: 2 as const, profiles: [profile(other)], rightsDecisions: [rights(other, { allowedUses: ["internal-research"] })],
      artifacts: [], captures: [], decisions: [], labels: [], identityLinks: [] };
    addCapture(rival, "binding-rival", [revision("binding-rival-player", "player-bridge", { provider: "gsis", rawPlayerId: "00-0000002",
      playerId: "00-0000001", effectiveFrom: "2026-01-01T00:00:00.000Z", effectiveTo: "2027-01-01T00:00:00.000Z" })], later, other);
    await store.publish("binding-rival-run", rival, later);
    const stale = await store.replaySourceNormalization({ ...request, cutoff: later });
    expect(stale).toMatchObject({ reason: "source-binding-stale", head: null, currentPlan: { reason: "player-bridge-conflict", candidate: null } });
    expect(await store.replaySourceNormalization({ ...request, cutoff: a.event.recordedAt })).toEqual(before);
    await probe(client, async () => {
      await expect(client.query("SELECT predictive_record_source_binding('rival-stale','before-rival',$1)", [JSON.stringify(a.event.plan)])).rejects.toThrow();
    });
  });
});

it("CSV binding bridge retention removes ancestors and descendants and identical restored evidence re-applies its audit", async () => {
  const fixture = await normalizationFixture();
  let history: RecordedRetentionEvent[] = [];
  const publishChain = async (store: Store) => {
    await store.publishSourceStats(fixture.input); await store.publish("bridge-retention-context", fixture.context, "2026-10-11T00:00:00.000Z");
    const request = { profileId: fixture.input.profile.id, rawGameId: sourceGameId, rawTeam: "PHI", rawPlayerId: "00-0000001" };
    await store.recordSourceNormalization("bridge-retention-A", request, null);
    await store.recordSourceNormalization("bridge-retention-B", request, "bridge-retention-A");
    return request;
  };
  await withProof(async ({ client, store }) => {
    const request = await publishChain(store);
    await store.retain({ id: "bridge-retention", reason: "provider-request", authority: "synthetic test", decidedAt: fixture.input.capturedAt,
      scope: { kind: "source", profileIds: [BRIDGE_PROFILE], capturedFrom: null, capturedBefore: null }, auditLevel: "digest-only" });
    history = await store.retentionEvents();
    expect(history[0].removedCounts).toMatchObject({ sourceBindings: 2, sourceStatsRevisions: 1 });
    expect((await client.query("SELECT count(*)::integer AS n FROM predictive_source_bindings")).rows[0].n).toBe(0);
    expect((await store.replaySourceStats({ ...request, cutoff: await captureTime(client, fixture.input.captureId) })).status).toBe("observed-source-claim");
  });
  await withProof(async ({ store }) => {
    await publishChain(store);
    expect(await store.reapply(history)).toEqual([{ eventId: "bridge-retention", status: "reapplied", matched: true }]);
    expect(await store.reapply(history)).toEqual([{ eventId: "bridge-retention", status: "present", matched: true }]);
  });
});

it("CSV binding migration upgrades v4 without changing released history and reruns are no-ops", async () => {
  await withProof(async ({ client, target, store }) => {
    const input = sourceClaimFixture("before-v5"); await store.publishSourceStats(input);
    const ledger = (await client.query("SELECT * FROM db_migrations ORDER BY version")).rows;
    const raw = (await client.query("SELECT * FROM predictive_source_stats_rows ORDER BY id")).rows;
    const files = await checkMigrationArtifacts(); const contracts = await loadCatalogContracts(files);
    await runScratchMigrations(client, { ...target, files, verify: createCatalogVerifier(contracts) });
    const upgraded = (await client.query("SELECT * FROM db_migrations ORDER BY version")).rows;
    expect(upgraded.slice(0, 4)).toEqual(ledger); expect(upgraded).toHaveLength(5);
    expect((await client.query("SELECT * FROM predictive_source_stats_rows ORDER BY id")).rows).toEqual(raw);
    await runScratchMigrations(client, { ...target, files, verify: createCatalogVerifier(contracts) });
    expect((await client.query("SELECT * FROM db_migrations ORDER BY version")).rows).toEqual(upgraded);
  }, 4);
});

it("CSV binding canonical guard refuses generated JSON under real source profiles and immutable bindings cannot be rewritten", async () => {
  await withProof(async ({ client, store }) => {
    const { request, input } = await seedBinding(store);
    const a = await store.recordSourceNormalization("immutable-binding", request, null);
    for (const sql of ["UPDATE predictive_source_bindings SET plan=plan", "DELETE FROM predictive_source_bindings",
      "TRUNCATE predictive_source_bindings CASCADE", "UPDATE predictive_source_stats_revisions SET data=data"])
      await probe(client, async () => { await expect(client.query(sql)).rejects.toThrow("predictive-append-only"); });
    const sourceProfile = { ...input.profile, id: "wrapped-real-csv-profile", purpose: "source" as const, license: "fixture qualification only" };
    const right = { ...input.rightsDecisions[0], id: "rights-wrapped-profile", profileId: sourceProfile.id,
      evidenceKind: "terms-review" as const, evidenceReference: "synthetic negative test, no provider qualification" };
    const wrapped = { formatVersion: 2 as const, profiles: [sourceProfile], rightsDecisions: [right], artifacts: [], captures: [], decisions: [], labels: [], identityLinks: [] };
    if (a.event.revision?.kind !== "player-game-stats") throw new Error("fixture-player-statistics-missing");
    addCapture(wrapped, "generated-json", [revision("generated-json-stats", "player-game-stats", a.event.revision.data)],
      "2026-10-09T12:00:00.000Z", sourceProfile.id);
    await expect(store.publish("generated-json-run", wrapped, "2026-10-11T00:00:00.000Z")).rejects.toThrow("predictive-source-canonical-binding-required");
    expect((await client.query("SELECT count(*)::integer AS n FROM predictive_source_bindings")).rows[0].n).toBe(1);
    expect((await client.query("SELECT count(*)::integer AS n FROM predictive_observations WHERE kind='player-game-stats'")).rows[0].n).toBe(0);
  });
});
