import { expect } from "vitest";
import { objectKey, type ObjectStore } from "../../src/featureStore/objectStore.ts";

export const checkObjectStore = async (store: ObjectStore, payloads: Buffer[]) => {
  const keys = payloads.map((bytes) => objectKey("raw", bytes));
  const written = await store.putIfAbsent(keys[0], payloads[0]);
  expect(written).toEqual({
    created: true, object: { key: keys[0], sha256: keys[0].slice(4), byteSize: payloads[0].length },
  });
  expect(await store.putIfAbsent(keys[0], payloads[0])).toEqual({ ...written, created: false });
  expect(await store.get(keys[0])).toEqual(payloads[0]);
  expect(await store.head(keys[0])).toEqual(written.object);
  const verified = await store.getVerified(keys[0], payloads[0].length);
  expect(verified.wireSha256).toBe(written.object.sha256);
  expect(verified.byteSize).toBe(written.object.byteSize);
  await expect(store.getVerified(keys[0], payloads[0].length - 1)).rejects.toThrow("object-size-refused");
  for (const [index, bytes] of payloads.entries()) {
    if (index > 0) expect((await store.putIfAbsent(keys[index], bytes)).created).toBe(true);
  }
  expect((await store.list("raw")).map(({ key }) => key).sort()).toEqual([...keys].sort());
  expect(await store.list("datasets")).toEqual([]);
  const sorted = [...keys].sort();
  const firstPage = await store.listPage("raw", { limit: 2 });
  expect(firstPage.entries.map(({ key }) => key)).toEqual(sorted.slice(0, 2));
  expect(firstPage.nextStartAfter).toBe(sorted.length > 2 ? sorted[1] : null);
  if (firstPage.nextStartAfter) {
    const lastPage = await store.listPage("raw", { limit: 1, startAfter: firstPage.nextStartAfter });
    expect(lastPage.entries.map(({ key }) => key)).toEqual(sorted.slice(2));
    expect(lastPage.nextStartAfter).toBeNull();
  }
  await expect(store.listPage("datasets", { limit: 1, startAfter: sorted[0] })).rejects.toThrow("object-page-request-refused");
  expect(await store.listPage("raw", { limit: 1, startAfter: sorted.at(-1)! })).toEqual({
    entries: [], nextStartAfter: null,
  });
  for (const key of keys) await store.delete(key);
  await store.delete(keys[0]);
  expect(await store.head(keys[0])).toBeNull();
  expect(await store.list("raw")).toEqual([]);
  await expect(store.get(keys[0])).rejects.toMatchObject({ code: "ENOENT" });
};
