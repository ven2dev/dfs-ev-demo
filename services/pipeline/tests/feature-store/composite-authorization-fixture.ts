import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { FEATURE_VERSION, HISTORY_POLICY } from "../../src/featureStore/derived.ts";
import { startJob, finishJob } from "../../src/featureStore/jobs.ts";
import type { ModelContextRequest } from "../../src/featureStore/modelContext.ts";
import { sha256, type ObjectStore } from "../../src/featureStore/objectStore.ts";
import { governanceFixture, governanceIdentity, type GovernanceDataset } from "./artifact-governance-fixture.ts";

type Database = Pick<Client, "query">;
export const compositeFixture = (writer: Database, store: ObjectStore) => {
  const graph = governanceFixture(writer, store);
  const clock = async () => (await writer.query("SELECT clock_timestamp()::text AS now")).rows[0].now as string;
  const source = async (complete = true) => {
    const input = await graph.source();
    if (complete) await finishJob(writer, input.job, { counts: { syntheticSource: 1 } });
    return input;
  };
  const feature = async (inputs: string[], options: { n?: number; playerId?: string; gameId?: string;
    unavailable?: boolean; supersedes?: string; mode?: ModelContextRequest["evidenceMode"]; running?: boolean } = {}) => {
    const id = randomUUID(), job = await startJob(writer, { kind: "features", codeSha: "b".repeat(40),
      policySha256: sha256(Buffer.from("#231 synthetic feature graph")), inputSetSha256: sha256(Buffer.from(id)) });
    const n = options.n ?? 3, usable = !options.unavailable && n >= 2;
    const history = Array.from({ length: n }, (_, i) => ({ gameId: `prior-${i}`, kickoff: "2024-01-01T00:00:00Z", yards: i * 100 }));
    const playerId = options.playerId ?? randomUUID(), gameId = options.gameId ?? "synthetic-unlabeled-target-" + randomUUID();
    const evidenceMode = options.mode ?? "retrospective-reconstruction-v1";
    const row = (await writer.query(`INSERT INTO fs138.feature_values(feature_id,job_id,player_id,game_id,stat,season,
      cutoff,checkpoint,feature_version,history_policy,evidence_mode,state,reasons,flags,sample_size,history,history_gaps,supersedes_id)
      VALUES($1,$2,$3,$4,'passing_yards',2025,'2025-09-01',clock_timestamp(),$5,$6,$7,$8,$9,'{}',$10,$11,'[]',$12)
      RETURNING computed_at::text,checkpoint::text`, [id, job.jobId, playerId, gameId, FEATURE_VERSION, HISTORY_POLICY,
      evidenceMode, usable ? "usable" : "unavailable", usable ? [] : ["synthetic-unavailable"], n, JSON.stringify(history), options.supersedes ?? null])).rows[0];
    await writer.query("INSERT INTO fs138.feature_inputs SELECT $1,unnest($2::uuid[])", [id, inputs]);
    if (!options.running) await finishJob(writer, job.jobId, { counts: { syntheticFeatures: 1 } });
    const request: ModelContextRequest = { playerId, gameId, knownAsOf: await clock(), featureVersion: FEATURE_VERSION,
      historyPolicy: HISTORY_POLICY, evidenceMode };
    return { id, jobId: job.jobId, history, request, computedAt: row.computed_at as string, checkpoint: row.checkpoint as string };
  };
  const publish = async (datasets: GovernanceDataset[]) => {
    const objects = await graph.objects(datasets);
    const published = (await writer.query("SELECT * FROM fs138.publish_model_run($1,$2)", [governanceIdentity, JSON.stringify(objects)])).rows[0];
    return { runId: published.run_id as string, objects };
  };
  const world = async (options: { n?: number; overlap?: boolean } = {}) => {
    const model = await source(), served = options.overlap ? model : await source();
    const dataset = await graph.dataset([model.snapshot], "retrospective-reconstruction-v1");
    return { model, served, dataset, feature: await feature([served.snapshot], { n: options.n }), ...await publish([dataset]) };
  };
  const rights = (profile: string, allowed: boolean) => writer.query(`INSERT INTO fs138.rights_decisions
    (profile_id,allowed_uses,valid_from,rationale) VALUES($1,$2,clock_timestamp(),'#231 synthetic rights control')`,
  [profile, allowed ? ["research"] : []]);
  return { graph, source, feature, publish, world, rights, clock };
};
