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
      expect((await client.query("SELECT max(version) AS version FROM db_migrations")).rows[0].version).toBe(11);
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


it("CSV QB migration upgrades v9 preserving binding and decision history and is idempotent", async () => {
  await withProof(async ({ client,store,target }) => {
    const { request } = await seedBinding(store);
    await store.recordSourceNormalization("pre-consumer-binding",request,null);
    const decision=await store.recordSourceDecision("pre-consumer-decision",decisionScope(request.profileId),null);
    const ledger=(await client.query("SELECT * FROM db_migrations ORDER BY version")).rows;
    const files=await checkMigrationArtifacts(); const contracts=await loadCatalogContracts(files);
    const options={ ...target,files,verify: createCatalogVerifier(contracts) };
    expect(await runScratchMigrations(client,options)).toMatchObject({ executed: [10, 11],schemaVersion: 11 });
    expect((await client.query("SELECT * FROM db_migrations ORDER BY version")).rows.slice(0,9)).toEqual(ledger);
    expect(await store.replaySourceDecision({ ...decisionScope(request.profileId),cutoff: decision.record.recordedAt })).toMatchObject({ record: decision.record });
    expect(await runScratchMigrations(client,options)).toMatchObject({ executed: [],schemaVersion: 11 });
  },9);
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


it("CSV source decision migration upgrades v8 preserving recorded bindings and witnesses and reruns as a no-op", async () => {
  await withProof(async ({ client, target, store }) => {
    const { request } = await seedBinding(store); const a = await store.recordSourceNormalization("decision-upgrade-binding", request, null);
    const req = factRequest(request.profileId, a.event.recordedAt); const witness = await sqlWitness(client, req);
    const bindings = (await client.query("SELECT * FROM predictive_source_bindings ORDER BY id")).rows;
    const ledger = (await client.query("SELECT * FROM db_migrations ORDER BY version")).rows;
    const files = await checkMigrationArtifacts(); const contracts = await loadCatalogContracts(files);
    const options = { ...target, files, verify: createCatalogVerifier(contracts) };
    expect(await runScratchMigrations(client, options)).toMatchObject({ executed: [9, 10, 11], schemaVersion: 11 });
    expect((await client.query("SELECT * FROM db_migrations ORDER BY version")).rows.slice(0, 8)).toEqual(ledger);
    expect((await client.query("SELECT * FROM predictive_source_bindings ORDER BY id")).rows).toEqual(bindings);
    expect(await sqlWitness(client, req)).toEqual(witness);
    expect(await runScratchMigrations(client, options)).toMatchObject({ executed: [], schemaVersion: 11 });
    const decision = await store.recordSourceDecision("after-decision-upgrade", decisionScope(request.profileId), null);
    expect(decision.record.plan.witness.heads).toEqual(witness.heads);
  }, 8);
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


it("CSV binding migration upgrades v5 without changing released history and reruns are no-ops", async () => {
  await withProof(async ({ client, target, store }) => {
    const input = sourceClaimFixture("before-v6"); await store.publishSourceStats(input);
    const ledger = (await client.query("SELECT * FROM db_migrations ORDER BY version")).rows;
    const raw = (await client.query("SELECT * FROM predictive_source_stats_rows ORDER BY id")).rows;
    const files = await checkMigrationArtifacts(); const contracts = await loadCatalogContracts(files);
    await runScratchMigrations(client, { ...target, files, verify: createCatalogVerifier(contracts) });
    const upgraded = (await client.query("SELECT * FROM db_migrations ORDER BY version")).rows;
    expect(upgraded.slice(0, 5)).toEqual(ledger); expect(upgraded).toHaveLength(11);
    expect((await client.query("SELECT * FROM predictive_source_stats_rows ORDER BY id")).rows).toEqual(raw);
    await runScratchMigrations(client, { ...target, files, verify: createCatalogVerifier(contracts) });
    expect((await client.query("SELECT * FROM db_migrations ORDER BY version")).rows).toEqual(upgraded);
  }, 5);
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


it("CSV normalization refuses tampered raw files before proposing a canonical payload", async () => {
  await withProof(async ({ client, store, root }) => {
    const { input, context } = await normalizationFixture();
    await store.publishSourceStats(input); await store.publish("tamper-normalization-context", context, "2026-10-11T00:00:00.000Z");
    await writeFile(join(root, ".db-blobs", input.artifact.sha256 + ".csv"), input.artifact.bytes.replace('"80"', '"81"'), { mode: 0o600 });
    await expect(store.planSourceStatsNormalization(replayRequest(await captureTime(client, input.captureId)))).rejects.toThrow("artifact-integrity-failed");
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