import { Client, type ClientConfig } from "pg";
import type { QbEvidenceMode } from "@dfs-ev/domain/qb-evaluation";
import { measureQbReport } from "./evaluation-measure.ts";
import type { Artifact } from "./evaluation-report.ts";
import { openLocalObjectStore } from "../../src/featureStore/localObjectStore.ts";

// A fresh native Node process and restricted connection per cold trial. Only
// generated scratch credentials arrive over IPC; no application env is loaded.
process.once("message", async (message: { config: ClientConfig; cleanupConfig: ClientConfig; storageRoot: string; inputPins: Artifact; mode: QbEvidenceMode }) => {
  const client = new Client(message.config);
  const cleanup = new Client(message.cleanupConfig);
  let cleanupConnected = false;
  const cleanupWriter = new Proxy(cleanup, { get(target, property) {
    if (property !== "query") return Reflect.get(target, property, target);
    return async (...args: unknown[]) => {
      if (!cleanupConnected) { await target.connect(); cleanupConnected = true; }
      return Reflect.apply(target.query, target, args);
    };
  } });
  try {
    const setup = performance.now();
    const store = await openLocalObjectStore(message.storageRoot);
    const objectStoreSetupMs = performance.now() - setup;
    const started = performance.now();
    await client.connect();
    const connected = performance.now();
    const result = await measureQbReport(client, store, message.inputPins, message.mode, cleanupWriter);
    const requestMs = performance.now() - started;
    process.send?.({ result: { ...result, requestMs, connectionMs: connected - started, objectStoreSetupMs } });
  } catch (error) { process.send?.({ failure: String(error) }); }
  finally { await Promise.all([client.end(), cleanup.end()]); process.disconnect?.(); }
});
process.send?.({ ready: true });
