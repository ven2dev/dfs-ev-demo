import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, realpath, unlink } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { digest, refuse } from "./validation.ts";

export type ArtifactMediaType = "application/json" | "text/csv";
export type ArtifactStore = {
  write: (bytes: string, sha256: string, mediaType?: ArtifactMediaType) => Promise<string>;
  read: (reference: string, sha256: string, byteSize: number) => Promise<string>;
  // Retention only: removes one content-addressed file. The caller first proves
  // the database no longer references it.
  remove: (reference: string, sha256: string) => Promise<void>;
};
export type BinaryArtifactStore = ArtifactStore & {
  // Exact wire bytes. Storage does not assert gzip validity or source rights.
  writeBinary: (bytes: Uint8Array, sha256: string) => Promise<string>;
  readBinary: (reference: string, sha256: string, byteSize: number) => Promise<Buffer>;
};
export type BlobCandidate = { reference: string; sha256: string; kind: "final" | "temporary" };
export type DatabaseBlobStore = BinaryArtifactStore & {
  candidates: (before: number) => Promise<BlobCandidate[]>;
  removeOrphan: (candidate: BlobCandidate, before: number) => Promise<boolean>;
};
export type PrivateArtifactStore = BinaryArtifactStore & { database: DatabaseBlobStore };
const repository = fileURLToPath(new URL("../../../", import.meta.url));
const checkedDigest = (value: string) => { if (!/^[a-f0-9]{64}$/.test(value)) refuse("artifact-reference-refused"); };
const checkedReference = (reference: string, sha256: string, kind: "text" | "binary" | "any" = "any") => {
  checkedDigest(sha256);
  const text = reference === sha256 + ".json" || reference === sha256 + ".csv";
  const binary = reference === sha256 + ".csv.gz";
  if (kind === "text" ? !text : kind === "binary" ? !binary : !text && !binary) refuse("artifact-reference-refused");
};
const wireDigest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const privateBytes = async (path: string, limit: number): Promise<Buffer> => {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077) !== 0 || info.size > limit) refuse("artifact-file-refused");
    // Read at most the checked size plus one sentinel byte, even if the file grows.
    const bytes = Buffer.alloc(info.size + 1); let length = 0;
    while (length < bytes.length) {
      const part = await handle.read(bytes, length, bytes.length - length, length);
      if (part.bytesRead === 0) break;
      length += part.bytesRead;
    }
    const after = await handle.stat();
    if (length !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.nlink !== 1 || (after.mode & 0o077) !== 0) refuse("artifact-file-refused");
    return bytes.subarray(0, length);
  } finally { await handle.close(); }
};
const privateFile = async (path: string, limit: number): Promise<string> => {
  const bytes = await privateBytes(path, limit); const text = bytes.toString("utf8");
  if (Buffer.byteLength(text) !== bytes.length) refuse("artifact-file-refused");
  return text;
};

