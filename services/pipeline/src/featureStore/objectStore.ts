import { createHash } from "node:crypto";

// Keys carry the digest, independent of media type. Identical wire bytes in one
// namespace have one address; media/codec metadata belongs to the snapshot row.
export type ObjectInfo = { key: string; sha256: string; byteSize: number };
export type ObjectPageRequest = { limit: number; startAfter?: string };
export type ObjectPage = { entries: ObjectInfo[]; nextStartAfter: string | null };
export type ObjectStore = {
  putIfAbsent: (key: string, bytes: Uint8Array) => Promise<{ created: boolean; object: ObjectInfo }>;
  get: (key: string) => Promise<Buffer>;
  getVerified: (key: string, maxBytes: number) => Promise<VerifiedWire>;
  head: (key: string) => Promise<ObjectInfo | null>;
  list: (namespace: ObjectNamespace) => Promise<ObjectInfo[]>;
  listPage: (namespace: ObjectNamespace, request: ObjectPageRequest) => Promise<ObjectPage>;
  delete: (key: string) => Promise<void>;
  // Optional local upload housekeeping; hosted adapters use their upload lifecycle.
  cleanupTemporary?: (graceSeconds?: number) => Promise<string[]>;
};
export const OBJECT_NAMESPACES = ["raw", "datasets", "models", "audits"] as const;
export type ObjectNamespace = typeof OBJECT_NAMESPACES[number];
export const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

export const parseObjectKey = (key: string): { namespace: ObjectNamespace; sha256: string } => {
  const match = /^(raw|datasets|models|audits)\/([a-f0-9]{64})$/.exec(key);
  if (!match) throw new Error("object-key-refused");
  return { namespace: match[1] as ObjectNamespace, sha256: match[2] };
};

export const objectKeyForDigest = (namespace: ObjectNamespace, digest: string): string => {
  const key = `${namespace}/${digest}`;
  parseObjectKey(key);
  return key;
};

export const objectKey = (namespace: ObjectNamespace, bytes: Uint8Array): string =>
  objectKeyForDigest(namespace, sha256(bytes));

export const checkObjectReadLimit = (maxBytes: number): void => {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("object-size-refused");
};

export const checkObjectPageRequest = (namespace: ObjectNamespace, { limit, startAfter }: ObjectPageRequest): void => {
  if (!OBJECT_NAMESPACES.includes(namespace) || !Number.isInteger(limit) || limit < 1 || limit > 1_000 ||
      (startAfter !== undefined && parseObjectKey(startAfter).namespace !== namespace)) {
    throw new Error("object-page-request-refused");
  }
};

const verifiedWireBrand = Symbol("verified-wire");

export class VerifiedWire {
  readonly #bytes: Buffer;
  readonly #wireSha256: string;

  private constructor(brand: typeof verifiedWireBrand, bytes: Buffer, wireSha256: string) {
    if (brand !== verifiedWireBrand) throw new Error("object-verification-required");
    this.#bytes = bytes;
    this.#wireSha256 = wireSha256;
    Object.freeze(this);
  }

  static readonly verify = (key: string, input: Buffer): VerifiedWire => {
    const expected = parseObjectKey(key).sha256;
    // Transfer the dedicated allocation, detaching any caller views before hashing.
    const allocation = input.buffer;
    if (!(allocation instanceof ArrayBuffer) || input.byteOffset !== 0 || input.byteLength !== allocation.byteLength) {
      throw new Error("object-verification-buffer-refused");
    }
    const bytes = Buffer.from(structuredClone(allocation, { transfer: [allocation] }));
    if (sha256(bytes) !== expected) throw new Error("object-digest-mismatch");
    return new VerifiedWire(verifiedWireBrand, bytes, expected);
  };

  get wireSha256(): string { return this.#wireSha256; }
  get byteSize(): number { return this.#bytes.byteLength; }
}
