import type { ArtifactStore } from "../../src/lib/predictive/artifacts.ts";
import type { Artifact, Dataset } from "../../src/lib/predictive/types.ts";
import { canonical, digest, exact, refuse } from "../../src/lib/predictive/validation.ts";

export type ArchivedRun = { id: string; dataset: Dataset };
export type ArchiveReference = { reference: string; sha256: string; byteSize: number };
export const archiveRuns = async (store: ArtifactStore, runs: ArchivedRun[]): Promise<ArchiveReference> => {
  const bytes = canonical({ formatVersion: 1, runs: runs.map(({ id, dataset }) => ({ id, dataset: { ...dataset,
    artifacts: dataset.artifacts.map(({ bytes, ...metadata }) => ({ ...metadata, byteSize: Buffer.byteLength(bytes) })),
  } })) });
  const sha256 = digest(bytes); const reference = await store.write(bytes, sha256);
  return { reference, sha256, byteSize: Buffer.byteLength(bytes) };
};
export const restoreRuns = async (store: ArtifactStore, reference: ArchiveReference): Promise<ArchivedRun[]> => {
  const root = exact(JSON.parse(await store.read(reference.reference, reference.sha256, reference.byteSize)), ["formatVersion", "runs"]);
  if (root.formatVersion !== 1 || !Array.isArray(root.runs) || root.runs.length > 16) refuse("archive-refused");
  const runs: ArchivedRun[] = [];
  for (const item of root.runs) {
    const row = exact(item, ["id", "dataset"]); const dataset = exact(row.dataset, ["formatVersion", "artifacts", "captures"]);
    if (typeof row.id !== "string" || dataset.formatVersion !== 1 || !Array.isArray(dataset.artifacts) || !Array.isArray(dataset.captures) ||
        dataset.artifacts.length > 256 || dataset.captures.length > 512) refuse("archive-refused");
    const artifacts: Artifact[] = [];
    for (const item of dataset.artifacts) {
      const metadata = exact(item, ["id", "sha256", "source", "origin", "feed", "schemaVersion", "parserVersion", "rightsReviewVersion", "byteSize"]);
      if (typeof metadata.sha256 !== "string" || typeof metadata.byteSize !== "number") refuse("archive-refused");
      const { byteSize, ...artifact } = metadata;
      artifacts.push({ ...artifact, bytes: await store.read(metadata.sha256 + ".json", metadata.sha256, byteSize as number) } as Artifact);
    }
    runs.push({ id: row.id, dataset: { formatVersion: 1, artifacts, captures: dataset.captures } as Dataset });
  }
  return runs;
};
