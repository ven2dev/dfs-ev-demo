import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { withFeatureStoreDatabase } from "../../scripts/feature-store/harness.ts";
import { measureQbModelPublication } from "../../scripts/feature-store/model-publication-measure.ts";
import { datasetContentSha256, type DatasetRow, type DatasetSpec } from "../../src/featureStore/datasets.ts";
import { FEATURE_VERSION, LABEL_VERSION, HISTORY_POLICY } from "../../src/featureStore/derived.ts";
import { EMPIRICAL_ADAPTER } from "../../src/featureStore/empiricalAdapter.ts";
import { MODEL_PREREGISTRATION, publishQbModelRun } from "@dfs-ev/pipeline/feature-store/model-manifests";
import { openLocalObjectStore } from "../../src/featureStore/localObjectStore.ts";
import { sha256 } from "../../src/featureStore/objectStore.ts";
import type { Artifact, QbInputPins } from "../../src/featureStore/qbReports.ts";
import { MODEL_VERSION } from "@dfs-ev/domain/baseline";

const code = { gitSha: "c".repeat(40), contentSha256: sha256(Buffer.from("#165 synthetic orchestration fixture")) };
const modes = ["strict-point-in-time-v1", "retrospective-reconstruction-v1"] as const;
const probes: { name: string; verdict: string; details: unknown }[] = [];
const evidence: Record<string, unknown> = { issue: 165, step: 2, runtime: process.version,
  fixture: "synthetic genuine scored envelopes, real 0/2504 dataset members, PostgreSQL LOGIN and local ObjectStore", probes };

