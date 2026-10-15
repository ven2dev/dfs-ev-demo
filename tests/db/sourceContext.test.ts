import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { expect, it } from "vitest";
import { createScratchHarness } from "./scratch.mjs";
import { checkMigrationArtifacts } from "../../scripts/db-migrations/files.mjs";
import { loadCatalogContracts, createCatalogVerifier } from "../../scripts/db-migrations/contracts.mjs";
import { runScratchMigrations } from "../../scripts/db-migrations/core.mjs";
import { ensurePredictiveRoles } from "../../scripts/predictive/harness.ts";
import { openArtifactStore } from "../../src/lib/predictive/artifacts.ts";
import { createLocalPredictiveStore } from "../../src/lib/predictive/persistence.ts";
import { prepareSourceContextPublication, SOURCE_CONTEXT_PROFILE_VERSION, type SourceContextPublication } from "../../src/lib/predictive/sourceContextPublication.ts";
import { SOURCE_HEADERS } from "../../src/lib/predictive/sourceHeaders.ts";
import { canonical, digest } from "../../src/lib/predictive/validation.ts";
import { sourceClaimFixture } from "../predictive/fixtures/sourceClaims.ts";
import { sourceCsv, sourceSamples } from "../predictive/fixtures/source.ts";

const fixture = (feed: "schedule" | "identifiers", many = false): SourceContextPublication => {
  const base = sourceClaimFixture("context:" + feed), bytes = sourceCsv(feed, feed === "schedule" ? sourceSamples().schedule :
    Array.from({ length: many ? 8193 : 1 }, (_, i) => ({ gsis_id: "00-" + String(i + 1).padStart(7, "0"), position: "QB", espn_id: String(i + 100) })));
  const tag = feed === "schedule" ? "schedules" : "players", name = feed === "schedule" ? "games.csv" : "players.csv";
  return { ...base, rightsDecisions: base.rightsDecisions.map(r => ({ ...r, evidenceKind: "terms-review", evidenceReference: "fixture-only-context-terms" })),
    profile: { ...base.profile, id: "context-profile-" + feed, purpose: "source", feed, releaseTag: tag, assetPattern: name,
      parserVersion: SOURCE_CONTEXT_PROFILE_VERSION, headerProfileSha256: digest(canonical(SOURCE_HEADERS[feed])),
      evidenceKinds: feed === "schedule" ? ["schedule", "game-bridge", "team-alias"] : ["player-bridge"] },
    artifact: { ...base.artifact, profileId: "context-profile-" + feed, bytes, sha256: digest(bytes), origin: `https://github.com/nflverse/nflverse-data/releases/download/${tag}/${name}`,
      scopeKind: "all-seasons", scopeSeason: null }, seasonRange: feed === "schedule" ? { fromSeason: 2024, throughSeason: 2026 } : null };
};
type Target = { expected: object; assertTarget: (config: object) => void };
const proof = async (work: (admin: Client, target: Target, artifacts: Awaited<ReturnType<typeof openArtifactStore>>, root: string) => Promise<void>, installPrototype = true) => {
  const harness = await createScratchHarness(process.env), root = await realpath(await mkdtemp(join(tmpdir(), "dfs106-context-db-")));
  try {
    const files = await checkMigrationArtifacts(), contracts = await loadCatalogContracts(files);
    await harness.withDatabase(async (admin: Client, expected: object) => {
      const target = { expected, assertTarget: harness.assertTarget };
      await ensurePredictiveRoles(admin);
      await runScratchMigrations(admin, { ...target, files, verify: createCatalogVerifier(contracts) });
      if (installPrototype) await admin.query(await readFile(new URL("../../db/prototypes/0021_original_context.sql", import.meta.url), "utf8"));
      await work(admin, target, await openArtifactStore(root, 8_000_000), root);
    });
  } finally { try { await harness.close(); } finally { await rm(root, { recursive: true, force: true }); } }
};
const login = async (admin: Client, target: Target, roles: string[], work: (client: Client, target: Target) => Promise<void>) => {
  const name = "dfs106_context_" + randomBytes(8).toString("hex");
  await admin.query(`CREATE ROLE ${name} LOGIN NOSUPERUSER PASSWORD 'disposable-context-test'`);
  await admin.query(`GRANT ${roles.join(",")} TO ${name}`);
  const expected = { ...target.expected, user: name, password: "disposable-context-test" }, client = new Client(expected);
  try { await client.connect(); await work(client, { expected, assertTarget: value => { expect(value).toEqual(expected); target.assertTarget(target.expected); } }); }
  finally { await client.end(); await admin.query(`DROP OWNED BY ${name}`); await admin.query(`DROP ROLE ${name}`); }
};
const input = (feed: "schedule" | "identifiers", many = false) => {
  const value = fixture(feed, many);
  value.rightsDecisions = value.rightsDecisions.map(r => ({ ...r, id: "context-rights:" + feed, profileId: value.profile.id }));
  return value;
};
it("context prototype records both original feeds through restricted roles and replays complete immutable claims", async () => {
  await proof(async (admin, target, artifacts) => {
    await login(admin, target, ["predictive_ingest", "predictive_replay"], async (client, local) => {
      const store = await createLocalPredictiveStore(client, local, artifacts);
      for (const feed of ["schedule", "identifiers"] as const) {
        const seed = input(feed), before = (await admin.query(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS t`)).rows[0].t as string;
        expect(await store.publishSourceContext(seed)).toMatchObject({ status: "published", reused: false });
        const replay = await store.replaySourceContext(seed.captureId);
        expect(replay!.ingestedAt >= before).toBe(true);
        expect(replay!.prepared.rows).toHaveLength(1);
        expect(replay!.canonicalEvidencePublished).toBe(false);
        const hashes = (await admin.query("SELECT predictive_context_claims_digest($1::jsonb) AS fast,predictive_source_digest($1::jsonb) AS reference",
          [JSON.stringify(replay!.prepared.rows)])).rows[0];
        expect(hashes.fast).toBe(hashes.reference);
        expect(hashes.fast).toBe(replay!.prepared.claimsSha256);
        expect((await store.publishSourceContext(seed)).reused).toBe(true);
        await expect(client.query("SELECT * FROM predictive_context_captures")).rejects.toMatchObject({ code: "42501" });
      }
    });
    expect((await admin.query("SELECT count(*)::integer AS n FROM predictive_observations")).rows[0].n).toBe(0);
    await login(admin, target, ["predictive_replay"], async (client, local) => {
      const reader = await createLocalPredictiveStore(client, local, artifacts);
      expect((await reader.replaySourceContext(input("schedule").captureId))!.prepared.rows[0].projection).toMatchObject({ kickoff: "2026-10-18T17:00:00.000Z" });
      await expect(client.query("SELECT predictive_context_guard()")).rejects.toMatchObject({ code: "42501" });
    });
  });
});
it("context prototype preserves 8193 rows without widening legacy numerical limits", async () => {
  await proof(async (admin, target, artifacts) => {
    const store = await createLocalPredictiveStore(admin, target, artifacts), seed = input("identifiers", true);
    await store.publishSourceContext(seed);
    const replay = await store.replaySourceContext(seed.captureId);
    expect(replay!.prepared.rows).toHaveLength(8193);
    expect(replay!.prepared.rows.at(-1)!.rowOrdinal).toBe(8193);
    await admin.query("BEGIN");
    try {
      await expect(admin.query(`INSERT INTO predictive_ingestion_runs SELECT (jsonb_populate_record(NULL::predictive_ingestion_runs,
        to_jsonb(r)||'{"id":"legacy-oversized-context-copy","code_version":"nflverse-csv-source-claims-v1"}'::jsonb)).*
        FROM predictive_ingestion_runs r WHERE id=$1`, [seed.id])).rejects.toMatchObject({ code: "23514" });
    } finally { await admin.query("ROLLBACK"); }
  });
}, 60_000);
it("context prototype refuses forged SQL rows and requires a seal before a capture can commit", async () => {
  await proof(async (admin, target, artifacts) => {
    const store = await createLocalPredictiveStore(admin, target, artifacts), seed = input("schedule");
    await store.publishSourceContext(seed);
    const prepared = await prepareSourceContextPublication(seed, new Date().toISOString());
    await admin.query("BEGIN");
    try {
      await admin.query("SELECT predictive_context_guard()");
      await admin.query("SELECT pg_advisory_lock(520054,$1)", [Number.parseInt(seed.artifact.sha256.slice(0, 8), 16) | 0]);
      const forged = structuredClone(prepared.prepared.rows);
      forged[0].rowOrdinal = 2;
      await expect(admin.query("SELECT predictive_record_context_capture($1,$2,$3)", [seed.captureId, JSON.stringify(seed.seasonRange), JSON.stringify(forged)])).rejects.toThrow("context-row-refused");
    } finally { await admin.query("ROLLBACK"); await admin.query("SELECT pg_advisory_unlock(520054,$1)", [Number.parseInt(seed.artifact.sha256.slice(0, 8), 16) | 0]); }
    await admin.query("BEGIN");
    try {
      await admin.query("SELECT predictive_context_guard()");
      await admin.query("SELECT pg_advisory_lock(520054,$1)", [Number.parseInt(seed.artifact.sha256.slice(0, 8), 16) | 0]);
      const forged = structuredClone(prepared.prepared.rows);
      if (forged[0].projection?.kind !== "raw-schedule") throw new Error("schedule-fixture-required");
      forged[0].projection.kickoff = "2026-10-18T18:00:00.000Z";
      await expect(admin.query("SELECT predictive_record_context_capture($1,$2,$3)", [seed.captureId, JSON.stringify(seed.seasonRange), JSON.stringify(forged)])).rejects.toThrow("context-kickoff-refused");
    } finally { await admin.query("ROLLBACK"); await admin.query("SELECT pg_advisory_unlock(520054,$1)", [Number.parseInt(seed.artifact.sha256.slice(0, 8), 16) | 0]); }
    await admin.query("BEGIN");
    try {
      await admin.query(`INSERT INTO predictive_captures SELECT 'context-without-seal',run_id,artifact_id,captured_at,available_at,ingested_at,published_at,publication_evidence,
        state,body_complete,header_verified,parser_succeeded,parsed_rows FROM predictive_captures WHERE id=$1`, [seed.captureId]);
      await expect(admin.query("COMMIT")).rejects.toThrow("context-seal-required");
    } finally { await admin.query("ROLLBACK"); }
  });
});
it("context prototype verifies original bytes and refuses current revoked rights before opening files", async () => {
  await proof(async (admin, target, artifacts, root) => {
    const store = await createLocalPredictiveStore(admin, target, artifacts), seed = input("schedule");
    await store.publishSourceContext(seed);
    const path = join(root, ".db-blobs", seed.artifact.sha256 + ".csv");
    await writeFile(path, Buffer.alloc(Buffer.byteLength(seed.artifact.bytes)));
    await expect(store.replaySourceContext(seed.captureId)).rejects.toThrow("artifact-integrity-failed");
    await writeFile(path, seed.artifact.bytes);
    expect(await store.replaySourceContext(seed.captureId)).not.toBeNull();
    const original = (await admin.query("SELECT claims,claims_sha256 FROM predictive_context_captures WHERE capture_id=$1", [seed.captureId])).rows[0];
    await admin.query("ALTER TABLE predictive_context_captures DISABLE TRIGGER USER");
    try {
      await admin.query(`UPDATE predictive_context_captures SET claims=jsonb_set(claims,'{0,projection,kickoff}','"2026-10-18T18:00:00.000Z"'),
        claims_sha256=predictive_source_digest(jsonb_set(claims,'{0,projection,kickoff}','"2026-10-18T18:00:00.000Z"')) WHERE capture_id=$1`, [seed.captureId]);
      await expect(store.replaySourceContext(seed.captureId)).rejects.toThrow("context-replay-integrity-failed");
    } finally {
      await admin.query("UPDATE predictive_context_captures SET claims=$2,claims_sha256=$3 WHERE capture_id=$1", [seed.captureId, JSON.stringify(original.claims), original.claims_sha256]);
      await admin.query("ALTER TABLE predictive_context_captures ENABLE TRIGGER USER");
    }
    const now = (await admin.query(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS t`)).rows[0].t as string;
    await admin.query(`INSERT INTO predictive_rights_decisions VALUES('context-revoked',$1,$2,'{}',$3,NULL,$3,'revocation','fixture-only revocation')`,
      [seed.profile.id, seed.rightsDecisions[0].id, now]);
    let reads = 0;
    const tracked = await createLocalPredictiveStore(admin, target, { ...artifacts, database: { ...artifacts.database, read: async (...args) => { reads++; return artifacts.database.read(...args); } } });
    await expect(tracked.replaySourceContext(seed.captureId)).rejects.toThrow("compressed-publication-rights-refused");
    expect(reads).toBe(0);
  });
});
it("context prototype refuses native canonical associations instead of treating raw captures as native JSON evidence", async () => {
  await proof(async (admin, target, artifacts) => {
    const store = await createLocalPredictiveStore(admin, target, artifacts), seed = input("schedule");
    await store.publishSourceContext(seed);
    const game = "00000000-0000-4000-8000-000000000001";
    const data = { gameId: game, rawGameId: "2026_06_CAR_PHI", season: 2026, seasonType: "REG", week: 6,
      kickoff: "2026-10-18T17:00:00.000Z", rawGameday: "2026-10-18", rawGametime: "13:00",
      homeTeamId: "nfl:team:PHI", awayTeamId: "nfl:team:CAR", rawHomeTeam: "PHI", rawAwayTeam: "CAR", rawRoof: null, rawSurface: null, rawStadiumId: null };
    await admin.query("BEGIN");
    try {
      await admin.query("INSERT INTO predictive_games VALUES($1)", [game]);
      await admin.query(`INSERT INTO predictive_observations(id,kind,profile_id,data,entity_key,source_key)
        SELECT 'context-native-bypass','schedule',$1,$2::jsonb,predictive_entity_key('schedule',$2::jsonb),
        predictive_entity_key('schedule',$2::jsonb)||'|'||$1||'|'`, [seed.profile.id, data]);
      await expect(admin.query("INSERT INTO predictive_artifact_observations VALUES($1,'context-native-bypass')", [seed.artifact.id])).rejects.toThrow("context-canonical-association-not-qualified");
    } finally { await admin.query("ROLLBACK"); }
    expect((await admin.query("SELECT count(*)::integer AS n FROM predictive_observations")).rows[0].n).toBe(0);
  });
});
it("context prototype commit-time rights refusal rolls back capture seals and files and permits clean recovery", async () => {
  await proof(async (admin, target, artifacts) => {
    const store = await createLocalPredictiveStore(admin, target, artifacts), seed = input("schedule");
    const definition = (await admin.query("SELECT pg_get_functiondef('public.predictive_context_capture_check()'::regprocedure) AS body")).rows[0].body as string;
    const needle = "PERFORM public.predictive_compressed_source_access(p,NEW.captured_at);";
    expect(definition.split(needle)).toHaveLength(2);
    await admin.query(definition.replace(needle, "PERFORM pg_sleep(1.1); " + needle));
    seed.rightsDecisions[0].effectiveTo = (await admin.query(`SELECT to_char((clock_timestamp()+interval '1 second') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS t`)).rows[0].t;
    await expect(store.publishSourceContext(seed)).rejects.toThrow("compressed-publication-rights-refused");
    expect((await admin.query("SELECT count(*)::integer AS n FROM predictive_context_captures")).rows[0].n).toBe(0);
    expect((await admin.query("SELECT count(*)::integer AS n FROM predictive_captures")).rows[0].n).toBe(0);
    expect((await admin.query("SELECT count(*)::integer AS n FROM predictive_ingestion_runs")).rows[0].n).toBe(0);
    await expect(artifacts.database.read(seed.artifact.sha256 + ".csv", seed.artifact.sha256, Buffer.byteLength(seed.artifact.bytes))).rejects.toMatchObject({ code: "ENOENT" });
    await admin.query(definition);
    seed.rightsDecisions[0].effectiveTo = null;
    expect((await store.publishSourceContext(seed)).status).toBe("published");
  });
});
it("context recording stays explicitly unavailable on the frozen prefix without scratch DDL", async () => {
  await proof(async (admin, target, artifacts) => {
    const store = await createLocalPredictiveStore(admin, target, artifacts), seed = input("schedule");
    await expect(store.publishSourceContext(seed)).rejects.toThrow("context-recording-not-installed");
    await expect(store.replaySourceContext(seed.captureId)).rejects.toThrow("context-recording-not-installed");
    expect((await admin.query("SELECT count(*)::integer AS n FROM predictive_captures")).rows[0].n).toBe(0);
  }, false);
});
it("context prototype mandatory deletion removes sealed claims and original bytes with supplemental audit", async () => {
  await proof(async (admin, target, artifacts) => {
    const store = await createLocalPredictiveStore(admin, target, artifacts), seed = input("schedule");
    await store.publishSourceContext(seed);
    await login(admin, target, ["predictive_retention_owner"], async (client, local) => {
      const retained = await createLocalPredictiveStore(client, local, artifacts);
      await retained.retain({ id: "context-delete", reason: "provider-request", authority: "fixture-only deletion", decidedAt: seed.capturedAt, auditLevel: "full",
        scope: { kind: "source", profileIds: [seed.profile.id], capturedFrom: null, capturedBefore: null } });
    });
    expect(await store.replaySourceContext(seed.captureId)).toBeNull();
    expect((await admin.query("SELECT removed_rows FROM predictive_context_retention_audits WHERE event_id='context-delete'")).rows).toEqual([{ removed_rows: 1 }]);
    await expect(artifacts.database.read(seed.artifact.sha256 + ".csv", seed.artifact.sha256, Buffer.byteLength(seed.artifact.bytes))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(store.publishSourceContext(seed)).rejects.toThrow("compressed-publication-erased-source");
  });
});
it("context prototype extends the guarded memo dependencies without allowing orphan ingestion runs", async () => {
  await proof(async (admin, target, artifacts) => {
    const store = await createLocalPredictiveStore(admin, target, artifacts), seed = input("schedule");
    await store.publishSourceContext(seed);
    await admin.query("BEGIN");
    try {
      await admin.query("SELECT predictive_training_read_guard()");
      expect((await admin.query("SELECT predictive_training_memo_ready() AS ready")).rows[0].ready).toBe(true);
      await admin.query("SELECT predictive_context_guard()");
      expect((await admin.query("SELECT predictive_training_memo_ready() AS ready")).rows[0].ready).toBe(false);
    } finally { await admin.query("ROLLBACK"); }
    await admin.query("BEGIN");
    try {
      await admin.query(`INSERT INTO predictive_ingestion_runs SELECT (jsonb_populate_record(NULL::predictive_ingestion_runs,
        to_jsonb(r)||'{"id":"context-orphan-run"}'::jsonb)).* FROM predictive_ingestion_runs r WHERE id=$1`, [seed.id]);
      await expect(admin.query("COMMIT")).rejects.toThrow("context-run-seal-required");
    } finally { await admin.query("ROLLBACK"); }
  });
});
it("context prototype canonical hashing preserves escaped strings null projections and exact array order", async () => {
  await proof(async (admin) => {
    const seed = input("identifiers");
    seed.artifact.bytes = sourceCsv("identifiers", [
      { gsis_id: "00-0000001", position: "QB", espn_id: 'quoted"\\slash café 🏈' },
      { gsis_id: "", position: "QB" },
    ]);
    seed.artifact.sha256 = digest(seed.artifact.bytes);
    const prepared = await prepareSourceContextPublication(seed, new Date().toISOString());
    for (const rows of [prepared.prepared.rows, [...prepared.prepared.rows].reverse()]) {
      const hashes = (await admin.query("SELECT predictive_context_claims_digest($1::jsonb) AS fast,predictive_source_digest($1::jsonb) AS reference", [JSON.stringify(rows)])).rows[0];
      expect(hashes.fast).toBe(hashes.reference);
      expect(hashes.fast).toBe(digest(canonical(rows)));
    }
  });
});
