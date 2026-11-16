import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { replayCodeIdentity } from "../../scripts/feature-store/replay-audit.ts";

const execute = promisify(execFile);

it("rejects tracked edits and untracked replay inputs before computing the code identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fs244-identity-"));
  const git = async (...args: string[]) => {
    const { stdout } = await execute("git", args, { cwd: directory, encoding: "utf8", timeout: 500, killSignal: "SIGKILL" });
    return stdout.trim();
  };
  const write = async (path: string, content: string) => {
    const file = join(directory, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content);
  };
  const repository = pathToFileURL(directory + sep);
  const asOf = "services/pipeline/src/featureStore/asOf.ts";
  try {
    await git("init", "--quiet");
    await write(asOf, "export const policy = 1;\n");
    await write("tracked.md", "original\n");
    await git("add", "--", asOf, "tracked.md");
    await git("-c", "user.name=Replay Test", "-c", "user.email=replay-test@example.invalid",
      "-c", "core.hooksPath=/dev/null", "commit", "--quiet", "--no-gpg-sign", "-m", "fixture");
    expect(await git("status", "--porcelain")).toBe("");

    for (const path of [asOf, "tracked.md"]) {
      await write(path, "changed\n");
      await expect(replayCodeIdentity(repository)).rejects.toThrow("replay-dirty-code");
      await git("restore", "--", path);
    }
    for (const path of ["services/pipeline/untracked.ts", "packages/db/untracked.sql", "scripts/db/untracked.mjs"]) {
      await write(path, "new file\n");
      await expect(replayCodeIdentity(repository)).rejects.toThrow("replay-dirty-code");
      await rm(join(directory, path));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
