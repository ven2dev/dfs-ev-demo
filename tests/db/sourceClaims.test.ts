import { createHash, randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";
import { mkdtemp, readFile, realpath, rm, utimes, writeFile } from "node:fs/promises";
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
import { inspectCompressedSource } from "../../src/lib/predictive/compressedSource.ts";
import type { Dataset, RecordedRetentionEvent } from "../../src/lib/predictive/types.ts";
import { canonical, digest, entityKey } from "../../src/lib/predictive/validation.ts";
import { createReplay } from "../../src/lib/predictive/replay.ts";
import { reconcileFact } from "../../src/lib/predictive/policies.ts";
import { ROUTING_FIELDS } from "../../src/lib/predictive/types.ts";
import { sourceNormalizationBasis } from "../../src/lib/predictive/persistence.ts";
import { SOURCE_NORMALIZATION_V1 } from "../../src/lib/predictive/sourceNormalization.ts";
import { selectSourceFact, SOURCE_FACT_BOUNDS } from "../../src/lib/predictive/sourceFacts.ts";
import { checkSourceWitness, sourceFactWitness, sourcePostWindowCapture, sourceReconciliationEvidence, sourceUsageEvidence } from "../../src/lib/predictive/sourceWitness.ts";
import { sourceDecisionBasis, type SourceDecisionPlan, type SourceDecisionRequest } from "../../src/lib/predictive/sourceDecisions.ts";
import { sourceConsumerInputDigest, type SourceConsumerBody } from "../../src/lib/predictive/sourceConsumers.ts";
import { fittingRunRequestDigest, normalizeFittingRunRequest, TRAINING_HISTORY_POLICY, TRAINING_HISTORY_SHA256, type FittingRunRequest, type TrainingSlot } from "../../src/lib/predictive/training.ts";
import { checkTrainingMetadataSelection, TRAINING_SELECTION_SQL, trainingSelectionParameters, type TrainingMetadataSelection } from "../../src/lib/predictive/trainingSql.ts";
import { recordCompletion } from "../../src/lib/predictive/completion.ts";
import { prepareSourceClaims, projectSourceClaim } from "../../src/lib/predictive/sourceClaims.ts";
import { sourceClaimFixture } from "../predictive/fixtures/sourceClaims.ts";
import { sourceCsv, sourceGameId, sourceSamples } from "../predictive/fixtures/source.ts";
import { passingYardsFixture } from "../predictive/fixtures/passingYards.ts";
import { addCapture, completionMarkers, coverage, gameId, membership, profile, PROFILE, revision, rights, schedule } from "../predictive/fixtures/passingYards.ts";
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
  if (roles.length) await client.query(`GRANT ${roles.join(",")} TO ${login}`);
  const expected = { ...target.expected, user: login, password: "disposable-csv-test" }; const connection = new Client(expected);
  try {
    await connection.connect();
    expect((await connection.query("SELECT rolsuper FROM pg_roles WHERE rolname=session_user")).rows[0].rolsuper).toBe(false);
    await work(connection, { expected, assertTarget: (config) => { expect(config).toEqual(expected); target.assertTarget(target.expected); } });
  } finally { await connection.end(); await client.query(`DROP OWNED BY ${login}`); await client.query(`DROP ROLE ${login}`); }
};

// Test-only staging: no runtime compressed publisher exists at prefix 0013.
const stageGzip = async (client: Client, artifacts: Artifacts, seed: ReturnType<typeof sourceClaimFixture>, id: string, profileId = seed.profile.id,
  verifiedRows = 0, wireOverride?: Buffer) => {
  const bytes = wireOverride ?? gzipSync(Buffer.from(seed.artifact.bytes));
  const sha = createHash("sha256").update(bytes).digest("hex");
  const ref = await artifacts.database.writeBinary(bytes, sha);
  await client.query("INSERT INTO predictive_blobs VALUES ($1,$2,'application/gzip',$3) ON CONFLICT DO NOTHING", [sha, bytes.length, ref]);
  await client.query(`INSERT INTO predictive_artifacts SELECT (jsonb_populate_record(NULL::predictive_artifacts,
    to_jsonb(a)||jsonb_build_object('id',$1::text,'profile_id',$2::text,'blob_sha256',$3::text))).*
    FROM predictive_artifacts a WHERE id=$4`, [id + ":artifact", profileId, sha, seed.artifact.id]);
  await client.query(`INSERT INTO predictive_captures SELECT (jsonb_populate_record(NULL::predictive_captures,
    to_jsonb(c)||jsonb_build_object('id',$1::text,'artifact_id',$2::text,'ingested_at',c.captured_at,
      'state','incomplete','body_complete',$4::integer>0,'header_verified',$4::integer>0,'parser_succeeded',$4::integer>0,'parsed_rows',$4::integer))).*
    FROM predictive_captures c WHERE id=$3`, [id + ":capture", id + ":artifact", seed.captureId, verifiedRows]);
  return { bytes, sha, ref };
};

const recordGzipProof = async (client: Client, captureId: string, proof: Awaited<ReturnType<typeof inspectCompressedSource>>) => {
  const key = Buffer.from(proof.wireSha256, "hex").readInt32BE(0);
  await client.query("SELECT pg_advisory_lock(520054,$1)", [key]);
  try { return (await client.query("SELECT predictive_record_compressed_inspection($1,$2) AS proof", [captureId, proof])).rows[0].proof; }
  finally { await client.query("SELECT pg_advisory_unlock(520054,$1)", [key]); }
};
const inspectedGzip = async (client: Client, artifacts: Artifacts, seed: ReturnType<typeof sourceClaimFixture>, id: string) => {
  const bytes = gzipSync(Buffer.from(seed.artifact.bytes));
  const proof = await inspectCompressedSource(bytes, { feed: "player", season: 2026, wireSha256: createHash("sha256").update(bytes).digest("hex"), wireBytes: bytes.length });
  const blob = await stageGzip(client, artifacts, seed, id, seed.profile.id, proof.rows);
  await recordGzipProof(client, id + ":capture", proof);
  return { ...blob, proof };
};

it("guarded gzip claims preserve complete ordinals refusals and capture-specific identities", async () => {
  await withProof(async ({ client, store, artifacts, target }) => {
    const sample = sourceSamples().player[0];
    const seed = sourceClaimFixture("claim-seed", "player", sourceCsv("player", [sample,
      {...sample, season:"2025",game_id:"2025_06_CAR_PHI"}, {...sample,player_id:"unknown"}]));
    await store.publishSourceStats(seed);
    const a = await inspectedGzip(client,artifacts,seed,"claims-A");
    await inspectedGzip(client,artifacts,seed,"claims-B");
    let reads=0;
    const tracked={...artifacts,database:{...artifacts.database,readBinary:async(ref:string,sha:string,size:number)=>{
      reads++;return artifacts.database.readBinary(ref,sha,size);
    }}};
    await withLogin(client,target,["predictive_replay"],async(reader,readerTarget)=>{
      const guarded=await createLocalPredictiveStore(reader,readerTarget,tracked);
      const ids=["claims-B:capture","claims-A:capture"];
      const result=await guarded.replayCompressedClaims(ids,{maxRows:6,maxDecodedBytes:a.proof.decodedBytes*2});
      expect(result.claims.map(entry=>entry.captureId)).toEqual(ids);
      expect(result.verification).toEqual({verifiedWireBytes:a.bytes.length,decodedBytes:a.proof.decodedBytes*2,decodedRows:6});
      expect(reads).toBe(1);
      for(const entry of result.claims){
        expect(entry.proof).toEqual(a.proof);
        expect(entry.rows.map(row=>[row.rowOrdinal,row.failureCode])).toEqual([[1,null],[2,"source-stats-scope-refused"],[3,"source-stats-player-refused"]]);
        expect(entry.rows[0].projection).toMatchObject({season:2026,rawGameId:"2026_06_CAR_PHI",rawPlayerId:"00-0000001",values:{passingYards:80,attempts:10,completions:null},missing:{completions:"source-blank"}});
        expect(entry.rows.slice(1).map(row=>row.projection)).toEqual([null,null]);
        for(const row of entry.rows)expect(row.id).toBe("source-row:"+createHash("sha256").update(JSON.stringify([entry.captureId,row.rowOrdinal])).digest("hex"));
      }
      expect(result.claims[0].rows[0].id).not.toBe(result.claims[1].rows[0].id);
      expect([result.publicationSupported,result.featuresPublished,result.labelsFinalized]).toEqual([false,false,false]);
      await expect(guarded.replayCompressedClaims(ids,{maxRows:5})).rejects.toThrow("compressed-row-budget-exceeded");
      expect((await guarded.replayCompressedClaims([ids[0]])).claims[0].rows).toEqual(result.claims[0].rows);
    });
    expect((await client.query("SELECT count(*)::integer AS n FROM predictive_source_stats_rows WHERE capture_id LIKE 'claims-%'")).rows[0].n).toBe(0);
  });
});

it("guarded gzip claims refuse forged proof CRC damage revoked rights and erased captures", async () => {
  await withProof(async({client,store,artifacts,target})=>{
    const seed=sourceClaimFixture();await store.publishSourceStats(seed);
    const valid=await inspectedGzip(client,artifacts,seed,"claims-valid");
    await stageGzip(client,artifacts,seed,"claims-forged",seed.profile.id,1);
    await recordGzipProof(client,"claims-forged:capture",{...valid.proof,selectedRecordsSha256:"0".repeat(64)});
    await expect(store.replayCompressedClaims(["claims-valid:capture","claims-forged:capture"])).rejects.toThrow("compressed-inspection-integrity-failed");
    const bad=Buffer.from(valid.bytes);bad[bad.length-8]^=1;
    const blob=await stageGzip(client,artifacts,seed,"claims-crc",seed.profile.id,1,bad);
    await recordGzipProof(client,"claims-crc:capture",{...valid.proof,wireSha256:blob.sha,wireBytes:blob.bytes.length});
    await expect(store.replayCompressedClaims(["claims-crc:capture"])).rejects.toThrow("compressed-gzip-refused");
    await client.query("INSERT INTO predictive_rights_decisions VALUES('claims-denied',$1,$2,'{}',date_trunc('milliseconds',clock_timestamp()),NULL,date_trunc('milliseconds',clock_timestamp()),'synthetic','fixture revocation')",[seed.profile.id,seed.rightsDecisions[0].id]);
    let reads=0;
    const tracked={...artifacts,database:{...artifacts.database,readBinary:async()=>{reads++;throw new Error("wire opened");}}};
    const denied=await createLocalPredictiveStore(client,target,tracked);
    await expect(denied.replayCompressedClaims(["claims-valid:capture"])).rejects.toThrow("compressed-inspection-rights-refused");
    expect(reads).toBe(0);
    await withLogin(client,target,["predictive_retention_owner"],async(owner,ownerTarget)=>{
      const retention=await createLocalPredictiveStore(owner,ownerTarget,artifacts);
      await retention.retain({id:"claims-delete",reason:"provider-request",authority:"synthetic test",decidedAt:seed.capturedAt,
        scope:{kind:"source",profileIds:[seed.profile.id],capturedFrom:null,capturedBefore:null},auditLevel:"full"});
    });
    await expect(store.replayCompressedClaims(["claims-valid:capture"])).rejects.toThrow("compressed-inspection-missing");
    await expect(artifacts.database.readBinary(valid.ref,valid.sha,valid.bytes.length)).rejects.toMatchObject({code:"ENOENT"});
  });
});

it("guarded gzip claims hold rights guards and recheck scheduled expiry after complete reconstruction", async()=>{
  await withProof(async({client,store,artifacts,target})=>{
    const seed=sourceClaimFixture();await store.publishSourceStats(seed);await inspectedGzip(client,artifacts,seed,"claims-expiry");
    await client.query("INSERT INTO predictive_rights_decisions VALUES('claims-expiring',$1,$2,'{}',date_trunc('milliseconds',clock_timestamp())+interval '2 seconds',NULL,date_trunc('milliseconds',clock_timestamp()),'synthetic','scheduled fixture revocation')",[seed.profile.id,seed.rightsDecisions[0].id]);
    await withLogin(client,target,["predictive_ingest","predictive_harness"],async writer=>{
      await writer.query("SET lock_timeout='200ms'");let reads=0;
      const tracked={...artifacts,database:{...artifacts.database,readBinary:async(ref:string,sha:string,size:number)=>{
        reads++;
        await expect(writer.query("INSERT INTO predictive_rights_decisions VALUES('claims-race',$1,'claims-expiring','{}',date_trunc('milliseconds',clock_timestamp()),NULL,date_trunc('milliseconds',clock_timestamp()),'synthetic','concurrent revocation')",[seed.profile.id])).rejects.toMatchObject({code:"55P03"});
        const bytes=await artifacts.database.readBinary(ref,sha,size);
        await client.query("SELECT pg_sleep(GREATEST(0,EXTRACT(epoch FROM (effective_from-date_trunc('milliseconds',clock_timestamp()))))+0.03) FROM predictive_rights_decisions WHERE id='claims-expiring'");
        return bytes;
      }}};
      const guarded=await createLocalPredictiveStore(client,target,tracked);
      await expect(guarded.replayCompressedClaims(["claims-expiry:capture"])).rejects.toThrow("compressed-inspection-rights-refused");
      expect(reads).toBe(1);
      await writer.query("INSERT INTO predictive_rights_decisions VALUES('claims-restored',$1,'claims-expiring','{internal-research}',date_trunc('milliseconds',clock_timestamp()),NULL,date_trunc('milliseconds',clock_timestamp()),'synthetic','fixture restoration')",[seed.profile.id]);
      expect((await store.replayCompressedClaims(["claims-expiry:capture"])).claims[0].rows[0].projection?.values.passingYards).toBe(80);
    });
  });
});

it("guarded gzip inspections reproduce exact envelopes with transaction-local wire and decoded accounting", async () => {
  await withProof(async ({ client, store, artifacts, target }) => {
    const seed = sourceClaimFixture(); await store.publishSourceStats(seed);
    const first = await inspectedGzip(client, artifacts, seed, "inspection-A");
    await inspectedGzip(client, artifacts, seed, "inspection-B");
    const before = (await client.query("SELECT * FROM predictive_compressed_inspections ORDER BY capture_id")).rows;
    await withLogin(client, target, ["predictive_ingest","predictive_harness"], async writer => {
      expect(await recordGzipProof(writer, "inspection-A:capture", first.proof)).toEqual(first.proof);
      await expect(recordGzipProof(writer, "inspection-A:capture", { ...first.proof, publicationSupported: true }))
        .rejects.toThrow("compressed-inspection-envelope-refused");
      await expect(recordGzipProof(writer, "inspection-A:capture", { ...first.proof, season: 2025 }))
        .rejects.toThrow("compressed-inspection-capture-mismatch");
      await expect(writer.query("INSERT INTO predictive_compressed_inspections VALUES('forged',$1,clock_timestamp())", [first.proof]))
        .rejects.toMatchObject({code:"42501"});
    });
    expect((await client.query("SELECT * FROM predictive_compressed_inspections ORDER BY capture_id")).rows).toEqual(before);
    let reads = 0;
    const tracked = { ...artifacts, database: { ...artifacts.database, readBinary: async (ref: string, sha: string, size: number) => {
      reads++; return artifacts.database.readBinary(ref, sha, size);
    } } };
    await withLogin(client, target, ["predictive_replay"], async (reader, readerTarget) => {
      await expect(reader.query("SELECT * FROM predictive_compressed_inspections")).rejects.toMatchObject({ code: "42501" });
      await expect(reader.query("SELECT predictive_read_compressed_inspections($1)", [["inspection-A:capture"]])).rejects.toThrow("compressed-inspection-guard-required");
      const replay = await createLocalPredictiveStore(reader, readerTarget, tracked);
      const result = await replay.replayCompressedInspections(["inspection-B:capture", "inspection-A:capture"]);
      expect(result.inspections.map(entry => entry.captureId)).toEqual(["inspection-B:capture", "inspection-A:capture"]);
      expect(result.inspections[0].proof).toEqual(first.proof);
      expect(result.verification).toEqual({ verifiedWireBytes: first.bytes.length, decodedBytes: Buffer.byteLength(seed.artifact.bytes), decodedRows: 1 });
      expect(result.publicationSupported).toBe(false); expect(reads).toBe(1);
      await replay.replayCompressedInspections(["inspection-A:capture"]); expect(reads).toBe(2);
    });
  });
});

it("guarded gzip inspections refuse revoked rights before any private wire bytes open", async () => {
  await withProof(async ({ client, store, artifacts, target, root }) => {
    const seed = sourceClaimFixture(); await store.publishSourceStats(seed);
    const gzip = await inspectedGzip(client, artifacts, seed, "denied");
    await writeFile(join(root, ".db-blobs", gzip.ref), Buffer.alloc(gzip.bytes.length));
    const t = new Date().toISOString();
    await client.query("INSERT INTO predictive_rights_decisions VALUES('gzip-revoked',$1,$2,'{}',$3,NULL,$3,'synthetic','fixture revocation')",
      [seed.profile.id, seed.rightsDecisions[0].id, t]);
    let reads = 0;
    const tracked = { ...artifacts, database: { ...artifacts.database, readBinary: async () => { reads++; throw new Error("wire opened"); } } };
    await withLogin(client, target, ["predictive_replay"], async (reader, readerTarget) => {
      const replay = await createLocalPredictiveStore(reader, readerTarget, tracked);
      await expect(replay.replayCompressedInspections(["denied:capture"])).rejects.toThrow("compressed-inspection-rights-refused");
    });
    expect(reads).toBe(0);
  });
});

it("guarded gzip inspections refuse forged decoded identities and CRC errors after valid wire hashing", async () => {
  await withProof(async ({ client, store, artifacts }) => {
    const seed = sourceClaimFixture(); await store.publishSourceStats(seed);
    const valid = await inspectedGzip(client, artifacts, seed, "valid");
    await stageGzip(client, artifacts, seed, "forged", seed.profile.id, 1);
    await recordGzipProof(client, "forged:capture", { ...valid.proof, decodedSha256: "0".repeat(64) });
    await expect(store.replayCompressedInspections(["forged:capture"])).rejects.toThrow("compressed-inspection-integrity-failed");
    const bad = Buffer.from(valid.bytes); bad[bad.length - 8] ^= 1;
    const blob = await stageGzip(client, artifacts, seed, "crc", seed.profile.id, 1, bad);
    await recordGzipProof(client, "crc:capture", { ...valid.proof, wireSha256: blob.sha, wireBytes: blob.bytes.length });
    await expect(store.replayCompressedInspections(["crc:capture"])).rejects.toThrow("compressed-gzip-refused");
    expect((await store.replayCompressedInspections(["valid:capture"])).inspections[0].proof).toEqual(valid.proof);
  });
});

