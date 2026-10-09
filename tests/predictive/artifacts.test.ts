import { createHash } from "node:crypto";
import { chmod, link, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { openArtifactStore } from "../../src/lib/predictive/artifacts.ts";
import { digest } from "../../src/lib/predictive/validation.ts";
import { archiveRuns, restoreRuns } from "../../scripts/predictive/archive.ts";
import { passingYardsFixture } from "./fixtures/passingYards.ts";

const roots: string[] = [];
const root = async () => {
  const path = await realpath(await mkdtemp(join(tmpdir(), "dfs-ev-predictive-artifacts-"))); roots.push(path); return path;
};
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
it("stores exact private bytes at immutable digest addresses and supports concurrent identical writes", async () => {
  const directory = await root(); const store = await openArtifactStore(directory); const bytes = "[\n]";
  // Compute the expected address independently of the predictive digest helper.
  const sha = createHash("sha256").update(bytes).digest("hex");
  const refs = await Promise.all([store.write(bytes, sha), store.write(bytes, sha)]);
  expect(refs).toEqual([sha + ".json", sha + ".json"]);
  expect(await store.read(refs[0], sha, Buffer.byteLength(bytes))).toBe(bytes);
  expect(await readFile(join(directory, refs[0]), "utf8")).toBe(bytes);
  const inode = (await stat(join(directory, refs[0]))).ino;
  await store.write(bytes, sha);
  expect((await stat(join(directory, refs[0]))).ino).toBe(inode);
  expect((await readdir(directory)).filter((name) => name.startsWith(".capture-"))).toEqual([]);
  expect((await stat(join(directory, refs[0]))).mode & 0o077).toBe(0);
  expect(await (await openArtifactStore(directory)).read(refs[0], sha, 3)).toBe(bytes);
});
it("refuses checkout roots, symlink roots and insecure directories", async () => {
  const directory = await root(); const alias = join(directory, "alias"); await symlink(directory, alias);
  await expect(openArtifactStore(alias)).rejects.toThrow("artifact-root-refused");
  await chmod(directory, 0o755); await expect(openArtifactStore(directory)).rejects.toThrow("artifact-root-refused");
  const checkout = join(process.cwd(), ".predictive-artifact-test");
  await mkdir(checkout, { mode: 0o700 });
  try { await expect(openArtifactStore(checkout)).rejects.toThrow("artifact-root-refused"); }
  finally { await rm(checkout, { recursive: true }); }
});
it("refuses traversal, bad hashes, tampered bytes, missing files and public permissions", async () => {
  const directory = await root(); const store = await openArtifactStore(directory); const bytes = "[]"; const sha = digest(bytes); const ref = await store.write(bytes, sha);
  await expect(store.read("../" + ref, sha, 2)).rejects.toThrow("artifact-reference-refused");
  await expect(store.read(ref, sha, 3)).rejects.toThrow("artifact-integrity-failed");
  await expect(store.write(bytes, "a".repeat(64))).rejects.toThrow("artifact-integrity-failed");
  await writeFile(join(directory, ref), "{}", { mode: 0o600 });
  await expect(store.read(ref, sha, 2)).rejects.toThrow("artifact-integrity-failed");
  await expect(store.write(bytes, sha)).rejects.toThrow("artifact-integrity-failed");
  expect(await readFile(join(directory, ref), "utf8")).toBe("{}");
  await writeFile(join(directory, ref), bytes); await chmod(join(directory, ref), 0o644);
  await expect(store.read(ref, sha, 2)).rejects.toThrow("artifact-file-refused");
  await rm(join(directory, ref)); await expect(store.read(ref, sha, 2)).rejects.toThrow();
});
it("refuses symlinks, hard links and changed root registrations without reading or overwriting them", async () => {
  const directory = await root(); const store = await openArtifactStore(directory); const bytes = "[]"; const sha = digest(bytes); const ref = await store.write(bytes, sha);
  await link(join(directory, ref), join(directory, "second-link.json"));
  await expect(store.read(ref, sha, 2)).rejects.toThrow("artifact-file-refused"); await rm(join(directory, "second-link.json"));
  const outside = await root(); await writeFile(join(outside, "bytes.json"), bytes, { mode: 0o600 });
  await rm(join(directory, ref)); await symlink(join(outside, "bytes.json"), join(directory, ref));
  await expect(store.read(ref, sha, 2)).rejects.toThrow(); expect(await readFile(join(outside, "bytes.json"), "utf8")).toBe(bytes);
  await writeFile(join(directory, ".predictive-artifacts.json"), "{}");
  await expect(store.write(bytes, sha)).rejects.toThrow("artifact-root-refused");
});
it("restores exact capture metadata and immutable source bytes from a private content-addressed archive", async () => {
  const directory = await root(); const store = await openArtifactStore(directory); const dataset = passingYardsFixture(false);
  dataset.captures[0] = { ...dataset.captures[0], state: "incomplete", publishedAt: "2026-10-06T12:00:00.000Z",
    publicationEvidence: "synthetic-publication", availableAt: "2026-10-07T13:00:00.000Z", ingestedAt: "2026-10-07T14:00:00.000Z" };
  const runs = [{ id: "A", dataset }];
  for (const artifact of runs[0].dataset.artifacts) await store.write(artifact.bytes, artifact.sha256);
  const reference = await archiveRuns(store, runs);
  expect(await restoreRuns(store, reference)).toEqual(runs);
  expect(await restoreRuns(await openArtifactStore(directory), reference)).toEqual(runs);
  await expect(restoreRuns(store, { ...reference, reference: "../" + reference.reference })).rejects.toThrow("artifact-reference-refused");
  await expect(restoreRuns(store, { ...reference, byteSize: reference.byteSize + 1 })).rejects.toThrow("artifact-integrity-failed");
  const source = runs[0].dataset.artifacts[0]; const sourcePath = join(directory, source.sha256 + ".json");
  await writeFile(sourcePath, source.bytes.replace('"week":1', '"week":2'));
  await expect(restoreRuns(store, reference)).rejects.toThrow("artifact-integrity-failed");
  await rm(sourcePath); await expect(restoreRuns(store, reference)).rejects.toMatchObject({ code: "ENOENT" });
});
