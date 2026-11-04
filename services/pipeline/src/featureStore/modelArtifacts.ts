import type { Client } from "pg";
import type { QbEvidenceMode } from "@dfs-ev/domain/qb-evaluation";
import type { DatasetSpec } from "./datasets.ts";
import { ArtifactGovernanceError } from "./artifactGovernanceErrors.ts";
import { ModelContextError, modelContextError, type ModelContext } from "./modelContext.ts";
import type { ObjectStore } from "./objectStore.ts";

export { ArtifactGovernanceError } from "./artifactGovernanceErrors.ts";
export type ModelArtifactSlot = "descriptor" | QbEvidenceMode;
export type ModelReadRequest = { runId: string; slots: readonly ModelArtifactSlot[]; context?: ModelContext };
export type ModelRightsReceipt = { checkedAt: string; decisions: { profileId: string; decisionId: string }[] };
export type ModelReadPins = {
  run: { runId: string; descriptorSha256: string; identity: unknown; recordedAt: string; rightsReceipt: unknown };
  datasets: { datasetId: string; mode: QbEvidenceMode; fileSha256: string; contentSha256: string;
    spec: DatasetSpec; rowCount: number; recordedAt: string }[];
  artifacts: { slot: ModelArtifactSlot; datasetId: string | null; objectKey: string; fileSha256: string; byteSize: number }[];
};
export type ModelFeatureHistory = { gameId: string; kickoff: string; yards: number }[];
export type ModelReadInput = ModelReadPins & { files: { slot: ModelArtifactSlot; bytes: Buffer }[];
  context?: ModelContext; history?: ModelFeatureHistory };
type Authorization = { authorization: ModelRightsReceipt; context?: ModelContext };
type Access = ModelReadPins & Authorization & { history?: ModelFeatureHistory };

// Only trusted application code runs inside calculate: it may inspect private
// bytes and selected history, but cannot stream/release a response or
// retain bytes for delivery outside this guard. Use a dedicated idle READ
// COMMITTED connection; the SQL boundary rejects snapshot isolation. An idle
// connection is a trusted caller precondition, as in the existing publisher.
// #231 resolves metadata before entering this boundary. Scoped Q1/Q2 each
// authorize the union of run and served-feature lineage; ordinary #166 calls
// keep their two queries. No nested reader, BEGIN or rehash: Q1 pins the scope,
// selected GETs and calculation finish privately, then fresh Q2 permits return.
export const withModelArtifacts = async <T>(client: Pick<Client, "query">, store: Pick<ObjectStore, "get">,
  request: ModelReadRequest, calculate: (input: ModelReadInput) => T | Promise<T>) => {
  if (!Array.isArray(request?.slots)) throw new ArtifactGovernanceError("model-read-request-refused");
  const runId = request?.runId, slots = [...request.slots];
  if (typeof runId !== "string" || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(runId)
    || slots.length < 1 || slots.length > 3 || new Set(slots).size !== slots.length
    || slots.some(slot => !["descriptor", "strict-point-in-time-v1", "retrospective-reconstruction-v1"].includes(slot)))
    throw new ArtifactGovernanceError("model-read-request-refused");
  let scope: string | undefined;
  if (request.context !== undefined) {
    if (!request.context || typeof request.context !== "object") throw new ModelContextError("model-context-reference-refused");
    try { scope = JSON.stringify(request.context); }
    catch (error) { throw new ModelContextError("model-context-reference-refused", error); }
    if (scope === undefined) throw new ModelContextError("model-context-reference-refused");
  }
  // A private immutable JSON string prevents caller/callback mutation from
  // changing the selected feature, complete lineage or knowledge pins at Q2.
  const access = async (pins: boolean) => (await client.query<{ access: Access }>(
    scope === undefined
      ? "SELECT fs138.authorize_model_read($1::uuid,$2::text[],$3) AS access"
      : "SELECT fs138.authorize_model_context_read($1::uuid,$2::text[],$3,$4::jsonb) AS access",
    scope === undefined ? [runId, slots, pins] : [runId, slots, pins, scope])).rows[0];
  try {
    const first = await access(true);
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
    const last = (await access(false)).access;
    return { value, authorization, delivery: last.authorization, ...(last.context ? { context: last.context } : {}) };
  } catch (error) { throw modelContextError(error); }
};

export const readModelArtifacts = (client: Pick<Client, "query">, store: Pick<ObjectStore, "get">, request: ModelReadRequest) =>
  withModelArtifacts(client, store, request, input => input);
