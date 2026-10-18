import { randomBytes } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { expect } from "vitest";
import { ensureHarnessSession } from "../../scripts/predictive/harness.ts";
import { openArtifactStore } from "../../src/lib/predictive/artifacts.ts";
import { createLocalPredictiveStore } from "../../src/lib/predictive/persistence.ts";
import type { Dataset } from "../../src/lib/predictive/types.ts";
import { canonical, digest, instant } from "../../src/lib/predictive/validation.ts";
import { createReplay } from "../../src/lib/predictive/replay.ts";
import { sourceFactWitness } from "../../src/lib/predictive/sourceWitness.ts";
import { type SourceDecisionPlan, type SourceDecisionRequest } from "../../src/lib/predictive/sourceDecisions.ts";
import { type SourceConsumerBody } from "../../src/lib/predictive/sourceConsumers.ts";
import { recordCompletion } from "../../src/lib/predictive/completion.ts";
import { sourceGameId } from "../predictive/fixtures/source.ts";
import { addCapture, completionMarkers, coverage, membership, profile, revision, rights, schedule } from "../predictive/fixtures/passingYards.ts";
import { BRIDGE_PROFILE, normalizationFixture, NORMALIZATION_GAME, rewriteNormalizationRows } from "../predictive/fixtures/sourceNormalization.ts";
import { withMigratedDatabase } from "./migrated.mts";

export type Store = Awaited<ReturnType<typeof createLocalPredictiveStore>>;
export type Artifacts = Awaited<ReturnType<typeof openArtifactStore>>;
export type Target = { expected: object; assertTarget: (config: object) => void };
export const withProof = async (work: (context: { client: Client; store: Store; artifacts: Artifacts; root: string; target: Target }) => Promise<void>, migrationCount?: number) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dfs52-csv-db-")));
  try {
    await withMigratedDatabase(process.env, async (client, target) => {
      await ensureHarnessSession(client);
      const artifacts = await openArtifactStore(root, 8_000_000);
      await work({ client, artifacts, root, target, store: await createLocalPredictiveStore(client, target, artifacts) });
    }, migrationCount);
  } finally { await rm(root, { recursive: true, force: true }); }
};
export const captureTime = async (client: Client, id: string) => (await client.query(`SELECT to_char(ingested_at AT TIME ZONE 'UTC',
  'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS time FROM predictive_captures WHERE id=$1`, [id])).rows[0].time as string;
export const replayRequest = (cutoff: string, player = true) => ({ profileId: "csv-synthetic-" + (player ? "player" : "team"),
  rawGameId: sourceGameId, rawTeam: "PHI", rawPlayerId: player ? "00-0000001" : null, cutoff });
