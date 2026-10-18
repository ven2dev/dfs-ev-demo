import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { checkMigrationArtifacts } from "../../scripts/db-migrations/files.mjs";
import { createCatalogVerifier, loadCatalogContracts } from "../../scripts/db-migrations/contracts.mjs";
import { runScratchMigrations } from "../../scripts/db-migrations/core.mjs";
import { createLocalPredictiveStore, retentionIdsDigest } from "../../src/lib/predictive/persistence.ts";
import type { Dataset } from "../../src/lib/predictive/types.ts";
import { canonical } from "../../src/lib/predictive/validation.ts";
import { applicableQuarterback } from "../../src/lib/predictive/identity.ts";
import { sourceConsumerInputDigest, type SourceConsumerBody } from "../../src/lib/predictive/sourceConsumers.ts";
import { sourceClaimFixture } from "../predictive/fixtures/sourceClaims.ts";
import { sourceCsv, sourceGameId, sourceSamples } from "../predictive/fixtures/source.ts";
import { addCapture, profile, revision, rights } from "../predictive/fixtures/passingYards.ts";
import { BRIDGE_PROFILE, NORMALIZATION_GAME } from "../predictive/fixtures/sourceNormalization.ts";
import { withProof, probe, withLogin, seedBinding, witnessClock, decisionScope, consumerTargetAt, seedConsumers, sqlConsumer } from "./sourceClaimsSupport";

it("CSV QB consumer fixtures keep a future target and applicable membership across year boundaries", () => {
  for (const clock of ["2026-12-31T23:59:59.999Z","2027-12-31T23:59:59.999Z"]) {
    const { target,targetMember } = consumerTargetAt(clock);
    expect(Date.parse(target.kickoff)).toBeGreaterThan(Date.parse(clock));
    expect(new Date(target.kickoff).getUTCFullYear()).toBe(new Date(clock).getUTCFullYear() + 1);
    expect(applicableQuarterback(targetMember,target)).toBe(true);
  }
});

it("CSV QB consumers record explicit source manifests and final labels without ordinary stats observations", async () => {
  await withProof(async ({ client,store }) => {
    const seed = await seedConsumers(store,await witnessClock(client));
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
    const seed = await seedConsumers(store,await witnessClock(client)); const original = await store.replaySourcePassingYards(seed.request,seed.profiles);
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
    const seed = await seedConsumers(store,await witnessClock(client));
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
  await withProof(async ({ client,store }) => {
    const seed = await seedConsumers(store,await witnessClock(client),"2026-10-09T12:00:00.000Z");
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
    const seed = await seedConsumers(store,await witnessClock(client)); const feature = await store.replaySourcePassingYards(seed.request,seed.profiles);
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
    const seed = await seedConsumers(store,await witnessClock(client));
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
    expect(await runScratchMigrations(client,options)).toMatchObject({ executed: [10, 11],schemaVersion: 11 });
    expect((await client.query("SELECT * FROM db_migrations ORDER BY version")).rows.slice(0,9)).toEqual(ledger);
    expect(await store.replaySourceDecision({ ...decisionScope(request.profileId),cutoff: decision.record.recordedAt })).toMatchObject({ record: decision.record });
    expect(await runScratchMigrations(client,options)).toMatchObject({ executed: [],schemaVersion: 11 });
  },9);
});

it("CSV QB consumers operate through non-superuser execute-only recorders and replay refuses damaged bytes or links", async () => {
  await withProof(async ({ client,store,artifacts,target,root }) => {
    const seed = await seedConsumers(store,await witnessClock(client));
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
    const seed = await seedConsumers(store,await witnessClock(client));
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
