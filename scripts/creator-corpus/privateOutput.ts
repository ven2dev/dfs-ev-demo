import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, link, lstat, open, readFile, realpath, rename, rm, unlink, type FileHandle } from "node:fs/promises";
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
const checkedPath = async (path: string, extensions: readonly string[] = [".json"]): Promise<string> => {
  const target = resolve(path);
  if (!extensions.some((extension) => target.endsWith(extension))) {
    fail(extensions.includes(".json") ? "json-file-required" : "jsonl-file-required");
  }
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

type LockOwner = { pid: number; at: number; token: string };

const readOwner = async (path: string): Promise<LockOwner | "unreadable" | "absent"> => {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unreadable";
  }
  try {
    const owner = JSON.parse(content) as Partial<LockOwner>;
    if (typeof owner.pid === "number" && typeof owner.token === "string" && typeof owner.at === "number") {
      return owner as LockOwner;
    }
  } catch {
    // Falls through to unreadable.
  }
  return "unreadable";
};

// Creates an ownership file only if none exists: the record (process id and a
// random token) is written whole under a unique name and then linked into
// place, which fails if the path is taken. So the file is never seen half
// written, and exactly one contender wins. Used for both the lock and the
// takeover claim, so both carry the same ownership guarantees.
const acquireOwned = async (path: string, token: string): Promise<boolean> => {
  const staging = `${path}.${token}.tmp`;
  try {
    const handle = await open(staging, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: Date.now(), token } satisfies LockOwner));
    } finally {
      await handle.close();
    }
    await link(staging, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    return fail("output-unwritable");
  } finally {
    await rm(staging, { force: true });
  }
};

// Removes an ownership file only if it still carries this holder's token. A
// live owner's file is never removed by anyone else, so it is still ours.
const releaseOwned = async (path: string, token: string): Promise<void> => {
  const owner = await readOwner(path);
  if (owner !== "absent" && owner !== "unreadable" && owner.token === token) await rm(path, { force: true });
};

const ownerIsGone = (owner: LockOwner): boolean => {
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
};

// Stale means nobody can be holding it: its owner process no longer exists.
// Age alone never frees a file whose owner is alive, because that owner would
// then still be inside the protected section (or paused: machine sleep, a
// debugger, CPU starvation). A file that cannot be parsed (damaged from
// outside, since ours are written whole) is judged by its age instead.
const ownedFileIsStale = async (path: string, staleMs: number): Promise<boolean> => {
  const owner = await readOwner(path);
  if (owner === "absent") return false;
  if (owner === "unreadable") {
    try {
      return Date.now() - (await lstat(path)).mtimeMs > staleMs;
    } catch {
      return false;
    }
  }
  return ownerIsGone(owner);
};

// Removes a file whose owner is gone without removing a live replacement: move
// it aside, check that what was moved is the file judged abandoned, and put it
// back if not.
// Exported for tests only.
export const removeAbandoned = async (path: string, token: string | null): Promise<void> => {
  const quarantine = `${path}.${randomUUID()}.stale`;
  try {
    await rename(path, quarantine);
  } catch {
    return;
  }
  const moved = await readOwner(quarantine);
  const wasAbandoned = token === null ? moved === "unreadable" : moved !== "absent" && moved !== "unreadable" && moved.token === token;
  if (!wasAbandoned) {
    try {
      await link(quarantine, path);
    } catch {
      // Someone else already holds the path: the moved file is not ours to keep.
    }
  }
  await rm(quarantine, { force: true });
};

// Removes a stale lock without ever removing a live one. The claim to do so is
// itself an owned file, named for the exact stale lock being removed, so only
// contenders that judged that same lock stale compete for it. The holder
// judges again while holding the claim: nothing else can remove or replace a
// stale lock (its owner is gone, and removal needs this claim), so what it
// removes is what it judged. A live claimant is never displaced, however long
// it is paused. A claim whose claimant died is removed like any other
// abandoned file. Returns whether this call did the takeover work.
export const reapStaleLock = async (lockPath: string, staleMs: number): Promise<boolean> => {
  const lock = await readOwner(lockPath);
  if (lock === "absent") return true;
  const key = lock === "unreadable" ? "unreadable" : lock.token;
  const claimPath = `${lockPath}.reap-${key}`;
  const claimToken = randomUUID();
  if (!(await acquireOwned(claimPath, claimToken))) {
    const claim = await readOwner(claimPath);
    if (claim !== "absent" && (await ownedFileIsStale(claimPath, staleMs))) {
      await removeAbandoned(claimPath, claim === "unreadable" ? null : claim.token);
    }
    return false;
  }
  try {
    const current = await readOwner(lockPath);
    const same = current !== "absent" && (current === "unreadable" ? key === "unreadable" : current.token === key);
    if (same && (await ownedFileIsStale(lockPath, staleMs))) {
      await removeAbandoned(lockPath, key === "unreadable" ? null : key);
    }
    return true;
  } finally {
    await releaseOwned(claimPath, claimToken);
  }
};

