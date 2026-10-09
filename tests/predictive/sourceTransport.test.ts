import { afterEach, expect, it, vi } from "vitest";
import { createSourceTransport, SOURCE_LIMITS, validateSourceLimits } from "../../src/lib/predictive/sourceTransport.ts";

const endpoint = "https://github.com/nflverse/nflverse-data/releases/download/schedules/games.csv";
afterEach(() => vi.useRealTimers());
it("timestamps availability only after consuming the exact response and counts redirects as requests", async () => {
  let time = 0; let call = 0;
  const fetcher = vi.fn(async () => ++call === 1 ? new Response(null, { status: 302, headers: { location: "https://release-assets.githubusercontent.com/test?signature=value" } }) :
    new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("a")); time = 9; controller.enqueue(new TextEncoder().encode("é")); controller.close(); } }), { headers: { "content-length": "3" } }));
  const transport = createSourceTransport(SOURCE_LIMITS, { fetch: fetcher, now: () => time, instant: () => new Date(time).toISOString() });
  expect(await transport.get(endpoint)).toMatchObject({ bytes: "aé", byteSize: 3, capturedAt: "1970-01-01T00:00:00.009Z" });
  expect(transport.metrics()).toMatchObject({ requests: 2, responseBytesRead: 3, elapsedMs: 9 });
});
it("sends bounded range requests with manual redirects, identity encoding and no credentials", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response("abc", { status: 206, headers: { "content-range": "bytes 0-2/99" } }));
  const transport = createSourceTransport(SOURCE_LIMITS, { fetch: fetcher });
  await transport.get(endpoint, { maxBytes: 3, range: true });
  const options = fetcher.mock.calls[0][1]!;
  expect(options.redirect).toBe("manual"); expect(options.headers).toMatchObject({ Range: "bytes=0-2", "Accept-Encoding": "identity" });
  expect(options.headers).not.toHaveProperty("Authorization");
});
it.each(["http://github.com/nflverse/nflverse-data/releases/download/a/b", "https://evil.test/nflverse/nflverse-data/releases/download/a/b",
  "https://user:pass@github.com/nflverse/nflverse-data/releases/download/a/b", endpoint + "?secret=1", endpoint + "#fragment"])("refuses unregistered origin %s before fetching", async (url) => {
  const fetcher = vi.fn<typeof fetch>();
  await expect(createSourceTransport(SOURCE_LIMITS, { fetch: fetcher }).get(url)).rejects.toThrow("source-url-refused"); expect(fetcher).not.toHaveBeenCalled();
});
it("refuses redirects to unapproved hosts and redirect loops", async () => {
  const evil = vi.fn<typeof fetch>(async () => new Response(null, { status: 302, headers: { location: "https://evil.test/file" } }));
  await expect(createSourceTransport(SOURCE_LIMITS, { fetch: evil }).get(endpoint)).rejects.toThrow("source-url-refused"); expect(evil).toHaveBeenCalledTimes(1);
  const loop = vi.fn<typeof fetch>(async () => new Response(null, { status: 302, headers: { location: endpoint } }));
  await expect(createSourceTransport(SOURCE_LIMITS, { fetch: loop }).get(endpoint)).rejects.toThrow("source-redirect-refused"); expect(loop).toHaveBeenCalledTimes(4);
});
it.each([408, 429, 500, 502, 503, 504])("retries transient HTTP %s with Retry-After and counted request budgets", async (status) => {
  let time = 0; let call = 0; const waits: number[] = [];
  const fetcher = vi.fn<typeof fetch>(async () => ++call === 1 ? new Response(null, { status, headers: { "retry-after": "2" } }) : new Response("ok"));
  const transport = createSourceTransport(SOURCE_LIMITS, { fetch: fetcher, now: () => time, sleep: async (ms) => { waits.push(ms); time += ms; } });
  expect((await transport.get(endpoint)).bytes).toBe("ok"); expect(waits).toEqual([2000]); expect(transport.metrics().requests).toBe(2);
});
it("handles Retry-After dates, network jitter and exhaustion deterministically", async () => {
  let time = 0; const waits: number[] = []; let call = 0;
  const transport = createSourceTransport(SOURCE_LIMITS, { now: () => time, instant: () => "2026-10-09T12:00:00.000Z", random: () => 0.5,
    sleep: async (ms) => { waits.push(ms); time += ms; }, fetch: async () => {
      if (++call === 1) return new Response(null, { status: 429, headers: { "retry-after": "Fri, 09 Oct 2026 12:00:03 GMT" } });
      throw new TypeError("network unavailable");
    } });
  await expect(transport.get(endpoint)).rejects.toThrow("source-attempts-exhausted"); expect(waits).toEqual([3000, 625]); expect(call).toBe(3);
});
it.each([403, 404])( "does not retry permanent HTTP %s", async (status) => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status }));
  await expect(createSourceTransport(SOURCE_LIMITS, { fetch: fetcher }).get(endpoint)).rejects.toThrow("source-http-refused"); expect(fetcher).toHaveBeenCalledTimes(1);
});
it("refuses oversized advertised bodies without reading and cancels streaming overflow", async () => {
  const advertised = createSourceTransport(SOURCE_LIMITS, { fetch: async () => new Response("abc", { headers: { "content-length": "9" } }) });
  await expect(advertised.get(endpoint, { maxBytes: 3 })).rejects.toThrow("source-byte-budget-exceeded"); expect(advertised.metrics().responseBytesRead).toBe(0);
  const cancel = vi.fn(); let count = 0;
  const stream = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array([65, 66])); count++; }, cancel });
  const transport = createSourceTransport(SOURCE_LIMITS, { fetch: async () => new Response(stream) });
  await expect(transport.get(endpoint, { maxBytes: 3 })).rejects.toThrow("source-byte-budget-exceeded");
  expect(cancel).toHaveBeenCalledOnce(); expect(transport.metrics()).toMatchObject({ requests: 1, responseBytesRead: 4 }); expect(count).toBeLessThanOrEqual(4);
});
it("counts consumed bytes from interrupted attempts toward the aggregate budget", async () => {
  let call = 0;
  const transport = createSourceTransport({ ...SOURCE_LIMITS, responseBytes: 4, totalBytes: 4 }, { sleep: async () => {}, fetch: async () => {
    if (++call === 1) { let read = false; return new Response(new ReadableStream({ pull(controller) {
      if (!read) { read = true; controller.enqueue(new Uint8Array([65, 66])); } else controller.error(new Error("connection closed"));
    } })); }
    return new Response("abc");
  } });
  await expect(transport.get(endpoint)).rejects.toThrow("source-byte-budget-exceeded"); expect(transport.metrics()).toMatchObject({ requests: 2, responseBytesRead: 5 });
});
it.each(["truncated", "bad-length", "bad-encoding", "empty"])("refuses %s responses without retry", async (kind) => {
  const responses = { truncated: new Response("ab", { headers: { "content-length": "3" } }),
    "bad-length": new Response("ab", { headers: { "content-length": "bad" } }), "bad-encoding": new Response(new Uint8Array([0xff])), empty: new Response(null) };
  const fetcher = vi.fn<typeof fetch>(async () => responses[kind as keyof typeof responses]);
  const codes = { truncated: "source-truncated-response", "bad-length": "source-byte-budget-exceeded", "bad-encoding": "source-encoding-refused", empty: "source-empty-response" };
  await expect(createSourceTransport(SOURCE_LIMITS, { fetch: fetcher }).get(endpoint)).rejects.toThrow(codes[kind as keyof typeof codes]); expect(fetcher).toHaveBeenCalledTimes(1);
});
it("enforces request and elapsed ceilings, including Retry-After that cannot fit", async () => {
  const limited = createSourceTransport({ ...SOURCE_LIMITS, requests: 1 }, { fetch: async () => new Response("a") });
  await limited.get(endpoint); await expect(limited.get(endpoint)).rejects.toThrow("source-request-budget-exceeded");
  const sleep = vi.fn(); const delayed = createSourceTransport(SOURCE_LIMITS, { sleep, fetch: async () => new Response(null, { status: 429, headers: { "retry-after": "91" } }) });
  await expect(delayed.get(endpoint)).rejects.toThrow("source-deadline-exceeded"); expect(sleep).not.toHaveBeenCalled();
  let time = 0; const timed = createSourceTransport(SOURCE_LIMITS, { now: () => time, fetch: async () => { time = 90_000; return new Response("a"); } });
  await expect(timed.get(endpoint)).rejects.toThrow("source-deadline-exceeded");
});
it("aborts a hanging request at the smaller request timeout", async () => {
  vi.useFakeTimers();
  const transport = createSourceTransport({ ...SOURCE_LIMITS, attempts: 1, requestTimeoutMs: 10 }, { fetch: async (_url, options) => new Promise((_resolve, reject) => {
    options!.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  }) });
  const check = expect(transport.get(endpoint)).rejects.toThrow("source-attempts-exhausted");
  await vi.advanceTimersByTimeAsync(11); await check; expect(transport.metrics().requests).toBe(1);
});
it("accepts only downward, integral, exact limit configuration", () => {
  expect(() => validateSourceLimits({ ...SOURCE_LIMITS, requests: 1 })).not.toThrow();
  for (const key of Object.keys(SOURCE_LIMITS) as (keyof typeof SOURCE_LIMITS)[]) {
    expect(() => validateSourceLimits({ ...SOURCE_LIMITS, [key]: SOURCE_LIMITS[key] + 1 })).toThrow("source-limits-refused");
    expect(() => validateSourceLimits({ ...SOURCE_LIMITS, [key]: 0 })).toThrow("source-limits-refused");
  }
  expect(() => validateSourceLimits({ ...SOURCE_LIMITS, responseBytes: 2, totalBytes: 1 })).toThrow("source-limits-refused");
  expect(() => validateSourceLimits({ ...SOURCE_LIMITS, elapsedMs: 1 })).toThrow("source-limits-refused");
});
