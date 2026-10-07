import { randomUUID } from "node:crypto";
import { access, open, readFile, realpath, rename, rm } from "node:fs/promises";
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
  return join(parent, basename(target));
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