it("compressed inspection envelopes are immutable and disappear with authorized capture retention", async () => {
  await withProof(async ({ client, store, artifacts, target }) => {
    const seed = sourceClaimFixture(); await store.publishSourceStats(seed);
    const gzip = await inspectedGzip(client, artifacts, seed, "delete-inspection");
    await probe(client, async () => { await expect(client.query("UPDATE predictive_compressed_inspections SET recorded_at=clock_timestamp()"))
      .rejects.toThrow("predictive-append-only"); });
    await withLogin(client, target, ["predictive_retention_owner"], async (owner, ownerTarget) => {
      const retention = await createLocalPredictiveStore(owner, ownerTarget, artifacts);
      await retention.retain({ id: "inspection-delete", reason: "provider-request", authority: "synthetic test", decidedAt: seed.capturedAt,
        scope: { kind: "source", profileIds: [seed.profile.id], capturedFrom: null, capturedBefore: null }, auditLevel: "full" });
    });
    expect((await client.query("SELECT count(*)::integer AS n FROM predictive_compressed_inspections")).rows[0].n).toBe(0);
    await expect(artifacts.database.readBinary(gzip.ref, gzip.sha, gzip.bytes.length)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(store.replayCompressedInspections(["delete-inspection:capture"])).rejects.toThrow("compressed-inspection-missing");
  });
});

it("guarded gzip inspections enforce decoded and row budgets independently of wire storage", async () => {
  await withProof(async ({ client, store, artifacts }) => {
    const seed = sourceClaimFixture(); await store.publishSourceStats(seed);
    const a = await inspectedGzip(client, artifacts, seed, "budget-A");
    const changed = { ...seed, artifact: { ...seed.artifact, bytes: sourceCsv("player", [{ ...sourceSamples().player[0], passing_yards: "95" }]) } };
    const b = await inspectedGzip(client, artifacts, changed, "budget-B");
    const ids = ["budget-A:capture","budget-B:capture"], decoded = a.proof.decodedBytes + b.proof.decodedBytes;
    const result = await store.replayCompressedInspections(ids, { maxDecodedBytes: decoded, maxRows: 2 });
    expect(result.verification).toEqual({ verifiedWireBytes: a.bytes.length+b.bytes.length, decodedBytes: decoded, decodedRows: 2 });
    await expect(store.replayCompressedInspections(ids, { maxDecodedBytes: decoded-1 })).rejects.toThrow("compressed-decoded-budget-exceeded");
    await expect(store.replayCompressedInspections(ids, { maxRows: 1 })).rejects.toThrow("compressed-batch-work-budget-exceeded");
    expect(() => store.replayCompressedInspections(ids, { maxDecodedBytes: 64_000_001 })).toThrow("compressed-batch-limits-refused");
    expect(() => store.replayCompressedInspections(ids, { maxRows: 160_001 })).toThrow("compressed-batch-limits-refused");
  });
});

it("guarded gzip inspections block concurrent rights writes through wire verification", async () => {
  await withProof(async ({ client, store, artifacts, target }) => {
    const seed = sourceClaimFixture(); await store.publishSourceStats(seed);
    await inspectedGzip(client, artifacts, seed, "locked");
    await withLogin(client, target, ["predictive_ingest","predictive_harness"], async (writer) => {
      await writer.query("SET lock_timeout='200ms'");
      let attempts = 0;
      const tracked = { ...artifacts, database: { ...artifacts.database, readBinary: async (ref: string, sha: string, size: number) => {
        attempts++;
        await expect(writer.query("INSERT INTO predictive_rights_decisions VALUES('blocked-gzip',$1,$2,'{}',clock_timestamp(),NULL,clock_timestamp(),'synthetic','fixture revocation')",
          [seed.profile.id,seed.rightsDecisions[0].id])).rejects.toMatchObject({ code: "55P03" });
        return artifacts.database.readBinary(ref,sha,size);
      } } };
      const guarded = await createLocalPredictiveStore(client,target,tracked);
      expect((await guarded.replayCompressedInspections(["locked:capture"])).inspections).toHaveLength(1);
      expect(attempts).toBe(1);
      expect((await client.query("SELECT count(*)::integer AS n FROM predictive_rights_decisions WHERE id='blocked-gzip'")).rows[0].n).toBe(0);
    });
  });
});

it("guarded gzip inspections recheck scheduled rights expiry before delivering decoded proof", async () => {
  await withProof(async ({ client, store, artifacts, target }) => {
    const seed = sourceClaimFixture(); await store.publishSourceStats(seed);
    await inspectedGzip(client, artifacts, seed, "expiring");
    const now = new Date(), until = new Date(now.getTime()+250);
    await client.query("INSERT INTO predictive_rights_decisions VALUES('expiring-gzip',$1,$2,'{}',$3,NULL,$4,'synthetic','scheduled fixture revocation')",
      [seed.profile.id,seed.rightsDecisions[0].id,until.toISOString(),now.toISOString()]);
    const tracked = { ...artifacts, database: { ...artifacts.database, readBinary: async (ref: string, sha: string, size: number) => {
      const wire = await artifacts.database.readBinary(ref,sha,size);
      await new Promise(resolve => setTimeout(resolve,Math.max(0,until.getTime()-Date.now()+30)));
      return wire;
    } } };
    const guarded = await createLocalPredictiveStore(client,target,tracked);
    await expect(guarded.replayCompressedInspections(["expiring:capture"])).rejects.toThrow("compressed-inspection-rights-refused");
  });
});

it("compressed inspection migration preserves fixed v14 evidence and ledger on upgrade and no-op", async () => {
  await withProof(async ({ client, store, target }) => {
    await store.publishSourceStats(sourceClaimFixture());
    const ledger = (await client.query("SELECT * FROM db_migrations ORDER BY version")).rows;
    const captures = (await client.query("SELECT * FROM predictive_captures ORDER BY id")).rows;
    const files=await checkMigrationArtifacts(), contracts=await loadCatalogContracts(files);
    const options={...target,files,verify:createCatalogVerifier(contracts)};
    expect(await runScratchMigrations(client,options)).toMatchObject({schemaVersion:16,executed:[15,16]});
    expect((await client.query("SELECT * FROM db_migrations ORDER BY version")).rows.slice(0,14)).toEqual(ledger);
    expect((await client.query("SELECT * FROM predictive_captures ORDER BY id")).rows).toEqual(captures);
    expect(await runScratchMigrations(client,options)).toMatchObject({schemaVersion:16,executed:[]});
  },14);
});

it("gzip staging stamps database receipt time and refuses published captures and raw claim bypasses", async () => {
  await withProof(async ({ client, store, artifacts }) => {
    const seed = sourceClaimFixture(); await store.publishSourceStats(seed);
    const before = await captureTime(client, seed.captureId);
    await stageGzip(client, artifacts, seed, "gzip");
    const at = await captureTime(client, "gzip:capture"); expect(at >= before).toBe(true); expect(at > seed.capturedAt).toBe(true);
    await probe(client, async () => {
      await expect(client.query(`INSERT INTO predictive_captures SELECT (jsonb_populate_record(NULL::predictive_captures,
        to_jsonb(c)||jsonb_build_object('id','gzip:published','state','published','body_complete',true,
          'header_verified',true,'parser_succeeded',true))).* FROM predictive_captures c WHERE id='gzip:capture'`))
        .rejects.toThrow("predictive-compressed-publication-not-qualified");
    });
    await probe(client, async () => {
      await client.query(`INSERT INTO predictive_source_stats_rows SELECT (jsonb_populate_record(NULL::predictive_source_stats_rows,
        to_jsonb(r)||jsonb_build_object('id',$1::text,'capture_id','gzip:capture'))).* FROM predictive_source_stats_rows r LIMIT 1`,
      ["source-row:" + digest(canonical(["gzip:capture", 1]))]);
      await expect(client.query("SET CONSTRAINTS ALL IMMEDIATE")).rejects.toThrow("predictive-source-claim-envelope-invalid");
    });
    expect(await store.replaySourceStats(replayRequest(at))).toMatchObject({ status: "observed-source-claim" });
    expect((await client.query("SELECT count(*)::integer AS n FROM predictive_source_stats_rows WHERE capture_id='gzip:capture'")).rows[0].n).toBe(0);
  });
});

it("gzip synthetic unknown parsers cannot bypass receipt clocks or canonical binding guards", async () => {
  await withProof(async ({ client, store, artifacts, target }) => {
    const seed = sourceClaimFixture(); await store.publishSourceStats(seed);
    await client.query(`INSERT INTO predictive_source_profiles SELECT (jsonb_populate_record(NULL::predictive_source_profiles,
      to_jsonb(p)||jsonb_build_object('id','gzip-unknown','parser_version','unqualified-codec'))).*
      FROM predictive_source_profiles p WHERE id=$1`, [seed.profile.id]);
    await withLogin(client, target, ["predictive_ingest", "predictive_harness"], async (writer) => {
      await stageGzip(writer, artifacts, seed, "unknown", "gzip-unknown");
      expect(await captureTime(writer, "unknown:capture") > seed.capturedAt).toBe(true);
      await probe(writer, async () => {
        await expect(writer.query("INSERT INTO predictive_artifact_observations VALUES ('unknown:artifact','unqualified-observation')"))
          .rejects.toThrow("predictive-source-canonical-binding-required");
      });
    });
    await probe(client, async () => {
      await expect(client.query("INSERT INTO predictive_blobs VALUES ($1,1,'application/gzip',$2)", ["a".repeat(64), "a".repeat(64) + ".csv"]))
        .rejects.toMatchObject({ code: "23514" });
    });
  });
});

it("gzip exact-address cleanup retains referenced bytes and resumes deletion through execute-only roles", async () => {
  await withProof(async ({ client, store, artifacts, target, root }) => {
    const seed = sourceClaimFixture(); await store.publishSourceStats(seed);
    const gzip = await stageGzip(client, artifacts, seed, "retained-gzip");
    const archive = await artifacts.writeBinary(gzip.bytes, gzip.sha);
    await utimes(join(root, ".db-blobs", gzip.ref), new Date(0), new Date(0));
    const orphanBytes = gzipSync(Buffer.from("orphan")), orphanSha = createHash("sha256").update(orphanBytes).digest("hex");
    const orphan = await artifacts.database.writeBinary(orphanBytes, orphanSha);
    await utimes(join(root, ".db-blobs", orphan), new Date(0), new Date(0));
    await withLogin(client, target, ["predictive_retention_owner"], async (owner, ownerTarget) => {
      const normal = await createLocalPredictiveStore(owner, ownerTarget, artifacts);
      await expect(owner.query("DELETE FROM predictive_blobs")).rejects.toMatchObject({ code: "42501" });
      expect(await normal.sweepOrphanBlobs()).toEqual([orphan]);
      expect(await artifacts.database.readBinary(gzip.ref, gzip.sha, gzip.bytes.length)).toEqual(gzip.bytes);
      await expect(owner.query("SELECT predictive_blob_referenced($1)", [gzip.ref])).rejects.toThrow("predictive-blob-lock-required");
      const broken = await createLocalPredictiveStore(owner, ownerTarget, { ...artifacts, database: { ...artifacts.database,
        remove: async (ref, sha) => { if (ref.endsWith(".csv.gz")) throw new Error("interrupted gzip unlink"); await artifacts.database.remove(ref, sha); } } });
      await expect(broken.retain({ id: "gzip-retention", reason: "provider-request", authority: "synthetic test", decidedAt: seed.capturedAt,
        scope: { kind: "source", profileIds: [seed.profile.id], capturedFrom: null, capturedBefore: null }, auditLevel: "full" }))
        .rejects.toThrow("interrupted gzip unlink");
      expect((await client.query("SELECT count(*)::integer AS n FROM predictive_blobs WHERE storage_ref=$1", [gzip.ref])).rows[0].n).toBe(0);
      expect(await normal.resumeBlobRemovals()).toContain(gzip.ref);
      await expect(artifacts.database.readBinary(gzip.ref, gzip.sha, gzip.bytes.length)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await normal.resumeBlobRemovals()).toEqual([]);
      await expect(owner.query("SELECT predictive_ack_blob_removal($1)", [gzip.sha + ".gz"]))
        .rejects.toThrow("predictive-blob-reference-refused");
    });
    expect(await artifacts.readBinary(archive, gzip.sha, gzip.bytes.length)).toEqual(gzip.bytes);
  });
});

it("gzip staging migration upgrades fixed v12 without rewriting evidence or prior ledger history", async () => {
  await withProof(async ({ client, store, target }) => {
    await store.publishSourceStats(sourceClaimFixture());
    const captures = (await client.query("SELECT * FROM predictive_captures ORDER BY id")).rows;
    const ledger = (await client.query("SELECT * FROM db_migrations ORDER BY version")).rows;
    const files = await checkMigrationArtifacts(), contracts = await loadCatalogContracts(files);
    const options = { ...target, files, verify: createCatalogVerifier(contracts) };
    expect(await runScratchMigrations(client, options)).toMatchObject({ executed: [13, 14, 15, 16], schemaVersion: 16 });
    expect((await client.query("SELECT * FROM predictive_captures ORDER BY id")).rows).toEqual(captures);
    expect((await client.query("SELECT * FROM db_migrations ORDER BY version")).rows.slice(0, 12)).toEqual(ledger);
    expect(await runScratchMigrations(client, options)).toMatchObject({ executed: [], schemaVersion: 16 });
  }, 12);
});

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

it("ordinary evidence stamps database ingestion time for application and direct SQL writers without backdating cutoff visibility", async () => {
  await withProof(async ({ client,target,artifacts }) => {
    const id = "ordinary-clock-source"; const old = "2026-10-07T12:00:00.000Z";
    // Artificial payload under a non-synthetic profile exercises production
    // receipt semantics; it is not a real provider or rights qualification.
    const dataset: Dataset = { formatVersion: 2,profiles: [{ ...profile(id),purpose: "source" }],
      rightsDecisions: [rights(id,{ evidenceKind: "terms-review",evidenceReference: "disposable clock test only" })],
      artifacts: [],captures: [],decisions: [],labels: [],identityLinks: [] };
    addCapture(dataset,"ordinary-clock",[revision("ordinary-clock-game","game-bridge",{
      provider: "nflverse",rawGameId: "clock-game",gameId: gameId(88),
    })],old,id);
    await withLogin(client,target,["predictive_ingest"],async (login,loginTarget) => {
      expect((await login.query("SELECT predictive_harness_session() AS harness")).rows[0].harness).toBe(false);
      const writer = await createLocalPredictiveStore(login,loginTarget,artifacts);
      const before = await witnessClock(client);
      expect(await writer.publish("ordinary-clock-run",dataset,before)).toMatchObject({ status: "published",reused: false });
      const actual = await captureTime(client,"capture-ordinary-clock");
      expect(Date.parse(actual)).toBeGreaterThanOrEqual(Date.parse(before));
      expect(actual).not.toBe(old);
      expect((await client.query("SELECT predictive_observation_usable('ordinary-clock-game',$1) AS usable",[old])).rows[0].usable).toBe(false);
      expect((await client.query("SELECT predictive_observation_usable('ordinary-clock-game',$1) AS usable",[actual])).rows[0].usable).toBe(true);
      expect(await writer.publish("ordinary-clock-run",dataset,before)).toMatchObject({ reused: true });
      expect(await captureTime(client,"capture-ordinary-clock")).toBe(actual);
      await login.query("BEGIN");
      try {
        await login.query(`INSERT INTO predictive_ingestion_runs(id,request_sha256,code_version,started_at,finished_at,status,
          failure_code,budget,requests,consumed_bytes,artifact_count,capture_count,row_count)
          SELECT 'direct-clock-run',request_sha256,code_version,started_at,finished_at,status,
          failure_code,budget,requests,consumed_bytes,artifact_count,capture_count,row_count
          FROM predictive_ingestion_runs WHERE id='ordinary-clock-run'`);
        await login.query(`INSERT INTO predictive_run_rights SELECT 'direct-clock-run',rights_decision_id
          FROM predictive_run_rights WHERE run_id='ordinary-clock-run'`);
        const directBefore = await witnessClock(client);
        await login.query(`INSERT INTO predictive_captures(id,run_id,artifact_id,captured_at,available_at,ingested_at,published_at,
          publication_evidence,state,body_complete,header_verified,parser_succeeded,parsed_rows)
          SELECT 'direct-clock-capture','direct-clock-run',artifact_id,captured_at,available_at,$1,published_at,
          publication_evidence,state,body_complete,header_verified,parser_succeeded,parsed_rows
          FROM predictive_captures WHERE id='capture-ordinary-clock'`,[old]);
        await login.query("SET CONSTRAINTS ALL IMMEDIATE");
        const direct = await captureTime(login,"direct-clock-capture");
        expect(Date.parse(direct)).toBeGreaterThanOrEqual(Date.parse(directBefore));
        expect(direct).not.toBe(old);
      } finally { await login.query("ROLLBACK"); }
    });
  });
});

it("ordinary synthetic capture times remain harness-only and cannot bypass production ingestion clocks", async () => {
  await withProof(async ({ client,store,target,artifacts }) => {
    const id = "clock-synthetic"; const old = "2026-10-07T12:00:00.000Z";
    const dataset: Dataset = { formatVersion: 2,profiles: [profile(id)],rightsDecisions: [rights(id)],
      artifacts: [],captures: [],decisions: [],labels: [],identityLinks: [] };
    addCapture(dataset,"synthetic-clock",[revision("synthetic-clock-game","game-bridge",{
      provider: "nflverse",rawGameId: "synthetic-clock-game",gameId: gameId(89),
    })],old,id);
    expect(await store.publish("synthetic-clock-run",dataset,old)).toMatchObject({ status: "published" });
    expect(await captureTime(client,"capture-synthetic-clock")).toBe(old);
    const outside: Dataset = { ...dataset,artifacts: [],captures: [] };
    addCapture(outside,"outside-clock",[],old,id);
    await withLogin(client,target,["predictive_ingest"],async (login,loginTarget) => {
      const writer = await createLocalPredictiveStore(login,loginTarget,artifacts);
      await expect(writer.publish("outside-clock-run",outside,old)).rejects.toThrow("predictive-synthetic-outside-harness");
    });
    expect((await client.query("SELECT count(*)::integer AS n FROM predictive_captures WHERE id='capture-outside-clock'")).rows[0].n).toBe(0);
  });
});

it("ordinary ingestion clock migration upgrades v10 without rewriting captures and reruns as a no-op", async () => {
  await withProof(async ({ client,store,target }) => {
    const dataset: Dataset = { formatVersion: 2,profiles: [profile()],rightsDecisions: [rights()],
      artifacts: [],captures: [],decisions: [],labels: [],identityLinks: [] };
    addCapture(dataset,"pre-clock",[],"2026-10-07T12:00:00.000Z");
    await store.publish("pre-clock-run",dataset,"2026-10-08T12:00:00.000Z");
    const captures = (await client.query("SELECT * FROM predictive_captures ORDER BY id")).rows;
    const ledger = (await client.query("SELECT * FROM db_migrations ORDER BY version")).rows;
    const files = await checkMigrationArtifacts(); const contracts = await loadCatalogContracts(files);
    const options = { ...target,files,verify: createCatalogVerifier(contracts) };
    expect(await runScratchMigrations(client,options)).toMatchObject({ executed: [11, 12, 13, 14, 15, 16],schemaVersion: 16 });
    expect((await client.query("SELECT * FROM predictive_captures ORDER BY id")).rows).toEqual(captures);
    expect((await client.query("SELECT * FROM db_migrations ORDER BY version")).rows.slice(0,10)).toEqual(ledger);
    expect(await runScratchMigrations(client,options)).toMatchObject({ executed: [],schemaVersion: 16 });
  },10);
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

it("CSV source migration upgrades released v4 preserving creator corpus evidence and recorded history", async () => {
  await withProof(async ({ client, store, target }) => {
    const importedAt = "2026-10-12T00:00:00.000Z";
    const importId = (await client.query(`INSERT INTO corpus_imports
      (imported_at,importer_version,rule_version,registration_fingerprint,gate_fingerprint,capture_input_fingerprint,
        decision_input_fingerprint,discovery_input_fingerprint,capture_event_count,decision_event_count,api_video_count)
      VALUES ($1,'corpus-import-v1','v1',repeat('1',64),repeat('2',64),repeat('3',64),repeat('4',64),repeat('5',64),1,1,1)
      RETURNING import_id`, [importedAt])).rows[0].import_id;
    await client.query(`INSERT INTO corpus_gate_registrations
      (commitment_digest,commitment_algorithm,commitment_version,eligible_creator_count,
        minimum_reviewed_gradable_picks_overall,minimum_reviewed_gradable_picks_per_creator,maximum_feature_count,
        start_season,start_week,end_season,end_week,collection_season_type,rule_version,registered_at,imported_at,first_import_id)
      VALUES (repeat('6',64),'sha256',1,4,500,100,10,2024,1,2026,4,'regular','v1',$1,$1,$2)`, [importedAt, importId]);
    await client.query(`INSERT INTO corpus_capture_events
      (creator_key,log_position,event_fingerprint,video_id,event_kind,published_date,published_date_precision,published_date_provenance,
        transcript_source,usage_status,caption_kind,transcript_sha256,transcript_characters,captured_at,first_import_id)
      VALUES ('creator-a',1,repeat('7',64),'aaaaaaaaaaa','captured','2026-09-10','day','owner-confirmed-video-page-pacific-date',
        'manual-owner-paste','internal-research-only','uploaded',repeat('8',64),1234,$1,$2)`, [importedAt, importId]);
    await client.query(`INSERT INTO corpus_decision_events
      (creator_key,file_position,event_fingerprint,video_id,decision_kind,reason,rule_version,decided_at,first_import_id)
      VALUES ('creator-a',1,repeat('9',64),'aaaaaaaaaaa','include','Synthetic upgrade proof','v1',$1,$2)`, [importedAt, importId]);
    await client.query(`INSERT INTO corpus_api_videos
      (creator_key,video_id,published_at,duration_seconds,live_broadcast_content,api_fetched_at,season,week,season_week_provenance,
        classification_status,classification_reasons,classification_rule_version,review_status,snapshot_import_id)
      VALUES ('creator-a','aaaaaaaaaaa','2026-09-10T17:00:00.000Z',1800,'none',$1,2026,1,'youtube-api-published-at.nfl-calendar-v1',
        'candidate','{prop-and-nfl-signal-in-title}','v1','present',$2)`, [importedAt, importId]);
    const tables = ["corpus_imports", "corpus_gate_registrations", "corpus_capture_events", "corpus_decision_events", "corpus_api_videos"];
    const before = new Map<string, unknown[]>();
    for (const table of tables) before.set(table, (await client.query(`SELECT * FROM ${table}`)).rows);
    const ledger = (await client.query("SELECT * FROM db_migrations ORDER BY version")).rows;
    expect(ledger).toHaveLength(4);
    expect(ledger[3].filename).toBe("0004_creator_corpus_projection.sql");
    const files = await checkMigrationArtifacts(); const contracts = await loadCatalogContracts(files);
    const options = { ...target, files, verify: createCatalogVerifier(contracts) };
    expect(await runScratchMigrations(client, options)).toMatchObject({ executed: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16], schemaVersion: 16 });
    const upgraded = (await client.query("SELECT * FROM db_migrations ORDER BY version")).rows;
    expect(upgraded.slice(0, 4)).toEqual(ledger);
    for (const table of tables) expect((await client.query(`SELECT * FROM ${table}`)).rows).toEqual(before.get(table));
    await store.publishSourceStats(sourceClaimFixture("after-corpus-upgrade"));
    expect(await runScratchMigrations(client, options)).toMatchObject({ executed: [], schemaVersion: 16 });
    expect((await client.query("SELECT * FROM db_migrations ORDER BY version")).rows).toEqual(upgraded);
    for (const table of tables) expect((await client.query(`SELECT * FROM ${table}`)).rows).toEqual(before.get(table));
  }, 4);
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
      const now = (await client.query("SELECT public.predictive_source_time(date_trunc('milliseconds',clock_timestamp())) AS time")).rows[0].time as string;
      expect(Date.parse(now)).toBeGreaterThan(Date.parse(time));
      time = now;
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
    // Current access uses the database clock. A host timestamp can still be
    // ahead of that clock after a sleep, leaving this revocation in the future.
    const revokedAt = await witnessClock(client);
    expect(Date.parse(revokedAt)).toBeGreaterThan(Date.parse(a.event.recordedAt));
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

it("CSV binding migration upgrades v5 without changing released history and reruns are no-ops", async () => {
  await withProof(async ({ client, target, store }) => {
    const input = sourceClaimFixture("before-v6"); await store.publishSourceStats(input);
    const ledger = (await client.query("SELECT * FROM db_migrations ORDER BY version")).rows;
    const raw = (await client.query("SELECT * FROM predictive_source_stats_rows ORDER BY id")).rows;
    const files = await checkMigrationArtifacts(); const contracts = await loadCatalogContracts(files);
    await runScratchMigrations(client, { ...target, files, verify: createCatalogVerifier(contracts) });
    const upgraded = (await client.query("SELECT * FROM db_migrations ORDER BY version")).rows;
    expect(upgraded.slice(0, 5)).toEqual(ledger); expect(upgraded).toHaveLength(16);
    expect((await client.query("SELECT * FROM predictive_source_stats_rows ORDER BY id")).rows).toEqual(raw);
    await runScratchMigrations(client, { ...target, files, verify: createCatalogVerifier(contracts) });
    expect((await client.query("SELECT * FROM db_migrations ORDER BY version")).rows).toEqual(upgraded);
  }, 5);
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

it("CSV unavailable bindings persist missing context with exact prefix evidence and refuse rehashed reason or rights forgeries", async () => {
  const cases = [
    ["game-map", "game-bridge-missing", []],
    ["team-map", "team-alias-missing", ["game-bridge"]],
    ["opponent-map", "opponent-alias-missing", ["game-bridge", "team-alias"]],
    ["game-schedule", "normalization-schedule-missing", ["game-bridge", "opponent-alias", "team-alias"]],
    ["player-map", "player-bridge-missing", ["game-bridge", "opponent-alias", "schedule", "team-alias"]],
    ["link", "player-bridge-link-missing", ["game-bridge", "opponent-alias", "player-bridge", "schedule", "team-alias"]],
    ["wrong-week", "source-schedule-context-conflict", ["game-bridge", "opponent-alias", "schedule", "team-alias"]],
  ] as const;
  for (const [missing, reason, roles] of cases) await withProof(async ({ client, store, artifacts, target }) => {
    const fixture = await normalizationFixture();
    if (missing === "link") fixture.context.identityLinks = [];
    if (missing === "wrong-week") fixture.bridgeRows.find((row) => row.kind === "schedule")!.data.week = 5;
    rewriteNormalizationRows(fixture.context, fixture.bridgeRows.filter((row) => row.id !== missing));
    await store.publishSourceStats(fixture.input);
    await store.publish("unavailable-context", fixture.context, "2026-10-11T00:00:00.000Z");
    const request = { profileId: fixture.input.profile.id, rawGameId: sourceGameId, rawTeam: "PHI", rawPlayerId: "00-0000001" };
    await withLogin(client, target, ["predictive_recorder", "predictive_replay", "predictive_harness"], async (login, loginTarget) => {
      const restricted = await createLocalPredictiveStore(login, loginTarget, artifacts);
      const saved = await restricted.recordSourceNormalization("unavailable", request, null);
      expect(saved.event).toMatchObject({ revision: null, plan: { reason, candidate: null } });
      expect(saved.event.plan.binding.dependencies.map((dep) => dep.role)).toEqual(roles);
      expect(saved.event.plan.binding.rightsDecisionIds).toEqual([fixture.input.rightsDecisions[0].id,
        ...(roles.length ? ["rights-" + BRIDGE_PROFILE] : [])].sort());
      expect(await restricted.replaySourceNormalization({ ...request, cutoff: saved.event.recordedAt })).toMatchObject({ reason, head: null });
      expect(await restricted.recordSourceNormalization("unavailable", request, null)).toEqual({ ...saved, reused: true });
      for (const mutation of ["reason", "rights", "dependency"]) await probe(login, async () => {
        const fake = structuredClone(saved.event.plan);
        if (mutation === "reason") fake.reason = "source-row-missing";
        if (mutation === "rights") fake.binding.rightsDecisionIds = [];
        if (mutation === "dependency") fake.binding.dependencies = [...fake.binding.dependencies, { ...fake.binding.dependencies[0],
          role: "schedule", observationId: "game-map" }];
        rehashPlan(fake);
        await expect(login.query("SELECT predictive_record_source_binding('forged-unavailable','unavailable',$1)", [JSON.stringify(fake)]))
          .rejects.toMatchObject({ code: "23514" });
      });
    });
    expect((await client.query("SELECT count(*)::integer AS n FROM predictive_source_stats_revisions")).rows[0].n).toBe(0);
  });
});

it("CSV unavailable bindings persist forward and reverse identity conflicts and schedule ambiguity with all conflicting evidence", async () => {
  for (const mode of ["game-forward", "game-reverse", "team", "opponent", "player-forward", "player-reverse", "schedule", "schedule-alias"]) {
    await withProof(async ({ client, store }) => {
      const { request, input } = await seedBinding(store);
      const other = "unavailable-rival-profile";
      const conflict = { formatVersion: 2 as const, profiles: [profile(other)], rightsDecisions: [rights(other, { allowedUses: ["internal-research"] })],
        artifacts: [], captures: [], decisions: [], labels: [], identityLinks: [] };
      const rows = mode.startsWith("game") ? [revision("rival", "game-bridge", { provider: "nflverse",
        rawGameId: mode === "game-forward" ? sourceGameId : "other-game", gameId: mode === "game-forward" ? gameId(67) : NORMALIZATION_GAME })]
        : mode === "team" || mode === "opponent" ? [revision("rival", "team-alias", { provider: "nflverse", rawAlias: mode === "team" ? "PHI" : "CAR",
          teamId: "nfl:team:BUF", effectiveFromSeason: 2026, effectiveToSeason: 2026 })]
        : mode.startsWith("player") ? [revision("rival", "player-bridge", { provider: "gsis",
          rawPlayerId: mode === "player-forward" ? "00-0000001" : "00-0000002", playerId: mode === "player-forward" ? "00-0000002" : "00-0000001",
          effectiveFrom: "2026-01-01T00:00:00.000Z", effectiveTo: "2027-01-01T00:00:00.000Z" })]
        : [revision("rival", "schedule", { ...(await normalizationFixture()).bridgeRows.find((row) => row.kind === "schedule")!.data,
          gameId: mode === "schedule-alias" ? gameId(67) : NORMALIZATION_GAME })];
      addCapture(conflict, "rival-context", rows, "2026-10-09T13:00:00.000Z", other);
      await store.publish("rival-context", conflict, "2026-10-11T00:00:00.000Z");
      const saved = await store.recordSourceNormalization("conflicting", request, null);
      const expected = mode.startsWith("game") ? "game-bridge-conflict" : mode === "team" ? "team-alias-conflict"
        : mode === "opponent" ? "opponent-alias-conflict" : mode.startsWith("player") ? "player-bridge-conflict" : "normalization-schedule-ambiguous";
      expect(saved.event.plan.reason).toBe(expected);
      expect(saved.event.plan.binding.dependencies.some((dep) => dep.observationId === "rival")).toBe(true);
      expect(saved.event.plan.binding.rightsDecisionIds).toEqual([input.rightsDecisions[0].id, "rights-" + BRIDGE_PROFILE, "rights-" + other].sort());
      expect(await store.replaySourceNormalization({ ...request, cutoff: saved.event.recordedAt })).toMatchObject({ reason: expected, head: null });
      await probe(client, async () => {
        const forged = structuredClone(saved.event.plan); forged.binding.dependencies = forged.binding.dependencies.filter((dep) => dep.observationId !== "rival");
        rehashPlan(forged); await expect(client.query("SELECT predictive_record_source_binding('forged-conflict','conflicting',$1)", [JSON.stringify(forged)]))
          .rejects.toMatchObject({ code: "23514" });
      });
    });
  }
});

it("CSV unavailable bindings supersede usable context and recover without inventing numeric corrections or changing earlier cutoffs", async () => {
  await withProof(async ({ client, store }) => {
    const { request, bridgeRows } = await seedBinding(store);
    const a = await store.recordSourceNormalization("usable-A", request, null);
    const original = await store.replaySourceNormalization({ ...request, cutoff: a.event.recordedAt });
    await client.query("SELECT pg_sleep(0.005)"); const later = new Date().toISOString();
    const changes = { formatVersion: 2 as const, profiles: [profile(BRIDGE_PROFILE)], rightsDecisions: [], artifacts: [], captures: [], decisions: [], labels: [], identityLinks: [] };
    const prior = bridgeRows.find((row) => row.kind === "schedule")!;
    addCapture(changes, "wrong-context", [revision("wrong-context", "schedule", { ...prior.data, week: 5 }, prior.id)], later, BRIDGE_PROFILE);
    await store.publish("wrong-context", changes, later);
    expect(await store.replaySourceNormalization({ ...request, cutoff: later })).toMatchObject({ reason: "source-binding-stale" });
    const b = await store.recordSourceNormalization("unavailable-B", request, a.event.id);
    expect(b.event).toMatchObject({ revision: null, plan: { reason: "source-schedule-context-conflict" } });
    expect(await store.replaySourceNormalization({ ...request, cutoff: b.event.recordedAt })).toMatchObject({ reason: "source-schedule-context-conflict", head: null });
    await client.query("SELECT pg_sleep(0.005)"); const recovered = new Date().toISOString();
    changes.artifacts = []; changes.captures = [];
    addCapture(changes, "recovered-context", [revision("recovered-context", "schedule", prior.data, "wrong-context")], recovered, BRIDGE_PROFILE);
    await store.publish("recovered-context", changes, recovered);
    const c = await store.recordSourceNormalization("usable-C", request, b.event.id);
    expect(c.event.revision).toEqual(a.event.revision);
    expect(await store.replaySourceNormalization({ ...request, cutoff: c.event.recordedAt })).toMatchObject({ status: "observed-source-normalization", head: { id: "usable-C" } });
    expect(await store.replaySourceNormalization({ ...request, cutoff: a.event.recordedAt })).toEqual(original);
    expect(await store.replaySourceNormalization({ ...request, cutoff: b.event.recordedAt })).toMatchObject({ reason: "source-schedule-context-conflict" });
    expect((await client.query("SELECT count(*)::integer AS n FROM predictive_source_stats_revisions")).rows[0].n).toBe(1);
  });
});

it("CSV unavailable bindings verify every ambiguous capture file and allow evidenced conflict recovery", async () => {
  await withProof(async ({ client, store, root }) => {
    const a = sourceClaimFixture("capture-rival-A");
    const b = sourceClaimFixture("capture-rival-B", "player", sourceCsv("player", [{ ...sourceSamples().player[0], passing_yards: "91" }]));
    b.capturedAt = a.capturedAt;
    await store.publishSourceStats(a); await store.publishSourceStats(b);
    const request = { profileId: a.profile.id, rawGameId: sourceGameId, rawTeam: "PHI", rawPlayerId: "00-0000001" };
    const saved = await store.recordSourceNormalization("ambiguous-captures", request, null);
    expect(saved.event.plan).toMatchObject({ reason: "source-capture-ambiguous", binding: { sourceRows: [], rightsDecisionIds: [a.rightsDecisions[0].id] } });
    expect(saved.event.plan.binding.sourceCaptures.map((capture) => capture.id)).toEqual([a.captureId, b.captureId]);
    for (const input of [a, b]) {
      const path = join(root, ".db-blobs", input.artifact.sha256 + ".csv");
      await writeFile(path, "damaged", { mode: 0o600 });
      await expect(store.recordSourceNormalization("ambiguous-captures", request, null)).rejects.toThrow("artifact-integrity-failed");
      await expect(store.replaySourceNormalization({ ...request, cutoff: saved.event.recordedAt })).rejects.toThrow("artifact-integrity-failed");
      await writeFile(path, input.artifact.bytes, { mode: 0o600 });
    }
    const fixture = await normalizationFixture(); await store.publish("capture-recovery-context", fixture.context, "2026-10-11T00:00:00.000Z");
    const next = sourceClaimFixture("capture-recovery"); next.capturedAt = saved.event.recordedAt; await store.publishSourceStats(next);
    const recovered = await store.recordSourceNormalization("capture-recovery", request, saved.event.id);
    expect(recovered.event.revision?.data.passingYards).toBe(80);
    expect(await store.replaySourceNormalization({ ...request, cutoff: saved.event.recordedAt })).toMatchObject({ reason: "source-capture-ambiguous" });
    expect(await store.replaySourceNormalization({ ...request, cutoff: recovered.event.recordedAt })).toMatchObject({ status: "observed-source-normalization" });
    expect((await client.query("SELECT count(*)::integer AS n FROM predictive_source_binding_captures WHERE binding_id='ambiguous-captures'")).rows[0].n).toBe(2);
  });
});

it("CSV capture-less unavailable bindings keep source rights and whole-lineage retention through execute-only ownership", async () => {
  await withProof(async ({ client, store, artifacts, target }) => {
    const fixture = await normalizationFixture();
    await store.publish("capture-less-context", fixture.context, "2026-10-11T00:00:00.000Z");
    const request = { profileId: fixture.input.profile.id, rawGameId: sourceGameId, rawTeam: "PHI", rawPlayerId: "00-0000001" };
    const a = await store.recordSourceNormalization("capture-less-A", request, null);
    expect(a.event.plan).toMatchObject({ reason: "source-capture-missing", binding: { sourceCaptures: [], sourceRows: [],
      dependencies: [], rightsDecisionIds: [fixture.input.rightsDecisions[0].id] } });
    await store.recordSourceNormalization("capture-less-B", request, a.event.id);
    await withLogin(client, target, ["predictive_retention_owner"], async (login, loginTarget) => {
      const owner = await createLocalPredictiveStore(login, loginTarget, artifacts);
      // No-capture records cannot establish that they fall outside a time-scoped deletion.
      await owner.retain({ id: "remove-capture-less", reason: "provider-request", authority: "synthetic test", decidedAt: fixture.input.capturedAt,
        scope: { kind: "source", profileIds: [fixture.input.profile.id], capturedFrom: "2026-10-01T00:00:00.000Z", capturedBefore: "2026-10-02T00:00:00.000Z" }, auditLevel: "digest-only" });
    });
    expect((await client.query("SELECT count(*)::integer AS n FROM predictive_source_bindings")).rows[0].n).toBe(0);
    const removed = await store.recordSourceNormalization("after-removal", request, null);
    expect(removed.event.plan.reason).toBe("retained-evidence-removed");
    expect(await store.replaySourceNormalization({ ...request, cutoff: removed.event.recordedAt })).toMatchObject({ reason: "retained-evidence-removed" });
  });
});

it("CSV unavailable migration upgrades v6 preserving v1 positive and withheld plans, exact retries and recorded history", async () => {
  for (const player of ["00-0000001", "00-0000002"]) await withProof(async ({ client, store, target }) => {
    const { input, request } = await seedBinding(store);
    request.rawPlayerId = player;
    const plan = await store.planSourceStatsNormalization({ ...request, cutoff: await captureTime(client, input.captureId) });
    plan.binding.version = SOURCE_NORMALIZATION_V1;
    if (!plan.candidate) plan.binding.rightsDecisionIds = [];
    rehashPlan(plan);
    const saved = (await client.query("SELECT predictive_record_source_binding('legacy-v1',NULL,$1) AS result", [JSON.stringify(plan)])).rows[0].result;
    const ledger = (await client.query("SELECT * FROM db_migrations ORDER BY version")).rows;
    const binding = (await client.query("SELECT * FROM predictive_source_bindings")).rows;
    const files = await checkMigrationArtifacts(); const contracts = await loadCatalogContracts(files);
    await runScratchMigrations(client, { ...target, files, verify: createCatalogVerifier(contracts) });
    expect((await client.query("SELECT * FROM db_migrations ORDER BY version")).rows.slice(0, 6)).toEqual(ledger);
    expect((await client.query("SELECT * FROM predictive_source_bindings")).rows).toEqual(binding);
    expect(await store.recordSourceNormalization("legacy-v1", request, null)).toMatchObject({ reused: true, event: { plan } });
    expect(await store.replaySourceNormalization({ ...request, cutoff: saved.recordedAt })).toMatchObject(player === "00-0000001"
      ? { status: "observed-source-normalization", head: { id: "legacy-v1" } } : { reason: "source-row-missing", head: null });
    const next = await store.recordSourceNormalization("v2-next", request, "legacy-v1");
    expect(next.event.plan.binding.version).toBe("nflverse-stats-normalization-plan-v2");
    if (plan.candidate) expect(next.event.revision?.id).toBe((await client.query("SELECT revision_id FROM predictive_source_bindings WHERE id='legacy-v1'")).rows[0].revision_id);
    await runScratchMigrations(client, { ...target, files, verify: createCatalogVerifier(contracts) });
    expect((await client.query("SELECT * FROM predictive_source_bindings WHERE id='legacy-v1'")).rows).toEqual(binding);
  }, 6);
});

it("CSV unavailable retention re-applies pre-v7 legacy events with identical counts and digests after restoration", async () => {
  for (const auditLevel of ["full", "digest-only"] as const) {
    const fixture = passingYardsFixture(false);
    const other: Dataset = { formatVersion: 2, profiles: [profile("retention-survivor")], rightsDecisions: [rights("retention-survivor")],
      artifacts: [], captures: [], decisions: [], labels: [], identityLinks: [] };
    addCapture(other, "retention-survivor", [revision("surviving-schedule", "schedule",
      schedule(81, "2026-09-14T00:15:00.000Z", "nfl:team:SEA", "nfl:team:ARI"))], "2026-10-07T12:00:00.000Z", "retention-survivor");
    const seed = async (store: Store) => {
      await store.publish("legacy-retention", fixture, "2026-10-11T00:00:00.000Z");
      await store.publish("surviving-retention", other, "2026-10-11T00:00:00.000Z");
    };
    // Hand-counted fixture: 13 schedules, 2 coverage rows, 6 memberships,
    // 6 player rows, 14 team rows, 18 markers and 1 availability row.
    const emptyCounts = { observations: 0, artifacts: 0, captures: 0, decisions: 0, labels: 0, featureRuns: 0,
      pins: 0, blobs: 0, links: 0, decisionInputs: 0, featureRunDependencies: 0, unpins: 0 };
    const removedCounts = { ...emptyCounts, observations: 60, artifacts: 7, captures: 7, blobs: 7, links: 60 };
    const assertDeleted = async (client: Client, artifacts: Artifacts) => {
      expect((await client.query("SELECT id FROM predictive_observations ORDER BY id")).rows).toEqual([{ id: "surviving-schedule" }]);
      expect((await client.query("SELECT id FROM predictive_artifacts ORDER BY id")).rows).toEqual([{ id: "retention-survivor" }]);
      expect((await client.query("SELECT count(*)::integer AS n FROM predictive_blob_removals")).rows[0].n).toBe(0);
      for (const artifact of fixture.artifacts)
        await expect(artifacts.database.read(artifact.sha256 + ".json", artifact.sha256, Buffer.byteLength(artifact.bytes)))
          .rejects.toMatchObject({ code: "ENOENT" });
      const kept = other.artifacts[0];
      expect(await artifacts.database.read(kept.sha256 + ".json", kept.sha256, Buffer.byteLength(kept.bytes))).toBe(kept.bytes);
    };
    let history: RecordedRetentionEvent[] = []; let oldProcedure = "";
    const procedure = async (client: Client) => (await client.query(`SELECT pg_get_functiondef(
      'public.predictive_retention_execute(text,text,text,timestamptz,jsonb,text)'::regprocedure) AS definition`)).rows[0].definition as string;
    await withProof(async ({ client, store, artifacts, target }) => {
      expect((await client.query("SELECT max(version) AS version FROM db_migrations")).rows[0].version).toBe(6);
      oldProcedure = await procedure(client);
      await seed(store);
      await withLogin(client, target, ["predictive_retention_owner"], async (login, loginTarget) => {
        const owner = await createLocalPredictiveStore(login, loginTarget, artifacts);
        await owner.retain({ id: "legacy-empty", reason: "provider-request", authority: "synthetic test", decidedAt: "2026-10-11T00:00:00.000Z",
          scope: { kind: "source", profileIds: [PROFILE], capturedFrom: "2025-01-01T00:00:00.000Z", capturedBefore: "2026-01-01T00:00:00.000Z" }, auditLevel });
        await owner.retain({ id: "legacy-removal", reason: "provider-request", authority: "synthetic test", decidedAt: "2026-10-11T00:00:00.000Z",
          scope: { kind: "source", profileIds: [PROFILE], capturedFrom: null, capturedBefore: null }, auditLevel });
        history = await owner.retentionEvents();
      });
      expect(history.map((event) => event.id)).toEqual(["legacy-empty", "legacy-removal"]);
      expect(history[0].removedCounts).toEqual(emptyCounts);
      expect(history[0].removedIdsDigest).toBe(retentionIdsDigest([]));
      expect(history[1].removedCounts).toEqual(removedCounts);
      expect(history[1].removedIdsDigest).not.toBe(history[0].removedIdsDigest);
      await assertDeleted(client, artifacts);
    }, 6);
    // Restore the same retained evidence and IDs into a fresh post-v7 database.
    // New timestamps are allowed; the deletion set and audit contract are not.
    await withProof(async ({ client, store, artifacts, target }) => {
      expect((await client.query("SELECT max(version) AS version FROM db_migrations")).rows[0].version).toBe(16);
      expect(await procedure(client)).not.toBe(oldProcedure);
      await seed(store);
      await withLogin(client, target, ["predictive_retention_owner"], async (login, loginTarget) => {
        const owner = await createLocalPredictiveStore(login, loginTarget, artifacts);
        expect(await owner.reapply(history)).toEqual([
          { eventId: "legacy-empty", status: "reapplied", matched: true }, { eventId: "legacy-removal", status: "reapplied", matched: true },
        ]);
        const restored = await owner.retentionEvents();
        expect(restored.map(({ id, removedCounts, removedIdsDigest }) => ({ id, removedCounts, removedIdsDigest })))
          .toEqual(history.map(({ id, removedCounts, removedIdsDigest }) => ({ id, removedCounts, removedIdsDigest })));
        expect(await owner.reapply(history)).toEqual([
          { eventId: "legacy-empty", status: "present", matched: true }, { eventId: "legacy-removal", status: "present", matched: true },
        ]);
        expect(await owner.retentionEvents()).toEqual(restored);
      });
      const tombstones = (await client.query("SELECT target_kind AS kind,target_id AS id FROM predictive_retention_tombstones")).rows;
      if (auditLevel === "full") { expect(tombstones).toHaveLength(81); expect(retentionIdsDigest(tombstones)).toBe(history[1].removedIdsDigest); }
      else expect(tombstones).toEqual([]);
      await assertDeleted(client, artifacts);
    });
  }
});

it("CSV unavailable bindings retain absence heads and distinguish out-of-window identity evidence from conflicts", async () => {
  for (const [id, expected] of [["game-map", "game-bridge-conflict"], ["team-map", "team-alias-conflict"],
    ["opponent-map", "opponent-alias-conflict"], ["player-map", "player-bridge-conflict"], ["game-schedule", "normalization-schedule-absent"],
    ["expired-player", "player-bridge-missing"], ["expired-team", "team-alias-missing"]]) await withProof(async ({ store }) => {
    const fixture = await normalizationFixture();
    const outOfWindow = id.startsWith("expired");
    const prior = fixture.bridgeRows.find((row) => row.id === (id === "expired-player" ? "player-map" : id === "expired-team" ? "team-map" : id))!;
    if (prior.kind === "player-bridge" && outOfWindow) prior.data.effectiveTo = "2026-10-01T00:00:00.000Z";
    if (prior.kind === "team-alias" && outOfWindow) prior.data.effectiveToSeason = 2025;
    if (prior.kind === "team-alias" && outOfWindow) prior.data.effectiveFromSeason = 2025;
    rewriteNormalizationRows(fixture.context, fixture.bridgeRows);
    Object.assign(fixture.context.artifacts[0], { scopeKind: "season-file", scopeSeason: 2026 });
    await store.publishSourceStats(fixture.input);
    await store.publish("before-absence", fixture.context, "2026-10-11T00:00:00.000Z");
    if (!outOfWindow) {
      const next = { formatVersion: 2 as const, profiles: [profile(BRIDGE_PROFILE)], rightsDecisions: [], artifacts: [], captures: [], decisions: [], labels: [], identityLinks: [] };
      addCapture(next, "empty-cover", [], "2026-10-10T12:00:00.000Z", BRIDGE_PROFILE);
      Object.assign(next.artifacts[0], { scopeKind: "season-file", scopeSeason: 2026 });
      const routing = Object.fromEntries(ROUTING_FIELDS.filter((field) => field in prior.data).map((field) => [field, (prior.data as Record<string, unknown>)[field]]));
      addCapture(next, "absent-context", [revision("context-absence", "source-row-absent", { priorObservationId: prior.id,
        priorEntityKey: entityKey(prior), coveringCaptureId: "capture-empty-cover", scopeKind: "season-file", scopeSeason: 2026,
        scopeWeek: null, scopeGameId: null, scopeFilter: null, ...routing }, prior.id)], "2026-10-10T12:00:00.000Z", BRIDGE_PROFILE);
      await store.publish("absent-context", next, "2026-10-11T00:00:00.000Z");
    }
    const saved = await store.recordSourceNormalization("context-unavailable", { profileId: fixture.input.profile.id,
      rawGameId: sourceGameId, rawTeam: "PHI", rawPlayerId: "00-0000001" }, null);
    expect(saved.event.plan.reason).toBe(expected);
    expect(saved.event.plan.binding.dependencies.some((dep) => dep.observationId === (outOfWindow ? prior.id : "context-absence"))).toBe(true);
  });
});

it("CSV binding schedule reconciliation pins only a current exact selection and a new conflicting head can be recorded unavailable", async () => {
  await withProof(async ({ client, store }) => {
    const fixture = await normalizationFixture(); await store.publishSourceStats(fixture.input);
    const other = "schedule-agreement-profile"; fixture.context.profiles.push(profile(other));
    fixture.context.rightsDecisions.push(rights(other, { allowedUses: ["internal-research"] }));
    const schedule = fixture.bridgeRows.find((row) => row.kind === "schedule")!;
    addCapture(fixture.context, "agree-schedule", [revision("agree-schedule", "schedule", schedule.data)], "2026-10-09T12:00:00.000Z", other);
    await store.publish("schedule-evidence", fixture.context, "2026-10-11T00:00:00.000Z");
    const fact = "schedule:" + NORMALIZATION_GAME; const decisionAt = "2026-10-10T12:00:00.000Z";
    const heads = createReplay(fixture.context, decisionAt, decisionAt, "internal-research").heads(fact);
    const selected = reconcileFact("schedule-selection", fact, heads, decisionAt, "synthetic-proof");
    await store.publish("schedule-decision", { ...fixture.context, artifacts: [], captures: [], decisions: [selected] }, "2026-10-11T00:00:00.000Z");
    const request = { profileId: fixture.input.profile.id, rawGameId: sourceGameId, rawTeam: "PHI", rawPlayerId: "00-0000001" };
    const a = await store.recordSourceNormalization("selected-schedule", request, null);
    expect(a.event.plan.binding.decisions).toEqual([{ ...selected, inputs: [
      { observationId: "agree-schedule", role: "candidate" }, { observationId: "game-schedule", role: "selected" },
    ] }]);
    const original = await store.replaySourceNormalization({ ...request, cutoff: a.event.recordedAt });
    await client.query("SELECT pg_sleep(0.005)"); const later = new Date().toISOString();
    const correction = { ...fixture.context, artifacts: [], captures: [], decisions: [], identityLinks: [] };
    addCapture(correction, "schedule-new-head", [revision("schedule-new-head", "schedule", { ...schedule.data, kickoff: "2026-10-18T19:00:00.000Z" }, "agree-schedule")], later, other);
    await store.publish("schedule-new-head", correction, later);
    const b = await store.recordSourceNormalization("stale-selection-withheld", request, a.event.id);
    expect(b.event.plan).toMatchObject({ reason: "normalization-schedule-ambiguous", binding: { decisions: [] } });
    expect(b.event.plan.binding.dependencies.filter((dep) => dep.role === "schedule").map((dep) => dep.observationId)).toEqual(["game-schedule", "schedule-new-head"]);
    expect(await store.replaySourceNormalization({ ...request, cutoff: a.event.recordedAt })).toEqual(original);
  });
});

const factKey = (player = "00-0000001") => "player-game-stats:" + NORMALIZATION_GAME + ":" + player;
const factRequest = (profileId: string, cutoff: string, entityKeys = [factKey()]) => ({ profileIds: [profileId], entityKeys, cutoff });
const changeFactPlayer = async (client: Client, store: Store, id: string, playerId: string, predecessor: string) => {
  await client.query("SELECT pg_sleep(0.005)");
  const time = new Date().toISOString();
  const context: Dataset = { formatVersion: 2, profiles: [profile(BRIDGE_PROFILE)], rightsDecisions: [], artifacts: [], captures: [], decisions: [], labels: [], identityLinks: [] };
  addCapture(context, id, [revision(id, "player-bridge", { provider: "gsis", rawPlayerId: "00-0000001", playerId,
    effectiveFrom: "2026-01-01T00:00:00.000Z", effectiveTo: "2027-01-01T00:00:00.000Z" }, predecessor)], time, BRIDGE_PROFILE);
  await store.publish(id, context, time);
  return time;
};

it("CSV canonical fact reads expand raw lineages before filtering and preserve read-only A to B to A provenance", async () => {
  await withProof(async ({ client, store, artifacts, target }) => {
    const { request } = await seedBinding(store);
    const a = await store.recordSourceNormalization("fact-A", request, null);
    const original = await store.replaySourceStatsFacts(factRequest(request.profileId, a.event.recordedAt));
    expect(selectSourceFact(original, factKey())).toMatchObject({ state: "selected", head: { head: { id: "fact-A",
      revision: { data: { playerId: "00-0000001", passingYards: 80 } } }, revisionKnownAt: a.event.recordedAt } });
    await changeFactPlayer(client, store, "fact-player-B", "00-0000002", "player-map");
    const b = await store.recordSourceNormalization("fact-B", request, "fact-A");
    await withLogin(client, target, ["predictive_replay"], async (reader, readerTarget) => {
      let snapshots = 0;
      const tracked = { query: async (sql: string, params?: unknown[]) => {
        if (sql.includes("SELECT DISTINCT b.profile_id AS")) {
          expect((await reader.query("SELECT current_setting('transaction_read_only') AS ro,current_setting('transaction_isolation') AS isolation")).rows[0])
            .toEqual({ ro: "on", isolation: "repeatable read" }); snapshots++;
        }
        return reader.query(sql, params);
      } } as unknown as Client;
      const replay = await createLocalPredictiveStore(tracked, readerTarget, artifacts);
      expect(await replay.replaySourceStatsFacts(factRequest(request.profileId, a.event.recordedAt))).toEqual(original);
      const atB = await replay.replaySourceStatsFacts(factRequest(request.profileId, b.event.recordedAt, [factKey(), factKey("00-0000002")]));
      expect(selectSourceFact(atB, factKey())).toMatchObject({ state: "missing", head: null });
      expect(selectSourceFact(atB, factKey("00-0000002"))).toMatchObject({ state: "selected", head: { head: { id: "fact-B" } } });
      expect(atB).toMatchObject({ coverage: "recorded-lineages-only", observationsPublished: false, featuresPublished: false, labelsFinalized: false });
      expect(snapshots).toBe(2);
      await expect(reader.query("SELECT predictive_record_source_binding('fact-denied',NULL,'{}')")).rejects.toMatchObject({ code: "42501" });
    });
    await changeFactPlayer(client, store, "fact-player-A-again", "00-0000001", "fact-player-B");
    const c = await store.recordSourceNormalization("fact-C", request, "fact-B");
    const returned = await store.replaySourceStatsFacts(factRequest(request.profileId, c.event.recordedAt));
    expect(returned.heads[0].head.revision).toEqual(a.event.revision);
    expect(returned.heads[0].revisionKnownAt).toBe(a.event.recordedAt);
    expect(returned.heads[0].headToken).not.toBe(original.heads[0].headToken);
    expect(await store.replaySourceStatsFacts(factRequest(request.profileId, a.event.recordedAt))).toEqual(original);
    expect((await client.query("SELECT count(*)::integer AS n FROM predictive_observations WHERE kind IN ('player-game-stats','team-game-stats')")).rows[0].n).toBe(0);
    for (const table of ["predictive_feature_runs", "predictive_outcome_labels"])
      expect((await client.query(`SELECT count(*)::integer AS n FROM ${table}`)).rows[0].n).toBe(0);
  });
});

it("CSV canonical fact reads discover an unrecorded destination and withhold both routes without stale numeric payloads", async () => {
  await withProof(async ({ client, store }) => {
    const { request } = await seedBinding(store); const a = await store.recordSourceNormalization("unrecorded-fact-A", request, null);
    const earlier = await store.replaySourceStatsFacts(factRequest(request.profileId, a.event.recordedAt));
    const at = await changeFactPlayer(client, store, "unrecorded-player-B", "00-0000002", "player-map");
    // B has no canonical source revision yet. A SQL filter over B's historical
    // revision IDs alone would miss the raw lineage that now maps to B.
    for (const key of [factKey(), factKey("00-0000002")]) {
      const snapshot = await store.replaySourceStatsFacts(factRequest(request.profileId, at, [key]));
      expect(snapshot.heads).toEqual([]);
      expect(snapshot.withheld).toEqual([{ lineageKey: expect.any(String), profileId: request.profileId,
        bindingId: "unrecorded-fact-A", reason: "source-binding-stale", routing: "known-destinations", entityKeys: [key] }]);
      expect(selectSourceFact(snapshot, key)).toMatchObject({ state: "withheld", head: null });
      expect(JSON.stringify(snapshot)).not.toContain("passingYards");
    }
    expect(await store.replaySourceStatsFacts(factRequest(request.profileId, a.event.recordedAt))).toEqual(earlier);
  });
});

it("CSV canonical fact reads retain missing-row uncertainty and reappearance binds unchanged values to fresh provenance", async () => {
  await withProof(async ({ client, store }) => {
    const { request } = await seedBinding(store); const a = await store.recordSourceNormalization("present-fact", request, null);
    const before = await store.replaySourceStatsFacts(factRequest(request.profileId, a.event.recordedAt));
    const missing = sourceClaimFixture("missing-fact", "player", sourceCsv("player", [{ ...sourceSamples().player[0], player_id: "00-0000002" }]));
    missing.capturedAt = a.event.recordedAt; await store.publishSourceStats(missing);
    const unrecorded = await store.replaySourceStatsFacts(factRequest(request.profileId, await captureTime(client, missing.captureId)));
    expect(selectSourceFact(unrecorded, factKey())).toMatchObject({ state: "withheld", head: null, withheld: [{ reason: "source-binding-stale" }] });
    const b = await store.recordSourceNormalization("missing-fact-binding", request, "present-fact");
    const withheld = await store.replaySourceStatsFacts(factRequest(request.profileId, b.event.recordedAt));
    expect(selectSourceFact(withheld, factKey())).toMatchObject({ state: "withheld", head: null, withheld: [{ reason: "source-row-missing" }] });
    expect(withheld.heads).toEqual([]);
    const recovered = sourceClaimFixture("recovered-fact"); recovered.capturedAt = b.event.recordedAt; await store.publishSourceStats(recovered);
    const c = await store.recordSourceNormalization("recovered-fact-binding", request, b.event.id);
    const after = await store.replaySourceStatsFacts(factRequest(request.profileId, c.event.recordedAt));
    expect(after.heads[0]).toMatchObject({ revisionKnownAt: a.event.recordedAt, head: { id: c.event.id, revision: a.event.revision } });
    expect(after.heads[0].headToken).not.toBe(before.heads[0].headToken);
    expect(after.heads[0].head.plan.binding.sourceCaptures.map((capture) => capture.id)).toEqual([recovered.captureId]);
    expect(await store.replaySourceStatsFacts(factRequest(request.profileId, a.event.recordedAt))).toEqual(before);
    expect((await client.query("SELECT count(*)::integer AS n FROM predictive_source_stats_revisions")).rows[0].n).toBe(1);
  });
});

it("CSV canonical fact reads check source and context rights before any provider file is opened", async () => {
  for (const revokeContext of [false, true]) await withProof(async ({ client, store, artifacts, target, root }) => {
    const { input, request } = await seedBinding(store); const a = await store.recordSourceNormalization("rights-fact", request, null);
    const profileId = revokeContext ? BRIDGE_PROFILE : request.profileId;
    const predecessor = revokeContext ? "rights-" + BRIDGE_PROFILE : input.rightsDecisions[0].id;
    const now = new Date().toISOString();
    await client.query(`INSERT INTO predictive_rights_decisions (id,profile_id,predecessor_id,allowed_uses,effective_from,decided_at,evidence_kind,evidence_reference)
      VALUES ('fact-revocation',$1,$2,'{}',$3,$3,'synthetic','fixture revocation')`, [profileId, predecessor, now]);
    await writeFile(join(root, ".db-blobs", input.artifact.sha256 + ".csv"), "damaged", { mode: 0o600 });
    let reads = 0;
    const blockedArtifacts = { ...artifacts, database: { ...artifacts.database, read: async () => { reads++; throw new Error("provider bytes opened without rights"); } } };
    const restricted = await createLocalPredictiveStore(client, target, blockedArtifacts);
    const snapshot = await restricted.replaySourceStatsFacts(factRequest(request.profileId, a.event.recordedAt));
    expect(snapshot).toMatchObject({ status: "unavailable-source-facts", reason: "rights-not-in-force", heads: [], withheld: [] });
    expect(selectSourceFact(snapshot, factKey())).toMatchObject({ state: "withheld", head: null });
    expect(reads).toBe(0);
  });
});

it("CSV canonical fact reads verify raw bytes even outside the requested destination and fail instead of truncating discovery", async () => {
  await withProof(async ({ client, store, artifacts, target, root }) => {
    const { input, request } = await seedBinding(store); const a = await store.recordSourceNormalization("integrity-fact", request, null);
    const scope = factRequest(request.profileId, a.event.recordedAt, [factKey("00-0000002")]);
    expect((await store.replaySourceStatsFacts(scope)).heads).toEqual([]);
    const path = join(root, ".db-blobs", input.artifact.sha256 + ".csv");
    await writeFile(path, "damaged", { mode: 0o600 });
    await expect(store.replaySourceStatsFacts(scope)).rejects.toThrow("artifact-integrity-failed");
    await writeFile(path, input.artifact.bytes, { mode: 0o600 });
    let reads = 0;
    const bounded = await createLocalPredictiveStore({ query: async (sql: string, params?: unknown[]) => {
      // A discovery-overflow probe tests refusal before any history hydration;
      // this simulates the query result boundary, not 257 real SQL lineages.
      if (sql.includes("SELECT DISTINCT b.profile_id AS")) return { rows: Array(SOURCE_FACT_BOUNDS.lineages + 1).fill({}) };
      return client.query(sql, params);
    } } as unknown as Client, target, { ...artifacts, database: { ...artifacts.database,
      read: async () => { reads++; throw new Error("unexpected hydration after overflow"); } } });
    await expect(bounded.replaySourceStatsFacts(scope)).rejects.toThrow("source-fact-bounds-refused"); expect(reads).toBe(0);
    expect((await client.query("SELECT 1 AS n")).rows).toEqual([{ n: 1 }]);
    expect(await store.replaySourceStatsFacts({ ...scope, profileIds: ["missing-profile"] })).toMatchObject({ reason: "source-profile-missing", heads: [] });
    await expect(store.replaySourceStatsFacts({ ...scope, cutoff: "2999-01-01T00:00:00.000Z" })).rejects.toThrow("source-binding-future-cutoff-refused");
  });
});

it("CSV canonical fact reads keep player and team identities distinct and do not backdate canonical recording", async () => {
  for (const feed of ["player", "team"] as const) await withProof(async ({ client, store }) => {
    const { input, request } = await seedBinding(store, feed);
    const key = feed === "player" ? factKey() : "team-game-stats:" + NORMALIZATION_GAME + ":nfl:team:PHI";
    const before = await store.replaySourceStatsFacts(factRequest(request.profileId, await captureTime(client, input.captureId), [key]));
    expect(selectSourceFact(before, key)).toMatchObject({ state: "missing", head: null });
    expect(before.coverage).toBe("recorded-lineages-only");
    const a = await store.recordSourceNormalization("typed-fact", request, null);
    const oneMsBefore = new Date(Date.parse(a.event.recordedAt) - 1).toISOString();
    expect((await store.replaySourceStatsFacts(factRequest(request.profileId, oneMsBefore, [key]))).heads).toEqual([]);
    const snapshot = await store.replaySourceStatsFacts(factRequest(request.profileId, a.event.recordedAt, [key]));
    expect(selectSourceFact(snapshot, key)).toMatchObject({ state: "selected", head: { revisionKnownAt: a.event.recordedAt,
      head: { revision: { kind: feed + "-game-stats", data: { gameId: NORMALIZATION_GAME, teamId: "nfl:team:PHI", passingYards: 80 } } } } });
    if (feed === "team") expect(snapshot.heads[0].head.revision!.data).not.toHaveProperty("playerId");
    const all = await store.replaySourceStatsFacts(factRequest(request.profileId, a.event.recordedAt, []));
    expect(all.heads).toEqual(snapshot.heads);
    const rights = input.rightsDecisions[0]; const now = new Date().toISOString();
    await client.query(`INSERT INTO predictive_rights_decisions (id,profile_id,predecessor_id,allowed_uses,effective_from,decided_at,evidence_kind,evidence_reference)
      VALUES ('fact-rights-renewal',$1,$2,'{internal-research}',$3,$3,'synthetic','fixture renewal')`, [request.profileId, rights.id, now]);
    expect(await store.replaySourceStatsFacts(factRequest(request.profileId, a.event.recordedAt, [key]))).toEqual(snapshot);
  });
});

it("CSV canonical fact reads preserve unresolved routing when no historical canonical destination exists", async () => {
  await withProof(async ({ store }) => {
    const fixture = await normalizationFixture();
    rewriteNormalizationRows(fixture.context, fixture.bridgeRows.filter((row) => row.kind !== "game-bridge"));
    await store.publishSourceStats(fixture.input); await store.publish("unrouted-context", fixture.context, "2026-10-11T00:00:00.000Z");
    const request = { profileId: fixture.input.profile.id, rawGameId: sourceGameId, rawTeam: "PHI", rawPlayerId: "00-0000001" };
    const a = await store.recordSourceNormalization("unrouted-fact", request, null);
    expect(a.event).toMatchObject({ revision: null, plan: { reason: "game-bridge-missing" } });
    for (const entityKeys of [[factKey()], [factKey("00-0000002")], []]) {
      const snapshot = await store.replaySourceStatsFacts(factRequest(request.profileId, a.event.recordedAt, entityKeys));
      expect(snapshot.heads).toEqual([]);
      expect(snapshot.withheld).toEqual([{ lineageKey: expect.any(String), profileId: request.profileId,
        bindingId: "unrouted-fact", reason: "game-bridge-missing", routing: "unresolved", entityKeys: [] }]);
      expect(selectSourceFact(snapshot, entityKeys[0] ?? factKey())).toMatchObject({ state: "withheld", head: null });
      expect(JSON.stringify(snapshot)).not.toContain("passingYards");
    }
  });
});

it("CSV consumer witnesses bind unchanged recaptures and post-window evidence through a replay-only login", async () => {
  await withProof(async ({ client, store, target, artifacts }) => {
    const { input, request } = await seedBinding(store);
    const a = await store.recordSourceNormalization("consumer-A", request, null);
    const earlier = await store.replaySourceStatsFacts(factRequest(request.profileId, a.event.recordedAt));
    const witness = sourceFactWitness(earlier);
    await client.query("SELECT pg_sleep(0.005)");
    const recapture = sourceClaimFixture("consumer-recapture"); recapture.capturedAt = new Date().toISOString();
    await store.publishSourceStats(recapture);
    const b = await store.recordSourceNormalization("consumer-B", request, "consumer-A");
    expect(b.event.revision).toEqual(a.event.revision);
    await withLogin(client, target, ["predictive_replay"], async (reader, readerTarget) => {
      const replay = await createLocalPredictiveStore(reader, readerTarget, artifacts);
      const after = await replay.replaySourceStatsFacts(factRequest(request.profileId, b.event.recordedAt));
      const current = sourceFactWitness(after);
      expect(checkSourceWitness(witness, after).state).toBe("changed");
      expect(current.heads).toMatchObject([{ bindingId: "consumer-B", revisionId: a.event.revision!.id }]);
      expect(sourceUsageEvidence(after, factKey()).state).toBe("positive-usage");
      expect(sourceReconciliationEvidence(after, factKey())).toMatchObject({ outcome: { result: "selected", rule: "single-source" },
        selected: { bindingId: "consumer-B", revisionId: a.event.revision!.id } });
      const post = { entityKey: factKey(), bindingId: "consumer-B", captureId: recapture.captureId, eligibleAt: a.event.recordedAt };
      expect(sourcePostWindowCapture(after, witness, post).reason).toBe("source-witness-changed");
      expect(sourcePostWindowCapture(after, current, post)).toMatchObject({ state: "confirmed-source-capture", captureId: recapture.captureId,
        head: { bindingId: "consumer-B", revisionId: a.event.revision!.id }, labelsFinalized: false });
      expect(sourcePostWindowCapture(after, current, { ...post, captureId: input.captureId }).reason).toBe("source-capture-selection-mismatch");
      expect(sourcePostWindowCapture(earlier, witness, { ...post, bindingId: "consumer-A", captureId: input.captureId }).reason)
        .toBe("source-capture-before-final-window");
      expect(await replay.replaySourceStatsFacts(factRequest(request.profileId, a.event.recordedAt))).toEqual(earlier);
      await expect(reader.query("SELECT predictive_record_source_binding('consumer-denied',NULL,'{}')")).rejects.toMatchObject({ code: "42501" });
    });
    for (const table of ["predictive_observations", "predictive_feature_runs", "predictive_outcome_labels"])
      expect((await client.query(`SELECT count(*)::integer AS n FROM ${table}${table === "predictive_observations" ? " WHERE kind IN ('player-game-stats','team-game-stats')" : ""}`)).rows[0].n).toBe(0);
  });
});

it("CSV consumer checks withhold stale routing and revoked access instead of reviving earlier selected values", async () => {
  await withProof(async ({ client, store, artifacts, target }) => {
    const { input, request } = await seedBinding(store);
    const a = await store.recordSourceNormalization("consumer-stale-A", request, null);
    const earlier = await store.replaySourceStatsFacts(factRequest(request.profileId, a.event.recordedAt));
    const witness = sourceFactWitness(earlier);
    const at = await changeFactPlayer(client, store, "consumer-player-B", "00-0000002", "player-map");
    const stale = await store.replaySourceStatsFacts(factRequest(request.profileId, at));
    expect(checkSourceWitness(witness, stale)).toMatchObject({ state: "unavailable", reason: "source-evidence-withheld", current: { heads: [] } });
    expect(sourceReconciliationEvidence(stale, factKey())).toMatchObject({ state: "withheld", selected: null, outcome: null });
    expect(sourceUsageEvidence(stale, factKey()).state).toBe("withheld");
    const post = { entityKey: factKey(), bindingId: a.event.id, captureId: input.captureId, eligibleAt: input.capturedAt };
    expect(sourcePostWindowCapture(stale, witness, post).reason).toBe("source-evidence-withheld");
    const now = new Date().toISOString();
    await client.query(`INSERT INTO predictive_rights_decisions (id,profile_id,predecessor_id,allowed_uses,effective_from,decided_at,evidence_kind,evidence_reference)
      VALUES ('consumer-revocation',$1,$2,'{}',$3,$3,'synthetic','fixture revocation')`, [request.profileId, input.rightsDecisions[0].id, now]);
    let reads = 0;
    const deniedBytes = { ...artifacts, database: { ...artifacts.database, read: async () => { reads++; throw new Error("unexpected provider read"); } } };
    const restricted = await createLocalPredictiveStore(client, target, deniedBytes);
    const denied = await restricted.replaySourceStatsFacts(factRequest(request.profileId, a.event.recordedAt));
    expect(checkSourceWitness(witness, denied)).toMatchObject({ state: "unavailable", reason: "rights-not-in-force" });
    expect(sourceReconciliationEvidence(denied, factKey()).outcome).toBeNull();
    expect(sourceUsageEvidence(denied, factKey()).state).toBe("withheld");
    expect(sourcePostWindowCapture(denied, witness, post).reason).toBe("rights-not-in-force");
    expect(reads).toBe(0);
  });
});

const witnessClock = async (client: Client) => (await client.query("SELECT predictive_source_time(clock_timestamp()) AS time")).rows[0].time as string;
const sqlWitness = async (client: Client, request: ReturnType<typeof factRequest>) =>
  (await client.query("SELECT predictive_source_witness($1) AS witness", [request])).rows[0].witness;
const rehashWitness = (witness: ReturnType<typeof sourceFactWitness>) => {
  const { cutoff: _cutoff, evidenceDigest: _digest, ...fields } = witness;
  void _cutoff; void _digest;
  return { ...witness, evidenceDigest: digest(canonical(fields)) };
};

it("CSV SQL witnesses match verified player and team reads, missing scope and equivalent rights renewal", async () => {
  for (const feed of ["player", "team"] as const) await withProof(async ({ client, store }) => {
    const { input, request } = await seedBinding(store, feed);
    const a = await store.recordSourceNormalization("sql-witness-A", request, null);
    const key = feed === "player" ? factKey() : "team-game-stats:" + NORMALIZATION_GAME + ":nfl:team:PHI";
    const scoped = factRequest(request.profileId, a.event.recordedAt, [key]);
    const witness = await sqlWitness(client, scoped);
    expect(witness).toEqual(sourceFactWitness(await store.replaySourceStatsFacts(scoped)));
    expect(witness).toMatchObject({ heads: [{ bindingId: a.event.id, revisionId: a.event.revision!.id, entityKey: key }],
      withheld: [], missingEntityKeys: [], coverage: "recorded-lineages-only", reason: null });
    const renewedAt = await witnessClock(client);
    await client.query(`INSERT INTO predictive_rights_decisions(id,profile_id,predecessor_id,allowed_uses,effective_from,decided_at,evidence_kind,evidence_reference)
      VALUES ('sql-rights-renewed',$1,$2,'{internal-research}',$3,$3,'synthetic','fixture renewal')`,
    [request.profileId, input.rightsDecisions[0].id, renewedAt]);
    const later = await sqlWitness(client, { ...scoped, cutoff: await witnessClock(client) });
    expect(later.evidenceDigest).toBe(witness.evidenceDigest);
    expect(await sqlWitness(client, scoped)).toEqual(witness);
    const missingKey = feed === "player" ? factKey("00-0000002") : "team-game-stats:" + NORMALIZATION_GAME + ":nfl:team:DAL";
    expect(await sqlWitness(client, { ...scoped, entityKeys: [missingKey] })).toMatchObject({ heads: [], withheld: [], missingEntityKeys: [missingKey] });
  });
});

it("CSV SQL witness checker rejects rehashed omissions, fabricated heads and forged unavailable reasons", async () => {
  await withProof(async ({ client, store }) => {
    const { request } = await seedBinding(store);
    const a = await store.recordSourceNormalization("sql-forgery-A", request, null);
    const witness = await sqlWitness(client, factRequest(request.profileId, a.event.recordedAt));
    for (const forged of [{ ...witness, heads: [] }, { ...witness, missingEntityKeys: [factKey()] },
      { ...witness, heads: [{ ...witness.heads[0], bindingId: "fabricated" }] },
      { ...witness, heads: [{ ...witness.heads[0], revisionId: "fabricated" }] },
      { ...witness, heads: [{ ...witness.heads[0], headToken: "0".repeat(64) }] }, { ...witness, reason: "rights-not-in-force" }]) {
      await expect(client.query("SELECT predictive_source_witness_check($1,$2,false)", [rehashWitness(forged), await witnessClock(client)]))
        .rejects.toMatchObject({ code: "23514", message: "predictive-source-witness-invalid" });
    }
    const at = await changeFactPlayer(client, store, "sql-forgery-B", "00-0000002", "player-map");
    const stale = await sqlWitness(client, factRequest(request.profileId, at, [factKey("00-0000002")]));
    expect(stale).toMatchObject({ heads: [], withheld: [{ reason: "source-binding-stale", entityKeys: [factKey("00-0000002")] }] });
    for (const forged of [{ ...stale, withheld: [] }, { ...stale, withheld: [{ ...stale.withheld[0], reason: "source-row-missing" }] }])
      await expect(client.query("SELECT predictive_source_witness_check($1,$2,false)", [rehashWitness(forged), await witnessClock(client)]))
        .rejects.toMatchObject({ code: "23514", message: "predictive-source-witness-invalid" });
    await client.query("SELECT predictive_source_witness_check($1,$2,false)", [stale, await witnessClock(client)]);
  });
});

it("CSV SQL current witness checks invalidate same-revision recaptures and refuse unchanged empty evidence", async () => {
  await withProof(async ({ client, store }) => {
    const { request } = await seedBinding(store);
    const a = await store.recordSourceNormalization("sql-current-A", request, null);
    const witness = await sqlWitness(client, factRequest(request.profileId, a.event.recordedAt));
    await client.query("SELECT predictive_source_witness_check($1,$2,true)", [witness, await witnessClock(client)]);
    const empty = await sqlWitness(client, factRequest(request.profileId, a.event.recordedAt, [factKey("00-0000002")]));
    await client.query("SELECT predictive_source_witness_check($1,$2,false)", [empty, await witnessClock(client)]);
    await expect(client.query("SELECT predictive_source_witness_check($1,$2,true)", [empty, await witnessClock(client)]))
      .rejects.toMatchObject({ code: "23514", message: "predictive-source-witness-not-current" });
    await client.query("SELECT pg_sleep(0.005)");
    const recapture = sourceClaimFixture("sql-current-recapture"); recapture.capturedAt = await witnessClock(client);
    await store.publishSourceStats(recapture);
    // Even before a new binding is recorded the old numerical payload cannot
    // authorize current use. After recording, the revision is reused but the
    // binding/token still invalidate the earlier witness.
    await expect(client.query("SELECT predictive_source_witness_check($1,$2,true)", [witness, await witnessClock(client)]))
      .rejects.toMatchObject({ code: "23514", message: "predictive-source-witness-not-current" });
    const b = await store.recordSourceNormalization("sql-current-B", request, a.event.id);
    expect(b.event.revision).toEqual(a.event.revision);
    const current = await sqlWitness(client, factRequest(request.profileId, b.event.recordedAt));
    expect(current.heads[0]).toMatchObject({ bindingId: b.event.id, revisionId: a.event.revision!.id });
    expect(current.evidenceDigest).not.toBe(witness.evidenceDigest);
    await client.query("SELECT predictive_source_witness_check($1,$2,true)", [current, await witnessClock(client)]);
    await client.query("SELECT predictive_source_witness_check($1,$2,false)", [witness, await witnessClock(client)]);
    await expect(client.query("SELECT predictive_source_witness_check($1,$2,true)", [witness, await witnessClock(client)]))
      .rejects.toMatchObject({ code: "23514", message: "predictive-source-witness-not-current" });
  });
});

it("CSV SQL witnesses expand unrecorded reroutes and unresolved identity before canonical filtering", async () => {
  await withProof(async ({ client, store }) => {
    const { request } = await seedBinding(store);
    const a = await store.recordSourceNormalization("sql-routing-A", request, null);
    const before = await sqlWitness(client, factRequest(request.profileId, a.event.recordedAt));
    const at = await changeFactPlayer(client, store, "sql-routing-B", "00-0000002", "player-map");
    for (const key of [factKey(), factKey("00-0000002")]) {
      const req = factRequest(request.profileId, at, [key]);
      expect(await sqlWitness(client, req)).toEqual(sourceFactWitness(await store.replaySourceStatsFacts(req)));
      expect(await sqlWitness(client, req)).toMatchObject({ heads: [], missingEntityKeys: [],
        withheld: [{ reason: "source-binding-stale", routing: "known-destinations", entityKeys: [key] }] });
    }
    const fixture = await normalizationFixture();
    const prior = fixture.bridgeRows.find((row) => row.id === "player-map")!;
    if (prior.kind !== "player-bridge") throw new Error("fixture-player-bridge-missing");
    const removedAt = await witnessClock(client);
    const context: Dataset = { formatVersion: 2, profiles: [profile(BRIDGE_PROFILE)], rightsDecisions: [], artifacts: [], captures: [], decisions: [], labels: [], identityLinks: [] };
    addCapture(context, "sql-routing-expired", [revision("sql-routing-expired", "player-bridge",
      { ...prior.data, effectiveTo: "2026-10-01T00:00:00.000Z" }, "sql-routing-B")], removedAt, BRIDGE_PROFILE);
    await store.publish("sql-routing-expired", context, removedAt);
    const unrelated = factRequest(request.profileId, removedAt, [factKey("00-0000003")]);
    expect(await sqlWitness(client, unrelated)).toEqual(sourceFactWitness(await store.replaySourceStatsFacts(unrelated)));
    expect(await sqlWitness(client, unrelated)).toMatchObject({ heads: [], missingEntityKeys: [],
      withheld: [{ reason: "source-binding-stale", routing: "unresolved", entityKeys: [] }] });
    expect(await sqlWitness(client, factRequest(request.profileId, a.event.recordedAt))).toEqual(before);
  });
});

it("CSV SQL witness access uses database-clock rights and denies private kernels and unbounded requests", async () => {
  await withProof(async ({ client, store, target }) => {
    const { request, input } = await seedBinding(store);
    const a = await store.recordSourceNormalization("sql-access-A", request, null);
    const req = factRequest(request.profileId, a.event.recordedAt);
    for (const role of ["predictive_replay", "predictive_recorder"]) await withLogin(client, target, [role], async (login) => {
      expect(await sqlWitness(login, req)).toMatchObject({ heads: [{ bindingId: a.event.id }], reason: null });
      for (const sql of ["SELECT predictive_source_witness_at($1,now())", "SELECT predictive_source_witness_check($1,now(),false)"])
        await expect(login.query(sql, [req])).rejects.toMatchObject({ code: "42501" });
      await expect(login.query("SELECT predictive_source_witness($1,now())", [req])).rejects.toMatchObject({ code: "42883" });
    });
    await withLogin(client, target, ["predictive_retention_owner"], async (login) => {
      await expect(sqlWitness(login, req)).rejects.toMatchObject({ code: "42501" });
      // A mistakenly granted EXECUTE still cannot bypass the membership guard.
      const user = (await login.query("SELECT session_user AS name")).rows[0].name;
      await client.query(`GRANT EXECUTE ON FUNCTION predictive_source_witness(jsonb) TO ${user}`);
      await expect(sqlWitness(login, req)).rejects.toMatchObject({ code: "42501", message: "predictive-source-witness-not-authorized" });
    });
    for (const bad of [{ ...req, extra: true }, { ...req, profileIds: [] }, { ...req, profileIds: Array(17).fill(request.profileId) },
      { ...req, entityKeys: Array(65).fill(factKey()) }, { ...req, entityKeys: [factKey() + ":extra"] },
      { ...req, entityKeys: ["team-game-stats:" + NORMALIZATION_GAME + ":nfl:team:LAR"] }, { ...req, cutoff: "tomorrow" }])
      await expect(sqlWitness(client, bad)).rejects.toMatchObject({ code: "23514", message: "predictive-source-witness-request-refused" });
    const revokedAt = await witnessClock(client);
    await client.query(`INSERT INTO predictive_rights_decisions(id,profile_id,predecessor_id,allowed_uses,effective_from,decided_at,evidence_kind,evidence_reference)
      VALUES ('sql-access-revoked',$1,$2,'{}',$3,$3,'synthetic','fixture revocation')`, [request.profileId, input.rightsDecisions[0].id, revokedAt]);
    expect(await sqlWitness(client, req)).toEqual(sourceFactWitness(await store.replaySourceStatsFacts(req)));
    expect(await sqlWitness(client, req)).toMatchObject({ reason: "rights-not-in-force", heads: [], withheld: [], missingEntityKeys: [] });
  });
});

it("CSV SQL witness migration upgrades v7 preserving bindings and prior migration history", async () => {
  await withProof(async ({ client, store, target }) => {
    const { request } = await seedBinding(store);
    const a = await store.recordSourceNormalization("sql-upgrade-A", request, null);
    const ledger = (await client.query("SELECT * FROM db_migrations ORDER BY version")).rows;
    const bindings = (await client.query("SELECT * FROM predictive_source_bindings ORDER BY id")).rows;
    const revisions = (await client.query("SELECT * FROM predictive_source_stats_revisions ORDER BY id")).rows;
    const files = await checkMigrationArtifacts(); const contracts = await loadCatalogContracts(files);
    const options = { ...target, files, verify: createCatalogVerifier(contracts) };
    expect(await runScratchMigrations(client, options)).toMatchObject({ executed: [8, 9, 10, 11, 12, 13, 14, 15, 16], schemaVersion: 16 });
    expect((await client.query("SELECT * FROM db_migrations ORDER BY version")).rows.slice(0, 7)).toEqual(ledger);
    expect((await client.query("SELECT * FROM predictive_source_bindings ORDER BY id")).rows).toEqual(bindings);
    expect((await client.query("SELECT * FROM predictive_source_stats_revisions ORDER BY id")).rows).toEqual(revisions);
    const scoped = factRequest(request.profileId, a.event.recordedAt);
    expect(await sqlWitness(client, scoped)).toEqual(sourceFactWitness(await store.replaySourceStatsFacts(scoped)));
    expect(await runScratchMigrations(client, options)).toMatchObject({ executed: [], schemaVersion: 16 });
    // The released-v4 upgrade test above seeds all five corpus tables and now
    // runs through 0008; this focused v7 test seeds source bindings as well.
  }, 7);
});

it("CSV SQL witness mismatch fails closed and restores the read-only replay transaction", async () => {
  await withProof(async ({ client, store, artifacts, target }) => {
    const { request } = await seedBinding(store);
    const a = await store.recordSourceNormalization("sql-parity-A", request, null);
    let checks = 0;
    const tracked = { query: async (sql: string, params?: unknown[]) => {
      const result = await client.query(sql, params);
      if (sql === "SELECT public.predictive_source_witness($1) AS witness") {
        expect((await client.query("SELECT current_setting('transaction_read_only') AS ro,current_setting('transaction_isolation') AS isolation")).rows[0])
          .toEqual({ ro: "on", isolation: "repeatable read" });
        result.rows[0].witness = rehashWitness({ ...result.rows[0].witness, heads: [] }); checks++;
      }
      return result;
    } } as unknown as Client;
    const reader = await createLocalPredictiveStore(tracked, target, artifacts);
    await expect(reader.replaySourceStatsFacts(factRequest(request.profileId, a.event.recordedAt))).rejects.toThrow("stored-source-witness-mismatch");
    expect(checks).toBe(1);
    expect((await client.query("SELECT current_setting('transaction_read_only') AS ro")).rows[0].ro).toBe("off");
    expect((await store.replaySourceStatsFacts(factRequest(request.profileId, a.event.recordedAt))).heads[0].head.id).toBe(a.event.id);
  });
});

it("CSV unavailable planning checks context rights before file hydration and revocation blocks saved conflicts and retries", async () => {
  await withProof(async ({ client, store, root }) => {
    const fixture = await normalizationFixture(); fixture.context.identityLinks = [];
    await store.publishSourceStats(fixture.input); await store.publish("rights-context", fixture.context, "2026-10-11T00:00:00.000Z");
    const request = { profileId: fixture.input.profile.id, rawGameId: sourceGameId, rawTeam: "PHI", rawPlayerId: "00-0000001" };
    const saved = await store.recordSourceNormalization("rights-unavailable", request, null);
    expect(saved.event.plan.reason).toBe("player-bridge-link-missing");
    await client.query("SELECT pg_sleep(0.005)"); const revokedAt = new Date().toISOString();
    await client.query(`INSERT INTO predictive_rights_decisions(id,profile_id,predecessor_id,allowed_uses,effective_from,effective_to,decided_at,evidence_kind,evidence_reference)
      VALUES ('unavailable-context-revoked',$1,$2,'{}',$3,NULL,$3,'synthetic','fixture revocation')`, [BRIDGE_PROFILE, "rights-" + BRIDGE_PROFILE, revokedAt]);
    await writeFile(join(root, ".db-blobs", fixture.context.artifacts[0].sha256 + ".json"), "damaged", { mode: 0o600 });
    expect(await store.replaySourceNormalization({ ...request, cutoff: saved.event.recordedAt })).toMatchObject({ reason: "rights-not-in-force", head: null });
    await expect(store.recordSourceNormalization("rights-unavailable", request, null)).rejects.toThrow("predictive-source-plan-rights-profile-invalid");
    expect(await store.planSourceStatsNormalization({ ...request, cutoff: revokedAt })).toMatchObject({ reason: "game-bridge-missing", binding: { dependencies: [] } });
    expect((await store.recordSourceNormalization("rights-new-unavailable", request, saved.event.id)).event.plan.reason).toBe("game-bridge-missing");
  });
});

const decisionScope = (profileId: string, kind: SourceDecisionRequest["kind"] = "reconciliation", entityKey = factKey()) =>
  ({ kind, profileIds: [profileId], entityKey });
const rehashDecision = (plan: SourceDecisionPlan) => {
  const { planDigest: _digest, ...fields } = plan; void _digest;
  return { ...plan, planDigest: digest(canonical(fields)) };
};
const publishInactive = async (store: Store, id = "native-inactive", predecessor: string | null = null,
  claim: "inactive-or-dnp" | "offensive-participant" = "inactive-or-dnp", at = "2026-10-09T12:00:00.000Z") => {
  const dataset: Dataset = { formatVersion: 2, profiles: [profile("native-participation")],
    rightsDecisions: predecessor ? [] : [rights("native-participation", { allowedUses: ["internal-research"] })],
    artifacts: [], captures: [], decisions: [], labels: [], identityLinks: [] };
  addCapture(dataset, id, [revision(id, "participation-evidence", { gameId: NORMALIZATION_GAME, playerId: "00-0000001",
    teamId: "nfl:team:PHI", evidenceKind: "participation-feed", claim }, predecessor)], at, "native-participation");
  expect(await store.publish(id, dataset, at)).toMatchObject({ status: "published" });
  return dataset;
};

it("CSV source decisions persist exact witnesses at database time with immutable history and idempotent retries", async () => {
  await withProof(async ({ client, store }) => {
    const { request } = await seedBinding(store);
    const binding = await store.recordSourceNormalization("decision-binding", request, null);
    for (const kind of ["reconciliation", "participation"] as const) {
      const scope = decisionScope(request.profileId, kind); const before = Date.now();
      const a = await store.recordSourceDecision("decision-" + kind, scope, null); const after = Date.now();
      expect(a).toMatchObject({ reused: false, featuresPublished: false, labelsFinalized: false,
        record: { predecessorId: null, plan: { mode: "synthetic-proof", state: "evaluated",
          witness: { heads: [{ bindingId: binding.event.id, revisionId: binding.event.revision!.id }] } } } });
      expect(Date.parse(a.record.recordedAt)).toBeGreaterThanOrEqual(before);
      expect(Date.parse(a.record.recordedAt)).toBeLessThanOrEqual(after);
      expect(a.record.plan.witness.cutoff <= a.record.recordedAt).toBe(true);
      expect(a.record.plan.outcome).toEqual(kind === "participation" ? { state: "offensive-participant" } :
        { result: "selected", rule: "single-source", selectedObservationId: binding.event.revision!.id });
      const atA = { ...scope, cutoff: a.record.recordedAt };
      const original = await store.replaySourceDecision(atA);
      expect(original).toMatchObject({ status: "current-source-decision", record: a.record });
      expect(await store.recordSourceDecision(a.record.id, scope, null)).toEqual({ ...a, reused: true });
      const b = await store.recordSourceDecision("successor-" + kind, scope, a.record.id);
      expect(sourceDecisionBasis(b.record.plan)).toBe(sourceDecisionBasis(a.record.plan));
      expect(await store.replaySourceDecision(atA)).toEqual(original);
      expect(await store.replaySourceDecision({ ...scope, cutoff: b.record.recordedAt })).toMatchObject({ record: b.record });
      await expect(store.recordSourceDecision(a.record.id, { ...scope, entityKey: factKey("00-0000002") }, null))
        .rejects.toThrow("source-decision-id-conflict");
      await expect(store.recordSourceDecision("bad-head-" + kind, scope, a.record.id)).rejects.toThrow("source-decision-head-conflict");
      for (const sql of ["UPDATE predictive_source_decisions SET plan=plan", "DELETE FROM predictive_source_decisions", "TRUNCATE predictive_source_decisions CASCADE"])
        await probe(client, async () => { await expect(client.query(sql)).rejects.toThrow("predictive-append-only"); });
    }
    expect((await client.query("SELECT count(*)::integer AS n FROM predictive_feature_runs")).rows[0].n).toBe(0);
    expect((await client.query("SELECT count(*)::integer AS n FROM predictive_outcome_labels")).rows[0].n).toBe(0);
  });
});

it("CSV source decision recaptures invalidate current records without changing earlier replay or numerical revisions", async () => {
  await withProof(async ({ client, store }) => {
    const { request } = await seedBinding(store); const binding = await store.recordSourceNormalization("recapture-binding-A", request, null);
    const scope = decisionScope(request.profileId); const a = await store.recordSourceDecision("recapture-decision-A", scope, null);
    const atA = { ...scope, cutoff: a.record.recordedAt }; const original = await store.replaySourceDecision(atA);
    const recapture = sourceClaimFixture("decision-recapture"); recapture.capturedAt = await witnessClock(client);
    await store.publishSourceStats(recapture);
    const stale = await store.replaySourceDecision({ ...scope, cutoff: await witnessClock(client) });
    expect(stale).toMatchObject({ status: "unavailable-source-decision", reason: "source-decision-stale", record: null,
      currentPlan: { state: "withheld", selected: null, outcome: null } });
    await probe(client, async () => { await expect(client.query("SELECT predictive_record_source_decision('stale',NULL,$1)", [a.record.plan]))
      .rejects.toThrow("source-decision-plan-stale"); });
    const nextBinding = await store.recordSourceNormalization("recapture-binding-B", request, binding.event.id);
    expect(nextBinding.event.revision).toEqual(binding.event.revision);
    expect(await store.replaySourceDecision({ ...scope, cutoff: nextBinding.event.recordedAt })).toMatchObject({ reason: "source-decision-stale", record: null });
    const b = await store.recordSourceDecision("recapture-decision-B", scope, a.record.id);
    expect(b.record.plan.selected).toMatchObject({ bindingId: nextBinding.event.id, revisionId: binding.event.revision!.id });
    expect(sourceDecisionBasis(b.record.plan)).not.toBe(sourceDecisionBasis(a.record.plan));
    expect(await store.replaySourceDecision(atA)).toEqual(original);
    expect(await store.recordSourceDecision(a.record.id, scope, null)).toEqual({ ...a, reused: true });
  });
});

it("CSV source participation combines native claims with positive usage and never infers absence from zero or blank statistics", async () => {
  for (const usage of ["positive", "zero", "blank"] as const) await withProof(async ({ client, store }) => {
    const row = { ...sourceSamples().player[0], attempts: usage === "positive" ? "10" : usage === "zero" ? "0" : "",
      carries: usage === "blank" ? "" : "0", targets: usage === "blank" ? "" : "0" };
    const fixture = await normalizationFixture("player", sourceCsv("player", [row]));
    await store.publishSourceStats(fixture.input); await store.publish("participation-context", fixture.context, "2026-10-11T00:00:00.000Z");
    const raw = { profileId: fixture.input.profile.id, rawGameId: sourceGameId, rawTeam: "PHI", rawPlayerId: "00-0000001" };
    await store.recordSourceNormalization("participation-binding", raw, null);
    const scope = decisionScope(raw.profileId, "participation");
    const a = await store.recordSourceDecision("participation-A", scope, null);
    expect(a.record.plan.outcome).toEqual({ state: usage === "positive" ? "offensive-participant" : "unresolved" });
    const before = await store.replaySourceDecision({ ...scope, cutoff: a.record.recordedAt });
    await publishInactive(store, "inactive-claim", null, "inactive-or-dnp", await witnessClock(client));
    expect(await store.replaySourceDecision({ ...scope, cutoff: await witnessClock(client) })).toMatchObject({ reason: "source-decision-stale", record: null });
    const b = await store.recordSourceDecision("participation-B", scope, a.record.id);
    expect(b.record.plan.outcome).toEqual({ state: usage === "positive" ? "conflicting" : "inactive-or-dnp" });
    expect(b.record.plan.nativeInputs).toMatchObject([{ observationId: "inactive-claim", profileId: "native-participation" }]);
    expect(await store.replaySourceDecision({ ...scope, cutoff: a.record.recordedAt })).toEqual(before);
    await publishInactive(store, "active-claim", "inactive-claim", "offensive-participant", await witnessClock(client));
    const c = await store.recordSourceDecision("participation-C", scope, b.record.id);
    expect(c.record.plan.outcome).toEqual({ state: "offensive-participant" });
    expect(c.record.plan.nativeInputs.map((input) => input.observationId)).toEqual(["active-claim"]);
  });
});

it("CSV source decisions persist unavailable plans and recover without stale selections while missing facts remain insufficient", async () => {
  await withProof(async ({ client, store }) => {
    const { request, bridgeRows } = await seedBinding(store);
    const bindingA = await store.recordSourceNormalization("recovery-binding-A", request, null);
    const scope = decisionScope(request.profileId);
    const a = await store.recordSourceDecision("recovery-decision-A", scope, null);
    const original = await store.replaySourceDecision({ ...scope, cutoff: a.record.recordedAt });
    const schedule = bridgeRows.find((row) => row.kind === "schedule")!;
    const changes: Dataset = { formatVersion: 2, profiles: [profile(BRIDGE_PROFILE)], rightsDecisions: [], artifacts: [], captures: [], decisions: [], labels: [], identityLinks: [] };
    const atB = await witnessClock(client);
    addCapture(changes, "decision-wrong-schedule", [revision("decision-wrong-schedule", "schedule", { ...schedule.data, week: 5 }, schedule.id)], atB, BRIDGE_PROFILE);
    await store.publish("decision-wrong-schedule", changes, atB);
    const bindingB = await store.recordSourceNormalization("recovery-binding-B", request, bindingA.event.id);
    const b = await store.recordSourceDecision("recovery-decision-B", scope, a.record.id);
    expect(b.record.plan).toMatchObject({ state: "withheld", outcome: null, selected: null,
      witness: { withheld: [{ bindingId: bindingB.event.id, reason: "source-schedule-context-conflict" }] } });
    const unavailable = await store.replaySourceDecision({ ...scope, cutoff: b.record.recordedAt });
    expect(unavailable).toMatchObject({ reason: "source-evidence-withheld", record: null });
    expect(sourceDecisionBasis(unavailable.currentPlan!)).toBe(sourceDecisionBasis(b.record.plan));
    const recovery = await witnessClock(client); changes.artifacts = []; changes.captures = [];
    addCapture(changes, "decision-recovered-schedule", [revision("decision-recovered-schedule", "schedule", schedule.data, "decision-wrong-schedule")], recovery, BRIDGE_PROFILE);
    await store.publish("decision-recovered-schedule", changes, recovery);
    const bindingC = await store.recordSourceNormalization("recovery-binding-C", request, bindingB.event.id);
    const c = await store.recordSourceDecision("recovery-decision-C", scope, b.record.id);
    expect(c.record.plan).toMatchObject({ state: "evaluated", outcome: { result: "selected" }, selected: { bindingId: bindingC.event.id, revisionId: bindingA.event.revision!.id } });
    expect(await store.replaySourceDecision({ ...scope, cutoff: c.record.recordedAt })).toMatchObject({ status: "current-source-decision", record: c.record });
    expect(await store.replaySourceDecision({ ...scope, cutoff: a.record.recordedAt })).toEqual(original);
    expect(await store.replaySourceDecision({ ...scope, cutoff: b.record.recordedAt })).toMatchObject({ reason: "source-evidence-withheld" });
    const missingScope = decisionScope(request.profileId, "reconciliation", factKey("00-0000002"));
    const missing = await store.recordSourceDecision("missing-decision", missingScope, null);
    expect(missing.record.plan).toMatchObject({ state: "evaluated", selected: null,
      outcome: { result: "insufficient-sources", selectedObservationId: null, rule: "no-candidates" } });
    expect(await store.replaySourceDecision({ ...missingScope, cutoff: missing.record.recordedAt })).toMatchObject({ status: "current-source-decision", record: missing.record });
    // Current means the immutable calculation is fresh; it does not imply that
    // an unresolved/conflicting/empty calculation is usable in a final label.
    expect((await client.query("SELECT count(*)::integer AS n FROM predictive_outcome_labels")).rows[0].n).toBe(0);
  });
});

it("CSV source decision SQL recomputes rehashed outcomes, exact inputs, witness scope, selection and mode", async () => {
  await withProof(async ({ client, store }) => {
    const { request } = await seedBinding(store); await store.recordSourceNormalization("forgery-binding", request, null);
    await publishInactive(store);
    for (const kind of ["reconciliation", "participation"] as const) {
      const plan = await store.planSourceDecision({ ...decisionScope(request.profileId, kind), cutoff: await witnessClock(client) });
      const variants = [
        { ...plan, outcome: kind === "reconciliation" ? { result: "conflict", selectedObservationId: null, rule: "material-discrepancy" } : { state: "offensive-participant" } },
        { ...plan, selected: null, outcome: null }, { ...plan, mode: "production-research" },
        { ...plan, state: "withheld" }, { ...plan, nativeInputs: [] },
        { ...plan, witness: rehashWitness({ ...plan.witness, heads: [] }) },
        { ...plan, witness: rehashWitness({ ...plan.witness, entityKeys: [factKey("00-0000002")] }) },
        { ...plan, selected: plan.selected ? { ...plan.selected, bindingId: "forged-binding" } : { bindingId: "forged-binding" } },
        { ...plan, policyId: "invented-v9" }, { ...plan, invented: true },
      ];
      for (const candidate of variants) {
        if (canonical(candidate) === canonical(plan)) continue;
        await probe(client, async () => {
          await expect(client.query("SELECT predictive_record_source_decision('forged',NULL,$1)", [rehashDecision(candidate as SourceDecisionPlan)]))
            .rejects.toMatchObject({ code: "23514", message: "source-decision-plan-invalid" });
        });
      }
    }
    expect((await client.query("SELECT count(*)::integer AS n FROM predictive_source_decisions")).rows[0].n).toBe(0);
  });
});

it("CSV source decision recorder and replay enforce actual non-superuser privileges and database-clock access", async () => {
  await withProof(async ({ client, store, artifacts, target }) => {
    const { request } = await seedBinding(store); await store.recordSourceNormalization("roles-binding", request, null);
    const scope = decisionScope(request.profileId);
    await withLogin(client, target, ["predictive_recorder", "predictive_replay", "predictive_harness"], async (writer, writerTarget) => {
      const restricted = await createLocalPredictiveStore(writer, writerTarget, artifacts);
      const a = await restricted.recordSourceDecision("roles-decision", scope, null);
      for (const table of ["predictive_source_decisions", "predictive_source_decision_bindings", "predictive_source_decision_inputs", "predictive_source_decision_rights"])
        await expect(writer.query(`INSERT INTO ${table} DEFAULT VALUES`)).rejects.toMatchObject({ code: "42501" });
      await expect(writer.query("SELECT predictive_source_decision_plan_at($1,clock_timestamp())", [{ ...scope, cutoff: a.record.recordedAt }]))
        .rejects.toMatchObject({ code: "42501" });
      await withLogin(client, target, ["predictive_replay"], async (reader, readerTarget) => {
        let checked = 0;
        const tracked = { query: async (sql: string, params?: unknown[]) => {
          if (sql === "SELECT public.predictive_source_decision_plan($1) AS plan") {
            expect((await reader.query("SELECT current_setting('transaction_read_only') AS ro,current_setting('transaction_isolation') AS isolation")).rows[0])
              .toEqual({ ro: "on", isolation: "repeatable read" }); checked++;
          }
          return reader.query(sql, params);
        } } as unknown as Client;
        const replay = await createLocalPredictiveStore(tracked, readerTarget, artifacts);
        expect(await replay.replaySourceDecision({ ...scope, cutoff: a.record.recordedAt })).toMatchObject({ status: "current-source-decision", record: a.record });
        expect(checked).toBeGreaterThan(0);
        await expect(reader.query("SELECT predictive_record_source_decision('denied',NULL,$1)", [a.record.plan])).rejects.toMatchObject({ code: "42501" });
        await expect(reader.query("SELECT predictive_source_decision_basis($1)", [a.record.plan])).rejects.toMatchObject({ code: "42501" });
      });
    });
    await withLogin(client, target, ["predictive_recorder", "predictive_replay"], async (writer, writerTarget) => {
      const restricted = await createLocalPredictiveStore(writer, writerTarget, artifacts);
      await expect(restricted.recordSourceDecision("no-harness", scope, "roles-decision")).rejects.toThrow("predictive-synthetic-outside-harness");
    });
    await withLogin(client, target, ["predictive_retention_owner"], async (owner) => {
      await expect(owner.query("SELECT predictive_source_decision_plan($1)", [{ ...scope, cutoff: await witnessClock(client) }])).rejects.toMatchObject({ code: "42501" });
    });
  });
});

it("CSV source decision current source, historical context and native rights are checked before any file opens", async () => {
  for (const revoked of ["source", "context", "native"] as const) await withProof(async ({ client, store, artifacts, target }) => {
    const { request, input } = await seedBinding(store); await store.recordSourceNormalization("rights-decision-binding", request, null);
    await publishInactive(store);
    const scope = decisionScope(request.profileId, "participation"); const a = await store.recordSourceDecision("rights-decision", scope, null);
    const profileId = revoked === "source" ? input.profile.id : revoked === "context" ? BRIDGE_PROFILE : "native-participation";
    const prior = revoked === "source" ? input.rightsDecisions[0].id : "rights-" + profileId;
    const at = await witnessClock(client);
    await client.query(`INSERT INTO predictive_rights_decisions(id,profile_id,predecessor_id,allowed_uses,effective_from,decided_at,evidence_kind,evidence_reference)
      VALUES ('decision-revoked',$1,$2,'{}',$3,$3,'synthetic','fixture revocation')`, [profileId, prior, at]);
    let reads = 0;
    const denied = async () => { reads++; throw new Error("provider bytes opened before access check"); };
    const gated = await createLocalPredictiveStore(client, target, { ...artifacts, database: { ...artifacts.database, read: denied } });
    expect(await gated.replaySourceDecision({ ...scope, cutoff: a.record.recordedAt })).toMatchObject({ reason: "rights-not-in-force", record: null, currentPlan: null });
    await expect(gated.recordSourceDecision(a.record.id, scope, null)).rejects.toThrow("source-decision-access-refused");
    await expect(client.query("SELECT predictive_source_decision_plan($1)", [{ ...scope, cutoff: a.record.recordedAt }])).rejects.toThrow("source-decision-access-refused");
    expect(reads).toBe(0);
  });
});

it("CSV source decision replay refuses corrupted source and native bytes, association omissions and SQL parity mismatches", async () => {
  await withProof(async ({ client, store, root, artifacts, target }) => {
    const { request, input } = await seedBinding(store); await store.recordSourceNormalization("integrity-decision-binding", request, null);
    const native = await publishInactive(store); const scope = decisionScope(request.profileId, "participation");
    const a = await store.recordSourceDecision("integrity-decision", scope, null); const req = { ...scope, cutoff: a.record.recordedAt };
    for (const [ref, bytes] of [[input.artifact.sha256 + ".csv", input.artifact.bytes], [native.artifacts[0].sha256 + ".json", native.artifacts[0].bytes]]) {
      await writeFile(join(root, ".db-blobs", ref), "damaged", { mode: 0o600 });
      await expect(store.replaySourceDecision(req)).rejects.toThrow("artifact-integrity-failed");
      await writeFile(join(root, ".db-blobs", ref), bytes, { mode: 0o600 });
    }
    for (const table of ["predictive_source_decision_bindings", "predictive_source_decision_inputs", "predictive_source_decision_rights"]) {
      const rows = (await client.query(`SELECT * FROM ${table} WHERE decision_id=$1`, [a.record.id])).rows;
      expect(rows.length).toBeGreaterThan(0);
      await client.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
      await client.query(`DELETE FROM ${table} WHERE decision_id=$1`, [a.record.id]);
      await expect(store.replaySourceDecision(req)).rejects.toThrow("stored-source-decision-associations-mismatch");
      for (const row of rows) await client.query(`INSERT INTO ${table} VALUES ($1,$2)`, Object.values(row));
      await client.query(`ALTER TABLE ${table} ENABLE TRIGGER USER`);
    }
    const tracked = { query: async (sql: string, params?: unknown[]) => {
      const result = await client.query(sql, params);
      if (sql === "SELECT public.predictive_source_decision_plan($1) AS plan")
        result.rows[0].plan = rehashDecision({ ...result.rows[0].plan, outcome: { state: "offensive-participant" } });
      return result;
    } } as unknown as Client;
    const corrupt = await createLocalPredictiveStore(tracked, target, artifacts);
    await expect(corrupt.replaySourceDecision(req)).rejects.toThrow("stored-source-decision-plan-mismatch");
    expect((await client.query("SELECT current_setting('transaction_read_only') AS ro")).rows[0].ro).toBe("off");
    expect(await store.replaySourceDecision(req)).toMatchObject({ status: "current-source-decision", record: a.record });
  });
});

it("CSV source decision concurrent recorders commit exactly one proposal for the expected head", async () => {
  await withProof(async ({ client, store, artifacts, target }) => {
    const { request } = await seedBinding(store); await store.recordSourceNormalization("decision-race-binding", request, null);
    const scope = decisionScope(request.profileId); const a = await store.recordSourceDecision("decision-race-A", scope, null);
    await withLogin(client, target, ["predictive_recorder", "predictive_replay", "predictive_harness"], async (one, oneTarget) => {
      await withLogin(client, target, ["predictive_recorder", "predictive_replay", "predictive_harness"], async (two, twoTarget) => {
        const first = await createLocalPredictiveStore(one, oneTarget, artifacts);
        const second = await createLocalPredictiveStore(two, twoTarget, artifacts);
        await client.query("BEGIN"); await client.query("SELECT pg_advisory_xact_lock(520052,1)");
        const pending = Promise.allSettled([first.recordSourceDecision("decision-race-B", scope, a.record.id),
          second.recordSourceDecision("decision-race-C", scope, a.record.id)]);
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
        const result = await pending;
        expect(result.filter((row) => row.status === "fulfilled")).toHaveLength(1);
        const failed = result.find((row) => row.status === "rejected");
        expect(failed?.status === "rejected" && failed.reason.message).toBe("source-decision-head-conflict");
        expect((await client.query("SELECT count(*)::integer AS n FROM predictive_source_decisions")).rows[0].n).toBe(2);
      });
    });
  });
});

it("CSV source decision retention removes cited source history and descendants with identical restored-backup audit", async () => {
  const fixture = await normalizationFixture(); let history: RecordedRetentionEvent[] = [];
  const publishChain = async (store: Store) => {
    await store.publishSourceStats(fixture.input); await store.publish("decision-retention-context", fixture.context, "2026-10-11T00:00:00.000Z");
    const raw = { profileId: fixture.input.profile.id, rawGameId: sourceGameId, rawTeam: "PHI", rawPlayerId: "00-0000001" };
    await store.recordSourceNormalization("retained-decision-binding", raw, null);
    const scope = decisionScope(raw.profileId);
    await store.recordSourceDecision("retained-decision-A", scope, null);
    await store.recordSourceDecision("retained-decision-B", scope, "retained-decision-A");
    const unrelated = sourceClaimFixture("decision-unrelated-team", "team"); await store.publishSourceStats(unrelated);
    await store.recordSourceDecision("unrelated-decision", decisionScope(unrelated.profile.id, "reconciliation",
      "team-game-stats:" + NORMALIZATION_GAME + ":nfl:team:PHI"), null);
  };
  await withProof(async ({ client, store, artifacts, target }) => {
    await publishChain(store);
    await withLogin(client, target, ["predictive_retention_owner"], async (login, loginTarget) => {
      const owner = await createLocalPredictiveStore(login, loginTarget, artifacts);
      const retained = await owner.retain({ id: "source-decision-retention", reason: "provider-request", authority: "synthetic test",
        decidedAt: fixture.input.capturedAt, scope: { kind: "source", profileIds: [fixture.input.profile.id], capturedFrom: null, capturedBefore: null }, auditLevel: "full" });
      expect(retained.removedCounts).toMatchObject({ sourceDecisions: 2, sourceDecisionLinks: 6 });
      expect(retained.removedIdsDigest).toBe(retentionIdsDigest((await client.query("SELECT target_kind AS kind,target_id AS id FROM predictive_retention_tombstones")).rows));
      history = await owner.retentionEvents();
    });
    expect((await client.query("SELECT id FROM predictive_source_decisions ORDER BY id")).rows).toEqual([{ id: "unrelated-decision" }]);
  });
  await withProof(async ({ client, store }) => {
    await publishChain(store);
    expect(await store.reapply(history)).toEqual([{ eventId: "source-decision-retention", status: "reapplied", matched: true }]);
    expect(await store.reapply(history)).toEqual([{ eventId: "source-decision-retention", status: "present", matched: true }]);
    expect((await client.query("SELECT id FROM predictive_source_decisions ORDER BY id")).rows).toEqual([{ id: "unrelated-decision" }]);
  });
});

it("CSV source decision native retention deletes the entire affected lineage without reviving an earlier positive record", async () => {
  await withProof(async ({ client, store, artifacts, target }) => {
    const { request } = await seedBinding(store); await store.recordSourceNormalization("native-retention-binding", request, null);
    const scope = decisionScope(request.profileId, "participation");
    const a = await store.recordSourceDecision("native-retention-A", scope, null);
    await publishInactive(store);
    const b = await store.recordSourceDecision("native-retention-B", scope, a.record.id);
    await store.recordSourceDecision("native-retention-C", scope, b.record.id);
    const unrelated = await store.recordSourceDecision("native-retention-unrelated", decisionScope(request.profileId), null);
    await withLogin(client, target, ["predictive_retention_owner"], async (login, loginTarget) => {
      const owner = await createLocalPredictiveStore(login, loginTarget, artifacts);
      const retained = await owner.retain({ id: "native-decision-retention", reason: "provider-request", authority: "synthetic test",
        decidedAt: "2026-10-09T12:00:00.000Z", scope: { kind: "source", profileIds: ["native-participation"], capturedFrom: null, capturedBefore: null }, auditLevel: "full" });
      expect(retained.removedCounts).toMatchObject({ sourceDecisions: 3, sourceDecisionLinks: 13, observations: 1 });
      expect(retained.removedIdsDigest).toBe(retentionIdsDigest((await client.query("SELECT target_kind AS kind,target_id AS id FROM predictive_retention_tombstones")).rows));
    });
    expect((await client.query("SELECT id FROM predictive_source_decisions ORDER BY id")).rows).toEqual([{ id: unrelated.record.id }]);
    expect(await store.replaySourceDecision({ ...scope, cutoff: await witnessClock(client) })).toMatchObject({ reason: "source-decision-missing", record: null });
    expect((await client.query("SELECT id FROM predictive_source_bindings")).rows).toEqual([{ id: "native-retention-binding" }]);
  });
});

it("CSV source decision retention conservatively removes capture-less scopes inside time-limited source deletions", async () => {
  await withProof(async ({ client, store }) => {
    const fixture = await normalizationFixture(); await store.publish("decision-capture-less", fixture.context, "2026-10-11T00:00:00.000Z");
    const scope = decisionScope(fixture.input.profile.id);
    const a = await store.recordSourceDecision("capture-less-decision-A", scope, null);
    await store.recordSourceDecision("capture-less-decision-B", scope, a.record.id);
    expect(a.record.plan.outcome).toMatchObject({ result: "insufficient-sources" });
    const retained = await store.retain({ id: "capture-less-decision-retention", reason: "provider-request", authority: "synthetic test",
      decidedAt: fixture.input.capturedAt, scope: { kind: "source", profileIds: [fixture.input.profile.id],
        capturedFrom: "2026-10-01T00:00:00.000Z", capturedBefore: "2026-10-02T00:00:00.000Z" }, auditLevel: "digest-only" });
    expect(retained.removedCounts).toMatchObject({ sourceDecisions: 2, sourceDecisionLinks: 2 });
    expect((await client.query("SELECT count(*)::integer AS n FROM predictive_source_decisions")).rows[0].n).toBe(0);
  });
});

it("CSV source decision migration upgrades v8 preserving recorded bindings and witnesses and reruns as a no-op", async () => {
  await withProof(async ({ client, target, store }) => {
    const { request } = await seedBinding(store); const a = await store.recordSourceNormalization("decision-upgrade-binding", request, null);
    const req = factRequest(request.profileId, a.event.recordedAt); const witness = await sqlWitness(client, req);
    const bindings = (await client.query("SELECT * FROM predictive_source_bindings ORDER BY id")).rows;
    const ledger = (await client.query("SELECT * FROM db_migrations ORDER BY version")).rows;
    const files = await checkMigrationArtifacts(); const contracts = await loadCatalogContracts(files);
    const options = { ...target, files, verify: createCatalogVerifier(contracts) };
    expect(await runScratchMigrations(client, options)).toMatchObject({ executed: [9, 10, 11, 12, 13, 14, 15, 16], schemaVersion: 16 });
    expect((await client.query("SELECT * FROM db_migrations ORDER BY version")).rows.slice(0, 8)).toEqual(ledger);
    expect((await client.query("SELECT * FROM predictive_source_bindings ORDER BY id")).rows).toEqual(bindings);
    expect(await sqlWitness(client, req)).toEqual(witness);
    expect(await runScratchMigrations(client, options)).toMatchObject({ executed: [], schemaVersion: 16 });
    const decision = await store.recordSourceDecision("after-decision-upgrade", decisionScope(request.profileId), null);
    expect(decision.record.plan.witness.heads).toEqual(witness.heads);
  }, 8);
});

it("CSV source reconciliation evaluates every bound provider and deterministic agreement also supports team facts", async () => {
  for (const feed of ["player", "team"] as const) await withProof(async ({ client, store }) => {
    const { request, input } = await seedBinding(store, feed);
    const a = await store.recordSourceNormalization("provider-A-binding", request, null);
    const key = feed === "player" ? factKey() : "team-game-stats:" + NORMALIZATION_GAME + ":nfl:team:PHI";
    const second = sourceClaimFixture("provider-B", feed);
    const other = "csv-other-" + feed; second.profile.id = other;
    second.artifact.profileId = other; second.rightsDecisions[0] = { ...second.rightsDecisions[0], id: "rights:" + other, profileId: other };
    await store.publishSourceStats(second);
    if (feed === "player") await client.query(`INSERT INTO predictive_profile_identity_links VALUES
      ('provider-B-link',$1,$2,'gsis','2026-01-01T00:00:00Z')`, [other, BRIDGE_PROFILE]);
    const raw = { ...request, profileId: other };
    const b = await store.recordSourceNormalization("provider-B-binding", raw, null);
    expect(b.event.revision?.data).toEqual(a.event.revision?.data);
    const scope = { ...decisionScope(input.profile.id, "reconciliation", key), profileIds: [other, input.profile.id] };
    const agreed = await store.recordSourceDecision("providers-agree", scope, null);
    const expected = input.profile.id < other ? a.event : b.event;
    expect(agreed.record.plan).toMatchObject({ witness: { heads: [{}, {}] }, outcome: {
      result: "selected", rule: "sources-agree", selectedObservationId: expected.revision!.id }, selected: { bindingId: expected.id } });
    const original = await store.replaySourceDecision({ ...scope, cutoff: agreed.record.recordedAt });
    const changed = sourceClaimFixture("provider-B-corrected", feed, sourceCsv(feed, [{ ...sourceSamples()[feed][0], passing_yards: "95" }]));
    changed.profile = second.profile; changed.artifact.profileId = other; changed.rightsDecisions = [];
    changed.capturedAt = await witnessClock(client); await store.publishSourceStats(changed);
    await store.recordSourceNormalization("provider-B-binding-corrected", raw, b.event.id);
    const disputed = await store.recordSourceDecision("providers-disagree", scope, agreed.record.id);
    expect(disputed.record.plan).toMatchObject({ outcome: { result: "conflict", rule: "material-discrepancy", selectedObservationId: null }, selected: null });
    expect(await store.replaySourceDecision({ ...scope, cutoff: disputed.record.recordedAt })).toMatchObject({ status: "current-source-decision", record: disputed.record });
    expect(await store.replaySourceDecision({ ...scope, cutoff: agreed.record.recordedAt })).toEqual(original);
  });
});

const seedConsumers = async (store: Store, captureAt = "2026-10-11T12:00:00.000Z", pregameSchedule = false) => {
  const fixture = await normalizationFixture();
  fixture.input.capturedAt = captureAt;
  fixture.input.rightsDecisions[0].allowedUses = ["internal-research","model-input","outcome-label"];
  fixture.context.rightsDecisions = [...fixture.input.rightsDecisions,rights(BRIDGE_PROFILE)];
  const prior = { ...schedule(6,"2026-10-04T17:00:00.000Z","nfl:team:PHI","nfl:team:CAR"),gameId: NORMALIZATION_GAME,rawGameId: sourceGameId };
  const target = schedule(77,"2026-10-18T17:00:00.000Z","nfl:team:PHI","nfl:team:CAR");
  const rows = fixture.bridgeRows.map((row) => row.kind === "schedule" ? { ...row,data: prior } : row);
  rows.push(revision("source-target","schedule",target),revision("source-coverage","schedule-coverage",coverage("nfl:team:PHI",[prior.gameId,target.gameId])),
    revision("source-prior-member","membership",membership(prior)),revision("source-target-member","membership",membership(target)),
    ...completionMarkers(prior));
  rewriteNormalizationRows(fixture.context,rows);
  Object.assign(fixture.context.artifacts[0],{ scopeKind: "season-file",scopeSeason: 2026 });
  fixture.context.captures[0].capturedAt=fixture.context.captures[0].availableAt=fixture.context.captures[0].ingestedAt="2026-10-07T12:00:00.000Z";
  if (pregameSchedule) addCapture(fixture.context, "prior-pregame-schedule", rows.filter((row) => row.id === "game-schedule"),
    "2026-10-01T12:00:00.000Z", BRIDGE_PROFILE);
  const native = createReplay(fixture.context,"2026-10-12T12:00:00.000Z","2026-10-12T12:00:00.000Z","internal-research");
  fixture.context.decisions=[recordCompletion("source-prior-completed",prior.gameId,native.completion(prior.gameId).inputs,
    "2026-10-08T12:00:00.000Z","synthetic-proof")];
  await store.publishSourceStats(fixture.input);
  expect(await store.publish("consumer-context",fixture.context,"2026-10-12T12:00:00.000Z")).toMatchObject({ status: "published" });
  const raw = { profileId: fixture.input.profile.id,rawGameId: sourceGameId,rawTeam: "PHI",rawPlayerId: "00-0000001" };
  const binding = await store.recordSourceNormalization("consumer-binding",raw,null);
  const rec = await store.recordSourceDecision("consumer-reconciliation",decisionScope(raw.profileId),null);
  const part = await store.recordSourceDecision("consumer-participation",decisionScope(raw.profileId,"participation"),null);
  const request = { playerId: "00-0000001",gameId: target.gameId,cutoff: part.record.recordedAt,computedAt: part.record.recordedAt,
    candidate: "stats-v1:player_pass_yds" as const };
  return { fixture,raw,binding,rec,part,request,profiles: [raw.profileId],labelRequest: { playerId: request.playerId,gameId: prior.gameId,profileIds: [raw.profileId] } };
};
const sqlConsumer = async (client: Client,body: SourceConsumerBody,id = "forged-consumer",head: string | null = null) => {
  const sha = digest(canonical(body));
  await client.query(`INSERT INTO predictive_blobs(sha256,byte_size,media_type,storage_ref) VALUES($1,$2,'application/json',$3) ON CONFLICT DO NOTHING`,
    [sha,Buffer.byteLength(canonical(body)),sha + ".json"]);
  return client.query("SELECT predictive_record_source_consumer($1,$2,$3)",[id,head,body]);
};

const metadataRun = (slots: TrainingSlot[], profileIds: string[], fitCutoff: string): FittingRunRequest => ({
  version: "qb-training-read-v1", fittingRunId: "metadata-run", evaluationPlanId: "metadata-plan", foldId: "metadata-fold", fitCutoff,
  selection: { market: "player_pass_yds", stat: "passing_yards", candidate: "stats-v1:player_pass_yds", featureVersion: "passing-yards-source-v1",
    labelVersion: "source-final-label-v1", historyPolicy: TRAINING_HISTORY_POLICY, historyPolicySha256: TRAINING_HISTORY_SHA256, profileIds },
  modelIdentity: { modelVersion: "synthetic-proof", codeCommit: "a".repeat(40), configurationSha256: "b".repeat(64) },
  splitPolicy: { version: "target-event-disjoint-v1", evaluationMode: "walk-forward", aggregationPolicyId: "unique-events-v1", aggregationPolicySha256: "c".repeat(64) },
  population: { status: "unqualified", enumerationOrigin: "synthetic-explicit-slots", enumerationSha256: "d".repeat(64) }, slots,
});
const previewRequest = async (client: Client, seed: Awaited<ReturnType<typeof seedConsumers>>) => {
  const slot: TrainingSlot = { datasetId: "preview-evaluation", partition: "evaluation", playerId: seed.request.playerId,
    gameId: seed.request.gameId, season: 2026, seasonType: "REG", kickoff: "2026-10-18T17:00:00.000Z",
    kickoffObservationId: "source-target", featureCutoff: seed.request.cutoff, labelsAsOf: await witnessClock(client),
    featureRef: null, labelRef: null };
  return metadataRun([slot], seed.profiles, seed.request.cutoff);
};

const withDatasetProof = withProof;
const datasetRequest = (inventory: Awaited<ReturnType<Store["prepareFittingRun"]>>, pinId = "dataset-pin-A") => ({
  version: "qb-training-read-v1" as const, fittingRunId: inventory.request.fittingRunId,
  inventorySha256: inventory.inventorySha256, datasetId: inventory.rows[0].slot.datasetId, pinId,
});
const advanceDatasetClock = async (client: Client, time: string) => {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(time)) throw new Error("test-clock-refused");
  const replacement = "'" + time + "'::timestamptz";
  for (const signature of ["public.predictive_training_dataset_read(text)", "public.predictive_pin_training_dataset(text,text,text,text)",
    "public.predictive_training_retention_hook()", "public.predictive_training_dataset_expiry_hook()", "public.predictive_prepare_training_run(jsonb)",
    "public.predictive_retention_execute(text,text,text,timestamptz,jsonb,text)"]) {
    const sql = (await client.query("SELECT pg_get_functiondef($1::regprocedure) AS sql", [signature])).rows[0].sql as string;
    await client.query(sql.replaceAll("pg_catalog.clock_timestamp()", replacement).replaceAll("clock_timestamp()", replacement)
      .replaceAll("pg_catalog.now()", replacement));
  }
};

it("QB dataset sealing fixes assigned membership and closure with atomic audited pins through restricted roles", async () => {
  await withDatasetProof(async ({ client, store, target, artifacts }) => {
    const seed = await seedConsumers(store);
    const a = await store.recordSourcePassingYards("dataset-feature-A", seed.request, seed.profiles);
    const input = await previewRequest(client, seed); input.slots.push({ ...input.slots[0], playerId: "00-0000002" });
    const inventory = await store.prepareFittingRun(input);
    await store.recordSourcePassingYards("dataset-feature-B", seed.request, seed.profiles);
    await withLogin(client, target, ["predictive_recorder", "predictive_replay"], async (login, loginTarget) => {
      const reader = await createLocalPredictiveStore(login, loginTarget, artifacts);
      const req = datasetRequest(inventory); const saved = await reader.prepareDataset(req);
      expect(saved).toMatchObject({ status: "sealed", fittingReady: false, populationCoverage: "unqualified", activePin: true,
        rows: [{ ordinal: 0, selection: { featureId: a.id }, feature: { state: "usable" } }, { ordinal: 1, feature: { state: "missing" } }],
        pin: { id: req.pinId, reused: false }, byteVerification: "required-on-every-access" });
      expect(saved.closure.references).toEqual(expect.arrayContaining([
        { kind: "source-consumer", id: a.id }, { kind: "source-binding", id: seed.binding.event.id },
        { kind: "source-decision", id: seed.part.record.id }, { kind: "observation", id: "source-target" },
      ]));
      expect(saved.closure.blobs.map((b) => b.sha256)).toContain(a.bodySha256);
      expect(saved.closure.references).not.toContainEqual({ kind: "source-consumer", id: "dataset-feature-B" });
      expect(JSON.stringify(saved)).not.toContain('"passingYardsSum":');
      const retry = await reader.prepareDataset(req);
      expect(retry.manifestSha256).toBe(saved.manifestSha256); expect(retry.recordedAt).toBe(saved.recordedAt);
      expect(retry.pin).toMatchObject({ reused: true, recordedAt: saved.pin.recordedAt });
      const extra = await reader.pinDataset({ ...req, pinId: "dataset-pin-B" });
      expect(extra.manifestSha256).toBe(saved.manifestSha256); expect(extra.pin.reused).toBe(false);
      expect((await reader.readDatasetManifest(req.datasetId))?.manifestSha256).toBe(saved.manifestSha256);
      for (const table of ["predictive_training_datasets", "predictive_training_dataset_consumers", "predictive_training_dataset_pins", "predictive_training_dataset_releases"]) {
        await expect(login.query(`SELECT * FROM ${table}`)).rejects.toMatchObject({ code: "42501" });
        await expect(login.query(`DELETE FROM ${table}`)).rejects.toMatchObject({ code: "42501" });
      }
      await expect(reader.prepareDataset({ ...req, inventorySha256: "0".repeat(64) })).rejects.toThrow("training-dataset-inventory-mismatch");
      await expect(login.query("SELECT predictive_prepare_training_dataset($1)", [{ ...req, rows: saved.rows }])).rejects.toThrow("training-dataset-request-refused");
      const charge = (await client.query("SELECT charged_bytes FROM predictive_training_datasets WHERE id=$1", [req.datasetId])).rows[0].charged_bytes;
      const { manifestSha256: _sha, activePin: _active, pin: _pin, reused: _reuse, ...body } = saved; void _sha; void _active; void _pin; void _reuse;
      expect(Number(charge)).toBe(saved.closure.blobs.reduce((sum, b) => sum + Number(b.byteSize), 0) + Buffer.byteLength(canonical(body)));
    });
  });
});

it("QB dataset preparation rolls back all manifest and pin state when closure bytes are damaged", async () => {
  await withDatasetProof(async ({ client, store, root }) => {
    const seed = await seedConsumers(store); const feature = await store.recordSourcePassingYards("dataset-rollback-feature", seed.request, seed.profiles);
    const inventory = await store.prepareFittingRun(await previewRequest(client, seed)); const req = datasetRequest(inventory);
    const path = join(root, ".db-blobs", feature.bodySha256 + ".json"); const bytes = await readFile(path);
    try { await writeFile(path, "damaged"); await expect(store.prepareDataset(req)).rejects.toThrow("artifact-integrity-failed"); }
    finally { await writeFile(path, bytes); }
    for (const table of ["predictive_training_dataset_identities", "predictive_training_datasets", "predictive_training_dataset_consumers", "predictive_training_pin_identities", "predictive_training_dataset_pins"]) {
      expect((await client.query(`SELECT count(*)::integer AS n FROM ${table}`)).rows[0].n).toBe(0);
    }
    expect((await store.prepareDataset(req)).pin.reused).toBe(false);
    try { await writeFile(path, "damaged-after-seal"); await expect(store.readDatasetManifest(req.datasetId)).rejects.toThrow("artifact-integrity-failed"); }
    finally { await writeFile(path, bytes); }
  });
});

it("QB dataset independent releases are idempotent and never renew the original feature expiry", async () => {
  await withDatasetProof(async ({ client, store }) => {
    const seed = await seedConsumers(store); await store.recordSourcePassingYards("dataset-release-feature", seed.request, seed.profiles);
    const inventory = await store.prepareFittingRun(await previewRequest(client, seed)); const req = datasetRequest(inventory);
    const original = await store.prepareDataset(req); await store.pinDataset({ ...req, pinId: "second-pin" });
    const released = await store.releaseDatasetPin(req.pinId);
    expect(released).toMatchObject({ pinId: req.pinId, reused: false });
    expect(await store.releaseDatasetPin(req.pinId)).toEqual({ ...released, reused: true });
    expect((await store.readDatasetManifest(req.datasetId))?.activePin).toBe(true);
    await expect(store.pinDataset(req)).rejects.toThrow("training-pin-released");
    await store.releaseDatasetPin("second-pin");
    expect((await store.readDatasetManifest(req.datasetId))?.activePin).toBe(false);
    const newPin = await store.pinDataset({ ...req, pinId: "third-pin" });
    expect(newPin.manifestSha256).toBe(original.manifestSha256);
    expect(newPin.rows[0].feature.reference?.recordedAt).toBe(original.rows[0].feature.reference?.recordedAt);
    expect((await client.query("SELECT count(*)::integer AS n FROM predictive_training_dataset_releases")).rows[0].n).toBe(2);
  });
});

it("QB pinned datasets never block mandatory deletion and reproduce supplemental audit on restored history", async () => {
  let events: RecordedRetentionEvent[] = [], originalDigest = "";
  const proof = async (restore: boolean) => withDatasetProof(async ({ client, store, target, artifacts }) => {
    const seed = await seedConsumers(store); await store.recordSourcePassingYards("dataset-delete-feature", seed.request, seed.profiles);
    const inventory = await store.prepareFittingRun(await previewRequest(client, seed)); const req = datasetRequest(inventory);
    await store.prepareDataset(req); await store.pinDataset({ ...req, pinId: "dataset-delete-pin-B" });
    await store.releaseDatasetPin(req.pinId);
    if (restore) {
      expect((await store.reapply(events))[0].matched).toBe(true);
    } else {
      await withLogin(client, target, ["predictive_retention_owner"], async (login, loginTarget) => {
        const retention = await createLocalPredictiveStore(login, loginTarget, artifacts);
        const result = await retention.retain({ id: "dataset-delete", reason: "provider-request", authority: "disposable dataset proof",
          decidedAt: await witnessClock(client), scope: { kind: "source", profileIds: [BRIDGE_PROFILE], capturedFrom: "2026-01-01T00:00:00.000Z",
            capturedBefore: "2026-01-02T00:00:00.000Z" }, auditLevel: "digest-only" });
        expect(result.trainingRetention?.removedCounts).toMatchObject({ runs: 1, datasets: 1, datasetPins: 2, datasetReleases: 1 });
        events = await retention.retentionEvents(); originalDigest = result.trainingRetention!.removedIdsDigest;
      });
    }
    for (const table of ["predictive_training_runs", "predictive_training_datasets", "predictive_training_dataset_consumers", "predictive_training_dataset_pins", "predictive_training_dataset_releases"]) {
      expect((await client.query(`SELECT count(*)::integer AS n FROM ${table}`)).rows[0].n).toBe(0);
    }
    const audit = (await client.query("SELECT * FROM predictive_training_dataset_retention_audits")).rows[0];
    expect(audit.removed_ids).toBeNull();
    expect(JSON.stringify(audit)).not.toContain(req.datasetId);
    expect((await store.retentionEvents())[0].trainingRetention?.removedIdsDigest).toBe(originalDigest);
    await expect(store.readDatasetManifest(req.datasetId)).rejects.toThrow("training-dataset-evidence-removed");
    await expect(store.prepareDataset(req)).rejects.toThrow("training-dataset-evidence-removed");
  });
  await proof(false); await proof(true);
});

it("QB dataset active pins survive the exact expiry sweep and the last release restores eligibility", async () => {
  await withDatasetProof(async ({ client, store }) => {
    const seed = await seedConsumers(store); const feature = await store.recordSourcePassingYards("dataset-expiry-feature", seed.request, seed.profiles);
    const inventory = await store.prepareFittingRun(await previewRequest(client, seed)); const req = datasetRequest(inventory);
    await store.prepareDataset(req); await store.pinDataset({ ...req, pinId: "expiry-pin-B" });
    // Test-only future DB clock: preserve all evidence and recording clocks.
    // Recompile only access/expiry procedures in this disposable database.
    // Production callers receive no clock override, and no rows are backdated.
    const expiry = new Date(Date.parse(feature.recordedAt) + 90 * 86_400_000).toISOString();
    await advanceDatasetClock(client, expiry);
    const scope = { kind: "feature-run-expiry" as const, asOf: expiry };
    const sweep = (id: string) => store.retain({ id, reason: "expiry", authority: "disposable exact-boundary proof",
      decidedAt: feature.recordedAt, scope, auditLevel: "digest-only" });
    expect((await sweep("pinned-expiry-A")).removedCounts.sourceConsumers ?? 0).toBe(0);
    expect((await store.readDatasetManifest(req.datasetId))?.activePin).toBe(true);
    await store.releaseDatasetPin(req.pinId);
    expect((await sweep("pinned-expiry-B")).removedCounts.sourceConsumers ?? 0).toBe(0);
    expect((await store.readDatasetManifest(req.datasetId))?.activePin).toBe(true);
    const later = structuredClone(inventory.request); later.fittingRunId = "pinned-later-run"; later.foldId = "pinned-later-fold";
    const newer = (await client.query("SELECT predictive_prepare_training_run($1) AS result", [later])).rows[0].result;
    expect(newer.rows[0].feature).toMatchObject({ state: "usable", reference: { id: feature.id, recordedAt: feature.recordedAt } });
    expect(newer.pinEligibility).toEqual({ version: "source-feature-pin-eligibility-v1", featureIds: [feature.id] });
    await store.releaseDatasetPin("expiry-pin-B");
    await expect(store.readDatasetManifest(req.datasetId)).rejects.toThrow("training-dataset-feature-expired");
    await expect(store.pinDataset({ ...req, pinId: "too-late-pin" })).rejects.toThrow("training-dataset-feature-expired");
    const final = await sweep("released-expiry");
    expect(final.removedCounts.sourceConsumers).toBe(1);
    expect(final.trainingRetention?.removedCounts).toMatchObject({ runs: 2, datasets: 1, datasetPins: 2, datasetReleases: 2 });
    expect((await client.query("SELECT count(*)::integer AS n FROM predictive_source_consumers WHERE id=$1", [feature.id])).rows[0].n).toBe(0);
    await expect(store.readDatasetManifest(req.datasetId)).rejects.toThrow("training-dataset-evidence-removed");
  });
});

it("QB dataset current rights refuse reads before bytes and release remains available after revocation", async () => {
  await withDatasetProof(async ({ client, store, artifacts, target }) => {
    const seed = await seedConsumers(store); await store.recordSourcePassingYards("dataset-rights-feature", seed.request, seed.profiles);
    const inventory = await store.prepareFittingRun(await previewRequest(client, seed)); const req = datasetRequest(inventory);
    await store.prepareDataset(req);
    const clock = await witnessClock(client);
    await client.query(`INSERT INTO predictive_rights_decisions(id,profile_id,predecessor_id,allowed_uses,effective_from,effective_to,decided_at,evidence_kind,evidence_reference)
      SELECT 'dataset-revoke',profile_id,id,'{}',$2,NULL,$2,'synthetic','dataset current gate' FROM predictive_rights_decisions
      WHERE profile_id=$1 AND predecessor_id IS NULL`, [BRIDGE_PROFILE, clock]);
    let reads = 0;
    const observed = { ...artifacts, database: { ...artifacts.database, read: async (...args: Parameters<typeof artifacts.database.read>) => {
      reads++; return artifacts.database.read(...args);
    } } };
    await withLogin(client, target, ["predictive_replay", "predictive_recorder"], async (login, loginTarget) => {
      const reader = await createLocalPredictiveStore(login, loginTarget, observed);
      await expect(reader.readDatasetManifest(req.datasetId)).rejects.toThrow("training-dataset-rights-refused");
      await expect(reader.pinDataset({ ...req, pinId: "revoked-new-pin" })).rejects.toThrow("training-dataset-rights-refused");
      expect(reads).toBe(0);
      expect(await reader.releaseDatasetPin(req.pinId)).toMatchObject({ pinId: req.pinId, reused: false });
    });
  });
});

it("QB dataset quota refuses the complete publication and multiple pins charge one reservation", async () => {
  await withDatasetProof(async ({ client, store, target }) => {
    const seed = await seedConsumers(store); const input = await previewRequest(client, seed);
    input.slots = Array.from({ length: 32 }, (_, i) => ({ ...input.slots[0], datasetId: "quota-shard-" + i, playerId: "00-" + String(i + 10).padStart(7, "0") }));
    const inventory = await store.prepareFittingRun(input);
    await withLogin(client, target, ["predictive_replay", "predictive_recorder"], async (login) => {
      // Exercise the SQL membership/quota API directly; it never certifies bytes.
      for (const row of inventory.rows) await login.query("SELECT predictive_prepare_training_dataset($1)", [{
        ...datasetRequest(inventory, "quota-pin-" + row.ordinal), datasetId: row.slot.datasetId,
      }]);
      const second = structuredClone(input); second.fittingRunId = "quota-run-B"; second.foldId = "quota-fold-B";
      second.slots = [{ ...input.slots[0], datasetId: "overflow-shard", playerId: "00-0000999" }];
      const next = await store.prepareFittingRun(second);
      const before = (await client.query("SELECT count(*)::integer AS n FROM predictive_training_dataset_identities")).rows[0].n;
      await expect(store.prepareDataset(datasetRequest(next, "overflow-pin"))).rejects.toThrow("training-retention-quota-refused");
      expect((await client.query("SELECT count(*)::integer AS n FROM predictive_training_dataset_identities")).rows[0].n).toBe(before);
      await login.query("SELECT predictive_pin_training_dataset($1,$2,$3,$4)", [inventory.rows[0].slot.datasetId, "extra-quota-pin", input.fittingRunId, inventory.inventorySha256]);
      expect((await client.query("SELECT count(*)::integer AS n FROM predictive_training_datasets WHERE predictive_training_dataset_active(id)")).rows[0].n).toBe(32);
      await login.query("SELECT predictive_release_training_dataset_pin($1)", ["quota-pin-1"]);
      expect((await store.prepareDataset(datasetRequest(next, "overflow-pin"))).reused).toBe(false);
    });
  });
});

it("QB dataset late closure failure and failed mandatory deletion roll back manifest pins and audits together", async () => {
  await withDatasetProof(async ({ client, store, artifacts, target, root }) => {
    const seed = await seedConsumers(store, "2026-10-11T12:00:00.000Z", true);
    const a = await store.recordSourceFinalLabel("dataset-label-A", seed.labelRequest, null);
    const b = await store.recordSourceFinalLabel("dataset-label-B", seed.labelRequest, a.id);
    const slot: TrainingSlot = { datasetId: "dataset-label-shard", partition: "training", playerId: seed.request.playerId,
      gameId: seed.labelRequest.gameId, season: 2026, seasonType: "REG", kickoff: "2026-10-04T17:00:00.000Z",
      kickoffObservationId: "game-schedule", featureCutoff: "2026-10-04T12:00:00.000Z", labelsAsOf: b.recordedAt, featureRef: null, labelRef: null };
    const inventory = await store.prepareFittingRun(metadataRun([slot], seed.profiles, b.recordedAt)); const req = datasetRequest(inventory);
    const path = join(root, ".db-blobs", a.bodySha256 + ".json"); const bytes = await readFile(path); let manifestsDuringFailure = 0;
    const observed = { ...artifacts, database: { ...artifacts.database, read: async (...args: Parameters<typeof artifacts.database.read>) => {
      if (args[0] === a.bodySha256 + ".json") manifestsDuringFailure = (await client.query("SELECT count(*)::integer AS n FROM predictive_training_datasets")).rows[0].n;
      return artifacts.database.read(...args);
    } } };
    const reader = await createLocalPredictiveStore(client, target, observed);
    try { await writeFile(path, "damaged-ancestor-body"); await expect(reader.prepareDataset(req)).rejects.toThrow("artifact-integrity-failed"); }
    finally { await writeFile(path, bytes); }
    expect(manifestsDuringFailure).toBe(1); // SQL published inside the uncommitted transaction
    for (const table of ["predictive_training_datasets", "predictive_training_dataset_consumers", "predictive_training_dataset_pins", "predictive_training_pin_identities", "predictive_training_dataset_identities"]) {
      expect((await client.query(`SELECT count(*)::integer AS n FROM ${table}`)).rows[0].n).toBe(0);
    }
    const saved = await reader.prepareDataset(req);
    expect(saved.closure.references).toContainEqual({ kind: "source-consumer", id: a.id });
    expect(saved.closure.references).toContainEqual({ kind: "source-consumer", id: b.id });
    await client.query(`CREATE FUNCTION public.dataset_delete_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected-late-delete-failure'; END $$;
      CREATE TRIGGER dataset_delete_fail BEFORE DELETE ON public.predictive_captures FOR EACH ROW EXECUTE FUNCTION public.dataset_delete_fail()`);
    const event = { id: "dataset-failed-delete", reason: "provider-request" as const, authority: "disposable rollback proof", decidedAt: await witnessClock(client),
      scope: { kind: "source" as const, profileIds: [BRIDGE_PROFILE], capturedFrom: null, capturedBefore: null }, auditLevel: "digest-only" as const };
    await expect(store.retain(event)).rejects.toThrow("injected-late-delete-failure");
    expect((await reader.readDatasetManifest(req.datasetId))?.manifestSha256).toBe(saved.manifestSha256);
    for (const table of ["predictive_retention_events", "predictive_training_retention_audits", "predictive_training_dataset_retention_audits"]) {
      expect((await client.query(`SELECT count(*)::integer AS n FROM ${table}`)).rows[0].n).toBe(0);
    }
    await client.query("DROP TRIGGER dataset_delete_fail ON public.predictive_captures; DROP FUNCTION public.dataset_delete_fail()");
    expect((await store.retain(event)).trainingRetention?.removedCounts).toMatchObject({ datasets: 1, datasetPins: 1 });
  });
});

it("QB expiry removes an unpinned shard while preserving another pinned shard of the same inventory", async () => {
  await withDatasetProof(async ({ client, store }) => {
    const seed = await seedConsumers(store);
    const extra = schedule(78, "2026-10-19T17:00:00.000Z", "nfl:team:PHI", "nfl:team:CAR");
    const context: Dataset = { ...seed.fixture.context, artifacts: [], captures: [], rightsDecisions: [], decisions: [], labels: [] };
    addCapture(context, "second-shard-context", [revision("second-shard-schedule", "schedule", extra),
      revision("second-shard-membership", "membership", membership(extra))], "2026-10-07T12:00:00.000Z", BRIDGE_PROFILE);
    expect(await store.publish("second-shard-context", context, "2026-10-12T12:00:00.000Z")).toMatchObject({ status: "published" });
    const a = await store.recordSourcePassingYards("pin-preserved-feature", seed.request, seed.profiles);
    const b = await store.recordSourcePassingYards("unpinned-expired-feature", { ...seed.request, gameId: extra.gameId }, seed.profiles);
    const input = await previewRequest(client, seed); input.slots[0].datasetId = "pinned-shard";
    input.slots.push({ ...input.slots[0], datasetId: "released-shard", gameId: extra.gameId, kickoff: extra.kickoff, kickoffObservationId: "second-shard-schedule" });
    const inventory = await store.prepareFittingRun(input);
    await store.prepareDataset(datasetRequest(inventory, "preserved-pin"));
    await store.prepareDataset({ ...datasetRequest(inventory, "released-pin"), datasetId: "released-shard" });
    await store.releaseDatasetPin("released-pin");
    const expiry = new Date(Math.max(Date.parse(a.recordedAt), Date.parse(b.recordedAt)) + 90 * 86_400_000).toISOString();
    await advanceDatasetClock(client, expiry);
    const result = await store.retain({ id: "split-expiry", reason: "expiry", authority: "disposable shard proof", decidedAt: b.recordedAt,
      scope: { kind: "feature-run-expiry", asOf: expiry }, auditLevel: "digest-only" });
    expect(result.removedCounts.sourceConsumers).toBe(1);
    expect(result.trainingRetention?.removedCounts).toMatchObject({ datasets: 1, datasetPins: 1, datasetReleases: 1 });
    expect((await client.query("SELECT id FROM predictive_source_consumers ORDER BY id")).rows.map((r) => r.id)).toEqual([a.id]);
    expect((await store.readDatasetManifest("pinned-shard"))?.activePin).toBe(true);
    await expect(store.readDatasetManifest("released-shard")).rejects.toThrow("training-dataset-evidence-removed");
    expect((await client.query("SELECT count(*)::integer AS n FROM predictive_training_runs")).rows[0].n).toBe(1);
  });
});

it("QB dataset publication guards concurrent SQL writers and duplicate preparations without a partial pin", async () => {
  await withDatasetProof(async ({ client, store, target, artifacts }) => {
    const seed = await seedConsumers(store); await store.recordSourcePassingYards("dataset-concurrent-feature", seed.request, seed.profiles);
    const inventory = await store.prepareFittingRun(await previewRequest(client, seed)); const req = datasetRequest(inventory);
    await withLogin(client, target, ["predictive_replay", "predictive_recorder"], async (login, loginTarget) => {
      let entered!: () => void, unblock!: () => void;
      const opened = new Promise<void>((resolve) => { entered = resolve; });
      const gate = new Promise<void>((resolve) => { unblock = resolve; });
      const observed = { ...artifacts, database: { ...artifacts.database, read: async (...args: Parameters<typeof artifacts.database.read>) => {
        entered(); await gate; return artifacts.database.read(...args);
      } } };
      const reader = await createLocalPredictiveStore(login, loginTarget, observed);
      const original = structuredClone(req);
      const running = reader.prepareDataset(req).then((value) => ({ value }), (error: unknown) => ({ error }));
      await opened; req.pinId = "mutated-pin";
      try {
        await client.query("SET lock_timeout='100ms'");
        await expect(client.query("SELECT predictive_prepare_training_dataset($1)", [original])).rejects.toMatchObject({ code: "55P03" });
        await expect(client.query(`INSERT INTO predictive_rights_decisions(id,profile_id,predecessor_id,allowed_uses,effective_from,effective_to,decided_at,evidence_kind,evidence_reference)
          SELECT 'dataset-concurrent-revoke',profile_id,id,'{}',date_trunc('milliseconds',clock_timestamp()),NULL,
            date_trunc('milliseconds',clock_timestamp()),'synthetic','dataset writer probe' FROM predictive_rights_decisions WHERE profile_id=$1 AND predecessor_id IS NULL`, [BRIDGE_PROFILE])).rejects.toMatchObject({ code: "55P03" });
      } finally { await client.query("RESET lock_timeout"); unblock(); }
      const settled = await running;
      expect("error" in settled ? settled.error : null).toBeNull();
      if (!("value" in settled)) throw new Error("dataset publication failed");
      expect(settled.value.pin.id).toBe(original.pinId);
      const duplicate = (await client.query("SELECT predictive_prepare_training_dataset($1) AS result", [original])).rows[0].result;
      expect(duplicate.manifestSha256).toBe(settled.value.manifestSha256); expect(duplicate.reused).toBe(true);
      expect((await client.query("SELECT count(*)::integer AS n FROM predictive_training_dataset_pins")).rows[0].n).toBe(1);
    });
  });
});

it("QB dataset scheduled rights expiry after SQL sealing rolls back the complete manifest and pin", async () => {
  await withDatasetProof(async ({ client, store, artifacts, target }) => {
    const seed = await seedConsumers(store, "2026-10-11T12:00:00.000Z", true);
    const a = await store.recordSourceFinalLabel("expiry-ancestor-label-A", seed.labelRequest, null);
    const b = await store.recordSourceFinalLabel("expiry-selected-label-B", seed.labelRequest, a.id);
    const slot: TrainingSlot = { datasetId: "scheduled-expiry-shard", partition: "training", playerId: seed.request.playerId,
      gameId: seed.labelRequest.gameId, season: 2026, seasonType: "REG", kickoff: "2026-10-04T17:00:00.000Z",
      kickoffObservationId: "game-schedule", featureCutoff: "2026-10-04T12:00:00.000Z", labelsAsOf: b.recordedAt, featureRef: null, labelRef: null };
    const inventory = await store.prepareFittingRun(metadataRun([slot], seed.profiles, b.recordedAt)); const req = datasetRequest(inventory);
    await client.query(`INSERT INTO predictive_rights_decisions(id,profile_id,predecessor_id,allowed_uses,effective_from,effective_to,decided_at,evidence_kind,evidence_reference)
      SELECT 'dataset-scheduled-revoke',profile_id,id,'{}',date_trunc('milliseconds',now())+interval '5 seconds',NULL,
        date_trunc('milliseconds',now()),'synthetic','scheduled dataset proof' FROM predictive_rights_decisions WHERE profile_id=$1 AND predecessor_id IS NULL`, [BRIDGE_PROFILE]);
    const expiryAt = (await client.query(`SELECT to_char(effective_from AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS time
      FROM predictive_rights_decisions WHERE id='dataset-scheduled-revoke'`)).rows[0].time as string;
    await withLogin(client, target, [], async (clock) => {
      let entered!: () => void, unblock!: () => void, afterInsert = 0;
      const opened = new Promise<void>((resolve) => { entered = resolve; }); const gate = new Promise<void>((resolve) => { unblock = resolve; });
      const observed = { ...artifacts, database: { ...artifacts.database, read: async (...args: Parameters<typeof artifacts.database.read>) => {
        if (args[0] === a.bodySha256 + ".json") {
          afterInsert = (await client.query("SELECT count(*)::integer AS n FROM predictive_training_datasets")).rows[0].n;
          entered(); await gate;
        }
        return artifacts.database.read(...args);
      } } };
      const reader = await createLocalPredictiveStore(client, target, observed);
      const running = reader.prepareDataset(req).then(() => null, (error: unknown) => error);
      await Promise.race([opened, running.then((error) => { throw error ?? new Error("scheduled test never reached its closure gate"); })]);
      try {
        // No protected table access for the clock connection. Use the same DB
        // clock that recorded the decision, with no host-clock sleep estimate.
        await clock.query("SELECT pg_sleep(greatest(0,extract(epoch FROM ($1::timestamptz-clock_timestamp())))+0.01)", [expiryAt]);
      } finally { unblock(); }
      expect(await running).toMatchObject({ message: "source-consumer-rights-refused" });
      expect(afterInsert).toBe(1);
      for (const table of ["predictive_training_datasets", "predictive_training_dataset_identities", "predictive_training_dataset_pins", "predictive_training_pin_identities"]) {
        expect((await client.query(`SELECT count(*)::integer AS n FROM ${table}`)).rows[0].n).toBe(0);
      }
    });
  });
});

it("QB dataset lineage rights cover an ancestor provider and mandatory deletion erases its corrected descendants", async () => {
  await withDatasetProof(async ({ client, store, artifacts, target }) => {
    const seed = await seedConsumers(store, "2026-10-11T12:00:00.000Z", true);
    const a = await store.recordSourceFinalLabel("lineage-label-A", seed.labelRequest, null);
    const second = structuredClone(seed.fixture.input);
    second.id = "lineage-second-provider"; second.captureId = "lineage-second-capture"; second.artifact.id = "lineage-second-artifact";
    second.profile.id = "csv-second-player"; second.artifact.profileId = second.profile.id;
    second.rightsDecisions = [{ ...second.rightsDecisions[0], id: "rights:lineage-second", profileId: second.profile.id }];
    await store.publishSourceStats(second);
    await client.query("INSERT INTO predictive_profile_identity_links VALUES('lineage-second-link',$1,$2,'gsis','2026-01-01T00:00:00Z')", [second.profile.id, BRIDGE_PROFILE]);
    const raw = { ...seed.raw, profileId: second.profile.id };
    await store.recordSourceNormalization("lineage-second-binding", raw, null);
    await store.recordSourceDecision("lineage-second-reconciliation", decisionScope(raw.profileId), null);
    await store.recordSourceDecision("lineage-second-participation", decisionScope(raw.profileId, "participation"), null);
    const b = await store.recordSourceFinalLabel("lineage-label-B", { ...seed.labelRequest, profileIds: [second.profile.id] }, a.id);
    const slot: TrainingSlot = { datasetId: "lineage-shard", partition: "training", playerId: seed.request.playerId,
      gameId: seed.labelRequest.gameId, season: 2026, seasonType: "REG", kickoff: "2026-10-04T17:00:00.000Z",
      kickoffObservationId: "game-schedule", featureCutoff: "2026-10-04T12:00:00.000Z", labelsAsOf: b.recordedAt, featureRef: null, labelRef: null };
    const inventory = await store.prepareFittingRun(metadataRun([slot], [second.profile.id], b.recordedAt)); const req = datasetRequest(inventory);
    expect(inventory.protectedUses.map((p) => p.profile)).not.toContain(seed.raw.profileId);
    const manifest = await store.prepareDataset(req);
    expect(manifest.protectedUses).toContainEqual({ profile: seed.raw.profileId, use: "outcome-label" });
    const clock = await witnessClock(client);
    await client.query(`INSERT INTO predictive_rights_decisions(id,profile_id,predecessor_id,allowed_uses,effective_from,effective_to,decided_at,evidence_kind,evidence_reference)
      SELECT 'lineage-revoke',profile_id,id,'{}',$2,NULL,$2,'synthetic','ancestor provider revoked' FROM predictive_rights_decisions
      WHERE profile_id=$1 AND predecessor_id IS NULL`, [seed.raw.profileId, clock]);
    let reads = 0;
    const observed = { ...artifacts, database: { ...artifacts.database, read: async (...args: Parameters<typeof artifacts.database.read>) => {
      reads++; return artifacts.database.read(...args);
    } } };
    const reader = await createLocalPredictiveStore(client, target, observed);
    await expect(reader.readDatasetManifest(req.datasetId)).rejects.toThrow("training-dataset-rights-refused");
    expect(reads).toBe(0);
    const result = await store.retain({ id: "lineage-delete", reason: "provider-request", authority: "disposable lineage proof", decidedAt: clock,
      scope: { kind: "source", profileIds: [seed.raw.profileId], capturedFrom: null, capturedBefore: null }, auditLevel: "digest-only" });
    expect(result.removedCounts.sourceConsumers).toBe(2);
    expect(result.trainingRetention?.removedCounts).toMatchObject({ runs: 1, datasets: 1, datasetPins: 1 });
    await expect(reader.readDatasetManifest(req.datasetId)).rejects.toThrow("training-dataset-evidence-removed");
  });
});

it("QB dataset migration preserves v15 inventories consumers and legacy retention audit with no-op reruns", async () => {
  await withProof(async ({ client, store, target }) => {
    const seed = await seedConsumers(store); const feature = await store.recordSourcePassingYards("dataset-upgrade-feature", seed.request, seed.profiles);
    const inventory = await store.prepareFittingRun(await previewRequest(client, seed));
    const { reused: _reused, ...original } = inventory; void _reused;
    expect(original).not.toHaveProperty("pinEligibility");
    await store.publishSourceStats(sourceClaimFixture("dataset-unrelated-team", "team"));
    await store.retain({ id: "before-datasets-zero", reason: "provider-request", authority: "disposable upgrade audit", decidedAt: await witnessClock(client),
      scope: { kind: "source", profileIds: ["csv-synthetic-team"], capturedFrom: "2026-01-01T00:00:00.000Z", capturedBefore: "2026-01-02T00:00:00.000Z" }, auditLevel: "digest-only" });
    const events = await store.retentionEvents(); const ledger = (await client.query("SELECT * FROM db_migrations ORDER BY version")).rows;
    const files = await checkMigrationArtifacts(); const contracts = await loadCatalogContracts(files);
    const options = { ...target, files, verify: createCatalogVerifier(contracts) };
    expect(await runScratchMigrations(client, options)).toMatchObject({ executed: [16], schemaVersion: 16 });
    expect(await store.readFittingRun(inventory.request.fittingRunId)).toEqual(original);
    expect((await store.replaySourceConsumer(feature.id))?.bodySha256).toBe(feature.bodySha256);
    expect(await store.retentionEvents()).toEqual(events);
    expect((await client.query("SELECT * FROM db_migrations ORDER BY version")).rows.slice(0, 15)).toEqual(ledger);
    expect((await store.prepareDataset(datasetRequest(inventory))).activePin).toBe(true);
    expect(await runScratchMigrations(client, options)).toMatchObject({ executed: [], schemaVersion: 16 });
  }, 15);
});

it("QB assigned shard verifies fixed consumers and missing slots without reselecting or creating durable pins", async () => {
  await withProof(async ({ client, store, artifacts, target }) => {
    const seed = await seedConsumers(store);
    const a = await store.recordSourcePassingYards("shard-feature-A", seed.request, seed.profiles);
    const input = await previewRequest(client, seed);
    // Keep a different shard ahead of the requested one in global ordinal order.
    input.slots[0].datasetId = "first-shard";
    input.slots.push({ ...input.slots[0], datasetId: "missing-shard", playerId: "00-0000002" });
    const inventory = await store.prepareFittingRun(input);
    await store.recordSourcePassingYards("shard-feature-B", seed.request, seed.profiles);
    const calls: string[] = [];
    const observed = { ...artifacts, database: { ...artifacts.database, read: async (...args: Parameters<typeof artifacts.database.read>) => {
      calls.push(args[0]); return artifacts.database.read(...args);
    } } };
    await withLogin(client, target, ["predictive_replay"], async (login, loginTarget) => {
      const reader = await createLocalPredictiveStore(login, loginTarget, observed);
      const first = await reader.verifyDatasetShard({ version: "qb-training-read-v1", fittingRunId: input.fittingRunId,
        inventorySha256: inventory.inventorySha256, datasetId: "first-shard" });
      expect(first).toMatchObject({ status: "verified-only", fittingReady: false, populationCoverage: "unqualified",
        rows: [{ ordinal: 0, selection: { featureId: a.id }, feature: { state: "usable", reference: { id: a.id } }, label: { state: "missing" } }],
        counts: [{ partition: "training", slots: 0 }, { partition: "evaluation", slots: 1, targetEvents: 1, usableFeatures: 1, missingLabels: 1 }] });
      expect(calls).toHaveLength(3); expect(new Set(calls).size).toBe(3);
      const { proofSha256, verification: _metrics, ...proof } = first; void _metrics;
      expect(proofSha256).toBe(digest(canonical(proof)));
      expect(JSON.stringify(first)).not.toContain('"passingYardsSum":');
      expect(JSON.stringify(first)).not.toContain('"value":');
      const retry = await reader.verifyDatasetShard(first.request);
      expect(retry.rows).toEqual(first.rows); expect(retry.selectionSha256).toBe(first.selectionSha256);
      expect(calls).toHaveLength(6); // no cross-request "already verified" cache
      calls.length = 0;
      const missing = await reader.verifyDatasetShard({ ...first.request, datasetId: "missing-shard" });
      expect(missing.rows.map((row) => [row.ordinal, row.selection.featureId, row.feature.state, row.label.state])).toEqual([
        [1, null, "missing", "missing"],
      ]);
      expect(calls).toHaveLength(1); // context proof still required without consumers
      const { reused: _reused, ...saved } = inventory; void _reused;
      expect(await reader.readFittingRun(input.fittingRunId)).toEqual(saved);
      expect((await client.query("SELECT count(*)::integer AS n FROM predictive_training_runs")).rows[0].n).toBe(1);
      expect((await client.query("SELECT count(*)::integer AS n FROM predictive_feature_run_pins")).rows[0].n).toBe(0);
    });
  });
});

it("QB assigned shard refuses wrong identity and damaged or revoked missing-slot context before returning a proof", async () => {
  await withProof(async ({ client, store, artifacts, target, root }) => {
    const seed = await seedConsumers(store); const input = await previewRequest(client, seed);
    const inventory = await store.prepareFittingRun(input);
    const request = { version: "qb-training-read-v1" as const, fittingRunId: input.fittingRunId,
      inventorySha256: inventory.inventorySha256, datasetId: input.slots[0].datasetId };
    let reads = 0;
    const observed = { ...artifacts, database: { ...artifacts.database, read: async (...args: Parameters<typeof artifacts.database.read>) => {
      reads++; return artifacts.database.read(...args);
    } } };
    await withLogin(client, target, ["predictive_replay"], async (login, loginTarget) => {
      const reader = await createLocalPredictiveStore(login, loginTarget, observed);
      await expect(reader.verifyDatasetShard({ ...request, inventorySha256: "0".repeat(64) })).rejects.toThrow("training-shard-inventory-mismatch");
      await expect(reader.verifyDatasetShard({ ...request, datasetId: "unassigned" })).rejects.toThrow("training-shard-not-assigned");
      await expect(reader.verifyDatasetShard({ ...request, fittingRunId: "unknown" })).rejects.toThrow("training-run-not-found");
      expect(reads).toBe(0);
      const dep = inventory.rows[0].kickoff.dependencies[0];
      const path = join(root, ".db-blobs", dep.artifactSha256 + ".json");
      const bytes = await readFile(path);
      try {
        await writeFile(path, "damaged");
        await expect(reader.verifyDatasetShard(request)).rejects.toThrow("artifact-integrity-failed");
      } finally { await writeFile(path, bytes); }
      expect((await reader.verifyDatasetShard(request)).rows[0].feature.state).toBe("missing");
      reads = 0;
      const clock = await witnessClock(client);
      await client.query(`INSERT INTO predictive_rights_decisions(id,profile_id,predecessor_id,allowed_uses,effective_from,effective_to,decided_at,evidence_kind,evidence_reference)
        SELECT 'shard-context-revoke',profile_id,id,ARRAY['internal-research'],$2,NULL,$2,'synthetic','shard context gate'
        FROM predictive_rights_decisions WHERE profile_id=$1 AND predecessor_id IS NULL`, [BRIDGE_PROFILE, clock]);
      await expect(reader.verifyDatasetShard(request)).rejects.toThrow("training-run-rights-refused");
      expect(reads).toBe(0);
    });
  });
});

it("QB assigned shard rechecks damaged selected bytes on retry and preserves the original inventory", async () => {
  await withProof(async ({ client, store, root }) => {
    const seed = await seedConsumers(store);
    const feature = await store.recordSourcePassingYards("shard-damage-feature", seed.request, seed.profiles);
    const input = await previewRequest(client, seed); const inventory = await store.prepareFittingRun(input);
    const request = { version: "qb-training-read-v1" as const, fittingRunId: input.fittingRunId,
      inventorySha256: inventory.inventorySha256, datasetId: input.slots[0].datasetId };
    const proof = await store.verifyDatasetShard(request);
    const path = join(root, ".db-blobs", feature.bodySha256 + ".json"); const bytes = await readFile(path);
    try {
      await writeFile(path, "changed-after-successful-verification");
      await expect(store.verifyDatasetShard(request)).rejects.toThrow("artifact-integrity-failed");
    } finally { await writeFile(path, bytes); }
    expect((await store.verifyDatasetShard(request)).selectionSha256).toBe(proof.selectionSha256);
    const { reused: _reused, ...saved } = inventory; void _reused;
    expect(await store.readFittingRun(input.fittingRunId)).toEqual(saved);
    expect((await client.query("SELECT count(*)::integer AS n FROM predictive_feature_run_pins")).rows[0].n).toBe(0);
  });
});

it("QB assigned shard preserves historical label identity and inventory supersession after later corrections", async () => {
  await withProof(async ({ client, store, artifacts, target }) => {
    const seed = await seedConsumers(store, "2026-10-11T12:00:00.000Z", true);
    const a = await store.recordSourceFinalLabel("shard-label-A", seed.labelRequest, null);
    const b = await store.recordSourceFinalLabel("shard-label-B", seed.labelRequest, a.id);
    const slot: TrainingSlot = { datasetId: "label-shard", partition: "training", playerId: seed.request.playerId,
      gameId: seed.labelRequest.gameId, season: 2026, seasonType: "REG", kickoff: "2026-10-04T17:00:00.000Z",
      kickoffObservationId: "game-schedule", featureCutoff: "2026-10-04T12:00:00.000Z", labelsAsOf: a.recordedAt,
      featureRef: null, labelRef: null };
    const input = metadataRun([slot], seed.profiles, b.recordedAt);
    const inventory = await store.prepareFittingRun(input);
    const c = await store.recordSourceFinalLabel("shard-label-C", seed.labelRequest, b.id);
    await withLogin(client, target, ["predictive_replay"], async (login, loginTarget) => {
      const reader = await createLocalPredictiveStore(login, loginTarget, artifacts);
      const result = await reader.verifyDatasetShard({ version: "qb-training-read-v1", fittingRunId: input.fittingRunId,
        inventorySha256: inventory.inventorySha256, datasetId: slot.datasetId });
      expect(result.rows[0].label).toMatchObject({ state: "usable", reference: { id: a.id }, supersededAsOf: false, supersededAtSnapshot: true });
      expect(result.rows[0].selection.labelId).toBe(a.id);
      expect(result.counts).toMatchObject([
        { partition: "training", slots: 1, missingFeatures: 1, usableLabels: 1 },
        { partition: "evaluation", slots: 0, missingFeatures: 0, usableLabels: 0 },
      ]);
      expect(JSON.stringify(result)).not.toContain(b.bodySha256);
      expect(JSON.stringify(result)).not.toContain(c.bodySha256);
      expect(JSON.stringify(result)).not.toContain('"value":');
    });
  });
});

it("QB assigned shard guard excludes direct SQL rights changes and mandatory deletion while bytes are verified", async () => {
  await withProof(async ({ client, store, artifacts, target }) => {
    const seed = await seedConsumers(store);
    await store.recordSourcePassingYards("shard-concurrent-feature", seed.request, seed.profiles);
    const input = await previewRequest(client, seed); const inventory = await store.prepareFittingRun(input);
    const supplied = { version: "qb-training-read-v1" as const, fittingRunId: input.fittingRunId,
      inventorySha256: inventory.inventorySha256, datasetId: input.slots[0].datasetId };
    await withLogin(client, target, ["predictive_replay"], async (login, loginTarget) => {
      let entered!: () => void, unblock!: () => void;
      const opened = new Promise<void>((resolve) => { entered = resolve; });
      const gate = new Promise<void>((resolve) => { unblock = resolve; });
      const observed = { ...artifacts, database: { ...artifacts.database, read: async (...args: Parameters<typeof artifacts.database.read>) => {
        entered(); await gate; return artifacts.database.read(...args);
      } } };
      const reader = await createLocalPredictiveStore(login, loginTarget, observed);
      const running = reader.verifyDatasetShard(supplied).then((value) => ({ value }), (error: unknown) => ({ error }));
      await opened;
      supplied.datasetId = "mutated-after-start";
      try {
        await client.query("SET lock_timeout='100ms'");
        await expect(client.query(`INSERT INTO predictive_rights_decisions(id,profile_id,predecessor_id,allowed_uses,effective_from,effective_to,decided_at,evidence_kind,evidence_reference)
          SELECT 'shard-concurrent-revoke',profile_id,id,'{}',date_trunc('milliseconds',clock_timestamp()),NULL,
            date_trunc('milliseconds',clock_timestamp()),'synthetic','shard guard probe'
          FROM predictive_rights_decisions WHERE profile_id=$1 AND predecessor_id IS NULL`, [BRIDGE_PROFILE])).rejects.toMatchObject({ code: "55P03" });
        await expect(store.retain({ id: "shard-concurrent-delete", reason: "provider-request", authority: "disposable shard proof",
          decidedAt: await witnessClock(client), scope: { kind: "source", profileIds: seed.profiles, capturedFrom: null, capturedBefore: null },
          auditLevel: "digest-only" })).rejects.toMatchObject({ code: "55P03" });
      } finally { await client.query("RESET lock_timeout"); unblock(); }
      const settled = await running;
      expect("error" in settled ? settled.error : null).toBeNull();
      if (!("value" in settled)) throw new Error("shard verification failed");
      expect(settled.value.request.datasetId).toBe(input.slots[0].datasetId);
      expect((await client.query("SELECT count(*)::integer AS n FROM predictive_retention_events")).rows[0].n).toBe(0);
      await store.retain({ id: "shard-after-read-delete", reason: "provider-request", authority: "disposable shard proof",
        decidedAt: await witnessClock(client), scope: { kind: "source", profileIds: seed.profiles, capturedFrom: null, capturedBefore: null },
        auditLevel: "digest-only" });
      await expect(reader.verifyDatasetShard({ ...supplied, datasetId: input.slots[0].datasetId })).rejects.toThrow("training-run-evidence-removed");
    });
  });
});

it("QB assigned shard scheduled rights expiry withholds the complete proof before further bytes", async () => {
  await withProof(async ({ client, store, artifacts, target }) => {
    const seed = await seedConsumers(store);
    await store.recordSourcePassingYards("shard-scheduled-feature", seed.request, seed.profiles);
    const input = await previewRequest(client, seed); const inventory = await store.prepareFittingRun(input);
    await client.query(`INSERT INTO public.predictive_rights_decisions
      (id,profile_id,predecessor_id,allowed_uses,effective_from,effective_to,decided_at,evidence_kind,evidence_reference)
      SELECT 'shard-scheduled-revoke',profile_id,id,'{}',date_trunc('milliseconds',now())+interval '2 seconds',NULL,
        date_trunc('milliseconds',now()),'synthetic','scheduled shard access test'
      FROM predictive_rights_decisions WHERE profile_id=$1 AND predecessor_id IS NULL`, [BRIDGE_PROFILE]);
    await withLogin(client, target, ["predictive_replay"], async (login, loginTarget) => {
      let entered!: () => void, unblock!: () => void, reads = 0;
      const opened = new Promise<void>((resolve) => { entered = resolve; });
      const gate = new Promise<void>((resolve) => { unblock = resolve; });
      const observed = { ...artifacts, database: { ...artifacts.database, read: async (...args: Parameters<typeof artifacts.database.read>) => {
        reads++; entered(); await gate; return artifacts.database.read(...args);
      } } };
      const reader = await createLocalPredictiveStore(login, loginTarget, observed);
      const running = reader.verifyDatasetShard({ version: "qb-training-read-v1", fittingRunId: input.fittingRunId,
        inventorySha256: inventory.inventorySha256, datasetId: input.slots[0].datasetId }).then(() => null, (error: unknown) => error);
      await opened;
      try {
        await client.query(`SELECT pg_sleep(greatest(0,extract(epoch FROM (effective_from-clock_timestamp())))+0.01)
          FROM predictive_rights_decisions WHERE id='shard-scheduled-revoke'`);
      } finally { unblock(); }
      expect(await running).toMatchObject({ message: "source-consumer-rights-refused" });
      expect(reads).toBe(1);
    });
  });
});

it("QB run inventory atomically fixes complete shards and retries original selections through execute-only roles", async () => {
  await withProof(async ({ client, store, artifacts, target }) => {
    const seed = await seedConsumers(store);
    await store.recordSourcePassingYards("inventory-feature-A", seed.request, seed.profiles);
    const b = await store.recordSourcePassingYards("inventory-feature-B", seed.request, seed.profiles);
    const input = await previewRequest(client, seed);
    input.slots.push({ ...input.slots[0], datasetId: "second-shard", playerId: "00-0000002" });
    input.slots.reverse();
    await withLogin(client, target, ["predictive_recorder", "predictive_replay"], async (login, loginTarget) => {
      let reads = 0;
      const observed = { ...artifacts, database: { ...artifacts.database, read: async (...args: Parameters<typeof artifacts.database.read>) => {
        reads++; return artifacts.database.read(...args);
      } } };
      const recorder = await createLocalPredictiveStore(login, loginTarget, observed);
      const before = await witnessClock(client);
      const saved = await recorder.prepareFittingRun(input);
      expect(saved).toMatchObject({ version: "qb-training-run-inventory-v1", status: "inventory-sealed", fittingReady: false,
        populationCoverage: "unqualified", reused: false, reuseDisclosure: { priorRuns: 0, targetEventsInRun: 1, playerGameTargetsInRun: 2,
          reusedTargetEvents: 0, reusedPlayerGameTargets: 0 } });
      expect(saved.snapshotAt >= before && saved.snapshotAt <= await witnessClock(client)).toBe(true);
      expect(saved.requestSha256).toBe(fittingRunRequestDigest(input, saved.snapshotAt));
      const { inventorySha256, reused: _reused, ...body } = saved;
      expect(_reused).toBe(false);
      expect(inventorySha256).toBe(digest(canonical(body)));
      expect(saved.rows.map((row) => [row.ordinal, row.slot.datasetId, row.selection.featureId, row.feature.state, row.label.state])).toEqual([
        [0, "preview-evaluation", b.id, "usable", "missing"], [1, "second-shard", null, "missing", "missing"],
      ]);
      expect(saved.protectedUses).toContainEqual({ profile: BRIDGE_PROFILE, use: "model-input" });
      expect(saved.counts).toEqual([
        { partition: "training", slots: 0, targetEvents: 0, usableFeatures: 0, usableLabels: 0, missingFeatures: 0,
          unavailableFeatures: 0, expiredFeatures: 0, missingLabels: 0 },
        { partition: "evaluation", slots: 2, targetEvents: 1, usableFeatures: 1, usableLabels: 0, missingFeatures: 1,
          unavailableFeatures: 0, expiredFeatures: 0, missingLabels: 2 },
      ]);
      expect(reads).toBe(0); // inventory metadata is not a byte-verified dataset
      expect(JSON.stringify(saved)).not.toContain('"passingYardsSum":');
      expect(JSON.stringify(saved)).not.toContain('"value":');
      await store.recordSourcePassingYards("inventory-feature-C", seed.request, seed.profiles);
      expect(await recorder.prepareFittingRun(input)).toEqual({ ...saved, reused: true });
      expect(await recorder.readFittingRun(input.fittingRunId)).toEqual({ ...body, inventorySha256 });
      for (const table of ["predictive_training_runs", "predictive_training_run_slots", "predictive_training_run_events", "predictive_training_run_profiles"]) {
        expect((await login.query("SELECT has_table_privilege(current_user,$1,'INSERT') AS allowed", [table])).rows[0].allowed).toBe(false);
        await expect(login.query(`SELECT * FROM ${table}`)).rejects.toMatchObject({ code: "42501" });
      }
      await expect(recorder.prepareFittingRun({ ...input, modelIdentity: { ...input.modelIdentity, codeCommit: "f".repeat(40) } }))
        .rejects.toThrow("training-run-id-conflict");
      await expect(recorder.prepareFittingRun({ ...input, fittingRunId: "different-run-same-fold" })).rejects.toThrow("training-fold-id-conflict");
      const reused = await recorder.prepareFittingRun({ ...input, fittingRunId: "next-run", foldId: "next-fold" });
      expect(reused.reuseDisclosure).toMatchObject({ priorRuns: 1, targetEventsInRun: 1, playerGameTargetsInRun: 2,
        reusedTargetEvents: 1, reusedPlayerGameTargets: 2, interpretation: "repeated-events-are-correlated" });
      const fixed = { ...input, fittingRunId: "fixed-first", evaluationPlanId: "fixed-plan", splitPolicy: { ...input.splitPolicy, evaluationMode: "fixed-holdout" as const } };
      await recorder.prepareFittingRun(fixed);
      await expect(recorder.prepareFittingRun({ ...fixed, fittingRunId: "fixed-second", foldId: "fixed-second-fold" }))
        .rejects.toThrow("training-fixed-holdout-event-reuse");
    });
  });
});

it("QB run SQL rejects forged history kickoff clocks and cross-shard leakage before inventory publication", async () => {
  await withProof(async ({ client, store, artifacts, target }) => {
    const seed = await seedConsumers(store);
    const feature = await store.recordSourcePassingYards("inventory-sql-feature", seed.request, seed.profiles);
    const input = await previewRequest(client, seed);
    await withLogin(client, target, ["predictive_recorder", "predictive_replay"], async (login, loginTarget) => {
      const cases: [string, (request: FittingRunRequest) => void, string][] = [
        ["unapproved history", (r) => { r.selection.historyPolicySha256 = "0".repeat(64); }, "training-version-refused"],
        ["same event in two partitions", (r) => { r.slots.push({ ...r.slots[0], datasetId: "training-shard", partition: "training", playerId: "00-0000002",
          kickoff: "2026-10-01T17:00:00.000Z", featureCutoff: "2026-09-30T17:00:00.000Z", labelsAsOf: "2026-10-02T00:00:00.000Z" }); }, "training-evaluation-event-overlap"],
        ["duplicate target in another shard", (r) => { r.slots.push({ ...r.slots[0], datasetId: "other-shard" }); }, "training-duplicate-target"],
        ["claimed wrong kickoff", (r) => { r.slots[0].kickoff = "2026-10-19T17:00:00.000Z"; }, "training-kickoff-reference-mismatch"],
        ["unobserved kickoff", (r) => { r.slots[0].featureCutoff = r.fitCutoff = "2026-10-06T00:00:00.000Z"; }, "training-kickoff-missing"],
        ["wrong exact scope", (r) => { r.slots[0].featureRef = feature.id; r.slots[0].playerId = "00-0000002"; }, "training-feature-reference-mismatch"],
        ["future label clock", (r) => { r.slots[0].labelsAsOf = "2099-01-01T00:00:00.000Z"; }, "training-future-cutoff"],
        ["missing model hash", (r) => { Object.assign(r.modelIdentity, { configurationSha256: null }); }, "training-policy-identity-refused"],
        ["null canonical player", (r) => { Object.assign(r.slots[0], { playerId: null }); }, "training-slot-refused"],
        ["oversized run", (r) => { r.slots = Array.from({ length: 1025 }, (_, i) => ({ ...r.slots[0], playerId: "00-" + String(i).padStart(7, "0") })); }, "training-slot-bounds-refused"],
        ["oversized shard", (r) => { r.slots = Array.from({ length: 257 }, (_, i) => ({ ...r.slots[0], playerId: "00-" + String(i).padStart(7, "0") })); }, "training-dataset-bounds-refused"],
      ];
      for (const [, change, reason] of cases) {
        const request = structuredClone(input); change(request);
        // Direct SQL skips every application normalizer and byte verifier.
        await expect(login.query("SELECT predictive_prepare_training_run($1)", [request])).rejects.toThrow(reason);
        expect((await client.query("SELECT count(*)::integer AS n FROM predictive_training_runs")).rows[0].n).toBe(0);
        expect((await client.query("SELECT count(*)::integer AS n FROM predictive_training_run_identities")).rows[0].n).toBe(0);
      }
      // Sixteen selected feeds plus the separate kickoff context are seventeen
      // protected profiles. Missing consumers do not bypass the run-wide cap.
      const extraProfiles = Array.from({ length: 15 }, (_, i) => "inventory-extra-profile-" + i);
      const registration: Dataset = { formatVersion: 2,
        profiles: extraProfiles.map((id) => profile(id)), rightsDecisions: extraProfiles.map((id) => rights(id)),
        artifacts: [], captures: [], decisions: [], labels: [], identityLinks: [] };
      const registeredAt = await witnessClock(client);
      addCapture(registration, "inventory-bound-empty", [], registeredAt, extraProfiles[0]);
      expect(await store.publish("inventory-profile-bound-fixture", registration, registeredAt))
        .toMatchObject({ status: "published" });
      const expanded = structuredClone(input);
      expanded.selection.profileIds.push(...extraProfiles);
      await probe(login, async () => {
        await expect(login.query("SELECT predictive_prepare_training_run($1)", [expanded])).rejects.toThrow("training-profile-bounds-refused");
      });
      expect((await client.query("SELECT count(*)::integer AS n FROM predictive_training_runs")).rows[0].n).toBe(0);
      const recorder = await createLocalPredictiveStore(login, loginTarget, artifacts);
      await recorder.prepareFittingRun(input);
      const changed = { ...input, fittingRunId: "policy-changed-run", foldId: "different-fold", modelIdentity: { ...input.modelIdentity, configurationSha256: "f".repeat(64) } };
      await expect(recorder.prepareFittingRun(changed)).rejects.toThrow("training-plan-policy-conflict");
    });
    await withLogin(client, target, ["predictive_replay"], async (login) => {
      await expect(login.query("SELECT predictive_prepare_training_run($1)", [input])).rejects.toMatchObject({ code: "42501" });
    });
    const normalized = (await client.query("SELECT predictive_training_request($1,$2) AS request", [input, await witnessClock(client)])).rows[0].request;
    expect(normalized).toEqual(normalizeFittingRunRequest(input, await witnessClock(client)));
  });
});

it("QB run concurrent SQL preparation reserves one immutable identity and refuses later split extensions", async () => {
  await withProof(async ({ client, store, artifacts, target }) => {
    const seed = await seedConsumers(store); const input = await previewRequest(client, seed);
    await withLogin(client, target, ["predictive_recorder", "predictive_replay"], async (one) => {
      await withLogin(client, target, ["predictive_recorder", "predictive_replay"], async (two, twoTarget) => {
        await one.query("BEGIN");
        const saved = (await one.query("SELECT predictive_prepare_training_run($1) AS result", [input])).rows[0].result;
        try {
          await two.query("SET lock_timeout='100ms'");
          await expect(two.query("SELECT predictive_prepare_training_run($1)", [input])).rejects.toMatchObject({ code: "55P03" });
        } finally { await one.query("COMMIT"); await two.query("RESET lock_timeout"); }
        const recorder = await createLocalPredictiveStore(two, twoTarget, artifacts);
        expect(await recorder.prepareFittingRun(input)).toEqual({ ...saved, reused: true });
        const extended = structuredClone(input); extended.slots.push({ ...input.slots[0], playerId: "00-0000002", datasetId: "late-shard" });
        await expect(recorder.prepareFittingRun(extended)).rejects.toThrow("training-run-id-conflict");
        expect((await client.query("SELECT count(*)::integer AS n FROM predictive_training_runs")).rows[0].n).toBe(1);
        expect((await client.query("SELECT count(*)::integer AS n FROM predictive_training_run_slots")).rows[0].n).toBe(1);
      });
    });
  });
});

it("QB pending inventory retention erases protected selections and audits deletion through execute-only ownership", async () => {
  await withProof(async ({ client, store, artifacts, target }) => {
    const seed = await seedConsumers(store); const input = await previewRequest(client, seed);
    await store.prepareFittingRun(input); // all consumers missing, kickoff still protected
    await withLogin(client, target, ["predictive_retention_owner"], async (login, loginTarget) => {
      const owner = await createLocalPredictiveStore(login, loginTarget, artifacts);
      const event = { id: "inventory-mandatory-delete", reason: "provider-request" as const, authority: "disposable retention proof",
        decidedAt: await witnessClock(client), scope: { kind: "source" as const, profileIds: seed.profiles,
          capturedFrom: "2026-10-12T00:00:00.000Z", capturedBefore: "2026-10-13T00:00:00.000Z" }, auditLevel: "digest-only" as const };
      const removed = await owner.retain(event);
      expect(removed.trainingRetention).toEqual({ removedCounts: { runs: 1, slots: 1, events: 1, profiles: 2 },
        removedIdsDigest: retentionIdsDigest([{ kind: "training-run", id: input.fittingRunId }]) });
      expect(removed.removedCounts).not.toHaveProperty("trainingRuns");
      expect((await client.query("SELECT removed_run_ids FROM predictive_training_retention_audits WHERE event_id=$1", [event.id])).rows[0].removed_run_ids).toBeNull();
      for (const table of ["predictive_training_runs", "predictive_training_run_slots", "predictive_training_run_events", "predictive_training_run_profiles"]) {
        expect((await client.query(`SELECT count(*)::integer AS n FROM ${table}`)).rows[0].n).toBe(0);
      }
      await expect(store.readFittingRun(input.fittingRunId)).rejects.toThrow("training-run-evidence-removed");
      await expect(store.prepareFittingRun(input)).rejects.toThrow("training-run-evidence-removed");
      await expect(store.prepareFittingRun({ ...input, fittingRunId: "new-run-after-deletion", foldId: "new-fold" })).rejects.toThrow("training-plan-history-removed");
      const history = await owner.retentionEvents(); expect(history[0].trainingRetention).toEqual(removed.trainingRetention);
      expect(await owner.reapply(history)).toEqual([{ eventId: event.id, status: "present", matched: true }]);
      await expect(login.query("SELECT * FROM predictive_training_retention_audits")).rejects.toMatchObject({ code: "42501" });
    });
  });
});

it("QB run replay checks current protected rights and rejects omitted inventory associations", async () => {
  await withProof(async ({ client, store }) => {
    const seed = await seedConsumers(store); const input = await previewRequest(client, seed);
    await store.prepareFittingRun(input);
    const links = (await client.query("SELECT * FROM predictive_training_run_profiles WHERE run_id=$1", [input.fittingRunId])).rows;
    await client.query("ALTER TABLE predictive_training_run_profiles DISABLE TRIGGER USER");
    await client.query("DELETE FROM predictive_training_run_profiles WHERE run_id=$1", [input.fittingRunId]);
    await expect(store.readFittingRun(input.fittingRunId)).rejects.toThrow("training-inventory-integrity-refused");
    for (const row of links) await client.query("INSERT INTO predictive_training_run_profiles VALUES($1,$2,$3)", [row.run_id, row.profile_id, row.use_kind]);
    await client.query("ALTER TABLE predictive_training_run_profiles ENABLE TRIGGER USER");
    const clock = await witnessClock(client);
    await client.query(`INSERT INTO predictive_rights_decisions(id,profile_id,predecessor_id,allowed_uses,effective_from,effective_to,decided_at,evidence_kind,evidence_reference)
      SELECT 'inventory-rights-revoke',profile_id,id,ARRAY['internal-research'],$2,NULL,$2,'synthetic','inventory access gate'
      FROM predictive_rights_decisions WHERE profile_id=$1 AND predecessor_id IS NULL`, [BRIDGE_PROFILE, clock]);
    await expect(store.readFittingRun(input.fittingRunId)).rejects.toThrow("training-run-rights-refused");
    await expect(store.prepareFittingRun(input)).rejects.toThrow("training-run-rights-refused");
  });
});

it("QB inventory deletion reproduces supplemental audit after fresh restoration and rolls back with failed retention", async () => {
  let history: RecordedRetentionEvent[] = [];
  const prepare = async (client: Client, store: Store) => {
    const seed = await seedConsumers(store); const input = await previewRequest(client, seed);
    await store.prepareFittingRun(input); return { seed, input };
  };
  await withProof(async ({ client, store }) => {
    const { seed, input } = await prepare(client, store);
    await client.query(`CREATE FUNCTION public.disposable_training_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected-training-retention-failure'; END $$`);
    await client.query(`CREATE TRIGGER disposable_training_failure BEFORE DELETE ON public.predictive_training_runs
      FOR EACH ROW EXECUTE FUNCTION public.disposable_training_failure()`);
    const event = { id: "inventory-restore-delete", reason: "provider-request" as const, authority: "disposable recovery proof",
      decidedAt: await witnessClock(client), scope: { kind: "source" as const, profileIds: seed.profiles,
        capturedFrom: null, capturedBefore: null }, auditLevel: "full" as const };
    await expect(store.retain(event)).rejects.toThrow("injected-training-retention-failure");
    expect((await client.query("SELECT count(*)::integer AS n FROM predictive_training_runs")).rows[0].n).toBe(1);
    expect((await client.query("SELECT count(*)::integer AS n FROM predictive_retention_events")).rows[0].n).toBe(0);
    expect((await client.query("SELECT count(*)::integer AS n FROM predictive_training_retention_audits")).rows[0].n).toBe(0);
    expect((await store.readFittingRun(input.fittingRunId))?.requestSha256).toBe(fittingRunRequestDigest(input, await witnessClock(client)));
    await client.query("DROP TRIGGER disposable_training_failure ON predictive_training_runs");
    await client.query("DROP FUNCTION disposable_training_failure()");
    const result = await store.retain(event);
    expect(result.trainingRetention?.removedIdsDigest).toBe(retentionIdsDigest([{ kind: "training-run", id: input.fittingRunId }]));
    expect((await client.query("SELECT removed_run_ids FROM predictive_training_retention_audits")).rows[0].removed_run_ids).toEqual([input.fittingRunId]);
    history = await store.retentionEvents();
  });
  // A fresh, registered DB reconstructs the same IDs/closure. Its newer receipt
  // and run snapshot must not alter either legacy or supplemental deletion IDs.
  await withProof(async ({ client, store }) => {
    const { input } = await prepare(client, store);
    expect(await store.reapply(history)).toEqual([{ eventId: history[0].id, status: "reapplied", matched: true }]);
    expect(await store.reapply(history)).toEqual([{ eventId: history[0].id, status: "present", matched: true }]);
    await expect(store.readFittingRun(input.fittingRunId)).rejects.toThrow("training-run-evidence-removed");
  });
});

it("QB inventory migration upgrades v13 without rewriting evidence and preserves guarded replay", async () => {
  await withProof(async ({ client, store, artifacts, target }) => {
    const seed = await seedConsumers(store); const feature = await store.recordSourcePassingYards("inventory-upgrade-feature", seed.request, seed.profiles);
    const prior = await store.replaySourceConsumer(feature.id);
    const ledger = (await client.query("SELECT * FROM db_migrations ORDER BY version")).rows;
    const evidence = (await client.query("SELECT id,body_sha256,recorded_at FROM predictive_source_consumers ORDER BY id")).rows;
    const files = await checkMigrationArtifacts(); const contracts = await loadCatalogContracts(files);
    const options = { ...target, files, verify: createCatalogVerifier(contracts) };
    expect(await runScratchMigrations(client, options)).toMatchObject({ schemaVersion: 16, executed: [14, 15, 16] });
    expect((await client.query("SELECT * FROM db_migrations ORDER BY version")).rows.slice(0, 13)).toEqual(ledger);
    expect((await client.query("SELECT id,body_sha256,recorded_at FROM predictive_source_consumers ORDER BY id")).rows).toEqual(evidence);
    expect(await store.replaySourceConsumer(feature.id)).toEqual(prior);
    await withLogin(client, target, ["predictive_replay"], async (login, loginTarget) => {
      const reader = await createLocalPredictiveStore(login, loginTarget, artifacts);
      expect((await reader.replaySourceConsumers([feature.id])).records[0]).toEqual(prior);
      await expect(login.query("SELECT predictive_training_evidence_guard()")).rejects.toMatchObject({ code: "42501" });
    });
    const request = await previewRequest(client, seed);
    expect(await store.prepareFittingRun(request)).toMatchObject({ fittingReady: false, rows: [{ selection: { featureId: feature.id } }] });
    expect(await runScratchMigrations(client, options)).toMatchObject({ executed: [], schemaVersion: 16 });
  }, 13);
});

it("QB run preview verifies kickoff context and complete selections through restricted replay without publishing a dataset", async () => {
  await withProof(async ({ client, store, artifacts, target }) => {
    const seed = await seedConsumers(store);
    const a = await store.recordSourcePassingYards("preview-feature-A", seed.request, seed.profiles);
    const b = await store.recordSourcePassingYards("preview-feature-B", seed.request, seed.profiles);
    const input = await previewRequest(client, seed);
    input.slots.push({ ...input.slots[0], playerId: "00-0000002", datasetId: "preview-other-shard" });
    input.slots.reverse();
    const before = (await client.query("SELECT id FROM predictive_source_consumers ORDER BY id")).rows;
    await withLogin(client, target, ["predictive_replay"], async (login, loginTarget) => {
      const reads: string[] = [];
      const observed = { ...artifacts, database: { ...artifacts.database, read: async (...args: Parameters<typeof artifacts.database.read>) => {
        reads.push(args[0]); return artifacts.database.read(...args);
      } } };
      const reader = await createLocalPredictiveStore(login, loginTarget, observed);
      const preview = await reader.previewFittingRun(input);
      expect(preview).toMatchObject({ status: "preview-only", fittingReady: false, populationCoverage: "unqualified",
        counts: [{ partition: "training", slots: 0 }, { partition: "evaluation", slots: 2, targetEvents: 1,
          features: { usable: 1, unavailable: 0, missing: 1, expired: 0 }, labels: { usable: 0, missing: 2 } }] });
      expect(preview.rows.map((row) => [row.ordinal, row.slot.playerId, row.feature.reference?.id ?? null])).toEqual([
        [0, seed.request.playerId, b.id], [1, "00-0000002", null],
      ]);
      expect(preview.rows[0].kickoff).toMatchObject({ observationId: "source-target", profileId: BRIDGE_PROFILE,
        dependencies: [{ observationId: "source-target", captureId: seed.fixture.context.captures[0].id,
          sha256: seed.fixture.context.artifacts[0].sha256 }] });
      expect(JSON.stringify(preview)).not.toContain('"passingYardsSum":');
      expect(JSON.stringify(preview)).not.toContain('"value":');
      expect(new Set(reads).size).toBe(reads.length);
      expect(reads).toHaveLength(3); // shared native JSON, selected body JSON, CSV
      expect((await login.query("SELECT count(*)::integer AS n FROM pg_locks WHERE pid=pg_backend_pid() AND mode='ShareLock'")).rows[0].n).toBe(0);
      input.slots.find((row) => row.playerId === seed.request.playerId)!.featureRef = a.id;
      expect((await reader.previewFittingRun(input)).rows[0].feature.reference?.id).toBe(a.id);
    });
    expect((await client.query("SELECT id FROM predictive_source_consumers ORDER BY id")).rows).toEqual(before);
  });
});

it("QB run preview independently refuses false late and superseded kickoff claims while preserving earlier cutoffs", async () => {
  await withProof(async ({ client, store }) => {
    const seed = await seedConsumers(store);
    await store.recordSourcePassingYards("preview-kickoff-feature", seed.request, seed.profiles);
    const input = await previewRequest(client, seed);
    for (const fields of [{ kickoffObservationId: "game-schedule" }, { kickoff: "2026-10-19T17:00:00.000Z" }, { season: 2025 }]) {
      const changed = structuredClone(input); Object.assign(changed.slots[0], fields);
      await expect(store.previewFittingRun(changed)).rejects.toThrow("training-kickoff-reference-mismatch");
    }
    const late = structuredClone(input); late.slots[0].featureCutoff = late.fitCutoff = "2026-10-06T12:00:00.000Z";
    await expect(store.previewFittingRun(late)).rejects.toThrow("training-kickoff-missing");
    const original = await store.previewFittingRun(input);
    const old = JSON.parse(seed.fixture.context.artifacts[0].bytes).find((row: { id: string }) => row.id === "source-target");
    const correction = revision("source-target-corrected", "schedule", { ...old.data, kickoff: "2026-10-25T17:00:00.000Z" }, "source-target");
    const changed: Dataset = { formatVersion: 2, profiles: [profile(BRIDGE_PROFILE)], rightsDecisions: [], artifacts: [], captures: [],
      decisions: [], labels: [], identityLinks: [] };
    const clock = await witnessClock(client);
    addCapture(changed, "preview-later-schedule", [correction], clock, BRIDGE_PROFILE);
    expect(await store.publish("preview-schedule-correction", changed, clock)).toMatchObject({ status: "published" });
    expect((await store.previewFittingRun(input)).rows).toEqual(original.rows);
    const current = structuredClone(input); current.slots[0].featureCutoff = current.fitCutoff = await witnessClock(client);
    await expect(store.previewFittingRun(current)).rejects.toThrow("training-kickoff-reference-mismatch");
    current.slots[0].kickoffObservationId = correction.id; current.slots[0].kickoff = correction.data.kickoff;
    expect((await store.previewFittingRun(current)).rows[0]).toMatchObject({
      kickoff: { observationId: correction.id }, feature: { state: "missing" }, label: { state: "missing" },
    });
  });
});

it("QB run preview checks missing-slot context rights before bytes and refuses damaged kickoff evidence", async () => {
  await withProof(async ({ client, store, artifacts, root, target }) => {
    const seed = await seedConsumers(store);
    const input = await previewRequest(client, seed); // no consumer exists
    await withLogin(client, target, ["predictive_replay"], async (login, loginTarget) => {
      let reads = 0;
      const observed = { ...artifacts, database: { ...artifacts.database, read: async (...args: Parameters<typeof artifacts.database.read>) => {
        reads++; return artifacts.database.read(...args);
      } } };
      const reader = await createLocalPredictiveStore(login, loginTarget, observed);
      const path = join(root, ".db-blobs", seed.fixture.context.artifacts[0].sha256 + ".json");
      const original = await readFile(path);
      await writeFile(path, "damaged", { mode: 0o600 });
      await expect(reader.previewFittingRun(input)).rejects.toThrow("artifact-integrity-failed");
      await writeFile(path, original, { mode: 0o600 });
      const clock = await witnessClock(client);
      await client.query(`INSERT INTO predictive_rights_decisions
        (id,profile_id,predecessor_id,allowed_uses,effective_from,effective_to,decided_at,evidence_kind,evidence_reference)
        SELECT 'preview-context-revoke',profile_id,id,ARRAY['internal-research'],$2::timestamptz,NULL,
          $2::timestamptz,'synthetic','missing-slot context gate'
        FROM predictive_rights_decisions WHERE profile_id=$1 AND predecessor_id IS NULL`, [BRIDGE_PROFILE, clock]);
      reads = 0;
      await expect(reader.previewFittingRun(input)).rejects.toThrow("source-consumer-rights-refused");
      expect(reads).toBe(0);
      expect((await login.query("SELECT count(*)::integer AS n FROM pg_locks WHERE pid=pg_backend_pid() AND mode='ShareLock'")).rows[0].n).toBe(0);
    });
  });
});

it("QB run preview preserves historical label identity and supersession without returning a later outcome", async () => {
  await withProof(async ({ client, store, artifacts, target }) => {
    const seed = await seedConsumers(store, "2026-10-11T12:00:00.000Z", true);
    const a = await store.recordSourceFinalLabel("preview-label-A", seed.labelRequest, null);
    const b = await store.recordSourceFinalLabel("preview-label-B", seed.labelRequest, a.id);
    const first: TrainingSlot = { datasetId: "preview-training", partition: "training", playerId: seed.request.playerId,
      gameId: seed.labelRequest.gameId, season: 2026, seasonType: "REG", kickoff: "2026-10-04T17:00:00.000Z",
      kickoffObservationId: "game-schedule", featureCutoff: "2026-10-04T12:00:00.000Z", labelsAsOf: a.recordedAt,
      featureRef: null, labelRef: null };
    const input = metadataRun([first], seed.profiles, b.recordedAt);
    await withLogin(client, target, ["predictive_replay"], async (login, loginTarget) => {
      const reader = await createLocalPredictiveStore(login, loginTarget, artifacts);
      const old = await reader.previewFittingRun(input);
      expect(old.rows[0].label).toMatchObject({ state: "usable", reference: { id: a.id }, supersededAsOf: false, supersededAtSnapshot: true });
      expect(old.rows[0].selection.labelId).toBe(a.id);
      expect(JSON.stringify(old)).not.toContain(b.bodySha256);
      expect(JSON.stringify(old)).not.toContain('"value":');
      input.slots[0].labelsAsOf = b.recordedAt;
      expect((await reader.previewFittingRun(input)).rows[0].label).toMatchObject({ reference: { id: b.id },
        supersededAsOf: false, supersededAtSnapshot: false });
      input.slots[0].labelRef = a.id;
      expect((await reader.previewFittingRun(input)).rows[0].label).toMatchObject({ reference: { id: a.id },
        supersededAsOf: true, supersededAtSnapshot: true });
    });
  });
});

it("QB run preview freezes caller input and excludes concurrent publication from its complete snapshot", async () => {
  await withProof(async ({ client, store, artifacts, target }) => {
    const seed = await seedConsumers(store);
    const saved = await store.recordSourcePassingYards("preview-snapshot-feature", seed.request, seed.profiles);
    const input = await previewRequest(client, seed);
    await withLogin(client, target, ["predictive_replay"], async (login, loginTarget) => {
      let entered!: () => void, unblock!: () => void;
      const opened = new Promise<void>((resolve) => { entered = resolve; });
      const gate = new Promise<void>((resolve) => { unblock = resolve; });
      const observed = { ...artifacts, database: { ...artifacts.database, read: async (...args: Parameters<typeof artifacts.database.read>) => {
        entered(); await gate; return artifacts.database.read(...args);
      } } };
      const reader = await createLocalPredictiveStore(login, loginTarget, observed);
      const running = reader.previewFittingRun(input).then((value) => ({ value }), (error: unknown) => ({ error }));
      await opened;
      input.slots[0].datasetId = "mutated-after-call";
      try {
        await client.query("SET lock_timeout='100ms'");
        await expect(sqlConsumer(client, saved.body, "preview-concurrent-feature")).rejects.toMatchObject({ code: "55P03" });
      } finally { await client.query("RESET lock_timeout"); unblock(); }
      const result = await running;
      if ("error" in result) throw result.error;
      expect(result.value.rows[0]).toMatchObject({ slot: { datasetId: "preview-evaluation" }, feature: { reference: { id: saved.id } } });
      expect((await client.query("SELECT id FROM predictive_source_consumers WHERE id='preview-concurrent-feature'")).rows).toEqual([]);
    });
  });
});

it("QB training metadata batches exact and latest features without dropping missing slots", async () => {
  await withProof(async ({ client, store }) => {
    const seed = await seedConsumers(store);
    const a = await store.recordSourcePassingYards("batch-feature-A", seed.request, seed.profiles);
    const b = await store.recordSourcePassingYards("batch-feature-B", seed.request, seed.profiles);
    const clock = await witnessClock(client);
    const first: TrainingSlot = { datasetId: "batch-shard", partition: "evaluation", playerId: seed.request.playerId, gameId: seed.request.gameId,
      season: 2026, seasonType: "REG", kickoff: "2026-10-18T17:00:00.000Z", kickoffObservationId: "source-target",
      featureCutoff: seed.request.cutoff, labelsAsOf: clock, featureRef: null, labelRef: null };
    const input = metadataRun([first, { ...first, playerId: "00-0000002" }], seed.profiles, seed.request.cutoff);
    const query = async (at: string) => checkTrainingMetadataSelection((await client.query<TrainingMetadataSelection>(TRAINING_SELECTION_SQL,
      [...trainingSelectionParameters(input, at)])).rows, 2);
    expect(await query(clock)).toEqual([
      { ordinal: 0, featureId: b.id, labelId: null, labelSupersededAsOf: false, labelSupersededAtSnapshot: false },
      { ordinal: 1, featureId: null, labelId: null, labelSupersededAsOf: false, labelSupersededAtSnapshot: false },
    ]);
    input.slots[0].featureRef = a.id;
    expect((await query(clock))[0].featureId).toBe(a.id);
    // An existing ID with the wrong scope must reach the verifier and refuse,
    // rather than being represented as a legitimate missing requested record.
    input.slots[1].featureRef = a.id;
    expect((await query(clock))[1].featureId).toBe(a.id);
  });
});

it("QB training metadata keeps label clocks and supersession separate from prediction cutoffs", async () => {
  await withProof(async ({ client, store }) => {
    const seed = await seedConsumers(store);
    const a = await store.recordSourceFinalLabel("batch-label-A", seed.labelRequest, null);
    await client.query("SELECT pg_sleep(0.005)");
    const b = await store.recordSourceFinalLabel("batch-label-B", seed.labelRequest, a.id);
    const clock = await witnessClock(client);
    const first: TrainingSlot = { datasetId: "training-shard", partition: "training", playerId: seed.request.playerId, gameId: seed.labelRequest.gameId,
      season: 2026, seasonType: "REG", kickoff: "2026-10-04T17:00:00.000Z", kickoffObservationId: "schedule-context",
      featureCutoff: "2026-10-04T12:00:00.000Z", labelsAsOf: a.recordedAt, featureRef: null, labelRef: null };
    const input = metadataRun([first], seed.profiles, clock);
    const query = async () => checkTrainingMetadataSelection((await client.query<TrainingMetadataSelection>(TRAINING_SELECTION_SQL,
      [...trainingSelectionParameters(input, clock)])).rows, 1)[0];
    expect(await query()).toEqual({ ordinal: 0, featureId: null, labelId: a.id, labelSupersededAsOf: false, labelSupersededAtSnapshot: true });
    input.slots[0].labelsAsOf = b.recordedAt;
    expect(await query()).toMatchObject({ labelId: b.id, labelSupersededAsOf: false, labelSupersededAtSnapshot: false });
    input.slots[0].labelRef = a.id;
    expect(await query()).toMatchObject({ labelId: a.id, labelSupersededAsOf: true, labelSupersededAtSnapshot: true });
  });
});

it("QB guarded evidence batches reproduce restricted replay and share files at 1 16 and 64 consumers", async () => {
  await withProof(async ({ client, store, artifacts, target }) => {
    const seed = await seedConsumers(store);
    const saved = await store.recordSourcePassingYards("guarded-feature-0", seed.request, seed.profiles);
    const ids = [saved.id];
    for (let i = 1; i < 64; i++) {
      const id = "guarded-feature-" + i; await sqlConsumer(client, saved.body, id); ids.push(id);
    }
    const expected = await store.replaySourceConsumer(saved.id);
    await withLogin(client, target, ["predictive_replay"], async (login, loginTarget) => {
      let reads: string[] = [];
      const observed = { ...artifacts, database: { ...artifacts.database, read: async (...args: Parameters<typeof artifacts.database.read>) => {
        reads.push(args[0]); return artifacts.database.read(...args);
      } } };
      const reader = await createLocalPredictiveStore(login, loginTarget, observed);
      const measurements = [];
      for (const n of [1, 16, 64]) {
        reads = [];
        const started = performance.now();
        const result = await reader.replaySourceConsumers(ids.slice(0, n));
        const wallMs = performance.now() - started;
        expect(result.records).toHaveLength(n);
        expect(result.records[0]).toEqual(expected);
        expect(result.records.every((record) => canonical(record?.body) === canonical(saved.body))).toBe(true);
        expect(new Set(reads).size).toBe(reads.length);
        expect(reads).toHaveLength(3); // consumer JSON, native JSON, source CSV
        const explain = (await login.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
          SELECT public.predictive_source_consumer_check(id) FROM unnest($1::text[]) id`, [ids.slice(0, n)])).rows[0]["QUERY PLAN"][0];
        measurements.push({ n, ...result.verification, wallMs: Math.round(wallMs), preflightCalls: n,
          preflightExecutionMs: explain["Execution Time"], preflightSharedHits: explain.Plan["Shared Hit Blocks"] });
        expect((await login.query("SELECT count(*)::integer AS n FROM pg_locks WHERE pid=pg_backend_pid() AND mode='ShareLock'")).rows[0].n).toBe(0);
      }
      // Equal producer bodies share reconstruction, while every record's SQL
      // association/access check still runs. Not a diverse-population benchmark.
      expect(measurements.map((row) => row.queries)).toEqual([measurements[0].queries, measurements[0].queries, measurements[0].queries]);
      process.stdout.write("guarded evidence shared-context benchmark " + JSON.stringify(measurements) + "\n");
      expect((await reader.replaySourceConsumers([saved.id, "not-recorded", saved.id])).records).toEqual([expected, null, expected]);
      expect(() => reader.replaySourceConsumers(Array(65).fill(saved.id))).toThrow("training-consumer-bounds-refused");
      const label = await store.recordSourceFinalLabel("guarded-label", seed.labelRequest, null);
      expect((await reader.replaySourceConsumers([saved.id, label.id])).records).toEqual([expected, label]);
    });
  });
});

it("QB guarded evidence blocks direct rights changes and retention until file reads finish", async () => {
  await withProof(async ({ client, store, artifacts, target }) => {
    const seed = await seedConsumers(store);
    const saved = await store.recordSourcePassingYards("guarded-race", seed.request, seed.profiles);
    await withLogin(client, target, ["predictive_replay"], async (login, loginTarget) => {
      let unblock!: () => void, entered!: () => void, reads = 0;
      const opened = new Promise<void>((resolve) => { entered = resolve; });
      const gate = new Promise<void>((resolve) => { unblock = resolve; });
      const observed = { ...artifacts, database: { ...artifacts.database, read: async (...args: Parameters<typeof artifacts.database.read>) => {
        reads++; entered(); await gate; return artifacts.database.read(...args);
      } } };
      const reader = await createLocalPredictiveStore(login, loginTarget, observed);
      const running = reader.replaySourceConsumers([saved.id]);
      // Attach rejection handling immediately while deliberately pausing I/O.
      const settled = running.then((value) => ({ value }), (error: unknown) => ({ error }));
      await opened;
      const revoke = `INSERT INTO public.predictive_rights_decisions
        (id,profile_id,predecessor_id,allowed_uses,effective_from,effective_to,decided_at,evidence_kind,evidence_reference)
        SELECT 'guarded-revoked',profile_id,id,'{}',date_trunc('milliseconds',clock_timestamp()),NULL,
          date_trunc('milliseconds',clock_timestamp()),'synthetic','disposable concurrency proof'
        FROM predictive_rights_decisions WHERE profile_id=$1 AND predecessor_id IS NULL`;
      try {
        await withLogin(client, target, ["predictive_ingest", "predictive_harness"], async (writer) => {
          expect((await writer.query("SELECT predictive_harness_session() AS member")).rows[0].member).toBe(true);
          await writer.query("SET lock_timeout='100ms'");
          await expect(writer.query(revoke, [seed.raw.profileId])).rejects.toMatchObject({ code: "55P03" });
        });
        await withLogin(client, target, ["predictive_retention_owner"], async (owner) => {
          await owner.query("SET lock_timeout='100ms'");
          await expect(owner.query(`SELECT predictive_retention_execute('guarded-delete','provider-request','disposable test',
            date_trunc('milliseconds',now()),$1,'full')`, [{ kind: "source", profileIds: seed.profiles, capturedFrom: null, capturedBefore: null }]))
            .rejects.toMatchObject({ code: "55P03" });
        });
      } finally { unblock(); }
      const result = await settled;
      expect("value" in result && result.value.records[0]?.id).toBe(saved.id);
      await client.query(revoke, [seed.raw.profileId]);
      const before = reads;
      await expect(reader.replaySourceConsumers([saved.id])).rejects.toThrow();
      expect(reads).toBe(before); // committed revocation is seen before any bytes
    });
  });
});

it("QB guarded evidence refuses damaged shared files and associations and releases failed guards", async () => {
  await withProof(async ({ client, store, artifacts, root, target }) => {
    const seed = await seedConsumers(store);
    const saved = await store.recordSourcePassingYards("guarded-damage", seed.request, seed.profiles);
    await withLogin(client, target, ["predictive_replay"], async (login, loginTarget) => {
      let reads = 0;
      const observed = { ...artifacts, database: { ...artifacts.database, read: async (...args: Parameters<typeof artifacts.database.read>) => {
        reads++; return artifacts.database.read(...args);
      } } };
      const reader = await createLocalPredictiveStore(login, loginTarget, observed);
      const path = join(root, ".db-blobs", seed.fixture.input.artifact.sha256 + ".csv");
      const original = await readFile(path);
      await writeFile(path, "damaged", { mode: 0o600 });
      await expect(reader.replaySourceConsumers([saved.id, saved.id])).rejects.toThrow("artifact-integrity-failed");
      expect((await login.query("SELECT count(*)::integer AS n FROM pg_locks WHERE pid=pg_backend_pid() AND mode='ShareLock'")).rows[0].n).toBe(0);
      await writeFile(path, original, { mode: 0o600 });
      expect((await reader.replaySourceConsumers([saved.id])).records[0]).toEqual(saved);
      await client.query("ALTER TABLE predictive_source_consumer_bindings DISABLE TRIGGER predictive_source_consumer_bindings_immutable");
      await client.query("DELETE FROM predictive_source_consumer_bindings WHERE consumer_id=$1", [saved.id]);
      await client.query("ALTER TABLE predictive_source_consumer_bindings ENABLE TRIGGER predictive_source_consumer_bindings_immutable");
      const before = reads;
      await expect(reader.replaySourceConsumers([saved.id])).rejects.toThrow("stored-source-consumer-mismatch");
      expect(reads).toBe(before);
    });
    // Role membership is checked using session_user, even in SECURITY DEFINER.
    await withLogin(client, target, ["predictive_ingest"], async (login) => {
      await expect(login.query("SELECT predictive_training_read_guard()")).rejects.toMatchObject({ code: "42501" });
    });
    await withLogin(client, target, ["predictive_replay"], async (login) => {
      await login.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      try { await expect(login.query("SELECT predictive_training_read_guard()")).rejects.toMatchObject({ code: "25000" }); }
      finally { await login.query("ROLLBACK"); }
      expect((await login.query("SELECT has_table_privilege(current_user,'predictive_blobs','INSERT') AS allowed")).rows[0].allowed).toBe(false);
    });
  });
});

it("QB guarded evidence rechecks scheduled rights changes before subsequent bytes and delivery", async () => {
  await withProof(async ({ client, store, artifacts, target }) => {
    const seed = await seedConsumers(store);
    const saved = await store.recordSourcePassingYards("guarded-expiry", seed.request, seed.profiles);
    await client.query(`INSERT INTO public.predictive_rights_decisions
      (id,profile_id,predecessor_id,allowed_uses,effective_from,effective_to,decided_at,evidence_kind,evidence_reference)
      SELECT 'guarded-scheduled-revoke',profile_id,id,'{}',date_trunc('milliseconds',now())+interval '2 seconds',NULL,
        date_trunc('milliseconds',now()),'synthetic','scheduled refusal test'
      FROM predictive_rights_decisions WHERE profile_id=$1 AND predecessor_id IS NULL`, [seed.raw.profileId]);
    await withLogin(client, target, ["predictive_replay"], async (login, loginTarget) => {
      let unblock!: () => void, entered!: () => void, reads = 0;
      const opened = new Promise<void>((resolve) => { entered = resolve; });
      const gate = new Promise<void>((resolve) => { unblock = resolve; });
      const observed = { ...artifacts, database: { ...artifacts.database, read: async (...args: Parameters<typeof artifacts.database.read>) => {
        reads++; entered(); await gate; return artifacts.database.read(...args);
      } } };
      const reader = await createLocalPredictiveStore(login, loginTarget, observed);
      const result = reader.replaySourceConsumers([saved.id]).then(() => null, (error: unknown) => error);
      await opened;
      try {
        // Wait for the already-recorded effective boundary, not for a new DML
        // writer. SHARE locks alone cannot stop the passage of time.
        await client.query(`SELECT pg_sleep(greatest(0,extract(epoch FROM (effective_from-clock_timestamp())))+0.01)
          FROM predictive_rights_decisions WHERE id='guarded-scheduled-revoke'`);
      } finally { unblock(); }
      const refused = await result as Error;
      expect(refused).toBeInstanceOf(Error);
      // Native/source access may refuse before the per-file gate is reached.
      // Both are explicit rights failures; an integrity/SQL error is not a pass.
      expect(["source-consumer-rights-refused", "predictive-source-plan-rights-profile-invalid"]).toContain(refused.message);
      expect(reads).toBe(1);
    });
  });
});

it("CSV QB consumers record explicit source manifests and final labels without ordinary stats observations", async () => {
  await withProof(async ({ client,store }) => {
    const seed = await seedConsumers(store);
    const feature = await store.recordSourcePassingYards("qb-feature",seed.request,seed.profiles);
    expect(feature.body.kind).toBe("feature"); if (feature.body.kind !== "feature") throw new Error("expected feature");
    expect(feature.body.bundle).toMatchObject({ status: "ready-inputs",featureVersion: "passing-yards-source-v1" });
    expect(feature.body.bundle.player[0]).toMatchObject({ attemptsSum: 10,passingYardsSum: 80,expectedGames: 1,observedGames: 1,passingYardsPerAttempt: 8 });
    expect(feature.body.manifest.sources[0]).toMatchObject({ reconciliationId: seed.rec.record.id,participationId: seed.part.record.id,
      selected: { bindingId: seed.binding.event.id,revisionId: seed.binding.event.revision!.id } });
    expect(feature.body.bundle.dependencies.some((row) => row.kind === "player-game-stats")).toBe(false);
    expect(await store.replaySourceConsumer(feature.id)).toEqual(feature);
    const label = await store.recordSourceFinalLabel("qb-label",seed.labelRequest,null);
    expect(label).toMatchObject({ kind: "label",mode: "synthetic-proof",body: { value: 80,stat: "passing_yards",
      postWindowCaptureId: seed.fixture.input.captureId,playerBridgeObservationId: "player-map" } });
    expect(await store.replaySourceConsumer(label.id)).toEqual(label);
    expect((await client.query("SELECT count(*)::integer AS n FROM predictive_observations WHERE kind='player-game-stats'")).rows[0].n).toBe(0);
    expect((await client.query("SELECT count(*)::integer AS n FROM predictive_feature_runs")).rows[0].n).toBe(0);
    const absentAt=new Date().toISOString();
    const next: Dataset={ formatVersion: 2,profiles: [profile(BRIDGE_PROFILE)],rightsDecisions: [],artifacts: [],captures: [],decisions: [],labels: [],identityLinks: [] };
    addCapture(next,"completion-cover",[],absentAt,BRIDGE_PROFILE);
    Object.assign(next.artifacts[0],{ scopeKind: "season-file",scopeSeason: 2026 });
    const marker="final-" + sourceGameId;
    addCapture(next,"completion-absence",[revision("completion-absent","source-row-absent",{
      priorObservationId: marker,priorEntityKey: "event-state-marker:" + NORMALIZATION_GAME + ":provider-final-status",
      coveringCaptureId: "capture-completion-cover",scopeKind: "season-file",scopeSeason: 2026,scopeWeek: null,scopeGameId: null,scopeFilter: null,
      gameId: NORMALIZATION_GAME,
    },marker)],absentAt,BRIDGE_PROFILE);
    expect(await store.publish("completion-absence",next,absentAt)).toMatchObject({ status: "published" });
    await expect(store.recordSourceFinalLabel("absent-completion-label",seed.labelRequest,label.id)).rejects.toThrow("source-label-completion-refused");
    expect(await store.replaySourceConsumer(label.id)).toEqual(label);
  });
});

it("CSV QB consumers preserve earlier cutoffs while recaptures withhold current decisions and labels", async () => {
  await withProof(async ({ client,store }) => {
    const seed = await seedConsumers(store); const original = await store.replaySourcePassingYards(seed.request,seed.profiles);
    const saved = await store.recordSourcePassingYards("old-feature",seed.request,seed.profiles);
    const b = sourceClaimFixture("consumer-recapture"); b.capturedAt=seed.part.record.recordedAt;
    b.rightsDecisions=seed.fixture.input.rightsDecisions; await store.publishSourceStats(b);
    const binding = await store.recordSourceNormalization("consumer-recapture-binding",seed.raw,seed.binding.event.id);
    const latest = { ...seed.request,cutoff: binding.event.recordedAt,computedAt: binding.event.recordedAt };
    expect(await store.replaySourcePassingYards(seed.request,seed.profiles)).toEqual(original);
    expect(await store.replaySourceConsumer(saved.id)).toEqual(saved);
    expect((await store.replaySourcePassingYards(latest,seed.profiles)).bundle.status).toBe("unavailable-inputs");
    await expect(store.recordSourceFinalLabel("stale-label",seed.labelRequest,null)).rejects.toThrow("source-label-inputs-unavailable");
    const rec = await store.recordSourceDecision("recaptured-reconciliation",decisionScope(seed.raw.profileId),seed.rec.record.id);
    const part = await store.recordSourceDecision("recaptured-participation",decisionScope(seed.raw.profileId,"participation"),seed.part.record.id);
    expect((await store.replaySourcePassingYards({ ...latest,cutoff: part.record.recordedAt,computedAt: part.record.recordedAt },seed.profiles)).bundle.status).toBe("ready-inputs");
    const label = await store.recordSourceFinalLabel("fresh-label",seed.labelRequest,null);
    expect(label.body.manifest.sources[0].reconciliationId).toBe(rec.record.id);
    expect((await client.query("SELECT count(*)::integer AS n FROM predictive_source_stats_revisions")).rows[0].n).toBe(1);
  });
});

it("CSV QB consumers preserve earlier unavailable replay after a later unrelated source deletion", async () => {
  await withProof(async ({ client,store }) => {
    const seed = await seedConsumers(store);
    // The fixture has no opponent schedule coverage. This is a legitimate
    // unavailable answer whose reasons must not acquire later retention history.
    const request = { ...seed.request,candidate: "player-opponent-v1:player_pass_yds" as const };
    const saved = await store.recordSourcePassingYards("earlier-unavailable",request,seed.profiles);
    expect(saved.body.kind).toBe("feature");
    if (saved.body.kind !== "feature") throw new Error("expected feature");
    expect(saved.body.bundle.status).toBe("unavailable-inputs");
    expect(saved.body.bundle.reasons).not.toContain("retained-evidence-removed");
    const original = await store.replaySourcePassingYards(request,seed.profiles);
    expect(await store.replaySourceConsumer(saved.id)).toEqual(saved);
    const laterAt = await witnessClock(client);
    expect(Date.parse(laterAt)).toBeGreaterThan(Date.parse(request.cutoff));
    const unrelated = sourceClaimFixture("later-unrelated-team","team");
    unrelated.capturedAt = laterAt;
    await store.publishSourceStats(unrelated);
    const removed = await store.retain({ id: "later-unrelated-deletion",reason: "provider-request",authority: "synthetic retention regression",
      decidedAt: laterAt,scope: { kind: "source",profileIds: [unrelated.profile.id],capturedFrom: laterAt,capturedBefore: null },auditLevel: "full" });
    expect(removed.removedCounts.sourceStatsRows).toBe(1);
    expect(await store.replaySourcePassingYards(request,seed.profiles)).toEqual(original);
    expect(await store.replaySourceConsumer(saved.id)).toEqual(saved);
  });
});

it("CSV QB final labels refuse pre-window captures and unresolved participation without invented zeros", async () => {
  await withProof(async ({ store }) => {
    const seed = await seedConsumers(store,"2026-10-09T12:00:00.000Z");
    await expect(store.recordSourceFinalLabel("too-early",seed.labelRequest,null)).rejects.toThrow("source-label-post-window-refused");
    const b = sourceClaimFixture("zero-consumer","player",sourceCsv("player",[{ ...sourceSamples().player[0],attempts: "0",passing_yards: "0" }]));
    b.capturedAt=seed.part.record.recordedAt; b.rightsDecisions=seed.fixture.input.rightsDecisions;
    await store.publishSourceStats(b); await store.recordSourceNormalization("zero-binding",seed.raw,seed.binding.event.id);
    await store.recordSourceDecision("zero-reconciliation",decisionScope(seed.raw.profileId),seed.rec.record.id);
    const part = await store.recordSourceDecision("zero-participation",decisionScope(seed.raw.profileId,"participation"),seed.part.record.id);
    const body = await store.replaySourcePassingYards({ ...seed.request,cutoff: part.record.recordedAt,computedAt: part.record.recordedAt },seed.profiles);
    expect(body.bundle.status).toBe("unavailable-inputs");
    expect(body.bundle.player[0]).toMatchObject({ observedGames: 0,unknownGames: 1 });
    await expect(store.recordSourceFinalLabel("zero-label",seed.labelRequest,null)).rejects.toThrow("source-label-inputs-unavailable");
  });
});

it("CSV QB SQL refuses rehashed source manifests forged values identity and completion", async () => {
  await withProof(async ({ client,store }) => {
    const seed = await seedConsumers(store); const feature = await store.replaySourcePassingYards(seed.request,seed.profiles);
    const label = (await store.recordSourceFinalLabel("valid-label",seed.labelRequest,null)).body;
    const mutations: ((body: SourceConsumerBody) => void)[] = [
      (body) => { body.manifest.sources[0].selected!.headToken="0".repeat(64); },
      (body) => { body.manifest.sources[0].reconciliationId=null; },
      (body) => { body.manifest.sources[0].witness.heads=[]; },
      (body) => { if (body.kind === "feature") body.bundle.player[0].games[0].passingYards=99; else body.value=99; },
      (body) => { if (body.kind === "feature") body.manifest.sources=[]; else body.playerBridgeObservationId="game-map"; },
      (body) => { body.manifest.decisions=[]; },
    ];
    for (const original of [feature,label]) for (const mutate of mutations) await probe(client,async () => {
      const body=structuredClone(original); mutate(body); body.inputDigest=sourceConsumerInputDigest(body);
      if (body.kind === "feature") body.bundle.inputDigest=body.inputDigest;
      await expect(sqlConsumer(client,body,"forged",original.kind === "label" ? "valid-label" : null)).rejects.toMatchObject({ code: "23514" });
    });
    await probe(client,async () => { await expect(client.query("INSERT INTO predictive_source_consumers SELECT * FROM predictive_source_consumers LIMIT 1"))
      .rejects.toThrow(); });
  });
});

it("CSV QB consumers enforce use-specific rights before files for source context and native evidence", async () => {
  for (const revokeProfile of ["csv-synthetic-player",BRIDGE_PROFILE,"consumer-native"]) await withProof(async ({ client,store,artifacts,target }) => {
    const seed = await seedConsumers(store);
    if (revokeProfile === "consumer-native") {
      const native: Dataset = { formatVersion: 2,profiles: [profile(revokeProfile)],rightsDecisions: [rights(revokeProfile)],
        artifacts: [],captures: [],decisions: [],labels: [],identityLinks: [] };
      const nativeAt = new Date().toISOString();
      addCapture(native,"consumer-native",[revision("consumer-native-participated","participation-evidence",{
        gameId: NORMALIZATION_GAME,playerId: seed.request.playerId,teamId: "nfl:team:PHI",evidenceKind: "participation-feed",claim: "offensive-participant",
      })],nativeAt,revokeProfile);
      await store.publish("consumer-native",native,nativeAt);
      const part = await store.recordSourceDecision("native-participation",decisionScope(seed.raw.profileId,"participation"),seed.part.record.id);
      seed.request.cutoff=seed.request.computedAt=part.record.recordedAt;
    }
    const saved = await store.recordSourcePassingYards("rights-feature",seed.request,seed.profiles);
    const t = new Date().toISOString(); const prior = revokeProfile==="csv-synthetic-player" ? "rights:" + revokeProfile : "rights-" + revokeProfile;
    await client.query(`INSERT INTO predictive_rights_decisions VALUES('consumer-restricted',$1,$2,ARRAY['internal-research'], $3,NULL,$3,'synthetic','test use restriction')`,[revokeProfile,prior,t]);
    let reads=0;
    const guarded = { ...artifacts,database: { ...artifacts.database,read: async () => { reads++; throw new Error("unauthorized-file-read"); } } };
    const restricted = await createLocalPredictiveStore(client,target,guarded);
    await expect(restricted.replaySourcePassingYards(seed.request,seed.profiles)).rejects.toThrow("source-consumer-rights-refused");
    await expect(restricted.recordSourceFinalLabel("rights-label",seed.labelRequest,null)).rejects.toThrow("source-consumer-rights-refused");
    await expect(restricted.replaySourceConsumer(saved.id)).rejects.toThrow("source-consumer-rights-refused");
    expect(reads).toBe(0);
  });
});

it("CSV QB migration upgrades v9 preserving binding and decision history and is idempotent", async () => {
  await withProof(async ({ client,store,target }) => {
    const { request } = await seedBinding(store);
    await store.recordSourceNormalization("pre-consumer-binding",request,null);
    const decision=await store.recordSourceDecision("pre-consumer-decision",decisionScope(request.profileId),null);
    const ledger=(await client.query("SELECT * FROM db_migrations ORDER BY version")).rows;
    const files=await checkMigrationArtifacts(); const contracts=await loadCatalogContracts(files);
    const options={ ...target,files,verify: createCatalogVerifier(contracts) };
    expect(await runScratchMigrations(client,options)).toMatchObject({ executed: [10, 11, 12, 13, 14, 15, 16],schemaVersion: 16 });
    expect((await client.query("SELECT * FROM db_migrations ORDER BY version")).rows.slice(0,9)).toEqual(ledger);
    expect(await store.replaySourceDecision({ ...decisionScope(request.profileId),cutoff: decision.record.recordedAt })).toMatchObject({ record: decision.record });
    expect(await runScratchMigrations(client,options)).toMatchObject({ executed: [],schemaVersion: 16 });
  },9);
});

it("CSV QB consumers operate through non-superuser execute-only recorders and replay refuses damaged bytes or links", async () => {
  await withProof(async ({ client,store,artifacts,target,root }) => {
    const seed = await seedConsumers(store);
    await withLogin(client,target,["predictive_replay","predictive_recorder","predictive_harness"],async (login,loginTarget) => {
      const restricted = await createLocalPredictiveStore(login,loginTarget,artifacts);
      const saved = await restricted.recordSourcePassingYards("role-feature",seed.request,seed.profiles);
      expect(await restricted.replaySourceConsumer(saved.id)).toEqual(saved);
      const label = await restricted.recordSourceFinalLabel("role-label",seed.labelRequest,null);
      expect(await restricted.replaySourceConsumer(label.id)).toEqual(label);
      await expect(login.query("INSERT INTO predictive_source_consumers SELECT * FROM predictive_source_consumers LIMIT 1")).rejects.toMatchObject({ code: "42501" });
      const path=join(root,".db-blobs",saved.bodySha256 + ".json"); const original=await readFile(path);
      await writeFile(path,"damaged",{ mode: 0o600 });
      await expect(restricted.replaySourceConsumer(saved.id)).rejects.toThrow("artifact-integrity-failed"); await writeFile(path,original,{ mode: 0o600 });
      await client.query("ALTER TABLE predictive_source_consumer_source_decisions DISABLE TRIGGER predictive_source_consumer_source_decisions_immutable");
      await client.query("DELETE FROM predictive_source_consumer_source_decisions WHERE consumer_id=$1",[saved.id]);
      await client.query("ALTER TABLE predictive_source_consumer_source_decisions ENABLE TRIGGER predictive_source_consumer_source_decisions_immutable");
      await expect(restricted.replaySourceConsumer(saved.id)).rejects.toThrow("stored-source-consumer-mismatch");
    });
  });
});

it("CSV QB consumer retention removes features labels and complete label lineage through the retention-only login", async () => {
  await withProof(async ({ client,store,artifacts,target }) => {
    const seed = await seedConsumers(store);
    const feature = await store.recordSourcePassingYards("retained-feature",seed.request,seed.profiles);
    await store.recordSourceFinalLabel("retained-label-A",seed.labelRequest,null);
    await store.recordSourceFinalLabel("retained-label-B",seed.labelRequest,"retained-label-A");
    await withLogin(client,target,["predictive_retention_owner"],async (login,loginTarget) => {
      const owner=await createLocalPredictiveStore(login,loginTarget,artifacts);
      const result=await owner.retain({ id: "consumer-retention",reason: "provider-request",authority: "synthetic retention test",decidedAt: seed.fixture.input.capturedAt,
        scope: { kind: "source",profileIds: [seed.raw.profileId],capturedFrom: null,capturedBefore: null },auditLevel: "full" });
      expect(result.removedCounts.sourceConsumers).toBe(3);
      expect(result.removedIdsDigest).toBe(retentionIdsDigest((await client.query("SELECT target_kind AS kind,target_id AS id FROM predictive_retention_tombstones")).rows));
      expect(await owner.resumeBlobRemovals()).toEqual([]);
    });
    expect(await store.replaySourceConsumer(feature.id)).toBeNull();
    expect((await client.query("SELECT count(*)::integer AS n FROM predictive_source_consumers")).rows[0].n).toBe(0);
    await expect(artifacts.database.read(feature.bodySha256 + ".json",feature.bodySha256,Buffer.byteLength(canonical(feature.body)))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
