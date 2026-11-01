import type { Client } from "pg";
import type { QbEvidenceMode } from "@dfs-ev/domain/qb-evaluation";
import type { DatasetSpec } from "./datasets.ts";
import { ArtifactGovernanceError, artifactGovernanceError } from "./artifactGovernanceErrors.ts";
import type { ObjectStore } from "./objectStore.ts";

export { ArtifactGovernanceError } from "./artifactGovernanceErrors.ts";
export type ModelArtifactSlot = "descriptor" | QbEvidenceMode;
export type ModelReadRequest = { runId: string; slots: readonly ModelArtifactSlot[] };
export type ModelRightsReceipt = { checkedAt: string; decisions: { profileId: string; decisionId: string }[] };
export type ModelReadPins = {
  run: { runId: string; descriptorSha256: string; identity: unknown; recordedAt: string; rightsReceipt: unknown };
  datasets: { datasetId: string; mode: QbEvidenceMode; fileSha256: string; contentSha256: string;
    spec: DatasetSpec; rowCount: number; recordedAt: string }[];
  artifacts: { slot: ModelArtifactSlot; datasetId: string | null; objectKey: string; fileSha256: string; byteSize: number }[];
};
export type ModelReadInput = ModelReadPins & { files: { slot: ModelArtifactSlot; bytes: Buffer }[] };
type Authorization = { authorization: ModelRightsReceipt };

// Only trusted application code runs inside calculate: it may inspect private
// bytes and do #167's context lookup, but cannot stream/release a response or
// retain bytes for delivery outside this guard. Use a dedicated idle READ
// COMMITTED connection; the SQL boundary rejects snapshot isolation. An idle
// connection is a trusted caller precondition, as in the existing publisher.
// No nested dataset reader, BEGIN or rehash: Q1 pins/authorizes the entire run,
// selected GETs and calculation finish privately, then fresh Q2 permits return.
export const withModelArtifacts = async <T>(client: Pick<Client, "query">, store: Pick<ObjectStore, "get">,
  request: ModelReadRequest, calculate: (input: ModelReadInput) => T | Promise<T>) => {
  if (!Array.isArray(request?.slots)) throw new ArtifactGovernanceError("model-read-request-refused");
  const runId = request?.runId, slots = [...request.slots];
  if (typeof runId !== "string" || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(runId)
    || slots.length < 1 || slots.length > 3 || new Set(slots).size !== slots.length
    || slots.some(slot => !["descriptor", "strict-point-in-time-v1", "retrospective-reconstruction-v1"].includes(slot)))
    throw new ArtifactGovernanceError("model-read-request-refused");
  try {
    const first = (await client.query<{ access: ModelReadPins & Authorization }>(
      "SELECT fs138.authorize_model_read($1::uuid,$2::text[],true) AS access", [runId, slots])
      // The JSON envelope is one row; all pins derive from SQL, never the caller.
    ).rows[0];
    const { authorization, ...pins } = first.access;
    const files: ModelReadInput["files"] = [];
    for (const artifact of pins.artifacts) {
      let bytes: Buffer;
      try { bytes = await store.get(artifact.objectKey); }
      catch (error) { throw new ArtifactGovernanceError("model-artifact-unavailable", error); }
      if (bytes.byteLength !== artifact.byteSize) throw new ArtifactGovernanceError("model-artifact-unavailable");
      files.push({ slot: artifact.slot, bytes });
    }
    const value = await calculate({ ...pins, files });
    // Original request is private, so calculation/request mutation cannot make
    // Q2 authorize a different run or a narrower set of selected files.
    const last = (await client.query<{ access: Authorization }>(
      "SELECT fs138.authorize_model_read($1::uuid,$2::text[],false) AS access", [runId, slots])).rows[0].access;
    return { value, authorization, delivery: last.authorization };
  } catch (error) { throw artifactGovernanceError(error); }
};

export const readModelArtifacts = (client: Pick<Client, "query">, store: Pick<ObjectStore, "get">, request: ModelReadRequest) =>
  withModelArtifacts(client, store, request, input => input);
