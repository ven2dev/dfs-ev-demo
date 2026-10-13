import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { chmod, link, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { openArtifactStore } from "../../src/lib/predictive/artifacts.ts";
const roots: string[] = [];
const root = async () => { const directory = await realpath(await mkdtemp(join(tmpdir(), "dfs106-binary-artifacts-"))); roots.push(directory); return directory; };
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const wire = () => gzipSync(Buffer.from("id,yards\n00-0000001,-2\n", "utf8"));
afterEach(async () => { await Promise.all(roots.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

it("stores exact gzip wire bytes at immutable private addresses and preserves idempotent/concurrent publication", async () => {
  const directory = await root(), store = await openArtifactStore(directory), bytes = wire(), digest = sha(bytes), expected = digest + ".csv.gz";
  expect(await Promise.all(Array.from({ length: 8 }, () => store.database.writeBinary(bytes, digest)))).toEqual(Array(8).fill(expected));
  const path = join(directory, ".db-blobs", expected), inode = (await stat(path)).ino;
  expect(await readFile(path)).toEqual(bytes);
  expect(await store.database.readBinary(expected, digest, bytes.length)).toEqual(bytes);
  expect(await (await openArtifactStore(directory)).database.readBinary(expected, digest, bytes.length)).toEqual(bytes);
  await store.database.writeBinary(bytes, digest); expect((await stat(path)).ino).toBe(inode);
  expect((await stat(path)).mode & 0o077).toBe(0);
  expect((await readdir(join(directory, ".db-blobs"))).filter(name => name.startsWith(".capture-"))).toEqual([]);
});

it("pins mutable write inputs and returns independent read buffers without text decoding", async () => {
  const directory = await root(), store = await openArtifactStore(directory), bytes = wire(), original = Buffer.from(bytes), digest = sha(bytes);
  const pending = store.writeBinary(bytes, digest); bytes.fill(0);
  const ref = await pending;
  expect(await store.readBinary(ref, digest, original.length)).toEqual(original);
  const read = await store.readBinary(ref, digest, original.length); read.fill(0);
  expect(await store.readBinary(ref, digest, original.length)).toEqual(original);
  await expect(store.read(ref, digest, original.length)).rejects.toThrow("artifact-reference-refused");
  const textBytes = "\ufeffid,yards\nA,0\n";
  const textDigest = createHash("sha256").update(textBytes).digest("hex"), textRef = await store.write(textBytes, textDigest, "text/csv");
  expect(await store.read(textRef, textDigest, Buffer.byteLength(textBytes))).toBe(textBytes);
  await expect(store.readBinary(textRef, textDigest, Buffer.byteLength(textBytes))).rejects.toThrow("artifact-reference-refused");
});

it("refuses wrong suffixes, traversal, oversized bytes and digest/size mismatches", async () => {
  const store = await openArtifactStore(await root()), bytes = wire(), digest = sha(bytes), ref = await store.writeBinary(bytes, digest);
  for (const bad of ["../" + ref, digest + ".gz", digest + ".CSV.GZ", digest + ".json.csv.gz", "0".repeat(64) + ".csv.gz"]) {
    await expect(store.readBinary(bad, digest, bytes.length)).rejects.toThrow("artifact-reference-refused");
    await expect(store.remove(bad, digest)).rejects.toThrow("artifact-reference-refused");
  }
  await expect(store.readBinary(ref, digest, bytes.length + 1)).rejects.toThrow("artifact-integrity-failed");
  await expect(store.writeBinary(bytes, "0".repeat(64))).rejects.toThrow("artifact-integrity-failed");
  await expect(store.writeBinary(Buffer.alloc(1_000_001), sha(Buffer.alloc(1_000_001)))).rejects.toThrow("artifact-integrity-failed");
});

it("never replaces tampered wire bytes and refuses insecure files, hard links and symlinks", async () => {
  const directory = await root(), outside = await root(), store = await openArtifactStore(directory), bytes = wire(), digest = sha(bytes);
  const ref = await store.database.writeBinary(bytes, digest), path = join(directory, ".db-blobs", ref), altered = Buffer.from(bytes); altered[12] ^= 1;
  await writeFile(path, altered);
  await expect(store.database.readBinary(ref, digest, bytes.length)).rejects.toThrow("artifact-integrity-failed");
  await expect(store.database.writeBinary(bytes, digest)).rejects.toThrow("artifact-integrity-failed");
  expect(await readFile(path)).toEqual(altered);
  await writeFile(path, bytes); await chmod(path, 0o644);
  await expect(store.database.readBinary(ref, digest, bytes.length)).rejects.toThrow("artifact-file-refused");
  await chmod(path, 0o600); const alias = join(directory, "link"); await link(path, alias);
  await expect(store.database.readBinary(ref, digest, bytes.length)).rejects.toThrow("artifact-file-refused"); await rm(alias);
  const target = join(outside, "wire"); await writeFile(target, bytes, { mode: 0o600 }); await rm(path); await symlink(target, path);
  await expect(store.database.readBinary(ref, digest, bytes.length)).rejects.toThrow();
  expect(await readFile(target)).toEqual(bytes);
});

it("removes only the exact gzip address and handles missing final files idempotently", async () => {
  const directory = await root(), store = await openArtifactStore(directory), bytes = Buffer.from("123\n"), digest = sha(bytes);
  // The byte store is not a gzip validator; diagnostics still retain exact bytes.
  const gzip = await store.database.writeBinary(bytes, digest), json = await store.database.write("123\n", digest);
  await store.database.remove(gzip, digest);
  await expect(store.database.readBinary(gzip, digest, bytes.length)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await store.database.read(json, digest, bytes.length)).toBe("123\n");
  await store.database.remove(gzip, digest); expect(await readFile(join(directory, ".db-blobs", json), "utf8")).toBe("123\n");
});

it("discovers gzip orphans and temporary files only in the SQL-owned namespace, with age and exact-reference checks", async () => {
  const directory = await root(), store = await openArtifactStore(directory), bytes = wire(), digest = sha(bytes);
  const archive = await store.writeBinary(bytes, digest), orphan = await store.database.writeBinary(bytes, digest);
  const blobRoot = join(directory, ".db-blobs"), old = new Date(0);
  await utimes(join(blobRoot, orphan), old, old);
  const temporary = ".capture-" + digest + "-12345678-1234-1234-1234-123456789abc.tmp";
  await writeFile(join(blobRoot, temporary), bytes, { mode: 0o600 }); await utimes(join(blobRoot, temporary), old, old);
  const recentBytes = Buffer.from("recent"), recent = await store.database.writeBinary(recentBytes, sha(recentBytes));
  await utimes(join(blobRoot, recent), new Date("2100-01-01"), new Date("2100-01-01"));
  const candidates = await store.database.candidates(Date.now());
  expect(candidates).toEqual([{ reference: temporary, sha256: digest, kind: "temporary" }, { reference: orphan, sha256: digest, kind: "final" }]);
  await expect(store.database.removeOrphan({ ...candidates[1], reference: digest + ".gz" }, Date.now())).rejects.toThrow("artifact-reference-refused");
  expect(await store.database.removeOrphan(candidates[1], Date.now())).toBe(true);
  expect(await store.database.removeOrphan(candidates[1], Date.now())).toBe(false);
  expect(await store.database.removeOrphan(candidates[0], Date.now())).toBe(true);
  expect(await store.readBinary(archive, digest, bytes.length)).toEqual(bytes);
  expect(await store.database.readBinary(recent, sha(recentBytes), recentBytes.length)).toEqual(recentBytes);
});

it("refuses binary access after root/namespace replacement or registration changes", async () => {
  const directory = await root(), store = await openArtifactStore(directory), bytes = wire(), digest = sha(bytes), ref = await store.database.writeBinary(bytes, digest);
  await rename(join(directory, ".db-blobs"), join(directory, "original"));
  await openArtifactStore(directory);
  await expect(store.database.readBinary(ref, digest, bytes.length)).rejects.toThrow("artifact-root-refused");
  await expect(store.database.writeBinary(bytes, digest)).rejects.toThrow("artifact-root-refused");
  expect(await readFile(join(directory, "original", ref))).toEqual(bytes);
  const newStore = await openArtifactStore(directory); await writeFile(join(directory, ".predictive-artifacts.json"), "{}");
  await expect(newStore.writeBinary(bytes, digest)).rejects.toThrow("artifact-root-refused");
});
