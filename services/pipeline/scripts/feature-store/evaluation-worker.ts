import { Client, type ClientConfig } from "pg";
import type { QbEvidenceMode } from "@dfs-ev/domain/qb-evaluation";
import { measureQbReport } from "./evaluation-measure.ts";
import type { Artifact } from "./evaluation-report.ts";
import { openLocalObjectStore } from "../../src/featureStore/localObjectStore.ts";

// A fresh native Node process and restricted connection per cold trial. Only
// generated scratch credentials arrive over IPC; no application env is loaded.
process.once("message", async (message: { config: ClientConfig; storageRoot: string; inputPins: Artifact; mode: QbEvidenceMode }) => {
  const client = new Client(message.config);
  try {
    const setup = performance.now();
    const store = await openLocalObjectStore(message.storageRoot);
    const objectStoreSetupMs = performance.now() - setup;
    const started = performance.now();
    await client.connect();
    const connected = performance.now();
    const result = await measureQbReport(client, store, message.inputPins, message.mode);
    const requestMs = performance.now() - started;
    process.send?.({ result: { ...result, requestMs, connectionMs: connected - started, objectStoreSetupMs } });
  } catch (error) { process.send?.({ failure: String(error) }); }
  finally { await client.end(); process.disconnect?.(); }
});
process.send?.({ ready: true });
