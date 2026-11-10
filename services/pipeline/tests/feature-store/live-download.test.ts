import { afterEach, describe, expect, it, vi } from "vitest";
import { observeLiveDownload } from "../../scripts/feature-store/live-download.ts";
import { downloadSource, INGEST_LIMITS } from "../../src/featureStore/source.ts";
import { sha256 } from "../../src/featureStore/objectStore.ts";
import { sourceFixture } from "./fixtures.ts";

afterEach(() => vi.restoreAllMocks());
const fixture = () => sourceFixture();
const reply = (bytes: Buffer, length: number | null = bytes.length) => new Response(Uint8Array.from(bytes),
  { headers: length === null ? {} : { "content-length": String(length) } });

describe("#251 live transfer observations", () => {
  it("hashes the full redirected body, records changed bytes and omits signed URLs and body bytes", async () => {
    const source = fixture(), changed = Buffer.from("different live wire bytes");
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 302,
        headers: { location: "https://release-assets.githubusercontent.com/asset?signature=private-token" } }))
      .mockResolvedValueOnce(reply(changed));
    const original = JSON.stringify(source.asset);
    Object.freeze(source.asset);
    const result = await observeLiveDownload(source.asset, { fetcher });
    expect(result.status).toBe("completed");
    expect(result.observed).toEqual({ wireBytes: changed.length, sha256: sha256(changed) });
    expect(result.changed).toEqual({ wireBytes: true, sha256: true, providerDigest: true });
    expect(result.expected).toEqual({ wire_bytes: source.bytes.length, sha256: source.asset.sha256, provider_digest: source.asset.provider_digest });
    expect(result.requests).toEqual([
      { host: "github.com", status: 302, contentLength: null },
      { host: "release-assets.githubusercontent.com", status: 200, contentLength: changed.length },
    ]);
    expect(result.redirects).toBe(1);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(result)).not.toMatch(/private-token|signature|different live wire bytes|"bytes"/);
    expect(JSON.stringify(source.asset)).toBe(original);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0][1]).toMatchObject({ redirect: "manual", headers: { "Accept-Encoding": "identity" } });
  });

  it.each([true, false])("records unchanged bytes with Content-Length present=%s", async hasLength => {
    const source = fixture(), fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(source.bytes, hasLength ? source.bytes.length : null));
    const result = await observeLiveDownload(source.asset, { fetcher });
    expect(result.status).toBe("completed");
    expect(result.observed).toEqual({ wireBytes: source.bytes.length, sha256: source.asset.sha256 });
    expect(result.changed).toEqual({ wireBytes: false, sha256: false, providerDigest: false });
    expect(result.error).toBeNull();
  });

  it("detects same-size content drift and leaves absent expected hashes unknown", async () => {
    const source = fixture(), changed = Buffer.from(source.bytes); changed[0] ^= 1;
    const result = await observeLiveDownload({ ...source.asset, provider_digest: null },
      { fetcher: vi.fn<typeof fetch>().mockResolvedValue(reply(changed)) });
    expect(result.changed).toEqual({ wireBytes: false, sha256: true, providerDigest: null });
    const noHash = await observeLiveDownload({ ...source.asset, sha256: null, provider_digest: null },
      { fetcher: vi.fn<typeof fetch>().mockResolvedValue(reply(changed)) });
    expect(noHash.changed).toEqual({ wireBytes: false, sha256: null, providerDigest: null });
  });

  it("counts all streamed chunks and keeps no source body in the receipt", async () => {
    const source = fixture();
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(source.bytes.subarray(0, 5)); controller.enqueue(source.bytes.subarray(5)); controller.close();
    } });
    const result = await observeLiveDownload(source.asset, { fetcher: vi.fn<typeof fetch>().mockResolvedValue(new Response(stream)) });
    expect(result.observed).toEqual({ wireBytes: source.bytes.length, sha256: source.asset.sha256 });
    expect(Object.keys(result.observed).sort()).toEqual(["sha256", "wireBytes"]);
    expect(JSON.stringify(result)).not.toContain(source.bytes.toString());
  });

  it("measures through the complete body and hash rather than stopping at headers", async () => {
    const source = fixture(); let clock = 10;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    let readerStarted!: () => void, controller!: ReadableStreamDefaultController<Uint8Array>;
    const reading = new Promise<void>(resolve => { readerStarted = resolve; });
    const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; }, pull() { readerStarted(); } });
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => { clock = 20; return new Response(body); });
    const outcome = observeLiveDownload(source.asset, { fetcher });
    await reading;
    clock = 123; controller.enqueue(source.bytes); controller.close();
    const result = await outcome;
    expect(result.status).toBe("completed"); expect(result.elapsedMs).toBe(113);
    expect(result.observed.sha256).toBe(source.asset.sha256);
  });
});

