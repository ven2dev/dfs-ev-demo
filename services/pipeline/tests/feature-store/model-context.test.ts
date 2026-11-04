import { describe, expect, it } from "vitest";
import type { Client } from "pg";
import { FEATURE_VERSION, HISTORY_POLICY } from "../../src/featureStore/derived.ts";
import { ArtifactGovernanceError } from "../../src/featureStore/modelArtifacts.ts";
import { ModelContextError, modelContextError, resolveModelContext, type ModelContextRequest } from "../../src/featureStore/modelContext.ts";

describe("model context request and refusal boundary without a database", () => {
  const request: ModelContextRequest = { playerId: "QB-A", gameId: "same-game", knownAsOf: "2026-10-31 01:02:03.123456+00",
    featureVersion: FEATURE_VERSION, historyPolicy: HISTORY_POLICY, evidenceMode: "retrospective-reconstruction-v1" };
  it("owns only supported scalar pins before awaits, preserves microseconds and sends no caller history/labels", async () => {
    const input = { ...request, history: [999], label: 999 };
    const calls: unknown[][] = [], answer = { metadataOnly: true };
    const client = { query: async (...args: unknown[]) => {
      calls.push(args); input.playerId = "changed"; input.knownAsOf = "2099-01-01T00:00:00Z";
      return { rows: [{ context: answer }] };
    } } as unknown as Pick<Client, "query">;
    expect(await resolveModelContext(client, input)).toBe(answer);
    expect(calls).toEqual([["SELECT fs138.resolve_model_context($1,$2,$3,$4,$5,$6::timestamptz) AS context",
      [request.playerId, request.gameId, FEATURE_VERSION, HISTORY_POLICY, request.evidenceMode, request.knownAsOf]]]);
  });
  it("rejects malformed requests without a query", async () => {
    const client = { query: () => { throw new Error("unexpected-query"); } } as unknown as Pick<Client, "query">;
    for (const invalid of [null, {}, { ...request, playerId: " " }, { ...request, gameId: null },
      { ...request, knownAsOf: "infinity" }, { ...request, knownAsOf: "2026-01-01" }])
      await expect(resolveModelContext(client, invalid as ModelContextRequest)).rejects.toMatchObject({ code: "model-context-request-refused" });
    for (const patch of [{ featureVersion: "unknown" }, { historyPolicy: "unknown" }, { evidenceMode: "unknown" }])
      await expect(resolveModelContext(client, { ...request, ...patch } as ModelContextRequest)).rejects.toMatchObject({ code: "model-context-unsupported-version" });
  });
  it("maps SQLSTATE contracts and preserves unrelated database or connection errors", () => {
    for (const [state, code] of Object.entries({ P2311: "model-context-request-refused", P2312: "model-context-unsupported-version",
      P2313: "model-context-future-knowledge", P2314: "model-context-insufficient-history", P2315: "model-context-unavailable", P2316: "model-context-lineage-refused", P2317: "model-context-reference-refused",
      "22007": "model-context-request-refused", "22008": "model-context-request-refused", "22009": "model-context-request-refused" })) {
      const cause = { code: state, message: "provider text varies" }, error = modelContextError(cause);
      expect(error).toBeInstanceOf(ModelContextError); expect(error).toMatchObject({ code, cause });
    }
    expect(modelContextError({ code: "P1667" })).toBeInstanceOf(ArtifactGovernanceError);
    for (const error of [new Error("socket closed"), { code: "42501" }, { code: "08006" }, { code: "constructor" }])
      expect(modelContextError(error)).toBe(error);
  });
});
