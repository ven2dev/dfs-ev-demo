import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, realpath, unlink } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { digest, refuse } from "./validation.ts";

export type ArtifactStore = {
  write: (bytes: string, sha256: string) => Promise<string>;
  read: (reference: string, sha256: string, byteSize: number) => Promise<string>;
  // Retention only: removes one content-addressed file. The caller first proves
  // the database no longer references it.
  remove: (reference: string, sha256: string) => Promise<void>;
};
export type BlobCandidate = { reference: string; sha256: string };
export type DatabaseBlobStore = ArtifactStore & {
  candidates: (before: number) => Promise<BlobCandidate[]>;
  removeOrphan: (candidate: BlobCandidate, before: number) => Promise<boolean>;
};
export type PrivateArtifactStore = ArtifactStore & { database: DatabaseBlobStore };
const repository = fileURLToPath(new URL("../../../", import.meta.url));
const checkedDigest = (value: string) => { if (!/^[a-f0-9]{64}$/.test(value)) refuse("artifact-reference-refused"); };
const privateFile = async (path: string, limit: number): Promise<string> => {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077) !== 0 || info.size > limit) refuse("artifact-file-refused");
    const bytes = await handle.readFile("utf8");
    if (Buffer.byteLength(bytes) !== info.size) refuse("artifact-file-refused");
    return bytes;
  } finally { await handle.close(); }
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
  const contentStore = (directory: string): ArtifactStore => {
    const read: ArtifactStore["read"] = async (reference, sha256, byteSize) => {
      checkedDigest(sha256);
      if (reference !== sha256 + ".json" || !Number.isSafeInteger(byteSize) || byteSize < 0 || byteSize > maxFileBytes) refuse("artifact-reference-refused");
      await checkDirectory(directory);
      const bytes = await privateFile(join(directory, reference), maxFileBytes);
      if (Buffer.byteLength(bytes) !== byteSize || digest(bytes) !== sha256) refuse("artifact-integrity-failed");
      return bytes;
    };
    const syncDirectory = async () => {
      const handle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { await handle.sync(); } finally { await handle.close(); }
    };
    return {
      read,
      remove: async (reference, sha256) => {
        checkedDigest(sha256);
        if (reference !== sha256 + ".json") refuse("artifact-reference-refused");
        await checkDirectory(directory);
        try { await unlink(join(directory, reference)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        await syncDirectory();
      },
      write: async (bytes, sha256) => {
        checkedDigest(sha256);
        if (typeof bytes !== "string" || Buffer.byteLength(bytes) > maxFileBytes || digest(bytes) !== sha256) refuse("artifact-integrity-failed");
        await checkDirectory(directory);
        const reference = sha256 + ".json";
        const temporary = join(directory, ".capture-" + sha256 + "-" + randomUUID() + ".tmp");
        const handle = await open(temporary, "wx", 0o600);
        try {
          try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
          await checkDirectory(directory);
          try { await link(temporary, join(directory, reference)); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
        } finally { await unlink(temporary); }
        await syncDirectory();
        // An existing address must match. Never overwrite tampered stored bytes.
        await read(reference, sha256, Buffer.byteLength(bytes));
        return reference;
      },
    };
  };
  const candidateDigest = (reference: string) => /^([a-f0-9]{64})\.json$/.exec(reference)?.[1] ??
    /^\.capture-([a-f0-9]{64})-[a-f0-9-]{36}\.tmp$/.exec(reference)?.[1];
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
        const sha256 = candidateDigest(reference);
        if (sha256 && await oldPrivateFile(reference, before)) candidates.push({ reference, sha256 });
      }
      return candidates;
    },
    removeOrphan: async (candidate, before) => {
      if (!Number.isFinite(before) || candidateDigest(candidate.reference) !== candidate.sha256) refuse("artifact-reference-refused");
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
