import type { Client } from "pg";
import type { EvidenceMode } from "./asOf.ts";
import { FEATURE_VERSION, HISTORY_POLICY } from "./derived.ts";
import { artifactGovernanceError } from "./artifactGovernanceErrors.ts";

export type ModelContextRequest = {
  playerId: string; gameId: string; knownAsOf: string;
  featureVersion: typeof FEATURE_VERSION; historyPolicy: typeof HISTORY_POLICY; evidenceMode: EvidenceMode;
};
export type ModelContext = {
  request: ModelContextRequest;
  feature: { featureId: string; jobId: string; playerId: string; gameId: string; stat: "passing_yards"; season: number;
    cutoff: string; checkpoint: string; computedAt: string; featureVersion: typeof FEATURE_VERSION;
    historyPolicy: typeof HISTORY_POLICY; evidenceMode: EvidenceMode; sampleSize: number; flags: string[] };
  snapshotIds: string[];
  selection: { visibleHeadId: string; lastValid: boolean; reasons: string[] };
  freshness: { observedAt: string; headId: string; checkpoint: string; computedAt: string;
    superseded: boolean; stale: boolean; reasons: string[] };
};

export type ModelContextCode = "model-context-request-refused" | "model-context-unsupported-version"
  | "model-context-future-knowledge" | "model-context-insufficient-history" | "model-context-unavailable"
  | "model-context-lineage-refused";
export class ModelContextError extends Error {
  readonly code: ModelContextCode;
  constructor(code: ModelContextCode, cause?: unknown) {
    super(code, { cause }); this.name = "ModelContextError"; this.code = code;
  }
}

const sqlCodes: Record<string, ModelContextCode> = {
  P2311: "model-context-request-refused", P2312: "model-context-unsupported-version",
  P2313: "model-context-future-knowledge", P2314: "model-context-insufficient-history",
  P2315: "model-context-unavailable", P2316: "model-context-lineage-refused",
  // Date.parse accepts some normalized calendar dates that PostgreSQL refuses.
  // Keep those malformed caller timestamps in the explicit request contract.
  "22007": "model-context-request-refused", "22008": "model-context-request-refused", "22009": "model-context-request-refused",
};
export const modelContextError = (error: unknown): unknown => {
  const state = error && typeof error === "object" && "code" in error ? error.code : undefined;
  const code = typeof state === "string" && Object.hasOwn(sqlCodes, state) ? sqlCodes[state] : undefined;
  return code ? new ModelContextError(code, error) : artifactGovernanceError(error);
};

// Explicit offsets and verbatim microseconds avoid timezone ambiguity and
// Date's millisecond truncation changing the database's selection boundary.
const timestamp = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::?\d{2})?)$/;
export const resolveModelContext = async (client: Pick<Client, "query">, request: ModelContextRequest): Promise<ModelContext> => {
  // Own only scalar pins before the first await; caller extras (including history
  // or target labels) never reach SQL. Snapshot IDs are comparison evidence for
  // the later guard, not caller authority or permission to release feature data.
  const { playerId, gameId, knownAsOf, featureVersion, historyPolicy, evidenceMode } = request ?? {};
  if (typeof playerId !== "string" || !playerId.trim() || typeof gameId !== "string" || !gameId.trim()
    || typeof knownAsOf !== "string" || !timestamp.test(knownAsOf) || !Number.isFinite(Date.parse(knownAsOf)))
    throw new ModelContextError("model-context-request-refused");
  if (featureVersion !== FEATURE_VERSION || historyPolicy !== HISTORY_POLICY
    || !["strict-point-in-time-v1", "retrospective-reconstruction-v1"].includes(evidenceMode))
    throw new ModelContextError("model-context-unsupported-version");
  try {
    return (await client.query<{ context: ModelContext }>(
      "SELECT fs138.resolve_model_context($1,$2,$3,$4,$5,$6::timestamptz) AS context",
      [playerId, gameId, featureVersion, historyPolicy, evidenceMode, knownAsOf])).rows[0].context;
  } catch (error) { throw modelContextError(error); }
};
