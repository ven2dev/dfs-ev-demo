import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { openTransferFixture } from "../../scripts/feature-store/transfer-fixture.ts";
import { downloadSource, INGEST_LIMITS } from "../../src/featureStore/source.ts";
import { downloadPinnedWire, type TransferPolicy } from "../../src/featureStore/sourceTransfer.ts";
import { openLocalObjectStore } from "../../src/featureStore/localObjectStore.ts";
import { objectKey, type ObjectStore } from "../../src/featureStore/objectStore.ts";
import { normalizeSource } from "../../src/featureStore/normalize.ts";
import { sourceFixture } from "./fixtures.ts";

const signal = () => AbortSignal.timeout(5_000);
const withStore = async (run: (store: ObjectStore) => Promise<void>) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dfs251-unit-")));
  try { await run(await openLocalObjectStore(root)); }
  finally { await rm(root, { recursive: true, force: true }); }
};

describe("#251 production host boundary", () => {
  it.each(["http://127.0.0.1:43210/fixture/0", "https://127.0.0.1/fixture/0",
    "http://localhost:43210/fixture/0", "http://[::1]:43210/fixture/0"])("refuses %s before dispatch", async url => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(downloadSource({ ...sourceFixture().asset, url }, signal(), INGEST_LIMITS, fetcher)).rejects.toThrow("ingest-url-refused");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("refuses a production redirect to loopback before dispatching it", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null,
      { status: 302, headers: { location: "http://127.0.0.1:43210/fixture/0" } }));
    await expect(downloadSource(sourceFixture().asset, signal(), INGEST_LIMITS, fetcher)).rejects.toThrow("ingest-url-refused");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe(sourceFixture().asset.url);
  });

  it("keeps the existing GitHub-to-release-assets route and exact receipt", async () => {
    const fixture = sourceFixture();
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "https://release-assets.githubusercontent.com/fixture?token=synthetic" } }))
      .mockResolvedValueOnce(new Response(fixture.bytes, { headers: { "content-length": String(fixture.bytes.length) } }));
    const result = await downloadSource(fixture.asset, signal(), INGEST_LIMITS, fetcher);
    expect(result.bytes).toEqual(fixture.bytes);
    expect(result.requests).toBe(2);
    expect(Object.keys(result).sort()).toEqual(["bytes", "capturedAt", "requests"]);
  });
});

describe("#251 exact fixture capability", () => {
  const origin = "http://127.0.0.1:43210", pathname = "/fixture/0";
  const policy: TransferPolicy = { kind: "fixture", origin, pathname };

  it.each(["http://127.0.0.1:43211/fixture/0", "http://localhost:43210/fixture/0",
    origin + "/fixture/1", origin + pathname + "?extra=1", origin + pathname + "#fragment",
    "http://user:pass@127.0.0.1:43210/fixture/0"])("refuses unmapped URL %s before dispatch", async url => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(downloadPinnedWire(url, 1, signal(), 64, fetcher, policy)).rejects.toThrow("ingest-url-refused");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(["http://127.0.0.1:43211/fixture/0", "https://github.com/fixture", "/fixture/1"])("refuses redirect escape %s", async location => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 302, headers: { location } }));
    await expect(downloadPinnedWire(origin + pathname, 1, signal(), 64, fetcher, policy)).rejects.toThrow("ingest-url-refused");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects a wildcard fixture origin", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(downloadPinnedWire("http://0.0.0.0:43210/fixture/0", 1, signal(), 64, fetcher,
      { kind: "fixture", origin: "http://0.0.0.0:43210", pathname })).rejects.toThrow("ingest-url-refused");
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("#251 ObjectStore fixture server", () => {
  it("requires explicit test enabling and unique raw mappings", async () => withStore(async store => {
    const fixture = sourceFixture(), mapping = { asset: fixture.asset, key: objectKey("raw", fixture.bytes) };
    await expect(openTransferFixture(store, [mapping], undefined as never)).rejects.toThrow("fixture-loopback-setting-required");
    await expect(openTransferFixture(store, [mapping, mapping], { testOnlyLoopback: true })).rejects.toThrow("fixture-mapping-refused");
    await expect(openTransferFixture(store, [{ ...mapping, key: objectKey("models", fixture.bytes) }],
      { testOnlyLoopback: true })).rejects.toThrow("fixture-mapping-refused");
  }));

  it("serves a real bounded download without changing source pins or provenance", async () => withStore(async store => {
    const fixture = sourceFixture(undefined, { gzip: true }), key = objectKey("raw", fixture.bytes);
    await store.putIfAbsent(key, fixture.bytes);
    const get = vi.fn(store.get);
    const input = JSON.stringify(fixture.asset);
    Object.freeze(fixture.asset);
    const server = await openTransferFixture({ ...store, get }, [{ asset: fixture.asset, key }], { testOnlyLoopback: true });
    try {
      expect(server.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const result = await server.download(fixture.asset, signal(), INGEST_LIMITS);
      expect(result.requests).toBe(1);
      expect(result.bytes).toEqual(fixture.bytes);
      expect(get).toHaveBeenCalledExactlyOnceWith(key);
      expect((await normalizeSource(result.bytes, fixture.asset, signal())).rows).toHaveLength(1);
      expect(JSON.stringify(fixture.asset)).toBe(input);
      await expect(server.download({ ...fixture.asset, url: fixture.asset.url + "-unknown" }, signal())).rejects.toThrow("fixture-asset-refused");
    } finally { await server.close(); }
    expect(await store.get(key)).toEqual(fixture.bytes);
    await server.close();
    await expect(server.download(fixture.asset, signal())).rejects.toThrow("fixture-server-closed");
  }));

  it("refuses unregistered paths, methods and hosts without reading ObjectStore", async () => withStore(async store => {
    const fixture = sourceFixture(), get = vi.fn(store.get);
    const server = await openTransferFixture({ ...store, get }, [{ asset: fixture.asset, key: objectKey("raw", fixture.bytes) }],
      { testOnlyLoopback: true });
    try {
      expect((await fetch(server.origin + "/unknown")).status).toBe(404);
      expect((await fetch(server.origin + "/fixture/0?extra=1")).status).toBe(404);
      expect((await fetch(server.origin + "/fixture/0", { method: "POST" })).status).toBe(405);
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const req = request(server.origin + "/fixture/0", { headers: { host: "other.invalid" } }, response => {
          response.resume(); response.once("end", () => resolve(response.statusCode));
        });
        req.on("error", reject); req.end();
      });
      expect(status).toBe(403);
      expect(get).not.toHaveBeenCalled();
    } finally { await server.close(); }
  }));

  it("closes active sockets while an ObjectStore read is pending", async () => withStore(async store => {
    const fixture = sourceFixture();
    let readStarted!: () => void, finishRead!: (bytes: Buffer) => void;
    const started = new Promise<void>(resolve => { readStarted = resolve; });
    const body = new Promise<Buffer>(resolve => { finishRead = resolve; });
    const server = await openTransferFixture({ ...store, get: async () => { readStarted(); return body; } },
      [{ asset: fixture.asset, key: objectKey("raw", fixture.bytes) }], { testOnlyLoopback: true });
    const outcome = server.download(fixture.asset, signal()).then(() => "unexpected-success", () => "refused");
    try {
      await started;
      await server.close();
      expect(await outcome).toBe("refused");
    } finally { finishRead(fixture.bytes); await server.close(); }
  }));
});
