import { Readable } from "node:stream";
import { S3Client } from "@aws-sdk/client-s3";
import { expect, it } from "vitest";
import { objectKey } from "../../src/featureStore/objectStore.ts";
import { openR2ObjectStore } from "../../src/featureStore/r2ObjectStore.ts";

const bytes = Buffer.from("synthetic");
const key = objectKey("raw", bytes);
const digest = key.slice(4);
type Reply = { status?: number; headers?: Record<string, string>; body?: string };

const fixture = (...replies: Reply[]) => {
  const calls: { method: string; headers: Record<string, string>; query?: Record<string, unknown> }[] = [];
  const client = new S3Client({
    region: "auto", endpoint: "https://example.invalid", forcePathStyle: true, maxAttempts: 1,
    credentials: { accessKeyId: "stub", secretAccessKey: "stub" },
    requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED",
    requestHandler: {
      handle: async (request: (typeof calls)[number]) => {
        calls.push(request);
        const reply = replies.shift();
        if (!reply) throw new Error("unexpected request");
        return { response: {
          statusCode: reply.status ?? 200, headers: reply.headers ?? {},
          body: Readable.from([Buffer.from(reply.body ?? "")]),
        } };
      },
    },
  });
  return { calls, store: openR2ObjectStore(client, "edgetrace-fs-test", 2) };
};

it("uses one conditional PUT for a new object", async () => {
  const { calls, store } = fixture({});
  expect(await store.putIfAbsent(key, bytes)).toMatchObject({ created: true });
  expect(calls.map(({ method }) => method)).toEqual(["PUT"]);
  expect(calls[0].headers).toMatchObject({ "if-none-match": "*", "x-amz-meta-sha256": digest });
});

it.each([
  [{ status: 404 }, "object-disappeared-after-precondition"],
  [{ headers: { "content-length": "9" } }, "object-metadata-integrity-failed"],
  [{ headers: { "content-length": "9", "x-amz-meta-sha256": "wrong" } }, "object-metadata-integrity-failed"],
  [{ headers: { "content-length": "8", "x-amz-meta-sha256": digest } }, "object-existing-integrity-failed"],
  [{ headers: { "content-length": "9", "x-amz-meta-sha256": digest } }, null],
] as const)("uses one HEAD after 412 and never retries PUT (%j)", async (reply, error) => {
  const { calls, store } = fixture({ status: 412 }, reply);
  const result = store.putIfAbsent(key, bytes);
  if (error) await expect(result).rejects.toThrow(error);
  else await expect(result).resolves.toMatchObject({ created: false });
  expect(calls.map(({ method }) => method)).toEqual(["PUT", "HEAD"]);
});

it("uses one request each for HEAD, GET and DELETE and rejects corrupted bytes", async () => {
  const { calls, store } = fixture({ status: 404 }, { body: "corrupted" }, { status: 204 });
  expect(await store.head(key)).toBeNull();
  await expect(store.get(key)).rejects.toThrow("object-digest-mismatch");
  await store.delete(key);
  expect(calls.map(({ method }) => method)).toEqual(["HEAD", "GET", "DELETE"]);
});

it("uses one LIST per page without issuing HEADs", async () => {
  const keys = [key, objectKey("raw", Buffer.from("second")), objectKey("raw", Buffer.from("third"))];
  const entries = (items: string[]) => items.map((item) =>
    `<Contents><Key>${item}</Key><Size>9</Size></Contents>`).join("");
  const { calls, store } = fixture(
    { body: `<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>next</NextContinuationToken>${entries(keys.slice(0, 2))}</ListBucketResult>` },
    { body: `<ListBucketResult><IsTruncated>false</IsTruncated>${entries(keys.slice(2))}</ListBucketResult>` },
  );
  expect(await store.list("raw")).toEqual(keys.map((item) => ({ key: item, sha256: item.slice(4), byteSize: 9 })));
  expect(calls.map(({ method }) => method)).toEqual(["GET", "GET"]);
  expect(calls[0].query).toMatchObject({ "list-type": "2", "max-keys": "2", prefix: "raw/" });
  expect(calls[1].query).toMatchObject({ "continuation-token": "next" });
});
