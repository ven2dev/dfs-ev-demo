import { mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openLocalObjectStore } from "../../src/featureStore/localObjectStore.ts";
import { objectKey, parseObjectKey } from "../../src/featureStore/objectStore.ts";

const roots: string[] = [];
const fixture = async (maxObjectBytes?: number) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dfs138-objects-")));
  roots.push(root);
  return { root, store: await openLocalObjectStore(root, { maxObjectBytes }) };
};
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("#138 local ObjectStore", () => {
  it("preserves binary wire bytes, metadata, namespace listing and idempotent deletion", async () => {
    const { store } = await fixture();
    const bytes = Buffer.from([0x1f, 0x8b, 0x00, 0xff, 0x80, 0x0a]);
    const key = objectKey("raw", bytes);
    const written = await store.putIfAbsent(key, bytes);
    expect(written).toEqual({ created: true, object: { key, sha256: key.slice(4), byteSize: 6 } });
    expect(await store.get(key)).toEqual(bytes);
    expect(await store.head(key)).toEqual(written.object);
    expect(await store.list("raw")).toEqual([written.object]);
    expect(await store.list("datasets")).toEqual([]);
    await store.delete(key);
    await store.delete(key);
    expect(await store.head(key)).toBeNull();
    expect(await store.list("raw")).toEqual([]);
    await expect(store.get(key)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("has exactly one winner for concurrent create-once writes and survives reopening", async () => {
    const { root, store } = await fixture();
    const other = await openLocalObjectStore(root);
    const bytes = Buffer.from("same snapshot\n");
    const key = objectKey("raw", bytes);
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? store : other).putIfAbsent(key, bytes)));
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(await (await openLocalObjectStore(root)).get(key)).toEqual(bytes);
    expect(await readdir(join(root, "raw"))).toEqual([key.slice(4)]);
  });

  it("rejects a wrong digest and preserves a corrupt existing address instead of repairing it", async () => {
    const { root, store } = await fixture();
    const bytes = Buffer.from("good");
    const key = objectKey("raw", bytes);
    await expect(store.putIfAbsent(key, Buffer.from("wrong"))).rejects.toThrow("object-digest-mismatch");
    expect(await store.list("raw")).toEqual([]);
    await writeFile(join(root, key), "bad!", { mode: 0o600 });
    await expect(store.putIfAbsent(key, bytes)).rejects.toThrow("object-existing-integrity-failed");
    expect(await readFile(join(root, key), "utf8")).toBe("bad!");
    expect(await readdir(join(root, "raw"))).toEqual([key.slice(4)]);
  });

  it("bounds reads and writes before returning oversized data, including empty objects", async () => {
    const { root, store } = await fixture(4);
    const big = Buffer.from("12345");
    const key = objectKey("raw", big);
    await expect(store.putIfAbsent(key, big)).rejects.toThrow("object-size-refused");
    await writeFile(join(root, key), big, { mode: 0o600 });
    await expect(store.get(key)).rejects.toThrow("object-file-refused");
    const empty = objectKey("datasets", Buffer.alloc(0));
    await store.putIfAbsent(empty, Buffer.alloc(0));
    expect(await store.get(empty)).toEqual(Buffer.alloc(0));
  });

  it("rejects traversal, alternate suffixes and symlinks without touching their targets", async () => {
    const { root, store } = await fixture();
    const bytes = Buffer.from("outside");
    const key = objectKey("raw", bytes);
    for (const bad of ["../outside", `/raw/${"a".repeat(64)}`, key + ".csv", key.toUpperCase()]) {
      expect(() => parseObjectKey(bad)).toThrow("object-key-refused");
      await expect(store.delete(bad)).rejects.toThrow("object-key-refused");
    }
    const target = join(root, "outside");
    await writeFile(target, bytes, { mode: 0o600 });
    await symlink(target, join(root, key));
    await expect(store.get(key)).rejects.toThrow();
    await expect(store.putIfAbsent(key, bytes)).rejects.toThrow();
    await store.delete(key);
    expect(await readFile(target)).toEqual(bytes);
  });

  it("refuses a namespace replaced with a symlink and excludes unfinished writes from listing", async () => {
    const { root, store } = await fixture();
    await writeFile(join(root, "raw", ".put-crashed.tmp"), "partial", { mode: 0o600 });
    expect(await store.list("raw")).toEqual([]);
    await rm(join(root, "models"), { recursive: true });
    await symlink(join(root, "raw"), join(root, "models"));
    await expect(store.head(objectKey("models", Buffer.alloc(0)))).rejects.toThrow("object-root-refused");
  });

  it("copies input before asynchronous work so mutation cannot change published bytes", async () => {
    const { store } = await fixture();
    const bytes = Buffer.from("original");
    const key = objectKey("raw", bytes);
    const pending = store.putIfAbsent(key, bytes);
    bytes.fill(0);
    await pending;
    expect(await store.get(key)).toEqual(Buffer.from("original"));
  });
});
