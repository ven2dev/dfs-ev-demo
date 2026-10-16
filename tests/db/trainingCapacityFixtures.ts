import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { Client } from "pg";
import { expect } from "vitest";
import type { PrivateArtifactStore } from "../../src/lib/predictive/artifacts.ts";
import { createLocalPredictiveStore } from "../../src/lib/predictive/persistence.ts";
import { canonical, digest } from "../../src/lib/predictive/validation.ts";
import { createReplay } from "../../src/lib/predictive/replay.ts";
import { recordCompletion } from "../../src/lib/predictive/completion.ts";
import { compressedSourceAsset, COMPRESSED_SOURCE_PROFILE_VERSION } from "../../src/lib/predictive/compressedPublication.ts";
import { sourceDecisionPlan, type SourceDecisionRecord } from "../../src/lib/predictive/sourceDecisions.ts";
import { sourceFactSnapshot, type SourceFactSnapshot } from "../../src/lib/predictive/sourceFacts.ts";
import { sourceFactWitness } from "../../src/lib/predictive/sourceWitness.ts";
import { buildSourcePassingYards, buildSourceFinalLabel, sourceConsumerInputDigest, type SourceConsumerBody, type SourceConsumerFact } from "../../src/lib/predictive/sourceConsumers.ts";
import { TRAINING_HISTORY_POLICY, TRAINING_HISTORY_SHA256, type FittingRunRequest, type TrainingSlot } from "../../src/lib/predictive/training.ts";
import type { Dataset, Revision, Schedule } from "../../src/lib/predictive/types.ts";
import { addCapture, completionMarkers, coverage, membership, profile, revision, rights, schedule } from "../predictive/fixtures/passingYards.ts";
import { sourceClaimFixture } from "../predictive/fixtures/sourceClaims.ts";
import { sourceCsv } from "../predictive/fixtures/source.ts";

type Store = Awaited<ReturnType<typeof createLocalPredictiveStore>>;
const NATIVE = "capacity-context";
const CAPTURED = "2026-10-11T12:00:00.000Z";
const KICKOFF = "2026-10-18T17:00:00.000Z";
const pairs = [["PHI", "CAR"], ["DAL", "NYG"], ["BUF", "NE"], ["KC", "LV"],
  ["SF", "SEA"], ["BAL", "CIN"], ["CHI", "GB"], ["HOU", "TEN"]];
type Example = { playerId: string; prior: Schedule; target: Schedule; targetObservationId: string; profileId: string;
  passingYards: number; attempts: number; featureId: string; labelId: string };