// Runs `work` while holding an exclusive lock next to a private file, so two
// processes cannot both read the same version and then overwrite each other's
// change. The lock is an owned file (see `acquireOwned`). Only a lock whose
// owner process is gone is taken over (see `reapStaleLock`), and release
// removes the lock only if it still carries this holder's token.
export const withPrivateFileLock = async <T>(
  path: string,
  work: () => Promise<T>,
  { timeoutMs = 5000, staleMs = 30_000 }: { timeoutMs?: number; staleMs?: number } = {}
): Promise<T> => {
  const target = await checkedPath(path, [".json", ".jsonl"]);
  const lockPath = join(dirname(target), `.${basename(target)}.lock`);
  const token = randomUUID();
  const deadline = Date.now() + timeoutMs;
  while (!(await acquireOwned(lockPath, token))) {
    // Having done the takeover work ourselves, try again at once; otherwise
    // (live owner, or another process is taking over) wait and look again.
    if ((await ownedFileIsStale(lockPath, staleMs)) && (await reapStaleLock(lockPath, staleMs)) && Date.now() < deadline) {
      continue;
    }
    if (Date.now() >= deadline) return fail("file-busy");
    await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
  }
  try {
    return await work();
  } finally {
    await releaseOwned(lockPath, token);
  }
};

// Deletes a private file that passed the same location, symlink and hard-link
// checks as every other private file, and only if it exists. Used to remove
// saved API data once its retention period ends.
export const deletePrivateFile = async (path: string): Promise<void> => {
  const target = await checkedPath(path);
  try {
    await unlink(target);
  } catch {
    return fail("input-unreadable");
  }
};

// Checks the opened file itself, not its name, so nothing swapped in after the
// location check can slip through: a regular file, one link, and no access for
// group or others. A file that is too open is refused rather than changed, so
// the owner decides (`chmod 600`) and nothing is read or written meanwhile.
const requireOwnerOnly = async (handle: FileHandle): Promise<void> => {
  const info = await handle.stat();
  if (!info.isFile()) return fail("input-unreadable");
  if (info.nlink !== 1) return fail("hard-link-not-allowed");
  if ((info.mode & 0o077) !== 0) return fail("insecure-file-permissions");
};

// Reads a JSON Lines file as text. A file that does not exist yet is
// `undefined`; one that exists but cannot be read still fails, so a caller
// never appends to something it could not understand. The log holds
// transcripts, so a file readable by anyone but the owner is refused.
export const readPrivateTextOptional = async (path: string): Promise<string | undefined> => {
  const target = await checkedPath(path, [".jsonl"]);
  let handle: FileHandle;
  try {
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : fail("input-unreadable");
  }
  try {
    await requireOwnerOnly(handle);
    return await handle.readFile("utf8");
  } catch (error) {
    if (error instanceof PrivateFileError) throw error;
    return fail("input-unreadable");
  } finally {
    await handle.close();
  }
};

// Appends one line to a private JSON Lines log, creating it at owner-only
// permissions and refusing an existing file that is more open than that. The
// file is opened append-only and without following links, so a link swapped in
// after the location check still cannot redirect the write, and the line goes
// out in one write that is flushed before returning. Callers hold the file
// lock around their read-check-append.
export const appendPrivateLine = async (path: string, line: string): Promise<void> => {
  if (line.includes("\n") || line.includes("\r")) throw new PrivateFileError("invalid-line");
  const target = await checkedPath(path, [".jsonl"]);
  let handle: FileHandle;
  try {
    handle = await open(
      target,
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
      0o600
    );
  } catch {
    return fail("output-unwritable");
  }
  try {
    await requireOwnerOnly(handle);
    await handle.write(line + "\n");
    await handle.sync();
  } catch (error) {
    if (error instanceof PrivateFileError) throw error;
    return fail("output-unwritable");
  } finally {
    await handle.close();
  }
};
