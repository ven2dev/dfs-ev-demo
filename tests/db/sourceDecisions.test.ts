import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "pg";
import { expect, it } from "vitest";
import { checkMigrationArtifacts } from "../../scripts/db-migrations/files.mjs";
import { createCatalogVerifier, loadCatalogContracts } from "../../scripts/db-migrations/contracts.mjs";
import { runScratchMigrations } from "../../scripts/db-migrations/core.mjs";
import { createLocalPredictiveStore, retentionIdsDigest } from "../../src/lib/predictive/persistence.ts";
import type { Dataset, RecordedRetentionEvent } from "../../src/lib/predictive/types.ts";
import { canonical } from "../../src/lib/predictive/validation.ts";
import { selectSourceFact, SOURCE_FACT_BOUNDS } from "../../src/lib/predictive/sourceFacts.ts";
import { checkSourceWitness, sourceFactWitness, sourcePostWindowCapture, sourceReconciliationEvidence, sourceUsageEvidence } from "../../src/lib/predictive/sourceWitness.ts";
import { sourceDecisionBasis, type SourceDecisionPlan } from "../../src/lib/predictive/sourceDecisions.ts";
import { sourceClaimFixture } from "../predictive/fixtures/sourceClaims.ts";
import { sourceCsv, sourceGameId, sourceSamples } from "../predictive/fixtures/source.ts";
import { addCapture, profile, revision } from "../predictive/fixtures/passingYards.ts";
import { BRIDGE_PROFILE, normalizationFixture, NORMALIZATION_GAME, rewriteNormalizationRows } from "../predictive/fixtures/sourceNormalization.ts";
import { withProof, captureTime, probe, withLogin, seedBinding, factKey, factRequest, changeFactPlayer, witnessClock, sqlWitness, rehashWitness, decisionScope, rehashDecision, publishInactive, type Store } from "./sourceClaimsSupport";

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
    expect(await runScratchMigrations(client, options)).toMatchObject({ executed: [9, 10, 11], schemaVersion: 11 });
    expect((await client.query("SELECT * FROM db_migrations ORDER BY version")).rows.slice(0, 8)).toEqual(ledger);
    expect((await client.query("SELECT * FROM predictive_source_bindings ORDER BY id")).rows).toEqual(bindings);
    expect(await sqlWitness(client, req)).toEqual(witness);
    expect(await runScratchMigrations(client, options)).toMatchObject({ executed: [], schemaVersion: 11 });
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