test("#165 trusted report preparation and enroll-before-upload publication", { timeout: 120_000 }, async t => {
  const output = new URL("../../../../node_modules/.cache/feature-store-165/", import.meta.url);
  await mkdir(output, { recursive: true });
  const root = await realpath(await mkdtemp(new URL("165-publication-tests-", output).pathname));
  evidence.storageRoot = root;
  const store = await openLocalObjectStore(root);
  const persist = async (value: unknown): Promise<Artifact> => {
    const bytes = Buffer.from(JSON.stringify(value) + "\n"), digest = sha256(bytes);
    const artifact = { objectKey: `audits/${digest}`, sha256: digest, byteSize: bytes.byteLength };
    await store.putIfAbsent(artifact.objectKey, bytes); return artifact;
  };
  try {
    await withFeatureStoreDatabase(async ({ admin, writer, openWriter }) => {
      const check = async (name: string, run: () => Promise<unknown>) => t.test(name, async () => {
        try { const details = await run(); probes.push({ name, verdict: "pass", details }); }
        catch (error) { probes.push({ name, verdict: "fail", details: String(error) }); throw error; }
      });
      await admin.query(await readFile(new URL(import.meta.resolve("@dfs-ev/db/assets/165_model_manifests.sql")), "utf8"));
      await writer.query(`INSERT INTO fs138.source_profiles(profile_id,provider,feed,parser_version,license)
        VALUES('publication-fixture','synthetic','stats','test','{}')`);
      const grant = (allowed: boolean) => writer.query(`INSERT INTO fs138.rights_decisions(profile_id,allowed_uses,valid_from,rationale)
        VALUES('publication-fixture',$1::text[],'2020-01-01','synthetic local test only')`, [allowed ? ["research"] : []]);
      await grant(true);
      const job = (await writer.query(`INSERT INTO fs138.job_runs(kind,code_sha,policy_sha256,input_set_sha256)
        VALUES('model',$1,$2,$2) RETURNING job_id`, [code.gitSha, code.contentSha256])).rows[0].job_id;
      const snapshot = (await writer.query(`INSERT INTO fs138.source_snapshots(profile_id,job_id,sha256,byte_size,object_key,media_type,
        decoded_sha256,header_sha256,row_count,captured_at,available_at,evidence_basis)
        VALUES('publication-fixture',$1,$2,1,$3,'text/csv',$2,$2,2504,'2020-01-01','2020-01-01','retrospective') RETURNING snapshot_id`,
      [job, code.contentSha256, `raw/${code.contentSha256}`])).rows[0].snapshot_id;
      const pins: QbInputPins = { format: "qb-evaluation-input-pins-v1", rightsScope: "research",
        designation: "uncalibrated-interim-hit-rate", preregistration: { ...MODEL_PREREGISTRATION, approved: true }, code,
        versions: { model: MODEL_VERSION, adapter: EMPIRICAL_ADAPTER, feature: FEATURE_VERSION, label: LABEL_VERSION, history: HISTORY_POLICY },
        modes: [], populationDiagnostics: [], populationArtifact: await persist({ format: "qb-evaluation-observed-stats-v1", rows: [] }) };
      for (const mode of modes) {
        const rows: DatasetRow[] = Array.from({ length: mode === modes[0] ? 0 : 2504 }, (_, n) => ({
          featureId: randomUUID(), labelId: randomUUID(), playerId: `test-qb-${n}`, gameId: `2022-test-${n}`, season: 2022,
          cutoff: "2022-01-01T00:00:00Z", labelCutoff: new Date().toISOString(), sampleSize: 2,
          history: [{ gameId: "h1", kickoff: "2021-01-01T00:00:00Z", yards: 100 },
            { gameId: "h2", kickoff: "2021-01-02T00:00:00Z", yards: 200 }], label: 250,
          flags: ["historical-availability-unverified"] }));
        const spec: DatasetSpec = { mode, featureVersion: FEATURE_VERSION, labelVersion: LABEL_VERSION, historyPolicy: HISTORY_POLICY,
          featuresAsOf: new Date().toISOString(), labelsAsOf: new Date().toISOString(), includeRetrospective: mode === modes[1], includeSuperseded: true };
        const contentSha256 = datasetContentSha256(spec, rows);
        const bytes = Buffer.from(JSON.stringify({ format: "qb-passing-yards-dataset-v1", spec, contentSha256, code, rows }) + "\n");
        const fileSha256 = sha256(bytes), objectKey = `datasets/${fileSha256}`;
        await store.putIfAbsent(objectKey, bytes);
        const datasetId = (await writer.query(`INSERT INTO fs138.dataset_manifests(code_sha,implementation_sha256,spec,input_sha256,
          file_sha256,object_key,byte_size,row_count,exclusions,rights_receipt,content_sha256)
          VALUES($1,$2,$3,$2,$4,$5,$6,$7,'{}','{}',$8) RETURNING dataset_id`,
        [code.gitSha, code.contentSha256, spec, fileSha256, objectKey, bytes.byteLength, rows.length, contentSha256])).rows[0].dataset_id;
        await writer.query("INSERT INTO fs138.dataset_inputs VALUES($1,$2)", [datasetId, snapshot]);
        if (rows.length) await writer.query(`WITH data AS MATERIALIZED(SELECT * FROM jsonb_to_recordset($1::jsonb)
          r("featureId" uuid,"labelId" uuid,"playerId" text,"gameId" text,history jsonb)), features AS(
          INSERT INTO fs138.feature_values(feature_id,job_id,player_id,game_id,stat,season,cutoff,checkpoint,feature_version,
            history_policy,evidence_mode,state,reasons,flags,sample_size,history,history_gaps)
          SELECT "featureId",$2,"playerId","gameId",'passing_yards',2022,'2022-01-01',clock_timestamp(),$3,$4,$5,'usable','{}',
            ARRAY['historical-availability-unverified'],2,history,'[]' FROM data RETURNING feature_id
        ), labels AS(
          INSERT INTO fs138.outcome_labels(label_id,job_id,player_id,game_id,stat,season,label_cutoff,label_version,evidence_mode,state,reasons,flags,value)
          SELECT "labelId",$2,"playerId","gameId",'passing_yards',2022,clock_timestamp(),$6,$5,'usable','{}',
            ARRAY['historical-availability-unverified'],250 FROM data RETURNING label_id
        ) INSERT INTO fs138.dataset_members SELECT $7,feature_id,label_id FROM data JOIN features ON feature_id="featureId"
          JOIN labels ON label_id="labelId"`, [JSON.stringify(rows), job, FEATURE_VERSION, HISTORY_POLICY, mode, LABEL_VERSION, datasetId]);
        const coverageArtifact = await persist({ format: "qb-evaluation-coverage-v1", mode, rows: rows.map(r => ({
          player_id: r.playerId, game_id: r.gameId, season: r.season, sample_size: r.sampleSize,
          feature_state: "usable", label_state: "usable", feature_reasons: [], label_reasons: [], history_gaps: [], flags: r.flags, zero_attempts: false })) });
        pins.modes.push({ mode, spec, dataset: { datasetId, objectKey, fileSha256, contentSha256, byteSize: bytes.byteLength, rowCount: rows.length }, coverageArtifact });
      }
      const input = await persist(pins);
      const counts = async () => (await admin.query(`SELECT (SELECT count(*)::integer FROM fs138.model_runs) AS runs,
        (SELECT count(*)::integer FROM fs138.model_artifacts) AS artifacts`)).rows[0];
      const observed = async () => (await writer.query("SELECT object_key FROM fs138.orphan_observations ORDER BY object_key")).rows.map(r => r.object_key);
      await check("fixed measured work and ordering for 0 and 2504 actual members", async () => {
        const actual = (await admin.query(`SELECT d.row_count,count(m.feature_id)::integer AS actual FROM fs138.dataset_manifests d
          LEFT JOIN fs138.dataset_members m USING(dataset_id) GROUP BY d.dataset_id ORDER BY d.row_count`)).rows;
        assert.deepEqual(actual, [{ row_count: 0, actual: 0 }, { row_count: 2504, actual: 2504 }]);
        const trials = [];
        for (const mode of modes) {
          const measured = await measureQbModelPublication(writer, store, input, { code, modes: [mode] });
          assert.deepEqual(measured.work, { preparationStatements: 3, publicationStatements: 5, transactionStatements: 4,
            preflightHeads: 2, transactionHeads: 2, objectReads: 4, transactionObjectReads: 0,
            uploads: 2, transactionUploads: 0, hashes: 9, transactionHashes: 0, objectDeletes: 0 });
          const sequence = measured.events.filter(e => e.operation !== "hash" && e.operation !== "get" && e.operation !== "sql:prepare")
            .map(e => e.operation);
          assert.deepEqual(sequence, ["head", "head", "sql:enroll", "put", "put", "sql:BEGIN", "sql:guard", "head", "head", "sql:publish", "sql:COMMIT"]);
          const descriptor = JSON.parse((await store.get(measured.result.descriptor.objectKey)).toString());
          const report = JSON.parse((await store.get(measured.result.reports[0].objectKey)).toString());
          assert.equal(report.report.folds.length, mode === modes[0] ? 0 : 2504);
          assert.deepEqual(report.code, code); assert.deepEqual(descriptor.identity, measured.result.identity);
          assert.equal(descriptor.reports[0].sha256, measured.result.reports[0].fileSha256);
          trials.push({ mode, work: measured.work, sequence, artifacts: [measured.result.descriptor, ...measured.result.reports] });
        }
        assert.deepEqual(trials[0].work, trials[1].work); assert.deepEqual(await observed(), []);
        return { actualMembers: actual, trials };
      });
      await check("both-mode publication and repeated reuse never enroll existing objects", async () => {
        const before = await counts();
        let calls = 0;
        const checkedWriter = new Proxy(writer, { get(target, property) {
          if (property !== "query") return Reflect.get(target, property, target);
          return (...args: unknown[]) => {
            if (typeof args[0] === "string" && args[0].includes("enroll_model_objects")) {
              if (calls++ > 0) assert.deepEqual(args[1], [[]]);
            }
            return Reflect.apply(target.query, target, args);
          };
        } });
        const first = await measureQbModelPublication(checkedWriter, store, input, { code });
        const retry = await measureQbModelPublication(checkedWriter, store, input, { code });
        assert.equal(calls, 2); assert.equal(first.work.hashes, 16); // the two reports already exist
        assert.equal(retry.work.hashes, 17); assert.equal(retry.work.publicationStatements, 5);
        assert.equal(retry.work.preflightHeads, 3); assert.equal(retry.work.transactionHeads, 3);
        assert.equal(retry.work.transactionHashes, 0); assert.equal(retry.work.objectReads, 6);
        assert.equal(first.result.descriptor.objectKey, retry.result.descriptor.objectKey);
        assert.equal(first.result.existingPublication, false); assert.equal(retry.result.existingPublication, true);
        assert.equal(first.result.runId, retry.result.runId);
        assert.deepEqual(first.result.recordedAt, retry.result.recordedAt);
        assert.deepEqual(first.result.rightsReceipt, retry.result.rightsReceipt);
        assert.equal((await counts()).runs, before.runs + 1);
        return { first: first.work, retry: retry.work, oneRun: true, retryExistingPublication: true };
      });
      await check("mismatched input versions, preregistration, dataset pins and coverage refuse before uploads", async () => {
        const cases: [string, (p: QbInputPins) => void][] = [
          ["input code", p => { p.code = { ...code, contentSha256: "0".repeat(64) }; }],
          ["versions", p => { p.versions.model = "unknown"; }],
          ["preregistration", p => { p.preregistration.approved = false; }],
          ["dataset file", p => { p.modes[0].dataset.fileSha256 = "0".repeat(64); }],
          ["dataset content", p => { p.modes[0].dataset.contentSha256 = "0".repeat(64); }],
          ["dataset count", p => { p.modes[0].dataset.rowCount = 1; }],
          ["dataset spec", p => { p.modes[0].spec.includeSuperseded = false; }],
          ["dataset mode", p => { p.modes[0].dataset = p.modes[1].dataset; }],
          ["coverage", p => { p.modes[0].coverageArtifact = p.modes[1].coverageArtifact; }],
          ["duplicate mode", p => { p.modes.push(p.modes[0]); }],
        ];
        const before = await counts();
        for (const [name, mutate] of cases) {
          const modified = structuredClone(pins); mutate(modified);
          const artifact = await persist(modified);
          await assert.rejects(measureQbModelPublication(writer, store, artifact, { code }), error => {
            const failure = error as Error & { work: { uploads: number; publicationStatements: number } };
            assert.equal(failure.work.uploads, 0, name); assert.equal(failure.work.publicationStatements, 0, name); return true;
          });
        }
        assert.deepEqual(await counts(), before); return { refusals: cases.map(c => c[0]), uploads: 0 };
      });
      await check("pre-existing unregistered bytes are not enrolled on a refused publication", async () => {
        // A new code identity produces new descriptor/report addresses.
        const privateCode = { ...code, contentSha256: "d".repeat(64) };
        const stopAfterUpload = { ...store, putIfAbsent: async (key: string, bytes: Uint8Array) => {
          const put = await store.putIfAbsent(key, bytes);
          if (key.startsWith("audits/")) throw new Error("synthetic-upload-response-lost");
          return put;
        } };
        await assert.rejects(publishQbModelRun(writer, stopAfterUpload, input, { code: privateCode, modes: [modes[0]] }), /upload-response-lost/);
        const enrolled = await observed(); assert.equal(enrolled.length, 2);
        // Fixture simulates old private/unregistered bytes, outside #165 ownership.
        await admin.query("DELETE FROM fs138.orphan_observations");
        await assert.rejects(measureQbModelPublication(writer, { ...store, head: async key => {
          const head = await store.head(key);
          if (key.startsWith("models/")) await grant(false);
          return head;
        } }, input, { code: privateCode, modes: [modes[0]] }), /model-current-rights-refused/);
        assert.deepEqual(await observed(), []); await grant(true);
        return { preExistingObjects: 2, enrolledOnRetry: 0, noDirectDeletes: true };
      });
      await check("revocation during upload rolls back and preserves enrollment, never deleting bytes", async () => {
        const before = await counts(); let uploads = 0;
        const failureCode = { ...code, contentSha256: "e".repeat(64) };
        await assert.rejects(measureQbModelPublication(writer, { ...store, putIfAbsent: async (key, bytes) => {
          const put = await store.putIfAbsent(key, bytes);
          if (++uploads === 2) await grant(false);
          return put;
        } }, input, { code: failureCode, modes: [modes[0]] }), error => {
          const e = error as Error & { work: { publicationStatements: number; transactionStatements: number; objectDeletes: number } };
          assert.match(e.message, /model-current-rights-refused/);
          assert.equal(e.work.publicationStatements, 4); assert.equal(e.work.transactionStatements, 3); assert.equal(e.work.objectDeletes, 0); return true;
        });
        assert.deepEqual(await counts(), before); const addresses = await observed(); assert.equal(addresses.length, 2);
        for (const address of addresses) assert(await store.head(address));
        await grant(true); return { rolledBack: true, durableEnrollment: addresses };
      });
      await check("missing metadata refuses without partial rows; connection loss withholds the result", async () => {
        const before = await counts(); let heads = 0;
        await assert.rejects(measureQbModelPublication(writer, { ...store, head: async key => ++heads > 2 ? null : store.head(key) },
          input, { code: { ...code, contentSha256: "f".repeat(64) }, modes: [modes[0]] }), /model-object-missing-or-mismatched/);
        assert.deepEqual(await counts(), before);
        const other = await openWriter();
        const broken = new Proxy(other, { get(target, property) {
          if (property !== "query") return Reflect.get(target, property, target);
          return async (...args: unknown[]) => {
            if (args[0] === "BEGIN") { await target.end(); throw new Error("Connection terminated"); }
            return Reflect.apply(target.query, target, args);
          };
        } });
        await assert.rejects(publishQbModelRun(broken, store, input, { code }), /model-connection-interrupted-replace/);
        assert.deepEqual(await counts(), before); return { missingHeadRollback: true, interruptedBeginWithheld: true };
      });
      evidence.database = (await admin.query("SELECT version() AS version")).rows[0].version;
    });
    evidence.verdict = probes.every(p => p.verdict === "pass") ? "pass" : "fail";
  } finally {
    const files = ["services/pipeline/src/featureStore/modelManifests.ts", "services/pipeline/src/featureStore/qbReports.ts",
      "services/pipeline/src/featureStore/datasets.ts", "services/pipeline/scripts/feature-store/evaluation-report.ts",
      "services/pipeline/scripts/feature-store/model-publication-measure.ts", "services/pipeline/tests/feature-store/model-publication.check.mts"];
    evidence.codeHashes = Object.fromEntries(await Promise.all(files.map(async p =>
      [p, sha256(await readFile(new URL("../../../../" + p, import.meta.url)))])));
    if (process.env.FS165_PUBLICATION_EVIDENCE) await writeFile(process.env.FS165_PUBLICATION_EVIDENCE, JSON.stringify(evidence, null, 2) + "\n");
  }
});
