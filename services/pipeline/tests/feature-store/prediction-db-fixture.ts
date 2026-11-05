import type { Client } from "pg";
import { MODEL_VERSION } from "@dfs-ev/domain/baseline";
import { QB_EVALUATOR_VERSION, type QbEvidenceMode } from "@dfs-ev/domain/qb-evaluation";
import type { ObjectStore } from "../../src/featureStore/objectStore.ts";
import { compositeFixture } from "./composite-authorization-fixture.ts";
import { governanceIdentity } from "./artifact-governance-fixture.ts";
import type { GovernanceDataset } from "./artifact-governance-fixture.ts";

// Real registry/producer shapes with explicitly synthetic sources and histories.
// Unlike #231's authorization-only fixture, these descriptors are consumed by
// the final handler's actual compatibility validator.
export const predictionDatabaseFixture = (writer: Pick<Client, "query">, store: ObjectStore) => {
  const composite = compositeFixture(writer, store);
  const world = async (options: { n?: number; overlap?: boolean; modes?: QbEvidenceMode[]; mode?: QbEvidenceMode } = {}) => {
    const model = await composite.source(), served = options.overlap ? model : await composite.source();
    const datasets: GovernanceDataset[] = [];
    for (const mode of options.modes ?? ["retrospective-reconstruction-v1"])
      datasets.push(await composite.graph.dataset([model.snapshot], mode));
    const reports = await Promise.all(datasets.map(d => composite.graph.report(d)));
    const descriptor = await composite.graph.persist("models", {
      format: "qb-model-descriptor-v1", rightsScope: "research", identity: governanceIdentity,
      datasets: datasets.map(({ sources, ...pin }) => { void sources; return pin; }),
      reports: reports.map((r, i) => ({ ...r, mode: datasets[i].mode, datasetId: datasets[i].datasetId })),
    });
    const objects = [{ slot: "descriptor", datasetId: null, objectKey: descriptor.objectKey,
      fileSha256: descriptor.sha256, byteSize: descriptor.byteSize }, ...datasets.map((d, i) => ({
      slot: d.mode, datasetId: d.datasetId, objectKey: reports[i].objectKey,
      fileSha256: reports[i].sha256, byteSize: reports[i].byteSize }))];
    const runId = (await writer.query("SELECT * FROM fs138.publish_model_run($1,$2)",
      [governanceIdentity, JSON.stringify(objects)])).rows[0].run_id as string;
    const feature = await composite.feature([served.snapshot], { n: options.n, mode: options.mode });
    return { model, served, datasets, descriptor, objects, runId, feature,
      request: { ...feature.request, runId, modelVersion: MODEL_VERSION, scoringPolicy: QB_EVALUATOR_VERSION, line: 100 } };
  };
  return { ...composite, world };
};