describe("#251 incomplete/protocol transfers stay failed without retry", () => {
  it.each(["-1", "1.2", "invalid", "9007199254740992"])("refuses malformed Content-Length %s", async length => {
    const cancel = vi.fn();
    const body = new ReadableStream({ cancel });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { headers: { "content-length": length } }));
    const result = await observeLiveDownload(fixture().asset, { fetcher });
    expect(result.error?.code).toBe("ingest-wire-metadata-refused");
    expect(result.status).toBe("failed"); expect(result.observed.sha256).toBeNull();
    expect(cancel).toHaveBeenCalledOnce(); expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([1, 8])("refuses declared/body mismatch for length %s", async length => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(Buffer.from("four"), length));
    const result = await observeLiveDownload(fixture().asset, { fetcher });
    expect(result.status).toBe("failed"); expect(result.error?.code).toBe("ingest-wire-size-mismatch");
    expect(result.observed).toEqual({ wireBytes: 4, sha256: null }); expect(result.changed).toBeNull();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each(["gzip", "br"])("refuses transparent encoding %s", async encoding => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("body", { headers: { "content-encoding": encoding } }));
    const result = await observeLiveDownload(fixture().asset, { fetcher });
    expect(result.error?.code).toBe("ingest-wire-metadata-refused"); expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([403, 404, 429, 500])("keeps HTTP %s as a failure", async status => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("error", { status }));
    const result = await observeLiveDownload(fixture().asset, { fetcher });
    expect(result.error?.code).toBe("ingest-http-refused"); expect(result.requests[0].status).toBe(status);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("refuses a missing response body", async () => {
    const result = await observeLiveDownload(fixture().asset,
      { fetcher: vi.fn<typeof fetch>().mockResolvedValue(new Response(null)) });
    expect(result.error?.code).toBe("ingest-http-refused");
  });

  it("stops on the fourth redirect without following or retrying it", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null,
      { status: 302, headers: { location: "https://github.com/nflverse/nflverse-data/releases/download/test/next" } }));
    const result = await observeLiveDownload(fixture().asset, { fetcher });
    expect(result.error?.code).toBe("ingest-redirect-refused");
    expect(result.requests).toHaveLength(4); expect(result.redirects).toBe(4); expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it.each(["http://127.0.0.1:43210/file", "https://other.invalid/file"])("refuses redirect %s before dispatching it", async location => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 302, headers: { location } }));
    const result = await observeLiveDownload(fixture().asset, { fetcher });
    expect(result.error?.code).toBe("ingest-url-refused"); expect(fetcher).toHaveBeenCalledOnce();
    expect(result.requests).toHaveLength(1);
  });

  it("does not enable loopback in the live observer", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const result = await observeLiveDownload({ ...fixture().asset, url: "http://127.0.0.1:43210/file" }, { fetcher });
    expect(result.error?.code).toBe("ingest-url-refused"); expect(fetcher).not.toHaveBeenCalled();
  });

  it("bounds observed size by the wire cap, not by the original pin", async () => {
    const source = fixture(), cap = source.bytes.length + 1;
    const atCap = Buffer.alloc(cap);
    const result = await observeLiveDownload(source.asset, { limits: { ...INGEST_LIMITS, wireBytes: cap },
      fetcher: vi.fn<typeof fetch>().mockResolvedValue(reply(atCap)) });
    expect(result.status).toBe("completed"); expect(result.observed.wireBytes).toBe(cap);
    const oversized = await observeLiveDownload(source.asset, { limits: { ...INGEST_LIMITS, wireBytes: cap },
      fetcher: vi.fn<typeof fetch>().mockResolvedValue(reply(Buffer.alloc(cap + 1))) });
    expect(oversized.error?.code).toBe("ingest-wire-budget-exceeded"); expect(oversized.observed.wireBytes).toBe(0);
    const streamed = await observeLiveDownload(source.asset, { limits: { ...INGEST_LIMITS, wireBytes: cap },
      fetcher: vi.fn<typeof fetch>().mockResolvedValue(reply(Buffer.alloc(cap + 1), null)) });
    expect(streamed.error?.code).toBe("ingest-wire-budget-exceeded"); expect(streamed.observed.sha256).toBeNull();
  });

  it("refuses a limit increase before dispatch", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const result = await observeLiveDownload(fixture().asset, { fetcher, limits: { ...INGEST_LIMITS, deadlineMs: 60_001 } });
    expect(result.error?.code).toBe("ingest-limits-refused"); expect(fetcher).not.toHaveBeenCalled();
  });

  it("redacts transport errors and retains partial progress without a complete hash", async () => {
    const source = fixture(); let pulls = 0;
    const body = new ReadableStream<Uint8Array>({ pull(controller) {
      if (pulls++ === 0) controller.enqueue(source.bytes.subarray(0, 5));
      else controller.error(new Error("private-token https://release-assets.githubusercontent.com/file?secret=token"));
    } });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
    const result = await observeLiveDownload(source.asset, { fetcher });
    expect(result.status).toBe("failed"); expect(result.observed).toEqual({ wireBytes: 5, sha256: null });
    expect(result.error).toEqual({ code: "ingest-transport-failed", censored: true });
    expect(JSON.stringify(result)).not.toMatch(/private-token|secret/); expect(fetcher).toHaveBeenCalledOnce();
  });

  it("records a connection error with one attempted request and no retry", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("private network failure"));
    const result = await observeLiveDownload(fixture().asset, { fetcher });
    expect(result.requests).toEqual([{ host: "github.com", status: null, contentLength: null }]);
    expect(result.error?.code).toBe("ingest-transport-failed"); expect(fetcher).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain("private network failure");
  });
});

