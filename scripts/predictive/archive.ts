import type { ArtifactStore } from "../../src/lib/predictive/artifacts.ts";
import type { Artifact, Dataset } from "../../src/lib/predictive/types.ts";
import { canonical, digest, exact, refuse } from "../../src/lib/predictive/validation.ts";

export type ArchivedRun = { id: string; dataset: Dataset };
export type ArchiveReference = { reference: string; sha256: string; byteSize: number };
export const archiveRuns = async (store: ArtifactStore, runs: ArchivedRun[]): Promise<ArchiveReference> => {
  const bytes = canonical({ formatVersion: 3, runs: runs.map(({ id, dataset }) => ({ id, dataset: { ...dataset,
    artifacts: dataset.artifacts.map(({ bytes, ...metadata }) => ({ ...metadata, byteSize: Buffer.byteLength(bytes) })),
  } })) });
  const sha256 = digest(bytes); const reference = await store.write(bytes, sha256);
  return { reference, sha256, byteSize: Buffer.byteLength(bytes) };
};
export const restoreRuns = async (store: ArtifactStore, reference: ArchiveReference): Promise<ArchivedRun[]> => {
  const root = exact(JSON.parse(await store.read(reference.reference, reference.sha256, reference.byteSize)), ["formatVersion", "runs"]);
  if (root.formatVersion !== 3 || !Array.isArray(root.runs) || root.runs.length > 16) refuse("archive-refused");
  const runs: ArchivedRun[] = [];
  for (const item of root.runs) {
    const row = exact(item, ["id", "dataset"]);
    const dataset = exact(row.dataset, ["formatVersion", "profiles", "rightsDecisions", "artifacts", "captures", "decisions", "labels"]);
    if (typeof row.id !== "string" || dataset.formatVersion !== 2 || !Array.isArray(dataset.profiles) || !Array.isArray(dataset.rightsDecisions) ||
        !Array.isArray(dataset.artifacts) || !Array.isArray(dataset.captures) || !Array.isArray(dataset.decisions) || !Array.isArray(dataset.labels) ||
        dataset.artifacts.length > 256 || dataset.captures.length > 512) refuse("archive-refused");
    const artifacts: Artifact[] = [];
    for (const item of dataset.artifacts) {
      const metadata = exact(item, ["id", "sha256", "profileId", "retrievalKind", "origin", "providerEtag", "providerLastModified",
        "releaseUpdatedAt", "scopeKind", "scopeSeason", "scopeWeek", "scopeGameId", "scopeFilter", "byteSize"]);
      if (typeof metadata.sha256 !== "string" || typeof metadata.byteSize !== "number") refuse("archive-refused");
      const { byteSize, ...artifact } = metadata;
      artifacts.push({ ...artifact, bytes: await store.read(metadata.sha256 + ".json", metadata.sha256, byteSize as number) } as Artifact);
    }
    runs.push({ id: row.id, dataset: { formatVersion: 2, profiles: dataset.profiles, rightsDecisions: dataset.rightsDecisions,
      artifacts, captures: dataset.captures, decisions: dataset.decisions, labels: dataset.labels } as Dataset });
  }
  return runs;
};
