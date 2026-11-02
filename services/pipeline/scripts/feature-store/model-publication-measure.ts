import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import type { Client } from "pg";
import { publishQbModelRun } from "../../src/featureStore/modelManifests.ts";
import type { ObjectStore } from "../../src/featureStore/objectStore.ts";

// Local measurement only: serialize calls in this process while the crypto
// observer is installed. Counts include adapter hashes, not just publisher code.
export const measureQbModelPublication = async (
  client: Pick<Client, "query">, store: ObjectStore, ...args: Parameters<typeof publishQbModelRun> extends
    [unknown, unknown, ...infer Rest] ? Rest : never
) => {
  let transaction = false;
  const events: { operation: string; transaction: boolean; key?: string }[] = [];
  const event = (operation: string, key?: string) => events.push({ operation, transaction, ...(key ? { key } : {}) });
  const original = crypto.createHash;
  crypto.createHash = ((...parameters: Parameters<typeof original>) => {
    event("hash"); return original(...parameters);
  }) as typeof original;
  syncBuiltinESMExports();
  const measuredClient = new Proxy(client, { get(target, property) {
    if (property !== "query") return Reflect.get(target, property, target);
    return async (...parameters: unknown[]) => {
      const sql = typeof parameters[0] === "string" ? parameters[0] : (parameters[0] as { text: string }).text;
      if (sql === "BEGIN") transaction = true;
      const name = sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK" ? sql :
        sql.includes("enroll_model_objects") ? "enroll" : sql.includes("guard_model_publication") ? "guard" :
        sql.includes("publish_model_run") ? "publish" : "prepare";
      event(`sql:${name}`);
      const result = await Reflect.apply(target.query, target, parameters);
      if (sql === "COMMIT" || sql === "ROLLBACK") transaction = false;
      return result;
    };
  } });
  const measuredStore: ObjectStore = { ...store,
    get: async key => { event("get", key); return store.get(key); },
    head: async key => { event("head", key); return store.head(key); },
    putIfAbsent: async (key, bytes) => { event("put", key); return store.putIfAbsent(key, bytes); },
    delete: async key => { event("delete", key); return store.delete(key); },
  };
  try {
    const result = await publishQbModelRun(measuredClient, measuredStore, ...args);
    return { result, events, work: publicationWork(events) };
  } catch (error) {
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { events, work: publicationWork(events) });
  } finally { crypto.createHash = original; syncBuiltinESMExports(); }
};
const publicationWork = (events: { operation: string; transaction: boolean }[]) => {
  const count = (operation: string, inTransaction?: boolean) => events.filter(e =>
    e.operation === operation && (inTransaction === undefined || e.transaction === inTransaction)).length;
  return { preparationStatements: count("sql:prepare"), publicationStatements: events.filter(e =>
    e.operation.startsWith("sql:") && e.operation !== "sql:prepare").length,
    transactionStatements: events.filter(e => e.operation.startsWith("sql:") && e.transaction).length,
    preflightHeads: count("head", false), transactionHeads: count("head", true),
    objectReads: count("get"), transactionObjectReads: count("get", true),
    uploads: count("put"), transactionUploads: count("put", true),
    hashes: count("hash"), transactionHashes: count("hash", true), objectDeletes: count("delete") };
};
