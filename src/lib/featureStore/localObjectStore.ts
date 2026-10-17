import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, realpath, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { OBJECT_NAMESPACES, parseObjectKey, sha256, type ObjectInfo, type ObjectStore } from "./objectStore.ts";

const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT";

// The local pipeline owns this private root. As with a bucket administrator,
// malicious replacement of parent directories by the filesystem owner is out of
// scope. No source-supplied key can select a path, symlink or temporary filename.
export const openLocalObjectStore = async (
  directory: string,
  { maxObjectBytes = 256 * 1024 * 1024 }: { maxObjectBytes?: number } = {},
): Promise<ObjectStore> => {
  if (!isAbsolute(directory) || !Number.isSafeInteger(maxObjectBytes) || maxObjectBytes < 1) {
    throw new Error("object-store-options-refused");
  }
  const root = resolve(directory);
  const rootInfo = await lstat(root);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory() || (rootInfo.mode & 0o077) !== 0 ||
      await realpath(root) !== root) throw new Error("object-root-refused");

  const directories = new Map<string, { dev: number; ino: number }>();
  for (const namespace of OBJECT_NAMESPACES) {
    const path = join(root, namespace);
    await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw new Error("object-root-refused");
    directories.set(namespace, { dev: info.dev, ino: info.ino });
  }

  const checkedPath = async (key: string): Promise<string> => {
    const { namespace } = parseObjectKey(key);
    const currentRoot = await lstat(root);
    const info = await lstat(join(root, namespace));
    const expected = directories.get(namespace)!;
    if (!currentRoot.isDirectory() || currentRoot.isSymbolicLink() || (currentRoot.mode & 0o077) !== 0 ||
        currentRoot.dev !== rootInfo.dev || currentRoot.ino !== rootInfo.ino ||
        !info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 ||
        info.dev !== expected.dev || info.ino !== expected.ino) throw new Error("object-root-refused");
    return join(root, key);
  };
  const syncDirectory = async (path: string): Promise<void> => {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { await handle.sync(); } finally { await handle.close(); }
  };
  await syncDirectory(root);

  const read = async (key: string, includeBytes: boolean): Promise<{ object: ObjectInfo; bytes?: Buffer }> => {
    const path = await checkedPath(key);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > maxObjectBytes) throw new Error("object-file-refused");
      const bytes = includeBytes ? await handle.readFile() : undefined;
      if (bytes && bytes.byteLength !== info.size) throw new Error("object-size-changed");
      return { object: { key, sha256: parseObjectKey(key).sha256, byteSize: info.size }, bytes };
    } finally { await handle.close(); }
  };

  return {
    putIfAbsent: async (key, input) => {
      const expected = parseObjectKey(key);
      // Copy before the first await so a caller cannot mutate bytes after the
      // digest check but before the immutable write.
      if (input.byteLength > maxObjectBytes) throw new Error("object-size-refused");
      const bytes = Buffer.from(input);
      if (sha256(bytes) !== expected.sha256) throw new Error("object-digest-mismatch");
      const path = await checkedPath(key);
      const directory = join(root, expected.namespace);
      const temporary = join(directory, `.put-${randomUUID()}.tmp`);
      const handle = await open(temporary, "wx", 0o600);
      let created = false;
      try {
        try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
        await checkedPath(key);
        // link is an atomic create-if-absent operation. rename would overwrite
        // an existing object on POSIX, breaking immutable snapshot semantics.
        try { await link(temporary, path); created = true; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      } finally { await unlink(temporary); }
      await syncDirectory(directory);
      // Validate an existing object at ingestion, never silently repair it.
      // Ordinary get/head do no repeat hashing; recompute audits own that check.
      if (!created) {
        const existing = await read(key, true);
        if (existing.object.byteSize !== bytes.byteLength || sha256(existing.bytes!) !== expected.sha256) {
          throw new Error("object-existing-integrity-failed");
        }
      }
      return { created, object: { key, sha256: expected.sha256, byteSize: bytes.byteLength } };
    },
    get: async (key) => (await read(key, true)).bytes!,
    head: async (key) => {
      try { return (await read(key, false)).object; }
      catch (error) { if (isMissing(error)) return null; throw error; }
    },
    list: async (namespace) => {
      if (!(OBJECT_NAMESPACES as readonly string[]).includes(namespace)) throw new Error("object-namespace-refused");
      await checkedPath(`${namespace}/${"0".repeat(64)}`);
      const objects: ObjectInfo[] = [];
      for (const name of (await readdir(join(root, namespace))).sort()) {
        if (!/^[a-f0-9]{64}$/.test(name)) continue;
        try { objects.push((await read(`${namespace}/${name}`, false)).object); }
        catch (error) { if (!isMissing(error)) throw error; }
      }
      return objects;
    },
    delete: async (key) => {
      const path = await checkedPath(key);
      // unlink removes a directory entry, never a symlink's target. A missing
      // object is success so cleanup can safely resume after a crash.
      try { await unlink(path); }
      catch (error) { if (!isMissing(error)) throw error; }
      await syncDirectory(join(root, parseObjectKey(key).namespace));
    },
  };
};
