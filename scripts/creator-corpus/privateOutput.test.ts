// @vitest-environment node
import { randomUUID } from "node:crypto";
import { chmod, link, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendPrivateLine,
  assertPrivateOutputAvailable,
  deletePrivateFile,
  readPrivateJson,
  readPrivateJsonOptional,
  readPrivateTextOptional,
  reapStaleLock,
  replacePrivateJson,
  withPrivateFileLock,
  writePrivateJson,
} from "./privateOutput.ts";

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

describe("readPrivateJsonOptional", () => {
  it("returns undefined for a missing file but fails for a corrupt or unsafe one", async () => {
    expect(await readPrivateJsonOptional(join(directory, "absent.json"))).toBeUndefined();
    await writeFile(join(directory, "ok.json"), '{"k":1}');
    expect(await readPrivateJsonOptional(join(directory, "ok.json"))).toEqual({ k: 1 });
    await writeFile(join(directory, "bad.json"), "{nope");
    expect(await code(readPrivateJsonOptional(join(directory, "bad.json")))).toBe("input-unreadable");
    expect(await code(readPrivateJsonOptional(join(process.cwd(), "package.json")))).toBe("must-be-outside-repository");
  });
});

describe("replacePrivateJson", () => {
  it("replaces an existing file atomically at owner-only permissions and leaves no temporary file", async () => {
    const target = join(directory, "log.json");
    await writeFile(target, '{"old":true}', { mode: 0o644 });
    await replacePrivateJson(target, { fresh: 1 });
    expect(JSON.parse(await readFile(target, "utf8"))).toEqual({ fresh: 1 });
    expect((await stat(target)).mode & 0o777).toBe(0o600);
    await replacePrivateJson(join(directory, "new.json"), { a: 1 });
    expect((await readdir(directory)).sort()).toEqual(["log.json", "new.json"]);
  });

  it("keeps the original and removes its temporary file when the replace fails", async () => {
    const target = join(directory, "is-a-directory.json");
    await mkdir(target);
    await writeFile(join(target, "keep.txt"), "x");
    expect(await code(replacePrivateJson(target, { a: 1 }))).toBe("output-unwritable");
    expect((await readdir(directory)).sort()).toEqual(["is-a-directory.json"]);
    expect(await readFile(join(target, "keep.txt"), "utf8")).toBe("x");
  });

  it("refuses repository locations and non-JSON names", async () => {
    const name = `creator-corpus-test-${randomUUID()}.json`;
    try {
      expect(await code(replacePrivateJson(join(process.cwd(), name), {}))).toBe("must-be-outside-repository");
      expect(await code(readFile(join(process.cwd(), name)))).toBe("ENOENT");
    } finally {
      await rm(join(process.cwd(), name), { force: true });
    }
    expect(await code(replacePrivateJson(join(directory, "x.txt"), {}))).toBe("json-file-required");
  });
});

