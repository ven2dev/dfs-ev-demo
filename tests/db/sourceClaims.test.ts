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
import { prepareSourceClaims, projectSourceClaim } from "../../src/lib/predictive/sourceClaims.ts";
import { sourceClaimFixture } from "../predictive/fixtures/sourceClaims.ts";
import { sourceCsv, sourceGameId, sourceSamples } from "../predictive/fixtures/source.ts";
import { passingYardsFixture } from "../predictive/fixtures/passingYards.ts";
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
    for (const sql of ["UPDATE predictive_source_stats_rows SET selected_sha256=repeat('0',64)", "DELETE FROM predictive_source_stats_rows", "TRUNCATE predictive_source_stats_rows"]) {
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
    expect(await runScratchMigrations(client, options)).toMatchObject({ executed: [4], schemaVersion: 4 });
    expect((await client.query("SELECT * FROM db_migrations ORDER BY version")).rows.slice(0, 3)).toEqual(ledger);
    expect((await client.query("SELECT * FROM predictive_observations ORDER BY id")).rows).toEqual(evidence);
    expect(await runScratchMigrations(client, options)).toMatchObject({ executed: [], schemaVersion: 4 });
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
