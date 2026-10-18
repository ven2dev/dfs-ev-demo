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


it("CSV SQL witness migration upgrades v7 preserving bindings and prior migration history", async () => {
  await withProof(async ({ client, store, target }) => {
    const { request } = await seedBinding(store);
    const a = await store.recordSourceNormalization("sql-upgrade-A", request, null);
    const ledger = (await client.query("SELECT * FROM db_migrations ORDER BY version")).rows;
    const bindings = (await client.query("SELECT * FROM predictive_source_bindings ORDER BY id")).rows;
    const revisions = (await client.query("SELECT * FROM predictive_source_stats_revisions ORDER BY id")).rows;
    const files = await checkMigrationArtifacts(); const contracts = await loadCatalogContracts(files);
    const options = { ...target, files, verify: createCatalogVerifier(contracts) };
    expect(await runScratchMigrations(client, options)).toMatchObject({ executed: [8, 9, 10, 11], schemaVersion: 11 });
    expect((await client.query("SELECT * FROM db_migrations ORDER BY version")).rows.slice(0, 7)).toEqual(ledger);
    expect((await client.query("SELECT * FROM predictive_source_bindings ORDER BY id")).rows).toEqual(bindings);
    expect((await client.query("SELECT * FROM predictive_source_stats_revisions ORDER BY id")).rows).toEqual(revisions);
    const scoped = factRequest(request.profileId, a.event.recordedAt);
    expect(await sqlWitness(client, scoped)).toEqual(sourceFactWitness(await store.replaySourceStatsFacts(scoped)));
    expect(await runScratchMigrations(client, options)).toMatchObject({ executed: [], schemaVersion: 11 });
    // The released-v4 upgrade test above seeds all five corpus tables and now
    // runs through 0008; this focused v7 test seeds source bindings as well.
  }, 7);
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
    expect(await runScratchMigrations(client,options)).toMatchObject({ executed: [11],schemaVersion: 11 });
    expect((await client.query("SELECT * FROM predictive_captures ORDER BY id")).rows).toEqual(captures);
    expect((await client.query("SELECT * FROM db_migrations ORDER BY version")).rows.slice(0,10)).toEqual(ledger);
    expect(await runScratchMigrations(client,options)).toMatchObject({ executed: [],schemaVersion: 11 });
  },10);
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