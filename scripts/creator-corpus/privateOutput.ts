import { randomUUID } from "node:crypto";
import { access, lstat, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export class PrivateFileError extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}
const fail = (code: string): never => {
  throw new PrivateFileError(code);
};

const repositoryRoot = (): string => fileURLToPath(new URL("../../", import.meta.url));

// Creator names, API data and review decisions are private working material.
// Every file this tool reads or writes must be a .json file in an existing
// directory outside the repository (after resolving symlinks), so nothing can
// be committed by accident.
const checkedPath = async (path: string): Promise<string> => {
  const target = resolve(path);
  if (!target.endsWith(".json")) fail("json-file-required");
  let parent: string;
  try {
    parent = await realpath(dirname(target));
  } catch {
    return fail("directory-missing");
  }
  const root = await realpath(repositoryRoot());
  const within = relative(root, parent);
  if (within === "" || (within !== ".." && !within.startsWith(".." + sep) && !within.startsWith(sep))) {
    fail("must-be-outside-repository");
  }
  const candidate = join(parent, basename(target));
  // Resolving the directory is not enough: a file here that is a symbolic link
  // (or a second hard link) to a file inside the repository would put private
  // data in the repository while looking like it is outside. Refuse both.
  let info;
  try {
    info = await lstat(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") fail("input-unreadable");
  }
  if (info?.isSymbolicLink()) fail("symlink-not-allowed");
  if (info?.isFile() && info.nlink > 1) fail("hard-link-not-allowed");
  return candidate;
};

// Exclusive create with owner-only permissions: an existing file is never
// overwritten, so earlier evidence cannot be replaced by accident.
export const writePrivateJson = async (path: string, data: unknown): Promise<void> => {
  const target = await checkedPath(path);
  let handle;
  try {
    handle = await open(target, "wx", 0o600);
  } catch (error) {
    return fail((error as NodeJS.ErrnoException).code === "EEXIST" ? "output-exists" : "output-unwritable");
  }
  try {
    await handle.writeFile(JSON.stringify(data, null, 2) + "\n");
  } finally {
    await handle.close();
  }
};

// Checked before any network call so a bad or taken output path cannot waste
// API quota.
export const assertPrivateOutputAvailable = async (path: string): Promise<void> => {
  const target = await checkedPath(path);
  try {
    await access(target);
  } catch {
    return;
  }
  fail("output-exists");
};

export const readPrivateJson = async (path: string): Promise<unknown> => {
  const target = await checkedPath(path);
  try {
    return JSON.parse(await readFile(target, "utf8"));
  } catch {
    return fail("input-unreadable");
  }
};

// Like readPrivateJson, but a file that does not exist yet is `undefined`
// rather than an error. A file that exists and is unreadable or corrupt still
// fails, so a caller never overwrites something it could not understand.
export const readPrivateJsonOptional = async (path: string): Promise<unknown> => {
  const target = await checkedPath(path);
  let content: string;
  try {
    content = await readFile(target, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : fail("input-unreadable");
  }
  try {
    return JSON.parse(content);
  } catch {
    return fail("input-unreadable");
  }
};

// Atomic replace for files the owner updates over time (the decisions log).
// The new content is written to an owner-only temporary file in the same
// directory and renamed over the target, so a crash can leave the old file or
// the new one but never a partial file.
export const replacePrivateJson = async (path: string, data: unknown): Promise<void> => {
  const target = await checkedPath(path);
  const temporary = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
  } catch {
    return fail("output-unwritable");
  }
  try {
    try {
      await handle.writeFile(JSON.stringify(data, null, 2) + "\n");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
  } catch {
    await rm(temporary, { force: true });
    return fail("output-unwritable");
  }
};

const LOCK_POLL_MS = 25;

// Runs `work` while holding an exclusive lock next to a private file, so two
// processes cannot both read the same version and then overwrite each other's
// change. The lock is a file created exclusively and holding its owner's
// process id and time. A lock whose owner is gone, or that is older than
// `staleMs`, is taken over so a crashed process cannot block the owner forever.
export const withPrivateFileLock = async <T>(
  path: string,
  work: () => Promise<T>,
  { timeoutMs = 5000, staleMs = 30_000 }: { timeoutMs?: number; staleMs?: number } = {}
): Promise<T> => {
  const target = await checkedPath(path);
  const lockPath = join(dirname(target), `.${basename(target)}.lock`);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }));
      } finally {
        await handle.close();
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return fail("output-unwritable");
    }
    if (await lockIsStale(lockPath, staleMs)) {
      await rm(lockPath, { force: true });
      continue;
    }
    if (Date.now() >= deadline) return fail("file-busy");
    await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
  }
  try {
    return await work();
  } finally {
    await rm(lockPath, { force: true });
  }
};

const lockIsStale = async (lockPath: string, staleMs: number): Promise<boolean> => {
  let owner: { pid?: unknown; at?: unknown };
  try {
    owner = JSON.parse(await readFile(lockPath, "utf8"));
  } catch {
    // Unreadable or half-written: judge by the file's own age instead.
    try {
      return Date.now() - (await lstat(lockPath)).mtimeMs > staleMs;
    } catch {
      return true;
    }
  }
  if (typeof owner.at === "number" && Date.now() - owner.at > staleMs) return true;
  if (typeof owner.pid !== "number") return false;
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
};
