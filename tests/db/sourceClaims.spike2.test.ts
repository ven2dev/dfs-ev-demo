import { afterAll } from "vitest";

import { templateFor, cleanupTemplates } from "./spike-template.mjs";

afterAll(cleanupTemplates);

import { appendFileSync as spikeAppend } from "node:fs";

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
  const spikeStart = performance.now(); let spikeLast = spikeStart; const spike: any = { file: "sourceClaims.test.ts", name: expect.getState().currentTestName, prefix: migrationCount ?? "latest", phases: {} };
  const mark = (key: string) => { const now = performance.now(); spike.phases[key] = now - spikeLast; spikeLast = now; };
  const harness = await createScratchHarness(process.env);
  const root = await realpath(await mkdtemp(join(tmpdir(), "dfs52-csv-db-")));
  mark("adminAndTemp");
  try {
    const template = await templateFor(migrationCount); mark("templateAcquire");
    await harness.withDatabase(async (client: Client, expected: object) => {
      mark("createConnect");
      const target = { expected, assertTarget: harness.assertTarget };
      await ensurePredictiveRoles(client); mark("roles");
      // Spike: clone already catalog-verified at the requested migration prefix.
      mark("migrationsIncludingVerify");
      await ensureHarnessSession(client);
      const artifacts = await openArtifactStore(root, 8_000_000);
      const store = await createLocalPredictiveStore(client, target, artifacts); mark("sessionArtifactsStore");
      await work({ client, artifacts, root, target, store }); mark("body");
    }, template);
  } finally { try { await harness.close(); } finally { await rm(root, { recursive: true, force: true }); mark("cleanup"); spike.totalMs = performance.now() - spikeStart; spikeAppend(process.env.SPIKE_PROFILE_PATH!, JSON.stringify(spike)+"\n"); } }
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


const witnessClock = async (client: Client) => (await client.query("SELECT predictive_source_time(clock_timestamp()) AS time")).rows[0].time as string;

const sqlWitness = async (client: Client, request: ReturnType<typeof factRequest>) =>
  (await client.query("SELECT predictive_source_witness($1) AS witness", [request])).rows[0].witness;

const rehashWitness = (witness: ReturnType<typeof sourceFactWitness>) => {
  const { cutoff: _cutoff, evidenceDigest: _digest, ...fields } = witness;
  void _cutoff; void _digest;
  return { ...witness, evidenceDigest: digest(canonical(fields)) };
};


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


const seedConsumers = async (store: Store, captureAt = "2026-10-11T12:00:00.000Z") => {
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
    expect(await runScratchMigrations(client, options)).toMatchObject({ executed: [5, 6, 7, 8, 9, 10, 11], schemaVersion: 11 });
    const upgraded = (await client.query("SELECT * FROM db_migrations ORDER BY version")).rows;
    expect(upgraded.slice(0, 4)).toEqual(ledger);
    for (const table of tables) expect((await client.query(`SELECT * FROM ${table}`)).rows).toEqual(before.get(table));
    await store.publishSourceStats(sourceClaimFixture("after-corpus-upgrade"));
    expect(await runScratchMigrations(client, options)).toMatchObject({ executed: [], schemaVersion: 11 });
    expect((await client.query("SELECT * FROM db_migrations ORDER BY version")).rows).toEqual(upgraded);
    for (const table of tables) expect((await client.query(`SELECT * FROM ${table}`)).rows).toEqual(before.get(table));
  }, 4);
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