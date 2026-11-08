// Internal shared transport, not a package export. Fixture access is selected
// only by the script adapter; the production facade always uses production.
import { createHash } from "node:crypto";

export type TransferPolicy = { kind: "production" } | { kind: "fixture"; origin: string; pathname: string };
export type TransferProgress = {
  wireBytes: number; redirects: number;
  requests: { host: string; status: number | null; contentLength: number | null }[];
};
type TransferMode = { kind: "pinned"; wireBytes: number } | { kind: "observe" };

const checkedUrl = (value: string, initial: boolean, policy: TransferPolicy): URL => {
  const url = new URL(value);
  if (policy.kind === "fixture") {
    const origin = new URL(policy.origin);
    if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || !origin.port ||
        origin.origin !== policy.origin || url.origin !== origin.origin || url.username || url.password ||
        url.search || url.hash || url.pathname !== policy.pathname) throw new Error("ingest-url-refused");
  } else if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash ||
      !(initial ? ["github.com"] : ["github.com", "release-assets.githubusercontent.com"]).includes(url.hostname) ||
      (initial && (url.search || !url.pathname.startsWith("/nflverse/nflverse-data/releases/download/")))) {
    throw new Error("ingest-url-refused");
  }
  return url;
};

const transferWire = async (
  sourceUrl: string, signal: AbortSignal, maxWireBytes: number, fetcher: typeof fetch,
  policy: TransferPolicy, mode: TransferMode, progress?: TransferProgress,
) => {
  if (mode.kind === "pinned" && (!Number.isSafeInteger(mode.wireBytes) || mode.wireBytes < 0 || mode.wireBytes > maxWireBytes))
    throw new Error("ingest-wire-budget-exceeded");
  let url = checkedUrl(sourceUrl, true, policy).href;
  for (let redirects = 0; redirects <= 3; redirects++) {
    signal.throwIfAborted();
    const request = { host: new URL(url).hostname, status: null as number | null, contentLength: null as number | null };
    progress?.requests.push(request);
    const response = await fetcher(url, { signal, redirect: "manual", headers: {
      "Accept-Encoding": "identity", "User-Agent": "dfs-ev-demo-feature-store-spike", Accept: "application/octet-stream",
    } });
    request.status = response.status;
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (progress) progress.redirects++;
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (!location || redirects === 3) throw new Error("ingest-redirect-refused");
      url = checkedUrl(new URL(location, url).href, false, policy).href;
      continue;
    }
    if (!response.ok || response.status !== 200 || !response.body) {
      await response.body?.cancel(); throw new Error("ingest-http-refused");
    }
    // fetch transparently decodes Content-Encoding. Refuse that transformation
    // so the stored hash continues to identify exact release-asset wire bytes.
    const encoding = response.headers.get("content-encoding");
    const length = response.headers.get("content-length");
    if ((encoding && encoding !== "identity") || (length !== null &&
        (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) ||
          (mode.kind === "pinned" && Number(length) !== mode.wireBytes)))) {
      await response.body.cancel(); throw new Error("ingest-wire-metadata-refused");
    }
    const declaredBytes = length === null ? null : Number(length);
    request.contentLength = declaredBytes;
    if (mode.kind === "observe" && declaredBytes !== null && declaredBytes > maxWireBytes) {
      await response.body.cancel(); throw new Error("ingest-wire-budget-exceeded");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    const hash = mode.kind === "observe" ? createHash("sha256") : null;
    let count = 0;
    const cancel = () => { void reader.cancel(signal.reason).catch(() => {}); };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      for (;;) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        signal.throwIfAborted();
        if (done) break;
        count += value.byteLength;
        if (progress) progress.wireBytes = count;
        if (count > maxWireBytes || (mode.kind === "pinned" && count > mode.wireBytes)) throw new Error("ingest-wire-budget-exceeded");
        if (mode.kind === "observe" && declaredBytes !== null && count > declaredBytes) throw new Error("ingest-wire-size-mismatch");
        if (hash) hash.update(value);
        else chunks.push(value);
      }
    } finally {
      signal.removeEventListener("abort", cancel);
      await reader.cancel().catch(() => {});
    }
    if ((mode.kind === "pinned" && count !== mode.wireBytes) ||
        (mode.kind === "observe" && declaredBytes !== null && count !== declaredBytes)) throw new Error("ingest-wire-size-mismatch");
    return { bytes: hash ? null : Buffer.concat(chunks, count), sha256: hash?.digest("hex") ?? null,
      capturedAt: new Date().toISOString(), requests: redirects + 1 };
  }
  throw new Error("ingest-redirect-refused");
};

export const downloadPinnedWire = async (
  sourceUrl: string, wireBytes: number, signal: AbortSignal, maxWireBytes: number, fetcher: typeof fetch = fetch,
  policy: TransferPolicy = { kind: "production" },
): Promise<{ bytes: Buffer; capturedAt: string; requests: number }> => {
  const result = await transferWire(sourceUrl, signal, maxWireBytes, fetcher, policy, { kind: "pinned", wireBytes });
  return { bytes: result.bytes!, capturedAt: result.capturedAt, requests: result.requests };
};

export const observeWire = async (
  sourceUrl: string, signal: AbortSignal, maxWireBytes: number, fetcher: typeof fetch, progress: TransferProgress,
) => {
  const result = await transferWire(sourceUrl, signal, maxWireBytes, fetcher, { kind: "production" }, { kind: "observe" }, progress);
  return result.sha256!;
};
