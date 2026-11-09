import { randomBytes } from "node:crypto";
import { expect, it } from "vitest";
import { OBJECT_NAMESPACES, objectKey } from "../../src/featureStore/objectStore.ts";
import { checkObjectStore } from "../support/checkObjectStore.ts";

it.skipIf(process.env.R2_LIVE_CONTRACT !== "1")("runs the shared contract on the dedicated R2 test bucket", async () => {
  const { loadR2TestClient } = await import("../support/r2TestConfig.ts");
  const { openR2ObjectStore } = await import("../../src/featureStore/r2ObjectStore.ts");
  const { client, bucket } = loadR2TestClient();
  const counts = { A: 0, B: 0, delete: 0 };
  client.middlewareStack.add((next, context) => async (args) => {
    const kind = context.commandName === "DeleteObjectCommand" ? "delete"
      : ["HeadObjectCommand", "GetObjectCommand"].includes(context.commandName ?? "") ? "B" : "A";
    if (kind !== "delete" && counts[kind] >= 50) throw new Error("R2 request cap exceeded");
    counts[kind]++;
    return next(args);
  }, { step: "build", name: "countLiveContractRequests" });
  const store = openR2ObjectStore(client, bucket, 2);
  const payloads = Array.from({ length: 3 }, () => randomBytes(32));
  try {
    for (const namespace of OBJECT_NAMESPACES) expect(await store.list(namespace)).toEqual([]);
    try {
      await checkObjectStore(store, payloads);
    } finally {
      const cleanup = await Promise.allSettled(payloads.map((bytes) => store.delete(objectKey("raw", bytes))));
      for (const namespace of OBJECT_NAMESPACES) expect(await store.list(namespace)).toEqual([]);
      expect(cleanup.every(({ status }) => status === "fulfilled")).toBe(true);
    }
  } finally {
    client.destroy();
    console.info("R2 contract request attempts", counts);
  }
});