describe("file links", () => {
  // A link here would put private data inside the repository (or somewhere
  // unchecked) while the link itself looks like it is outside.
  it("refuses a symbolic link that points into the repository, for every read and write", async () => {
    const linked = join(directory, "innocent.json");
    await symlink(join(process.cwd(), "package.json"), linked);
    expect(await code(readPrivateJson(linked))).toBe("symlink-not-allowed");
    expect(await code(readPrivateJsonOptional(linked))).toBe("symlink-not-allowed");
    expect(await code(writePrivateJson(linked, {}))).toBe("symlink-not-allowed");
    expect(await code(replacePrivateJson(linked, {}))).toBe("symlink-not-allowed");
    expect(await code(assertPrivateOutputAvailable(linked))).toBe("symlink-not-allowed");
    expect(JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")).name).toBe("dfs-ev-demo");
  });

  it("refuses any symbolic link, even a dangling one or one to another private file", async () => {
    await writeFile(join(directory, "real.json"), "{}");
    await symlink(join(directory, "real.json"), join(directory, "alias.json"));
    await symlink(join(directory, "nowhere.json"), join(directory, "dangling.json"));
    expect(await code(readPrivateJson(join(directory, "alias.json")))).toBe("symlink-not-allowed");
    expect(await code(writePrivateJson(join(directory, "dangling.json"), {}))).toBe("symlink-not-allowed");
    await expect(stat(join(directory, "nowhere.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a file that has a second hard link", async () => {
    await writeFile(join(directory, "one.json"), '{"k":1}');
    await link(join(directory, "one.json"), join(directory, "two.json"));
    expect(await code(readPrivateJson(join(directory, "one.json")))).toBe("hard-link-not-allowed");
    expect(await code(readPrivateJson(join(directory, "two.json")))).toBe("hard-link-not-allowed");
  });

  it("still reads and replaces an ordinary private file", async () => {
    await writeFile(join(directory, "plain.json"), '{"k":1}');
    expect(await readPrivateJson(join(directory, "plain.json"))).toEqual({ k: 1 });
    await replacePrivateJson(join(directory, "plain.json"), { k: 2 });
    expect(await readPrivateJson(join(directory, "plain.json"))).toEqual({ k: 2 });
  });
});

describe("withPrivateFileLock", () => {
  const lockFile = () => join(directory, ".log.json.lock");
  const target = () => join(directory, "log.json");
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it("runs the work, returns its result and removes the lock", async () => {
    expect(await withPrivateFileLock(target(), async () => "done")).toBe("done");
    expect(await readdir(directory)).toEqual([]);
  });

  it("removes the lock even when the work throws", async () => {
    await expect(withPrivateFileLock(target(), async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(await readdir(directory)).toEqual([]);
  });

  it("holds the lock with its owner recorded, at owner-only permissions, while the work runs", async () => {
    await withPrivateFileLock(target(), async () => {
      expect(JSON.parse(await readFile(lockFile(), "utf8"))).toMatchObject({ pid: process.pid, token: expect.stringMatching(/^[0-9a-f-]{36}$/) });
      expect((await stat(lockFile())).mode & 0o777).toBe(0o600);
    });
  });

  it("makes a second holder wait until the first has finished", async () => {
    const order: string[] = [];
    const first = withPrivateFileLock(target(), async () => {
      order.push("first start");
      await wait(150);
      order.push("first end");
    });
    await wait(30);
    const second = withPrivateFileLock(target(), async () => {
      order.push("second start");
    });
    await Promise.all([first, second]);
    expect(order).toEqual(["first start", "first end", "second start"]);
  });

  it("gives up with a fixed code when the lock stays held, and leaves the holder's lock alone", async () => {
    const holder = withPrivateFileLock(target(), async () => wait(300));
    await wait(30);
    expect(await code(withPrivateFileLock(target(), async () => "never", { timeoutMs: 100 }))).toBe("file-busy");
    await holder;
    expect(await readdir(directory)).toEqual([]);
  });

  const lockOf = (pid: number, token: string = randomUUID(), at = Date.now()) => JSON.stringify({ pid, at, token });

  it("takes over a lock whose owner process no longer exists, leaving nothing behind", async () => {
    await writeFile(lockFile(), lockOf(2147483646));
    expect(await withPrivateFileLock(target(), async () => "taken over", { timeoutMs: 500 })).toBe("taken over");
    expect(await readdir(directory)).toEqual([]);
  });

  it("treats an owner it may not signal as alive, not gone", async () => {
    // Process 1 exists but cannot be signalled by an ordinary user (EPERM), or can by root.
    await writeFile(lockFile(), lockOf(1));
    expect(await code(withPrivateFileLock(target(), async () => "intruder", { timeoutMs: 150 }))).toBe("file-busy");
  });

  it("judges staleness again after taking the takeover claim, so a lock that was replaced is left alone", async () => {
    // The contender saw an old stale lock; by the time it holds the claim, a live owner has a fresh one.
    const fresh = lockOf(process.pid, "fresh-owner");
    await writeFile(lockFile(), fresh);
    expect(await reapStaleLock(lockFile(), 30_000)).toBe(true);
    expect(await readFile(lockFile(), "utf8")).toBe(fresh);
    expect(await readdir(directory)).toEqual([".log.json.lock"]);
    await writeFile(lockFile(), lockOf(2147483646));
    expect(await reapStaleLock(lockFile(), 30_000)).toBe(true);
    expect(await readdir(directory)).toEqual([]);
  });

  it("never takes over a lock whose owner is alive, however old it is", async () => {
    const old = lockOf(process.pid, "owner-token", Date.now() - 24 * 60 * 60 * 1000);
    await writeFile(lockFile(), old);
    expect(await code(withPrivateFileLock(target(), async () => "intruder", { staleMs: 1, timeoutMs: 150 }))).toBe("file-busy");
    expect(await readFile(lockFile(), "utf8")).toBe(old);
  });

  it("removes only its own lock on release", async () => {
    const theirs = lockOf(process.pid, "someone-else");
    await withPrivateFileLock(target(), async () => {
      await rm(lockFile());
      await writeFile(lockFile(), theirs);
    });
    expect(await readFile(lockFile(), "utf8")).toBe(theirs);
    expect(await readdir(directory)).toEqual([".log.json.lock"]);
  });

  it("writes the lock whole, so a waiting process never sees a half-written one", async () => {
    let sawPartial = false;
    const stop = Date.now() + 400;
    const watcher = (async () => {
      while (Date.now() < stop) {
        try {
          JSON.parse(await readFile(lockFile(), "utf8"));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") sawPartial = true;
        }
      }
    })();
    for (let index = 0; index < 40; index++) await withPrivateFileLock(target(), async () => undefined);
    await watcher;
    expect(sawPartial).toBe(false);
  });

  const claimFile = (lock: string) => `${lockFile()}.reap-${(JSON.parse(lock) as { token: string }).token}`;

  it("never displaces a takeover claim whose claimant is alive, however old the claim is", async () => {
    const stale = lockOf(2147483646);
    await writeFile(lockFile(), stale);
    const claim = lockOf(process.pid, "paused-claimant", Date.now() - 24 * 60 * 60 * 1000);
    await writeFile(claimFile(stale), claim);
    const old = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await utimes(claimFile(stale), old, old);
    expect(await code(withPrivateFileLock(target(), async () => "x", { timeoutMs: 200, staleMs: 1 }))).toBe("file-busy");
    expect(await readFile(claimFile(stale), "utf8")).toBe(claim);
    expect(await readFile(lockFile(), "utf8")).toBe(stale);
  });

  it("fails closed when a takeover claimant died, with a fixed code, changing neither file", async () => {
    const stale = lockOf(2147483646);
    await writeFile(lockFile(), stale);
    const dead = lockOf(2147483645, "dead-claimant");
    await writeFile(claimFile(stale), dead);
    expect(await code(withPrivateFileLock(target(), async () => "never", { timeoutMs: 2000 }))).toBe("takeover-claim-abandoned");
    expect(await readFile(lockFile(), "utf8")).toBe(stale);
    expect(await readFile(claimFile(stale), "utf8")).toBe(dead);
    expect((await readdir(directory)).sort()).toEqual([".log.json.lock", `.log.json.lock.reap-${JSON.parse(stale).token}`]);
    // Deleting the named claim file is the whole recovery.
    await rm(claimFile(stale));
    expect(await withPrivateFileLock(target(), async () => "recovered", { timeoutMs: 2000 })).toBe("recovered");
    expect(await readdir(directory)).toEqual([]);
  });

  it("fails closed on a claim it cannot read, rather than guessing", async () => {
    const stale = lockOf(2147483646);
    await writeFile(lockFile(), stale);
    await writeFile(claimFile(stale), "{ damaged");
    expect(await code(withPrivateFileLock(target(), async () => "never", { timeoutMs: 500 }))).toBe("takeover-claim-abandoned");
    expect(await readFile(claimFile(stale), "utf8")).toBe("{ damaged");
  });

  it("names each claim for the lock it is removing, so claims for different locks never collide", async () => {
    const first = lockOf(2147483646);
    await writeFile(lockFile(), first);
    expect(claimFile(first)).toContain(".reap-");
    expect(claimFile(first)).not.toBe(claimFile(lockOf(2147483646)));
  });

  it("handles an unreadable lock file by its age", async () => {
    await writeFile(lockFile(), "{ half written");
    expect(await code(withPrivateFileLock(target(), async () => "x", { staleMs: 60_000, timeoutMs: 100 }))).toBe("file-busy");
    expect(await withPrivateFileLock(target(), async () => "aged out", { staleMs: 0, timeoutMs: 500 })).toBe("aged out");
  });

  it("applies the same location rules as every other private file", async () => {
    expect(await code(withPrivateFileLock(join(process.cwd(), `creator-corpus-test-${randomUUID()}.json`), async () => "x"))).toBe(
      "must-be-outside-repository"
    );
    await writeFile(join(directory, "real.json"), "{}");
    await symlink(join(directory, "real.json"), join(directory, "alias.json"));
    expect(await code(withPrivateFileLock(join(directory, "alias.json"), async () => "x"))).toBe("symlink-not-allowed");
  });
});

describe("deletePrivateFile", () => {
  it("deletes an ordinary private file and nothing else", async () => {
    await writeFile(join(directory, "gone.json"), "{}");
    await writeFile(join(directory, "stays.json"), "{}");
    await deletePrivateFile(join(directory, "gone.json"));
    expect(await readdir(directory)).toEqual(["stays.json"]);
  });

  it("refuses repository files, links, non-JSON names and files that do not exist", async () => {
    expect(await code(deletePrivateFile(join(process.cwd(), "package.json")))).toBe("must-be-outside-repository");
    expect(JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")).name).toBe("dfs-ev-demo");
    await writeFile(join(directory, "real.json"), "{}");
    await symlink(join(directory, "real.json"), join(directory, "alias.json"));
    expect(await code(deletePrivateFile(join(directory, "alias.json")))).toBe("symlink-not-allowed");
    await writeFile(join(directory, "note.txt"), "x");
    expect(await code(deletePrivateFile(join(directory, "note.txt")))).toBe("json-file-required");
    expect(await code(deletePrivateFile(join(directory, "absent.json")))).toBe("input-unreadable");
    expect((await readdir(directory)).sort()).toEqual(["alias.json", "note.txt", "real.json"]);
  });
});

describe("JSON Lines helpers", () => {
  const log = () => join(directory, "log.jsonl");

  it("appends lines to an owner-only file without disturbing earlier lines", async () => {
    await appendPrivateLine(log(), '{"a":1}');
    await appendPrivateLine(log(), '{"b":2}');
    expect(await readFile(log(), "utf8")).toBe('{"a":1}\n{"b":2}\n');
    expect((await stat(log())).mode & 0o777).toBe(0o600);
    expect(await readdir(directory)).toEqual(["log.jsonl"]);
  });

  it("appends to a file that already exists without truncating it", async () => {
    await writeFile(log(), '{"old":true}\n', { mode: 0o600 });
    await appendPrivateLine(log(), '{"new":true}');
    expect(await readFile(log(), "utf8")).toBe('{"old":true}\n{"new":true}\n');
  });

  it("refuses an existing log that group or others can read, and neither reads nor changes it", async () => {
    for (const mode of [0o644, 0o640, 0o604, 0o660, 0o666]) {
      await writeFile(log(), '{"old":true}\n');
      await chmod(log(), mode);
      expect(await code(appendPrivateLine(log(), '{"new":true}')), mode.toString(8)).toBe("insecure-file-permissions");
      expect(await code(readPrivateTextOptional(log())), mode.toString(8)).toBe("insecure-file-permissions");
      expect(await readFile(log(), "utf8")).toBe('{"old":true}\n');
      expect((await stat(log())).mode & 0o777).toBe(mode);
      await rm(log());
    }
  });

  it("accepts an existing owner-only log, whatever the owner bits", async () => {
    await writeFile(log(), '{"old":true}\n');
    for (const mode of [0o600, 0o400, 0o700]) {
      await chmod(log(), mode);
      expect(await readPrivateTextOptional(log())).toBe('{"old":true}\n');
    }
    await chmod(log(), 0o600);
    await appendPrivateLine(log(), '{"new":true}');
    expect(await readFile(log(), "utf8")).toBe('{"old":true}\n{"new":true}\n');
  });

  it("refuses a log with a second hard link even when it is owner-only", async () => {
    await writeFile(log(), "", { mode: 0o600 });
    await link(log(), join(directory, "other.jsonl"));
    expect(await code(appendPrivateLine(log(), "{}"))).toBe("hard-link-not-allowed");
  });

  it("refuses a line that contains a line break", async () => {
    for (const bad of ["a\nb", "a\rb"]) expect(await code(appendPrivateLine(log(), bad))).toBe("invalid-line");
    await expect(stat(log())).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("requires a .jsonl name and applies the usual location, symbolic-link and hard-link rules", async () => {
    expect(await code(appendPrivateLine(join(directory, "log.json"), "{}"))).toBe("jsonl-file-required");
    expect(await code(appendPrivateLine(join(process.cwd(), `creator-corpus-test-${randomUUID()}.jsonl`), "{}"))).toBe("must-be-outside-repository");
    await writeFile(join(directory, "real.jsonl"), "");
    await symlink(join(directory, "real.jsonl"), join(directory, "alias.jsonl"));
    expect(await code(appendPrivateLine(join(directory, "alias.jsonl"), "{}"))).toBe("symlink-not-allowed");
    expect(await readFile(join(directory, "real.jsonl"), "utf8")).toBe("");
    await link(join(directory, "real.jsonl"), join(directory, "second.jsonl"));
    expect(await code(appendPrivateLine(join(directory, "real.jsonl"), "{}"))).toBe("hard-link-not-allowed");
  });

  it("reads a log as text, treats a missing one as undefined, and applies the same rules", async () => {
    expect(await readPrivateTextOptional(log())).toBeUndefined();
    await appendPrivateLine(log(), '{"a":1}');
    expect(await readPrivateTextOptional(log())).toBe('{"a":1}\n');
    expect(await code(readPrivateTextOptional(join(directory, "log.json")))).toBe("jsonl-file-required");
    expect(await code(readPrivateTextOptional(join(process.cwd(), "x.jsonl")))).toBe("must-be-outside-repository");
  });

  it("can be locked like a JSON file", async () => {
    expect(await withPrivateFileLock(log(), async () => "ok")).toBe("ok");
    expect(await readdir(directory)).toEqual([]);
  });
});
