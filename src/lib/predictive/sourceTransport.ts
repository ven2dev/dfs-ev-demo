import { setTimeout as delay } from "node:timers/promises";
import { exact, PredictiveError, refuse } from "./validation.ts";

export const SOURCE_LIMITS = { requests: 28, responseBytes: 8_000_000, totalBytes: 20_000_000, rows: 80_000,
  elapsedMs: 90_000, requestTimeoutMs: 15_000, attempts: 3 } as const;
export type SourceLimits = { [K in keyof typeof SOURCE_LIMITS]: number };
type Dependencies = { fetch: typeof fetch; now: () => number; instant: () => string;
  sleep: (milliseconds: number) => Promise<void>; random: () => number };
const production: Dependencies = { fetch: globalThis.fetch, now: () => performance.now(), instant: () => new Date().toISOString(),
  sleep: (milliseconds) => delay(milliseconds), random: Math.random };
export const validateSourceLimits = (limits: SourceLimits) => {
  exact(limits, Object.keys(SOURCE_LIMITS));
  for (const key of Object.keys(SOURCE_LIMITS) as (keyof SourceLimits)[]) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > SOURCE_LIMITS[key]) refuse("source-limits-refused");
  }
  if (limits.responseBytes > limits.totalBytes || limits.requestTimeoutMs > limits.elapsedMs) refuse("source-limits-refused");
};
const allowedUrl = (url: string, redirect: boolean) => {
  const parsed = new URL(url);
  const hosts = redirect ? ["github.com", "release-assets.githubusercontent.com"] : ["api.github.com", "github.com"];
  if (parsed.protocol !== "https:" || !hosts.includes(parsed.hostname) || parsed.username || parsed.password || parsed.port || parsed.hash ||
      (!redirect && (parsed.search || !/^\/(repos\/)?nflverse\/nflverse-data\/(releases\/tags\/|releases\/download\/)/.test(parsed.pathname)))) refuse("source-url-refused");
};
const retryDelay = (response: Response | null, attempt: number, deps: Dependencies) => {
  const value = response?.headers.get("retry-after");
  if (value) {
    if (/^\d+$/.test(value)) return Number(value) * 1000;
    const time = Date.parse(value);
    if (Number.isFinite(time)) return Math.max(0, time - Date.parse(deps.instant()));
    refuse("source-retry-after-refused");
  }
  return 250 * 2 ** attempt + Math.floor(deps.random() * 250);
};

export const createSourceTransport = (limits: SourceLimits = SOURCE_LIMITS, overrides: Partial<Dependencies> = {}) => {
  validateSourceLimits(limits);
  const deps = { ...production, ...overrides }; const started = deps.now();
  let requests = 0; let responseBytesRead = 0; let peakRssBytes = process.memoryUsage().rss;
  const measure = () => { peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss, process.resourceUsage().maxRSS * 1024); };
  const remaining = () => limits.elapsedMs - (deps.now() - started);
  const check = () => { measure(); if (remaining() <= 0) refuse("source-deadline-exceeded"); };
  const metrics = () => { measure(); return { requests, responseBytesRead, elapsedMs: Math.ceil(deps.now() - started), peakRssBytes }; };
  const get = async (origin: string, options: { maxBytes?: number; range?: boolean } = {}) => {
    allowedUrl(origin, false);
    const maximum = options.maxBytes ?? limits.responseBytes;
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > limits.responseBytes) refuse("source-response-bound-refused");
    for (let attempt = 0; attempt < limits.attempts; attempt++) {
      let response: Response | null = null;
      const controller = new AbortController();
      check();
      const timer = setTimeout(() => controller.abort(), Math.min(limits.requestTimeoutMs, remaining()));
      try {
        let url = origin;
        for (let redirect = 0; ; redirect++) {
          check(); if (requests === limits.requests) refuse("source-request-budget-exceeded"); requests++;
          response = await deps.fetch(url, { redirect: "manual", signal: controller.signal, headers: {
            Accept: origin.includes("api.github.com") ? "application/vnd.github+json" : "text/csv",
            "Accept-Encoding": "identity", "User-Agent": "dfs-ev-demo-predictive-source-qualification",
            ...(options.range ? { Range: `bytes=0-${maximum - 1}` } : {}),
          } });
          if (![301, 302, 303, 307, 308].includes(response.status)) break;
          await response.body?.cancel();
          const location = response.headers.get("location");
          if (!location || redirect >= 3) refuse("source-redirect-refused");
          url = new URL(location, url).href; allowedUrl(url, true);
        }
        if ([408, 429, 500, 502, 503, 504].includes(response.status)) {
          await response.body?.cancel();
          if (attempt === limits.attempts - 1) refuse("source-attempts-exhausted");
        } else {
          if (response.status !== (options.range ? 206 : 200)) { await response.body?.cancel(); refuse("source-http-refused"); }
          const length = response.headers.get("content-length");
          if (length !== null && (!/^\d+$/.test(length) || Number(length) > maximum || Number(length) > limits.totalBytes - responseBytesRead)) {
            await response.body?.cancel(); refuse("source-byte-budget-exceeded");
          }
          if (!response.body) refuse("source-empty-response");
          const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
          try {
            for (;;) {
              check(); const result = await reader.read(); if (result.done) break;
              bytes += result.value.byteLength; responseBytesRead += result.value.byteLength;
              if (bytes > maximum || responseBytesRead > limits.totalBytes) refuse("source-byte-budget-exceeded");
              chunks.push(result.value);
            }
          } finally { await reader.cancel().catch(() => {}); }
          check();
          if (length !== null && bytes !== Number(length)) refuse("source-truncated-response");
          const raw = Buffer.concat(chunks, bytes);
          let text: string;
          try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw); }
          catch { refuse("source-encoding-refused"); }
          if (Buffer.byteLength(text!) !== bytes) refuse("source-encoding-refused");
          return { bytes: text!, capturedAt: deps.instant(), byteSize: bytes, headers: {
            etag: response.headers.get("etag"), lastModified: response.headers.get("last-modified"), contentRange: response.headers.get("content-range"),
          } };
        }
      } catch (error) {
        if (error instanceof PredictiveError) throw error;
        if (attempt === limits.attempts - 1) refuse("source-attempts-exhausted");
      } finally { clearTimeout(timer); }
      const wait = retryDelay(response, attempt, deps);
      check(); if (wait >= remaining()) refuse("source-deadline-exceeded");
      await deps.sleep(wait);
    }
    return refuse("source-attempts-exhausted");
  };
  return { get, metrics, check };
};
