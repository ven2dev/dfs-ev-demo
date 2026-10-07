import { access, open, readFile, realpath } from "node:fs/promises";
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