// Independent player identities, games, source rows/captures and native files.
// Eight QBs share each team's one-game synthetic history. This deliberately
// falls short of a real population, a full 16-game history or opponent context.
// Fixture preparation uses the same checked SQL recorders, plus one independently
// byte-verified full snapshot. It avoids reopening/decoding the entire population
// hundreds of times merely to seed a read benchmark. Measured APIs are untouched.
const recordCapacityBody = async (client: Client, artifacts: PrivateArtifactStore, id: string, body: SourceConsumerBody,
  guardedRecording: boolean) => {
  const bytes = canonical(body), sha = digest(bytes), key = Buffer.from(sha, "hex").readInt32BE(0);
  await client.query("SELECT pg_advisory_lock(520054,$1)", [key]);
  try {
    await artifacts.database.write(bytes, sha);
    const registerBlob = () => client.query("INSERT INTO predictive_blobs VALUES ($1,$2,'application/json',$3) ON CONFLICT DO NOTHING",
      [sha, Buffer.byteLength(bytes), sha + ".json"]);
    // Benchmark-only staging in the owned scratch database. A blob write inside
    // the recorder transaction correctly disables 0020 reuse. Commit metadata
    // first, then let the released recorder validate under the complete guard.
    // Setup failure still removes this entire scratch DB and artifact directory.
    if (guardedRecording) await registerBlob();
    await client.query("BEGIN");
    try {
      if (guardedRecording) {
        await client.query("SELECT predictive_training_read_guard()");
        expect((await client.query("SELECT predictive_training_memo_ready() AS ready")).rows[0].ready).toBe(true);
      } else await registerBlob();
      await client.query("SELECT predictive_record_source_consumer($1,NULL,$2)", [id, body]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      if (!(await client.query("SELECT 1 FROM predictive_blobs WHERE storage_ref=$1", [sha + ".json"])).rows.length) await artifacts.database.remove(sha + ".json", sha);
      throw error;
    }
  } finally { await client.query("SELECT pg_advisory_unlock(520054,$1)", [key]); }
};
export const seedCapacity = async (store: Store, client: Client, artifacts: PrivateArtifactStore, size: number,
  { guardedRecording = false, targetGames = 1 }: { guardedRecording?: boolean; targetGames?: number } = {}) => {
  if (!Number.isInteger(size) || size < 1 || size > 256 || ![1, 4].includes(targetGames)) throw new Error("capacity-fixture-bounds-refused");
  const context: Dataset = { formatVersion: 2, profiles: [profile(NATIVE)], rightsDecisions: [rights(NATIVE)],
    artifacts: [], captures: [], decisions: [], labels: [], identityLinks: [] };
  const examples: Example[] = [];
  const publications = [];
  const playersPerGroup = size > 64 ? 32 : 8;
  const groups = Math.ceil(size / playersPerGroup);
  for (let group = 0; group < groups; group++) {
    const [home, away] = pairs[group], teamId = "nfl:team:" + home, opponentId = "nfl:team:" + away;
    const rawGameId = `2026_06_${away}_${home}`;
    const prior = { ...schedule(600 + group, "2026-10-04T17:00:00.000Z", teamId, opponentId), rawGameId, week: 6 };
    const target = { ...schedule(700 + group, KICKOFF, teamId, opponentId), rawGameId: `2026_07_${away}_${home}`, week: 7 };
    const targets = Array.from({ length: targetGames }, (_, event) => event === 0 ? target : ({
      ...schedule(700 + group + event * 1000, `2026-${event === 1 ? "10-25" : event === 2 ? "11-01" : "11-08"}T17:00:00.000Z`, teamId, opponentId),
      rawGameId: `2026_${String(7 + event).padStart(2, "0")}_${away}_${home}`, week: 7 + event }));
    const players = Array.from({ length: Math.min(playersPerGroup, size - group * playersPerGroup) }, (_, i) => {
      const index = group * playersPerGroup + i;
      return { playerId: "00-" + String(100 + index).padStart(7, "0"), attempts: 10 + index, passingYards: 80 + index * 3 };
    });
    const csv = sourceCsv("player", players.map((player) => ({ player_id: player.playerId, position: "QB", game_id: rawGameId,
      season: "2026", week: "6", season_type: "REG", team: home, opponent_team: away,
      attempts: String(player.attempts), passing_yards: String(player.passingYards) })));
    const input = sourceClaimFixture("capacity-source-" + group, "player", csv), compressed = group % 2 === 1;
    input.profile.id = "capacity-stats-" + group; input.artifact.profileId = input.profile.id;
    input.capturedAt = CAPTURED;
    input.rightsDecisions = [rights(input.profile.id)];
    if (compressed) {
      const asset = compressedSourceAsset("player", 2026);
      input.profile = { ...input.profile, parserVersion: COMPRESSED_SOURCE_PROFILE_VERSION, assetPattern: asset.name };
    }
    publications.push({ input, compressed });
    context.profiles.push(input.profile); context.rightsDecisions.push(...input.rightsDecisions);
    context.identityLinks.push({ id: "capacity-identity-" + group, statsProfileId: input.profile.id,
      bridgeProfileId: NATIVE, provider: "gsis", decidedAt: "2026-01-01T00:00:00.000Z" });
    const rows: Revision[] = [
      revision("capacity-map-" + group, "game-bridge", { provider: "nflverse", rawGameId, gameId: prior.gameId }),
      ...[home, away].map((alias) => revision("capacity-alias-" + alias, "team-alias", { provider: "nflverse", rawAlias: alias,
        teamId: "nfl:team:" + alias, effectiveFromSeason: 2026, effectiveToSeason: 2026 })),
      revision("capacity-prior-" + group, "schedule", prior),
      ...targets.map((game, event) => revision("capacity-target-" + group + (event ? "-" + event : ""), "schedule", game)),
      revision("capacity-coverage-" + group, "schedule-coverage", coverage(teamId, [prior.gameId, ...targets.map((game) => game.gameId)])),
      ...completionMarkers(prior),
    ];
    for (const player of players) {
      rows.push(revision("capacity-player-map-" + player.playerId, "player-bridge", { provider: "gsis", rawPlayerId: player.playerId,
        playerId: player.playerId, effectiveFrom: "2026-01-01T00:00:00.000Z", effectiveTo: "2027-01-01T00:00:00.000Z" }),
      ...[prior, ...targets].map((game) => revision("capacity-member-" + game.gameId + "-" + player.playerId, "membership",
        membership(game, { playerId: player.playerId, rawPlayerId: player.playerId, teamId, rawTeam: home }))));
      for (const [event, game] of targets.entries()) examples.push({ ...player, prior, target: game,
        targetObservationId: "capacity-target-" + group + (event ? "-" + event : ""), profileId: input.profile.id,
        featureId: "capacity-feature-" + player.playerId + (event ? "-" + event : ""), labelId: "capacity-label-" + player.playerId });
    }
    addCapture(context, "capacity-native-" + group, rows, "2026-10-07T12:00:00.000Z", NATIVE);
    Object.assign(context.artifacts.at(-1)!, { scopeKind: "season-file", scopeSeason: 2026 });
  }
  const replay = createReplay(context, "2026-10-12T12:00:00.000Z", "2026-10-12T12:00:00.000Z", "internal-research");
  context.decisions = [...new Map(examples.map((example) => [example.prior.gameId, example])).values()].map(({ prior }) => recordCompletion("capacity-complete-" + prior.gameId,
    prior.gameId, replay.completion(prior.gameId).inputs, "2026-10-08T12:00:00.000Z", "synthetic-proof"));
  for (const { input, compressed } of publications) {
    if (compressed) {
      const { bytes, ...artifact } = input.artifact, wire = gzipSync(bytes), asset = compressedSourceAsset("player", 2026);
      await store.publishCompressedSource(wire, { ...input, artifact: { ...artifact, origin: asset.url,
        sha256: createHash("sha256").update(wire).digest("hex"), wireBytes: wire.length } });
    } else await store.publishSourceStats(input);
  }
  expect(await store.publish("capacity-context-run", context, "2026-10-12T12:00:00.000Z")).toMatchObject({ status: "published" });
  const profiles = publications.map(({ input }) => input.profile.id).sort();
  const players = [...new Map(examples.map((example) => [example.playerId, example])).values()];
  for (const [index, example] of players.entries()) {
    const raw = { profileId: example.profileId, rawGameId: example.prior.rawGameId, rawTeam: example.prior.rawHomeTeam,
      rawPlayerId: example.playerId };
    const normalize = Math.floor(index / playersPerGroup) % 2 ? store.recordCompressedSourceNormalization : store.recordSourceNormalization;
    await normalize("capacity-binding-" + example.playerId, raw, null);
    if ((index + 1) % 16 === 0 || index + 1 === size) process.stdout.write("capacity bindings " + (index + 1) + "\n");
  }
  const clock = async () => (await client.query("SELECT predictive_source_time(clock_timestamp()) AS time")).rows[0].time as string;
  const entityKeys = players.map((example) => "player-game-stats:" + example.prior.gameId + ":" + example.playerId).sort();
  const snapshots: SourceFactSnapshot[] = [], snapshotAt = await clock();
  // Source fact requests retain their frozen 64-key ceiling even when the
  // synthetic population grows. Every key belongs to one complete batch.
  for (let offset = 0; offset < entityKeys.length; offset += 64) {
    snapshots.push(await store.replaySourceStatsFacts({ profileIds: profiles, entityKeys: entityKeys.slice(offset, offset + 64), cutoff: snapshotAt }));
  }
  for (const snapshot of snapshots) { expect(snapshot.reason).toBeNull(); expect(snapshot.withheld).toEqual([]); }
  expect(snapshots.reduce((n, snapshot) => n + snapshot.heads.length, 0)).toBe(size);
  const snapshotFor = (key: string) => snapshots.find((snapshot) => snapshot.request.entityKeys.includes(key))!;
  const decisions = new Map<string, { rec: SourceDecisionRecord; part: SourceDecisionRecord }>();
  for (const example of players) {
    const entityKey = "player-game-stats:" + example.prior.gameId + ":" + example.playerId;
    const snapshot = snapshotFor(entityKey);
    const record = async (kind: "reconciliation" | "participation") => {
      const plan = sourceDecisionPlan(snapshot, { kind, profileIds: profiles, entityKey, cutoff: snapshot.request.cutoff }, [], "synthetic-proof");
      if (guardedRecording) await client.query("BEGIN");
      try {
        if (guardedRecording) await client.query("SELECT predictive_training_read_guard()");
        const result = (await client.query("SELECT predictive_record_source_decision($1,NULL,$2) AS record",
          ["capacity-" + kind + "-" + example.playerId, plan])).rows[0].record as SourceDecisionRecord;
        if (guardedRecording) await client.query("COMMIT");
        return result;
      } catch (error) { if (guardedRecording) await client.query("ROLLBACK"); throw error; }
    };
    decisions.set(entityKey, { rec: await record("reconciliation"), part: await record("participation") });
  }
  const cutoff = await clock();
  const facts = new Map<string, SourceConsumerFact>(entityKeys.map((key) => {
    const snapshot = snapshotFor(key);
    return [key, {
    // The label builder requires one target, while source verification above
    // checks the entire population before any canonical filtering.
    snapshot: sourceFactSnapshot({ ...snapshot.request, entityKeys: [key], cutoff },
      snapshot.heads.filter((head) => head.entityKey === key), [], null),
    reconciliation: decisions.get(key)!.rec, participation: decisions.get(key)!.part, reconciliationReason: null, participationReason: null }];
  }));
  process.stdout.write("capacity decisions " + size * 2 + "\n");
  for (const [index, example] of examples.entries()) {
    // Replay records cited decisions; each independent consumer starts fresh.
    const native = createReplay(context, cutoff, cutoff, "model-input");
    const body = buildSourcePassingYards(native, { playerId: example.playerId, gameId: example.target.gameId,
      cutoff, computedAt: cutoff, candidate: "stats-v1:player_pass_yds" }, profiles, facts);
    const intervening = example.target.kickoff > KICKOFF;
    expect(body.bundle.status, canonical({ featureId: example.featureId, reasons: body.bundle.reasons })).toBe(intervening ? "unavailable-inputs" : "ready-inputs");
    if (intervening) expect(body.bundle.reasons).toEqual(["intervening-player-game", "intervening-team-game"]);
    expect(body.bundle.player[0]).toMatchObject({ passingYardsSum: example.passingYards, attemptsSum: example.attempts });
    await recordCapacityBody(client, artifacts, example.featureId, body, guardedRecording);
    const fact = facts.get("player-game-stats:" + example.prior.gameId + ":" + example.playerId)!;
    const witness = sourceFactWitness(fact.snapshot, ["player-game-stats:" + example.prior.gameId + ":" + example.playerId]);
    expect([fact.reconciliation, fact.participation].map((record) => ({ kind: record!.plan.kind, entityKey: record!.plan.entityKey,
      digest: record!.plan.witness.evidenceDigest, visible: Date.parse(record!.recordedAt) <= Date.parse(witness.cutoff) }))).toEqual([
      { kind: "reconciliation", entityKey: witness.entityKeys[0], digest: witness.evidenceDigest, visible: true },
      { kind: "participation", entityKey: witness.entityKeys[0], digest: witness.evidenceDigest, visible: true }]);
    const label = buildSourceFinalLabel(fact,
      { id: "capacity-complete-" + example.prior.gameId, completionObservedAt: "2026-10-07T12:00:00.000Z" }, profiles);
    label.manifest.observations = native.completion(example.prior.gameId).inputs.map((row) => row.revision.id).sort();
    label.inputDigest = sourceConsumerInputDigest(label);
    expect(label.value).toBe(example.passingYards);
    if (example.featureId === "capacity-feature-" + example.playerId) await recordCapacityBody(client, artifacts, example.labelId, label, guardedRecording);
    if ((index + 1) % 16 === 0 || index + 1 === size) {
      process.stdout.write("capacity consumers " + (index + 1) * 2 + "\n");
    }
  }
  return { examples: examples.sort((a, b) => a.target.kickoff.localeCompare(b.target.kickoff) || a.playerId.localeCompare(b.playerId)), profiles, cutoff };
};

export const runRequest = (seed: Awaited<ReturnType<typeof seedCapacity>>, count: number, labelsAsOf: string): FittingRunRequest => {
  const slots: TrainingSlot[] = seed.examples.slice(0, count).map((example) => ({ datasetId: "capacity-dataset-" + count,
    partition: "evaluation", playerId: example.playerId, gameId: example.target.gameId, season: 2026, seasonType: "REG", kickoff: example.target.kickoff,
    kickoffObservationId: example.targetObservationId, featureCutoff: seed.cutoff, labelsAsOf, featureRef: null, labelRef: null }));
  return { version: "qb-training-read-v1", fittingRunId: "capacity-run-" + count, evaluationPlanId: "capacity-plan-" + count,
    foldId: "capacity-fold", fitCutoff: seed.cutoff,
    selection: { market: "player_pass_yds", stat: "passing_yards", candidate: "stats-v1:player_pass_yds", featureVersion: "passing-yards-source-v1",
      labelVersion: "source-final-label-v1", historyPolicy: TRAINING_HISTORY_POLICY, historyPolicySha256: TRAINING_HISTORY_SHA256, profileIds: seed.profiles },
    modelIdentity: { modelVersion: "capacity-proof", codeCommit: "a".repeat(40), configurationSha256: "b".repeat(64) },
    splitPolicy: { version: "target-event-disjoint-v1", evaluationMode: "walk-forward", aggregationPolicyId: "unique-events-v1", aggregationPolicySha256: "c".repeat(64) },
    population: { status: "unqualified", enumerationOrigin: "synthetic-capacity-slots", enumerationSha256: digest(canonical(slots)) }, slots };
};
