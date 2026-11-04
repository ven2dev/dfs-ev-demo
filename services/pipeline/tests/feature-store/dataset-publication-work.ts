import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { buildDataset } from "../../src/featureStore/datasets.ts";

type Args = Parameters<typeof buildDataset>;

const queryKind = (sql: string) => {
  if (sql.includes("lock_object_for_publication")) return "lock";
  if (sql.includes("INSERT INTO fs138.dataset_manifests")) return "manifest";
  if (sql.includes("requeue_removed_object")) return "requeue";
  if (sql.includes("AS rights_allowed")) return "rights";
  if (sql.startsWith("SET LOCAL")) return "timeout";
  return sql;
};

// Scoped to one awaited publisher in the test process. Observe the actual
// local adapter's payload reads, including reads initiated inside HEAD.
export const measureDatasetPublication = async (
  [client, store, spec, code]: Args,
  refusal?: RegExp,
  failedManifest = false,
) => {
  let transaction = false;
  const sql: string[] = [];
  const operations: { name: string; transaction: boolean }[] = [];
  const record = (name: string) => operations.push({ name, transaction });
  const { createHash } = crypto;
  const { open, readFile } = fs;
  crypto.createHash = (...args) => {
    record("hash");
    return createHash(...args);
  };
  fs.readFile = new Proxy(readFile, {
    apply(target, receiver, args) {
      record("payload");
      return Reflect.apply(target, receiver, args);
    },
  });
  fs.open = async (...args) => {
    const handle = await open(...args);
    return new Proxy(handle, {
      get(target, property) {
        const method = Reflect.get(target, property, target);
        if (typeof method !== "function") return method;
        return (...params: unknown[]) => {
          if (["read", "readFile", "readv", "createReadStream", "readableWebStream"].includes(String(property))) {
            record("payload");
          }
          return Reflect.apply(method, target, params);
        };
      },
    });
  };
  syncBuiltinESMExports();
  const observedClient = new Proxy(client, {
    get(target, property) {
      if (property !== "query") return Reflect.get(target, property, target);
      return async (...args: unknown[]) => {
        const statement = args[0] as string | { text: string };
        const kind = typeof statement === "string" ? queryKind(statement) : "join";
        sql.push(kind);
        if (kind === "BEGIN") transaction = true;
        record(`dispatch:${kind}`);
        const result = await Reflect.apply(target.query, target, args);
        record(`complete:${kind}`);
        if (kind === "COMMIT" || kind === "ROLLBACK") transaction = false;
        return result;
      };
    },
  });
  const observedStore = {
    ...store,
    putIfAbsent: async (key: string, bytes: Uint8Array) => {
      record("put");
      const result = await store.putIfAbsent(key, bytes);
      record("upload-complete");
      return result;
    },
    head: (key: string) => {
      record("head");
      return store.head(key);
    },
    get: (key: string) => {
      record("get");
      return store.get(key);
    },
  };
  let result: Awaited<ReturnType<typeof buildDataset>> | undefined;
  try {
    const publication = buildDataset(observedClient, observedStore, spec, code);
    if (refusal) await assert.rejects(publication, refusal);
    else result = await publication;
  } finally {
    crypto.createHash = createHash;
    fs.open = open;
    fs.readFile = readFile;
    syncBuiltinESMExports();
  }
  const count = (name: string, inside?: boolean) =>
    operations.filter(event => event.name === name && (inside === undefined || event.transaction === inside)).length;
  assert.equal(count("hash", true), 0, "in-transaction hashes");
  assert.equal(count("payload", true), 0, "in-transaction payload reads");
  assert.equal(count("get", true), 0);
  assert.equal(count("head"), 1);
  assert.equal(count("head", true), 1);
  assert.equal(count("put"), 1);
  assert.equal(count("put", false), 1);
  const position = (name: string) => operations.findIndex(event => event.name === name);
  assert.equal(count("upload-complete", false), 1);
  assert(position("upload-complete") < position("dispatch:BEGIN"));
  assert(position("complete:lock") < position("head"));
  assert.deepEqual(sql, [
    "join", "rights", "BEGIN", "timeout", "lock",
    ...(refusal ? [...(failedManifest ? ["manifest"] : []), "ROLLBACK", "requeue"] : ["manifest", "COMMIT", "rights"]),
  ]);
  return result;
};
