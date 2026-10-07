// @vitest-environment node
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertPrivateOutputAvailable, readPrivateJson, writePrivateJson } from "./privateOutput.ts";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "creator-corpus-test-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

const code = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return (error as { code: string }).code;
  }
  return "accepted";
};

describe("writePrivateJson", () => {
  it("creates an owner-only JSON file with a trailing newline", async () => {
    const path = join(directory, "out.json");
    await writePrivateJson(path, { a: 1 });
    expect(await readFile(path, "utf8")).toBe('{\n  "a": 1\n}\n');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("never overwrites an existing file", async () => {
    const path = join(directory, "out.json");
    await writeFile(path, "original");
    expect(await code(writePrivateJson(path, { a: 1 }))).toBe("output-exists");
    expect(await readFile(path, "utf8")).toBe("original");
  });

  // Unique names and cleanup: if the guard ever regressed, these tests must
  // not leave stray files in the repository.
  it("refuses a location inside the repository and creates nothing there", async () => {
    const inside = join(process.cwd(), `creator-corpus-test-${randomUUID()}.json`);
    try {
      expect(await code(writePrivateJson(inside, { a: 1 }))).toBe("must-be-outside-repository");
      expect(await code(readFile(inside))).toBe("ENOENT");
    } finally {
      await rm(inside, { force: true });
    }
  });

  it("refuses a directory that is a symlink into the repository", async () => {
    const link = join(directory, "linked");
    await symlink(process.cwd(), link);
    const name = `creator-corpus-test-${randomUUID()}.json`;
    try {
      expect(await code(writePrivateJson(join(link, name), {}))).toBe("must-be-outside-repository");
      expect(await code(readFile(join(process.cwd(), name)))).toBe("ENOENT");
    } finally {
      await rm(join(process.cwd(), name), { force: true });
    }
  });

  it("refuses non-JSON names and missing directories", async () => {
    expect(await code(writePrivateJson(join(directory, "out.txt"), {}))).toBe("json-file-required");
    expect(await code(writePrivateJson(join(directory, "missing", "out.json"), {}))).toBe("directory-missing");
  });
});

describe("assertPrivateOutputAvailable", () => {
  it("passes for a new path and fails before any network call for a taken or unsafe one", async () => {
    await assertPrivateOutputAvailable(join(directory, "new.json"));
    await writeFile(join(directory, "taken.json"), "{}");
    expect(await code(assertPrivateOutputAvailable(join(directory, "taken.json")))).toBe("output-exists");
    expect(await code(assertPrivateOutputAvailable(join(process.cwd(), `creator-corpus-test-${randomUUID()}.json`)))).toBe(
      "must-be-outside-repository"
    );
  });
});

describe("readPrivateJson", () => {
  it("reads private JSON but refuses repository files, so names cannot live in the repo", async () => {
    await mkdir(join(directory, "sub"));
    await writeFile(join(directory, "sub", "in.json"), '{"k":1}');
    expect(await readPrivateJson(join(directory, "sub", "in.json"))).toEqual({ k: 1 });
    expect(await code(readPrivateJson(join(process.cwd(), "package.json")))).toBe("must-be-outside-repository");
    expect(await code(readPrivateJson(join(directory, "absent.json")))).toBe("input-unreadable");
    await writeFile(join(directory, "bad.json"), "{not json");
    expect(await code(readPrivateJson(join(directory, "bad.json")))).toBe("input-unreadable");
  });
});
