import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, realpath, unlink } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { digest, refuse } from "./validation.ts";

export type ArtifactStore = {
  write: (bytes: string, sha256: string) => Promise<string>;
  read: (reference: string, sha256: string, byteSize: number) => Promise<string>;
};
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
// a registered root is used; no recursive deletion or automatic orphan cleanup.
export const openArtifactStore = async (directory: string): Promise<ArtifactStore> => {
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
  const read: ArtifactStore["read"] = async (reference, sha256, byteSize) => {
    checkedDigest(sha256);
    if (reference !== sha256 + ".json" || !Number.isSafeInteger(byteSize) || byteSize < 0 || byteSize > 1_000_000) refuse("artifact-reference-refused");
    await checkRoot();
    const bytes = await privateFile(join(root, reference), 1_000_000);
    if (Buffer.byteLength(bytes) !== byteSize || digest(bytes) !== sha256) refuse("artifact-integrity-failed");
    return bytes;
  };
  return {
    read,
    write: async (bytes, sha256) => {
      checkedDigest(sha256);
      if (typeof bytes !== "string" || Buffer.byteLength(bytes) > 1_000_000 || digest(bytes) !== sha256) refuse("artifact-integrity-failed");
      await checkRoot();
      const reference = sha256 + ".json";
      const temporary = join(root, ".capture-" + randomUUID() + ".tmp");
      const handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      try {
        await checkRoot();
        try { await link(temporary, join(root, reference)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      } finally { await unlink(temporary); }
      const directory = await open(root, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { await directory.sync(); } finally { await directory.close(); }
      // An existing address must match. Never overwrite tampered stored bytes.
      await read(reference, sha256, Buffer.byteLength(bytes));
      return reference;
    },
  };
};
