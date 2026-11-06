import {
  DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { OBJECT_NAMESPACES, parseObjectKey, sha256, type ObjectStore } from "./objectStore.ts";

const hasStatus = (error: unknown, status: number): boolean =>
  typeof error === "object" && error !== null && "$metadata" in error &&
  (error.$metadata as { httpStatusCode?: number } | undefined)?.httpStatusCode === status;

const checkedSize = (size: number | undefined): number => {
  if (size === undefined || !Number.isSafeInteger(size) || size < 0) throw new Error("object-size-refused");
  return size;
};

export const openR2ObjectStore = (
  client: Pick<S3Client, "send">, bucket: string, maxKeys?: number,
): ObjectStore => {
  const head: ObjectStore["head"] = async (key) => {
    const expected = parseObjectKey(key).sha256;
    const result = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key })).catch((error: unknown) => {
      if (hasStatus(error, 404)) return null;
      throw error;
    });
    if (!result) return null;
    if (result.Metadata?.sha256 !== expected) throw new Error("object-metadata-integrity-failed");
    return { key, sha256: expected, byteSize: checkedSize(result.ContentLength) };
  };

  return {
    head,
    putIfAbsent: async (key, bytes) => {
      const expected = parseObjectKey(key).sha256;
      const body = Buffer.from(bytes);
      if (sha256(body) !== expected) throw new Error("object-digest-mismatch");
      try {
        await client.send(new PutObjectCommand({
          Bucket: bucket, Key: key, Body: body, IfNoneMatch: "*", Metadata: { sha256: expected },
        }));
      } catch (error) {
        if (!hasStatus(error, 412)) throw error;
        const object = await head(key);
        if (!object) throw new Error("object-disappeared-after-precondition");
        if (object.byteSize !== body.length) throw new Error("object-existing-integrity-failed");
        return { created: false, object };
      }
      return { created: true, object: { key, sha256: expected, byteSize: body.length } };
    },
    get: async (key) => {
      const expected = parseObjectKey(key).sha256;
      const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key })).catch((error: unknown) => {
        if (hasStatus(error, 404)) throw Object.assign(new Error("object-not-found", { cause: error }), { code: "ENOENT" });
        throw error;
      });
      if (!result.Body) throw new Error("object-body-missing");
      const bytes = Buffer.from(await result.Body.transformToByteArray());
      if (sha256(bytes) !== expected) throw new Error("object-digest-mismatch");
      return bytes;
    },
    list: async (namespace) => {
      if (!OBJECT_NAMESPACES.includes(namespace)) throw new Error("object-key-refused");
      const objects = [];
      let token: string | undefined;
      do {
        const page = await client.send(new ListObjectsV2Command({
          Bucket: bucket, Prefix: namespace + "/", MaxKeys: maxKeys, ContinuationToken: token,
        }));
        for (const entry of page.Contents ?? []) {
          const key = entry.Key ?? "";
          // Reject foreign keys, including manually uploaded files without content addresses.
          const parsed = parseObjectKey(key);
          if (parsed.namespace !== namespace) throw new Error("object-key-refused");
          // LIST exposes the digest claimed by the address. HEAD and GET verify integrity.
          objects.push({ key, sha256: parsed.sha256, byteSize: checkedSize(entry.Size) });
        }
        const next = page.NextContinuationToken;
        if (!page.IsTruncated) break;
        if (!next || next === token) throw new Error("object-list-pagination-failed");
        token = next;
      } while (token);
      return objects;
    },
    delete: async (key) => {
      parseObjectKey(key);
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
  };
};
