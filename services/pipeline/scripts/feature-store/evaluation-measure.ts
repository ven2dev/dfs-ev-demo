import assert from "node:assert/strict";
import type { Client } from "pg";
import type { QbEvidenceMode } from "@dfs-ev/domain/qb-evaluation";
import { completeQbReport, type Artifact } from "./evaluation-report.ts";
import { sha256, type ObjectStore } from "../../src/featureStore/objectStore.ts";

// Shared by the opt-in speed probe and CI's deterministic work-budget checks.
export const measureQbReport = async (client: Pick<Client, "query">, store: ObjectStore,
  inputPins: Artifact, mode: QbEvidenceMode, cleanupWriter: Pick<Client, "query">) => {
  const queries: { text: string; elapsedMs: number }[] = [];
  const reads: string[] = [], writes: string[] = [];
  let busy = false;
  const reader = new Proxy(client, { get(target, property) {
    if (property !== "query") return Reflect.get(target, property, target);
    return async (...args: unknown[]) => {
      assert(!busy, "concurrent-report-query-refused"); busy = true;
      const started = performance.now();
      const text = typeof args[0] === "string" ? args[0] : (args[0] as { text: string }).text;
      try { return await Reflect.apply(target.query, target, args); }
      finally { queries.push({ text, elapsedMs: performance.now() - started }); busy = false; }
    };
  } });
  const measuredStore = { ...store,
    get: async (key: string) => { reads.push(key); return store.get(key); },
    putIfAbsent: async (key: string, bytes: Uint8Array) => { writes.push(key); return store.putIfAbsent(key, bytes); } };
  const result = await completeQbReport(reader, measuredStore, inputPins, mode, cleanupWriter);
  assert.equal(queries.length, 3);
  const rightsChecks = queries.filter(q => q.text.includes("fs138.effective_rights(")).length;
  assert.equal(rightsChecks, 2);
  assert(!queries.some(q => /fs138\.(norm_|normalized_evidence|outcome_labels|feature_values)/.test(q.text)), "report-evidence-read-refused");
  assert.equal(reads.length, 3); assert(!reads.some(key => key.startsWith("raw/")));
  assert.equal(writes.length, 1);
  const compactAccess = (access: typeof result.authorization) => ({ allowed: access.allowed, checkedAt: access.checked_at,
    decisions: access.decisions.length, decisionsSha256: sha256(Buffer.from(JSON.stringify(access.decisions))) });
  return { rightsScope: result.rightsScope, elapsedMs: result.elapsedMs, logicalSha256: result.logicalSha256, artifact: result.artifact,
    folds: result.report.folds.length, cases: result.report.cases.length,
    authorization: compactAccess(result.authorization), delivery: compactAccess(result.delivery),
    timingMs: { ...result.timingMs, manifestQuery: queries[0].elapsedMs,
      authorizationQuery: queries[1].elapsedMs, deliveryQuery: queries[2].elapsedMs },
    work: { statements: queries.length, rightsChecks, objectReads: reads.length, objectWrites: writes.length,
      rawSourceReads: 0, perExampleQueries: 0 } };
};
