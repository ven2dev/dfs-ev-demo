import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  DeleteObjectCommand, GetBucketLifecycleConfigurationCommand, GetObjectCommand,
  GetObjectLockConfigurationCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand,
} from "@aws-sdk/client-s3";
import { loadR2TestClient } from "../tests/support/r2TestConfig.ts";

const { client, bucket } = loadR2TestClient();
const counts = { A: 0, B: 0, delete: 0 };
const evidence = { counts, settings: {}, cleanup: false };
const payload = Buffer.from(randomUUID());
const sha256 = createHash("sha256").update(payload).digest("hex");
const key = `raw/${sha256}`;
const status = (error) => error?.$metadata?.httpStatusCode ?? null;
const send = (kind, Command, input = {}) => {
  if (kind !== "delete" && counts[kind] >= 50) throw new Error("request-cap");
  counts[kind]++;
  return client.send(new Command({ Bucket: bucket, ...input }), { abortSignal: AbortSignal.timeout(15000) });
};
let phase = "settings";
let attempted = false;
try {
  for (const [name, Command, absent] of [
    ["lifecycle", GetBucketLifecycleConfigurationCommand, "NoSuchLifecycleConfiguration"],
    ["lock", GetObjectLockConfigurationCommand, "ObjectLockConfigurationNotFoundError"],
  ]) {
    try {
      const config = await send("A", Command);
      evidence.settings[name] = name === "lifecycle"
        ? ((config.Rules?.length ?? 0) ? "rules-present" : "empty")
        : (config.ObjectLockConfiguration?.ObjectLockEnabled === "Enabled" ? "enabled" : "empty");
    } catch (error) {
      evidence.settings[name] = error.name === absent ? "empty" : { status: status(error) };
    }
  }
  assert.ok(Object.values(evidence.settings).every((setting) =>
    setting === "empty" || [403, 405, 501].includes(setting.status)), "settings-unverified");
  if (Object.values(evidence.settings).some((setting) => setting !== "empty")) {
    assert.ok(process.argv.includes("--dashboard-confirmed"), "dashboard-confirmation-required");
  }
  phase = "preflight";
  for (const namespace of ["raw", "datasets", "models", "audits"]) {
    const list = await send("A", ListObjectsV2Command, { Prefix: namespace + "/", MaxKeys: 2 });
    assert.equal(list.KeyCount, 0);
  }
  phase = "concurrent-put";
  attempted = true;
  const writes = await Promise.allSettled(Array.from({ length: 5 }, () =>
    send("A", PutObjectCommand, {
      Key: key, Body: payload, IfNoneMatch: "*", Metadata: { sha256 },
    })));
  evidence.putStatuses = writes.map((result) => result.status === "fulfilled"
    ? result.value.$metadata.httpStatusCode : status(result.reason)).sort((a, b) => (a ?? 0) - (b ?? 0));
  assert.deepEqual(evidence.putStatuses, [200, 412, 412, 412, 412]);
  phase = "head";
  const head = await send("B", HeadObjectCommand, { Key: key });
  assert.equal(head.Metadata?.sha256, sha256);
  assert.equal(head.ContentLength, payload.length);
  evidence.sha256 = sha256;
  evidence.byteSize = payload.length;
  phase = "get";
  const get = await send("B", GetObjectCommand, { Key: key });
  assert.deepEqual(Buffer.from(await get.Body.transformToByteArray()), payload);
  evidence.bytesVerified = true;
} catch (error) {
  evidence.failure = { phase, status: status(error) };
  process.exitCode = 1;
} finally {
  if (attempted) {
    try {
      await send("delete", DeleteObjectCommand, { Key: key });
      for (const namespace of ["raw", "datasets", "models", "audits"]) {
        const list = await send("A", ListObjectsV2Command, { Prefix: namespace + "/", MaxKeys: 2 });
        assert.equal(list.KeyCount, 0);
      }
      evidence.cleanup = true;
    } catch (error) {
      evidence.cleanupFailure = { status: status(error) };
      process.exitCode = 1;
    }
  }
  client.destroy();
  console.log(JSON.stringify(evidence, null, 2));
}