// The owner supplies an existing private directory outside the checkout. Only
// a registered root is used; orphan cleanup is limited to database-owned bytes.
export const openArtifactStore = async (directory: string, maxFileBytes = 1_000_000): Promise<PrivateArtifactStore> => {
  // Larger private source bases are opt-in for the bounded qualification CLI.
  // Synthetic publication keeps its independent one-million-byte schema cap.
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1 || maxFileBytes > 8_000_000) refuse("artifact-size-bound-refused");
  const root = await realpath(directory);
  const repo = await realpath(repository);
  const within = relative(repo, root);
  const info = await lstat(resolve(directory));
  if (info.isSymbolicLink() || !info.isDirectory() || (info.mode & 0o077) !== 0 ||
      within === "" || (!within.startsWith(".." + sep) && within !== ".." && !within.startsWith(sep))) refuse("artifact-root-refused");
  const marker = join(root, ".predictive-artifacts.json");
  try {
    const handle = await open(marker, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify({ formatVersion: 1, token: randomUUID() })); await handle.sync(); }
    finally { await handle.close(); }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const registration = await privateFile(marker, 256);
  const parsed = JSON.parse(registration);
  if (Object.keys(parsed).sort().join(",") !== "formatVersion,token" || parsed.formatVersion !== 1 ||
      typeof parsed.token !== "string" || !/^[a-f0-9-]{36}$/.test(parsed.token)) refuse("artifact-root-refused");
  const checkRoot = async () => {
    const current = await lstat(root);
    if (!current.isDirectory() || current.isSymbolicLink() || (current.mode & 0o077) !== 0 ||
        current.dev !== info.dev || current.ino !== info.ino || await privateFile(marker, 256) !== registration) refuse("artifact-root-refused");
  };
  // The root preserves private archive/journal compatibility. Database-owned
  // bytes live in a separate namespace, the only area eligible for orphan GC.
  const databaseRoot = join(root, ".db-blobs");
  await mkdir(databaseRoot, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
  const databaseInfo = await lstat(databaseRoot);
  if (!databaseInfo.isDirectory() || databaseInfo.isSymbolicLink() || (databaseInfo.mode & 0o077) !== 0) refuse("artifact-root-refused");
  // Persist registration and the namespace before any SQL row can own a file.
  const rootHandle = await open(root, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await rootHandle.sync(); } finally { await rootHandle.close(); }
  const checkDirectory = async (directory: string) => {
    await checkRoot();
    if (directory === root) return;
    const current = await lstat(directory);
    if (!current.isDirectory() || current.isSymbolicLink() || (current.mode & 0o077) !== 0 ||
        current.dev !== databaseInfo.dev || current.ino !== databaseInfo.ino) refuse("artifact-root-refused");
  };
  const contentStore = (directory: string): BinaryArtifactStore => {
    const readExact = async (reference: string, sha256: string, byteSize: number, kind: "text" | "binary"): Promise<Buffer> => {
      checkedReference(reference, sha256, kind);
      if (!Number.isSafeInteger(byteSize) || byteSize < 0 || byteSize > maxFileBytes) refuse("artifact-reference-refused");
      await checkDirectory(directory);
      const bytes = await privateBytes(join(directory, reference), maxFileBytes);
      if (bytes.length !== byteSize || wireDigest(bytes) !== sha256) refuse("artifact-integrity-failed");
      return bytes;
    };
    const read: ArtifactStore["read"] = async (reference, sha256, byteSize) => {
      const bytes = await readExact(reference, sha256, byteSize, "text"); const text = bytes.toString("utf8");
      if (Buffer.byteLength(text) !== bytes.length || digest(text) !== sha256) refuse("artifact-integrity-failed");
      return text;
    };
    const readBinary: BinaryArtifactStore["readBinary"] = (reference, sha256, byteSize) => readExact(reference, sha256, byteSize, "binary");
    const syncDirectory = async () => {
      const handle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { await handle.sync(); } finally { await handle.close(); }
    };
    const writeExact = async (bytes: Buffer, sha256: string, reference: string, kind: "text" | "binary") => {
      await checkDirectory(directory);
      const temporary = join(directory, ".capture-" + sha256 + "-" + randomUUID() + ".tmp");
      const handle = await open(temporary, "wx", 0o600);
      try {
        try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
        await checkDirectory(directory);
        try { await link(temporary, join(directory, reference)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      } finally { await unlink(temporary); }
      await syncDirectory();
      await readExact(reference, sha256, bytes.length, kind);
      return reference;
    };
    return {
      read, readBinary,
      remove: async (reference, sha256) => {
        checkedReference(reference, sha256);
        await checkDirectory(directory);
        try { await unlink(join(directory, reference)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        await syncDirectory();
      },
      write: async (bytes, sha256, mediaType = "application/json") => {
        checkedDigest(sha256);
        if (mediaType !== "application/json" && mediaType !== "text/csv") refuse("artifact-reference-refused");
        if (typeof bytes !== "string" || Buffer.byteLength(bytes) > maxFileBytes || digest(bytes) !== sha256) refuse("artifact-integrity-failed");
        return writeExact(Buffer.from(bytes, "utf8"), sha256, sha256 + (mediaType === "text/csv" ? ".csv" : ".json"), "text");
      },
      writeBinary: async (source, sha256) => {
        checkedDigest(sha256);
        if (!(source instanceof Uint8Array) || source.byteLength > maxFileBytes) refuse("artifact-integrity-failed");
        // Caller mutation after this point cannot change the hashed wire snapshot.
        const bytes = Buffer.from(source);
        if (wireDigest(bytes) !== sha256) refuse("artifact-integrity-failed");
        return writeExact(bytes, sha256, sha256 + ".csv.gz", "binary");
      },
    };
  };
  const blobCandidate = (reference: string): BlobCandidate | null => {
    const final = /^([a-f0-9]{64})\.(json|csv|csv\.gz)$/.exec(reference);
    if (final) return { reference, sha256: final[1], kind: "final" };
    const temporary = /^\.capture-([a-f0-9]{64})-[a-f0-9-]{36}\.tmp$/.exec(reference);
    return temporary ? { reference, sha256: temporary[1], kind: "temporary" } : null;
  };
  const oldPrivateFile = async (reference: string, before: number) => {
    const info = await lstat(join(databaseRoot, reference)).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    return !!info && info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && (info.mode & 0o077) === 0 && info.mtimeMs < before;
  };
  const database: DatabaseBlobStore = {
    ...contentStore(databaseRoot),
    candidates: async (before) => {
      if (!Number.isFinite(before)) refuse("artifact-age-refused");
      await checkDirectory(databaseRoot);
      const candidates: BlobCandidate[] = [];
      for (const reference of (await readdir(databaseRoot)).sort()) {
        const candidate = blobCandidate(reference);
        if (candidate && await oldPrivateFile(reference, before)) candidates.push(candidate);
      }
      return candidates;
    },
    removeOrphan: async (candidate, before) => {
      const parsed = blobCandidate(candidate.reference);
      if (!Number.isFinite(before) || !parsed || parsed.sha256 !== candidate.sha256 || parsed.kind !== candidate.kind) refuse("artifact-reference-refused");
      checkedDigest(candidate.sha256); await checkDirectory(databaseRoot);
      if (!await oldPrivateFile(candidate.reference, before)) return false;
      try { await unlink(join(databaseRoot, candidate.reference)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return false; }
      const handle = await open(databaseRoot, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { await handle.sync(); } finally { await handle.close(); }
      return true;
    },
  };
  return { ...contentStore(root), database };
};
