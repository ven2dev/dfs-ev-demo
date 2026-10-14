import { createHash } from "node:crypto";
import { chmod, link, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { openArtifactStore } from "../../src/lib/predictive/artifacts.ts";
import { canonical, digest } from "../../src/lib/predictive/validation.ts";
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
it("refuses cancelled text and binary reads before opening bytes and preserves subsequent access", async () => {
  const store = await openArtifactStore(await root()), bytes = "[]", sha = digest(bytes);
  const textRef = await store.database.write(bytes, sha), binaryRef = await store.database.writeBinary(Buffer.from(bytes), sha);
  const controller = new AbortController(); controller.abort(new Error("training-cancelled"));
  const absent = "a".repeat(64);
  await expect(store.database.read(absent + ".json", absent, 2, { signal: controller.signal })).rejects.toThrow("training-cancelled");
  await expect(store.database.readBinary(absent + ".csv.gz", absent, 2, { signal: controller.signal })).rejects.toThrow("training-cancelled");
  expect(await store.database.read(textRef, sha, 2)).toBe(bytes);
  expect(await store.database.readBinary(binaryRef, sha, 2)).toEqual(Buffer.from(bytes));
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
it("stores and reads CSV at the SQL media-type address and refuses other reference suffixes", async () => {
  const directory = await root(); const store = await openArtifactStore(directory); const bytes = "player_id,yards\n00-0000001,300\n";
  const sha = createHash("sha256").update(bytes).digest("hex"); const reference = sha + ".csv";
  expect(await store.database.write(bytes, sha, "text/csv")).toBe(reference);
  expect(await store.database.read(reference, sha, Buffer.byteLength(bytes))).toBe(bytes);
  expect(await readFile(join(directory, ".db-blobs", reference), "utf8")).toBe(bytes);
  expect(await (await openArtifactStore(directory)).database.read(reference, sha, Buffer.byteLength(bytes))).toBe(bytes);
  for (const bad of ["../" + reference, sha + ".txt", sha + ".CSV", sha + ".json.csv", "a".repeat(64) + ".csv"]) {
    await expect(store.database.read(bad, sha, Buffer.byteLength(bytes))).rejects.toThrow("artifact-reference-refused");
    await expect(store.database.remove(bad, sha)).rejects.toThrow("artifact-reference-refused");
  }
  // Runtime callers cannot choose an arbitrary extension through a media type.
  await expect(store.database.write(bytes, sha, "application/octet-stream" as "text/csv")).rejects.toThrow("artifact-reference-refused");
  expect((await readdir(join(directory, ".db-blobs"))).filter((name) => name.startsWith(".capture-"))).toEqual([]);
  await store.database.remove(reference, sha);
  await expect(store.database.read(reference, sha, Buffer.byteLength(bytes))).rejects.toMatchObject({ code: "ENOENT" });
});
it("refuses an insecure, symlinked or replaced database blob namespace", async () => {
  const directory = await root(); const outside = await root(); const database = join(directory, ".db-blobs");
  await symlink(outside, database);
  await expect(openArtifactStore(directory)).rejects.toThrow("artifact-root-refused");
  await rm(database); await mkdir(database, { mode: 0o755 });
  await expect(openArtifactStore(directory)).rejects.toThrow("artifact-root-refused");
  await chmod(database, 0o700); const store = await openArtifactStore(directory); const bytes = "[]"; const sha = digest(bytes);
  const ref = await store.database.write(bytes, sha);
  await rename(database, join(directory, ".original-db-blobs")); await mkdir(database, { mode: 0o700 });
  await expect(store.database.read(ref, sha, 2)).rejects.toThrow("artifact-root-refused");
  await expect(store.database.candidates(Date.now())).rejects.toThrow("artifact-root-refused");
  expect(await readFile(join(directory, ".original-db-blobs", ref), "utf8")).toBe(bytes);
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
  const legacy = JSON.parse(await store.read(reference.reference, reference.sha256, reference.byteSize)); legacy.formatVersion = 2;
  const legacyBytes = canonical(legacy); const legacySha = digest(legacyBytes); const legacyReference = await store.write(legacyBytes, legacySha);
  await expect(restoreRuns(store, { reference: legacyReference, sha256: legacySha, byteSize: Buffer.byteLength(legacyBytes) }))
    .rejects.toThrow("archive-refused");
  await expect(restoreRuns(store, { ...reference, reference: "../" + reference.reference })).rejects.toThrow("artifact-reference-refused");
  await expect(restoreRuns(store, { ...reference, byteSize: reference.byteSize + 1 })).rejects.toThrow("artifact-integrity-failed");
  const source = runs[0].dataset.artifacts[0]; const sourcePath = join(directory, source.sha256 + ".json");
  await writeFile(sourcePath, source.bytes.replace('"week":1', '"week":2'));
  await expect(restoreRuns(store, reference)).rejects.toThrow("artifact-integrity-failed");
  await rm(sourcePath); await expect(restoreRuns(store, reference)).rejects.toMatchObject({ code: "ENOENT" });
});