export const probe = async (client: Client, work: () => Promise<void>) => {
  await client.query("BEGIN"); try { await work(); } finally { await client.query("ROLLBACK"); }
};
export const withLogin = async (client: Client, target: Target, roles: string[], work: (connection: Client, loginTarget: Target) => Promise<void>) => {
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
export const seedBinding = async (store: Store, feed: "player" | "team" = "player") => {
  const fixture = await normalizationFixture(feed);
  if (feed === "team") {
    fixture.context.identityLinks = [];
    rewriteNormalizationRows(fixture.context, fixture.bridgeRows.filter((row) => row.kind !== "player-bridge"));
  }
  await store.publishSourceStats(fixture.input);
  await store.publish("source-binding-context", fixture.context, "2026-10-11T00:00:00.000Z");
  return { ...fixture, request: { profileId: fixture.input.profile.id, rawGameId: sourceGameId, rawTeam: "PHI", rawPlayerId: feed === "player" ? "00-0000001" : null } };
};
export const rehashPlan = (plan: Awaited<ReturnType<Store["planSourceStatsNormalization"]>>) => {
  plan.dataDigest = plan.candidate ? digest(canonical(plan.candidate)) : null;
  plan.planDigest = digest(canonical({ reason: plan.reason, candidate: plan.candidate, binding: plan.binding }));
  return plan;
};
export const factKey = (player = "00-0000001") => "player-game-stats:" + NORMALIZATION_GAME + ":" + player;
export const factRequest = (profileId: string, cutoff: string, entityKeys = [factKey()]) => ({ profileIds: [profileId], entityKeys, cutoff });
export const changeFactPlayer = async (client: Client, store: Store, id: string, playerId: string, predecessor: string) => {
  await client.query("SELECT pg_sleep(0.005)");
  const time = new Date().toISOString();
  const context: Dataset = { formatVersion: 2, profiles: [profile(BRIDGE_PROFILE)], rightsDecisions: [], artifacts: [], captures: [], decisions: [], labels: [], identityLinks: [] };
  addCapture(context, id, [revision(id, "player-bridge", { provider: "gsis", rawPlayerId: "00-0000001", playerId,
    effectiveFrom: "2026-01-01T00:00:00.000Z", effectiveTo: "2027-01-01T00:00:00.000Z" }, predecessor)], time, BRIDGE_PROFILE);
  await store.publish(id, context, time);
  return time;
};
export const witnessClock = async (client: Client) => (await client.query("SELECT predictive_source_time(clock_timestamp()) AS time")).rows[0].time as string;
export const sqlWitness = async (client: Client, request: ReturnType<typeof factRequest>) =>
  (await client.query("SELECT predictive_source_witness($1) AS witness", [request])).rows[0].witness;
export const rehashWitness = (witness: ReturnType<typeof sourceFactWitness>) => {
  const { cutoff: _cutoff, evidenceDigest: _digest, ...fields } = witness;
  void _cutoff; void _digest;
  return { ...witness, evidenceDigest: digest(canonical(fields)) };
};
export const decisionScope = (profileId: string, kind: SourceDecisionRequest["kind"] = "reconciliation", entityKey = factKey()) =>
  ({ kind, profileIds: [profileId], entityKey });
export const rehashDecision = (plan: SourceDecisionPlan) => {
  const { planDigest: _digest, ...fields } = plan; void _digest;
  return { ...plan, planDigest: digest(canonical(fields)) };
};
export const publishInactive = async (store: Store, id = "native-inactive", predecessor: string | null = null,
  claim: "inactive-or-dnp" | "offensive-participant" = "inactive-or-dnp", at = "2026-10-09T12:00:00.000Z") => {
  const dataset: Dataset = { formatVersion: 2, profiles: [profile("native-participation")],
    rightsDecisions: predecessor ? [] : [rights("native-participation", { allowedUses: ["internal-research"] })],
    artifacts: [], captures: [], decisions: [], labels: [], identityLinks: [] };
  addCapture(dataset, id, [revision(id, "participation-evidence", { gameId: NORMALIZATION_GAME, playerId: "00-0000001",
    teamId: "nfl:team:PHI", evidenceKind: "participation-feed", claim }, predecessor)], at, "native-participation");
  expect(await store.publish(id, dataset, at)).toMatchObject({ status: "published" });
  return dataset;
};
// Only synthetic event time moves. Database ingestion/decision clocks stay real,
// so these fixtures cannot become postgame merely because CI runs on a later day.
export const consumerTargetAt = (clock: string) => {
  const dayMs = 24 * 60 * 60 * 1000;
  const kickoff = instant(clock) + 7 * dayMs;
  const target = schedule(77,new Date(kickoff).toISOString(),"nfl:team:PHI","nfl:team:CAR");
  return { target, targetMember: membership(target,{ effectiveTo: new Date(kickoff + dayMs).toISOString() }) };
};
export const seedConsumers = async (store: Store, clock: string, captureAt = "2026-10-11T12:00:00.000Z") => {
  const fixture = await normalizationFixture();
  fixture.input.capturedAt = captureAt;
  fixture.input.rightsDecisions[0].allowedUses = ["internal-research","model-input","outcome-label"];
  fixture.context.rightsDecisions = [...fixture.input.rightsDecisions,rights(BRIDGE_PROFILE)];
  const prior = { ...schedule(6,"2026-10-04T17:00:00.000Z","nfl:team:PHI","nfl:team:CAR"),gameId: NORMALIZATION_GAME,rawGameId: sourceGameId };
  const { target,targetMember } = consumerTargetAt(clock);
  const rows = fixture.bridgeRows.map((row) => row.kind === "schedule" ? { ...row,data: prior } : row);
  rows.push(revision("source-target","schedule",target),revision("source-coverage","schedule-coverage",coverage("nfl:team:PHI",[prior.gameId,target.gameId])),
    revision("source-prior-member","membership",membership(prior)),revision("source-target-member","membership",targetMember),
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
  expect(instant(part.record.recordedAt)).toBeLessThan(instant(target.kickoff));
  const request = { playerId: "00-0000001",gameId: target.gameId,cutoff: part.record.recordedAt,computedAt: part.record.recordedAt,
    candidate: "stats-v1:player_pass_yds" as const };
  return { fixture,raw,binding,rec,part,request,profiles: [raw.profileId],labelRequest: { playerId: request.playerId,gameId: prior.gameId,profileIds: [raw.profileId] } };
};
export const sqlConsumer = async (client: Client,body: SourceConsumerBody,id = "forged-consumer",head: string | null = null) => {
  const sha = digest(canonical(body));
  await client.query(`INSERT INTO predictive_blobs(sha256,byte_size,media_type,storage_ref) VALUES($1,$2,'application/json',$3) ON CONFLICT DO NOTHING`,
    [sha,Buffer.byteLength(canonical(body)),sha + ".json"]);
  return client.query("SELECT predictive_record_source_consumer($1,$2,$3)",[id,head,body]);
};
