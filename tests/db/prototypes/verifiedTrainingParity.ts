import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "pg";
import { expect } from "vitest";
import type { PrivateArtifactStore } from "../../../src/lib/predictive/artifacts.ts";
import { createLocalPredictiveStore } from "../../../src/lib/predictive/persistence.ts";
import type { TrainingDatasetManifest } from "../../../src/lib/predictive/trainingDatasets.ts";
import type { TrainingHistoricalLabelRequest } from "../../../src/lib/predictive/trainingReads.ts";
import type { seedCapacity } from "../trainingCapacityFixtures.ts";
import { createVerifiedTrainingSpike } from "./verifiedTraining.ts";
import { canonical, digest } from "../../../src/lib/predictive/validation.ts";
import { sourceConsumerInputDigest, type SourceFeatureBody } from "../../../src/lib/predictive/sourceConsumers.ts";
import { runRequest } from "../trainingCapacityFixtures.ts";

type Harness = { assertTarget: (config: object) => void;
  withDatabase: <T>(work: (client: Client, expected: object) => Promise<T>, options: { template: object }) => Promise<T> };
type Check = { case: string; passed: boolean; details?: unknown };
const message = (error: unknown) => error instanceof Error ? error.message : "unknown";

export const checkVerifiedTrainingParity = async (harness: Harness, template: object, artifacts: PrivateArtifactStore,
  root: string, seed: Awaited<ReturnType<typeof seedCapacity>>, manifest: TrainingDatasetManifest, clock: string, checks: Check[]) => {
  const example = seed.examples[0];
  const request: TrainingHistoricalLabelRequest = { version: "qb-training-read-v1", labelsAsOf: clock,
    selection: { market: "player_pass_yds", stat: "passing_yards", labelVersion: "source-final-label-v1", profileIds: seed.profiles },
    keys: [{ playerId: example.playerId, gameId: example.prior.gameId, seasonType: "REG", labelRef: null }], limits: { rows: 1, bytes: 8_000_000 } };
  const page = { version: "qb-training-read-v1" as const, fittingRunId: manifest.fittingRunId, inventorySha256: manifest.inventorySha256,
    datasetId: manifest.datasetId, manifestSha256: manifest.manifestSha256, cursor: null, limits: { rows: 1, bytes: 8_000_000 } };
  const restricted = async <T>(admin: Client, expected: object, work: (client: Client, target: { expected: object; assertTarget: (config: object) => void }) => Promise<T>) => {
    const login = "dfs127_parity_" + randomBytes(8).toString("hex");
    await admin.query(`CREATE ROLE ${login} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD 'disposable-parity'`);
    await admin.query(`GRANT predictive_replay,predictive_recorder TO ${login}`);
    const config = { ...expected, user: login, password: "disposable-parity" }, client = new Client(config);
    try {
      await client.connect();
      return await work(client, { expected: config, assertTarget: (supplied) => { expect(supplied).toEqual(config); harness.assertTarget(expected); } });
    } finally { await client.end(); await admin.query(`DROP OWNED BY ${login}`); await admin.query(`DROP ROLE ${login}`); }
  };
  const revoke = (admin: Client, profile: string) => admin.query(`INSERT INTO predictive_rights_decisions
    SELECT 'spike-revoke-'||$1,d.profile_id,d.id,'{}',date_trunc('milliseconds',clock_timestamp()),NULL,
      date_trunc('milliseconds',clock_timestamp()),'synthetic','spike revocation parity'
    FROM predictive_rights_decisions d WHERE profile_id=$1 AND NOT EXISTS(SELECT 1 FROM predictive_rights_decisions n WHERE n.predecessor_id=d.id)`, [profile]);
  const remove = (admin: Client) => admin.query(`SELECT predictive_retention_execute('spike-remove','provider-request','disposable spike',
    date_trunc('milliseconds',now()),$1,'full')`, [{ kind: "source", profileIds: [example.profileId], capturedFrom: null, capturedBefore: null }]);
  const attempt = async (work: () => Promise<unknown>) => { try { return { result: await work(), reason: null }; } catch (error) { return { result: null, reason: message(error) }; } };
  await harness.withDatabase(async (admin, expected) => {
    await restricted(admin, expected, async (client, target) => {
      const baseline = await createLocalPredictiveStore(client, target, artifacts), spike = await createVerifiedTrainingSpike(client, target, artifacts);
      const cases: [string, TrainingHistoricalLabelRequest][] = [
        ["usable-label", request],
        ["missing-exact-label", { ...request, keys: [{ ...request.keys[0], labelRef: "not-recorded" }] }],
        ["label-before-recording-cutoff", { ...request, labelsAsOf: seed.cutoff }],
        ["future-exact-label-refusal", { ...request, labelsAsOf: seed.cutoff, keys: [{ ...request.keys[0], labelRef: example.labelId }] }],
        ["wrong-player-exact-label-refusal", { ...request, keys: [{ ...request.keys[0], playerId: "00-9999999", labelRef: example.labelId }] }],
      ];
      for (const [name, supplied] of cases) {
        const old = await attempt(() => baseline.readLabelsAt(supplied)), current = await attempt(() => spike.readLabelsAt(supplied));
        expect(current.reason).toBe(old.reason);
        if (old.result && current.result) expect((current.result as { rows: unknown }).rows).toEqual((old.result as { rows: unknown }).rows);
        checks.push({ case: name, passed: true, details: { baselineReason: old.reason, prototypeReason: current.reason } });
      }
      for (const sql of ["INSERT INTO public.spike127_certificates SELECT * FROM public.spike127_certificates LIMIT 1",
        "UPDATE public.spike127_certificates SET certificate_sha256=repeat('0',64)", "TRUNCATE public.spike127_certificates"]) {
        await expect(client.query(sql)).rejects.toMatchObject({ code: "42501" });
      }
      checks.push({ case: "restricted-login-cannot-forge-or-mutate-certificate", passed: true });
    });
  }, { template });
  await harness.withDatabase(async (admin, expected) => {
    const body = structuredClone((await admin.query("SELECT body FROM predictive_source_consumers WHERE id=$1", [example.featureId])).rows[0].body) as SourceFeatureBody;
    // Valid source references and a valid checksum are not proof that a caller
    // used the required history. Keep every dependency but erase a stats window.
    body.bundle.player = body.bundle.player.map((summary) => ({ ...summary, games: [], attemptsSum: 0, passingYardsSum: 0 }));
    body.inputDigest = sourceConsumerInputDigest(body); body.bundle.inputDigest = body.inputDigest;
    const bytes = canonical(body), hash = digest(bytes);
    await artifacts.database.write(bytes, hash);
    await admin.query("INSERT INTO predictive_blobs VALUES($1,$2,'application/json',$3) ON CONFLICT DO NOTHING", [hash, Buffer.byteLength(bytes), hash + ".json"]);
    const publication = await attempt(() => admin.query("SELECT spike127_record_source_consumer('forged-window',NULL,$1)", [body]));
    if (publication.reason) checks.push({ case: "forged-numerical-window-refused-at-certification", passed: true, details: publication.reason });
    else {
      const producer = await createLocalPredictiveStore(admin, { expected, assertTarget: harness.assertTarget }, artifacts);
      const old = await attempt(() => producer.replaySourceConsumer("forged-window"));
      const spike = await createVerifiedTrainingSpike(admin, { expected, assertTarget: harness.assertTarget }, artifacts);
      const req = runRequest(seed, 1, clock);
      const inventory = await spike.prepareFittingRun({ ...req, fittingRunId: "forged-run", evaluationPlanId: "forged-plan",
        slots: req.slots.map((slot) => ({ ...slot, datasetId: "forged-dataset", featureRef: "forged-window" })) });
      const forged = await spike.prepareDataset({ version: "qb-training-read-v1", fittingRunId: "forged-run", inventorySha256: inventory.inventorySha256,
        datasetId: "forged-dataset", pinId: "forged-pin" });
      const selected = await spike.readDatasetPage({ ...page, fittingRunId: "forged-run", inventorySha256: inventory.inventorySha256,
        datasetId: "forged-dataset", manifestSha256: forged.manifestSha256 });
      checks.push({ case: "forged-numerical-window-refused-at-certification", passed: false,
        details: { baselineReason: old.reason, prototypeDeliveredValue: selected.rows[0].feature.bundle?.player[0].passingYardsSum,
          implication: "existing SQL recorder is not a complete verify-on-write boundary; production ingestion needs trusted full reconstruction before certificate creation" } });
    }
  }, { template });
  for (const profile of [example.profileId, "capacity-context"]) await harness.withDatabase(async (admin, expected) => {
    await revoke(admin, profile);
    await restricted(admin, expected, async (client, target) => {
      const files: string[] = [], checked: PrivateArtifactStore = { ...artifacts, database: { ...artifacts.database,
        read: async (...args) => { files.push(args[0]); return artifacts.database.read(...args); },
        readBinary: async (...args) => { files.push(args[0]); return artifacts.database.readBinary(...args); } } };
      const old = await createLocalPredictiveStore(client, target, checked), current = await createVerifiedTrainingSpike(client, target, checked);
      const a = await attempt(() => old.readLabelsAt(request)), b = await attempt(() => current.readLabelsAt(request));
      expect(a.result).toBeNull(); expect(b.result).toBeNull(); expect(a.reason).toContain("rights"); expect(b.reason).toContain("rights");
      expect(files).toEqual([]);
      checks.push({ case: "revoked-before-files-" + profile, passed: true, details: { baselineReason: a.reason, prototypeReason: b.reason, fileReads: 0 } });
    });
  }, { template });
  await harness.withDatabase(async (admin, expected) => {
    await remove(admin);
    await restricted(admin, expected, async (client, target) => {
      const old = await createLocalPredictiveStore(client, target, artifacts), current = await createVerifiedTrainingSpike(client, target, artifacts);
      const a = await old.readLabelsAt(request), b = await current.readLabelsAt(request);
      expect(b.rows).toEqual(a.rows); expect(b.rows[0].reason).toBe("retained-evidence-removed");
      expect((await attempt(() => old.readDatasetPage(page))).result).toBeNull();
      expect((await attempt(() => current.readDatasetPage(page))).result).toBeNull();
      expect((await admin.query("SELECT count(*)::integer AS n FROM spike127_certificates WHERE consumer_id=$1", [example.labelId])).rows[0].n).toBe(0);
      expect((await admin.query("SELECT count(*)::integer AS n FROM predictive_training_invalidations WHERE body->>'origin'='authorized-retention'")).rows[0].n).toBeGreaterThan(0);
      checks.push({ case: "authorized-deletion-removes-certificates-and-invalidates-dataset", passed: true });
    });
  }, { template });
  for (const action of ["revocation", "deletion"] as const) await harness.withDatabase(async (admin, expected) => {
    await restricted(admin, expected, async (client, target) => {
      let changed = false;
      const mutate = async () => { if (!changed) { changed = true; if (action === "revocation") await revoke(admin, example.profileId); else await remove(admin); } };
      const during: PrivateArtifactStore = { ...artifacts, database: { ...artifacts.database,
        read: async (...args) => { const bytes = await artifacts.database.read(...args); await mutate(); return bytes; },
        readBinary: async (...args) => { const bytes = await artifacts.database.readBinary(...args); await mutate(); return bytes; } } };
      const current = await createVerifiedTrainingSpike(client, target, during);
      const result = await attempt(() => current.readLabelsAt(request));
      expect(changed).toBe(true); expect(result.result).toBeNull();
      expect(result.reason).toContain(action === "revocation" ? "rights" : "evidence-removed");
      checks.push({ case: action + "-during-file-read-withholds-delivery", passed: true, details: result.reason });
    });
  }, { template });
  await harness.withDatabase(async (admin, expected) => {
    const reference = manifest.closure.blobs.find((blob) => blob.storageRef.endsWith(".csv"))!;
    const path = join(root, ".db-blobs", reference.storageRef), original = await readFile(path), corrupt = Buffer.from(original);
    corrupt[0] ^= 1;
    try {
      await writeFile(path, corrupt);
      await restricted(admin, expected, async (client, target) => {
        const old = await createLocalPredictiveStore(client, target, artifacts), current = await createVerifiedTrainingSpike(client, target, artifacts);
        const a = await attempt(() => old.readLabelsAt(request)), b = await attempt(() => current.readLabelsAt(request));
        expect(a.result).toBeNull(); expect(b.result).toBeNull();
        expect(a.reason).toBe("artifact-integrity-failed"); expect(b.reason).toBe("artifact-integrity-failed");
        checks.push({ case: "external-file-corruption-refused-by-both-paths", passed: true });
      });
    } finally { await writeFile(path, original); }
  }, { template });
};