describe("#251 cancellation and strict production behavior", () => {
  it("honors an already aborted caller before dispatch", async () => {
    const caller = new AbortController(); caller.abort();
    const fetcher = vi.fn<typeof fetch>();
    const result = await observeLiveDownload(fixture().asset, { signal: caller.signal, fetcher });
    expect(result.error?.code).toBe("ingest-transfer-aborted"); expect(fetcher).not.toHaveBeenCalled();
  });

  it("cancels a pending body read on caller abort and leaves it incomplete", async () => {
    const caller = new AbortController(), cancel = vi.fn();
    let reading!: () => void;
    const started = new Promise<void>(resolve => { reading = resolve; });
    const body = new ReadableStream<Uint8Array>({ pull() { reading(); }, cancel });
    const resultPromise = observeLiveDownload(fixture().asset, { signal: caller.signal,
      fetcher: vi.fn<typeof fetch>().mockResolvedValue(new Response(body)) });
    await started; caller.abort();
    const result = await resultPromise;
    expect(result.error?.code).toBe("ingest-transfer-aborted"); expect(result.observed.sha256).toBeNull();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("applies its default 60 s deadline even without a caller signal", async () => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    let reading!: () => void;
    const started = new Promise<void>(resolve => { reading = resolve; });
    const body = new ReadableStream<Uint8Array>({ pull() { reading(); } });
    const resultPromise = observeLiveDownload(fixture().asset,
      { fetcher: vi.fn<typeof fetch>().mockResolvedValue(new Response(body)) });
    await started; deadline.abort(new DOMException("synthetic expiry", "TimeoutError"));
    expect((await resultPromise).error?.code).toBe("ingest-deadline-exceeded");
    expect(timeout).toHaveBeenCalledExactlyOnceWith(60_000);
  });

  it("allows lower explicit limits without extending the deadline", async () => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const source = fixture();
    const result = await observeLiveDownload(source.asset, { limits: { ...INGEST_LIMITS, deadlineMs: 300 },
      fetcher: vi.fn<typeof fetch>().mockResolvedValue(reply(source.bytes)) });
    expect(result.status).toBe("completed"); expect(timeout).toHaveBeenCalledExactlyOnceWith(300);
  });

  it("keeps strict production wire-size refusal when observation accepts drift", async () => {
    const source = fixture(), bytes = Buffer.from("changed");
    const observed = await observeLiveDownload(source.asset,
      { fetcher: vi.fn<typeof fetch>().mockResolvedValue(reply(bytes)) });
    expect(observed.status).toBe("completed");
    await expect(downloadSource(source.asset, AbortSignal.timeout(5_000), INGEST_LIMITS,
      vi.fn<typeof fetch>().mockResolvedValue(reply(bytes)))).rejects.toThrow("ingest-wire-metadata-refused");
  });

  it("keeps cancellation during the connection/headers phase as a failed attempt", async () => {
    const caller = new AbortController();
    let dispatched!: () => void;
    const started = new Promise<void>(resolve => { dispatched = resolve; });
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
      dispatched();
    }));
    const resultPromise = observeLiveDownload(fixture().asset, { fetcher, signal: caller.signal });
    await started; caller.abort();
    const result = await resultPromise;
    expect(result.error?.code).toBe("ingest-transfer-aborted");
    expect(result.requests).toEqual([{ host: "github.com", status: null, contentLength: null }]);
    expect(result.observed).toEqual({ wireBytes: 0, sha256: null }); expect(fetcher).toHaveBeenCalledOnce();
  });
});
