import { createHash } from "node:crypto";

// Keys carry the digest, independent of media type. Identical wire bytes in one
// namespace have one address; media/codec metadata belongs to the snapshot row.
export type ObjectInfo = { key: string; sha256: string; byteSize: number };
export type ObjectStore = {
  putIfAbsent: (key: string, bytes: Uint8Array) => Promise<{ created: boolean; object: ObjectInfo }>;
  get: (key: string) => Promise<Buffer>;
  head: (key: string) => Promise<ObjectInfo | null>;
  list: (namespace: ObjectNamespace) => Promise<ObjectInfo[]>;
  delete: (key: string) => Promise<void>;
};
export const OBJECT_NAMESPACES = ["raw", "datasets", "models", "audits"] as const;
export type ObjectNamespace = typeof OBJECT_NAMESPACES[number];
export const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

export const parseObjectKey = (key: string): { namespace: ObjectNamespace; sha256: string } => {
  const match = /^(raw|datasets|models|audits)\/([a-f0-9]{64})$/.exec(key);
  if (!match) throw new Error("object-key-refused");
  return { namespace: match[1] as ObjectNamespace, sha256: match[2] };
};

export const objectKey = (namespace: ObjectNamespace, bytes: Uint8Array): string => {
  const key = `${namespace}/${sha256(bytes)}`;
  parseObjectKey(key);
  return key;
};
