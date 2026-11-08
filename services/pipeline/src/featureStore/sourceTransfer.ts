// Internal shared transport, not a package export. Fixture access is selected
// only by the script adapter; the production facade always uses production.
export type TransferPolicy = { kind: "production" } | { kind: "fixture"; origin: string; pathname: string };

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

export const downloadPinnedWire = async (
  sourceUrl: string, wireBytes: number, signal: AbortSignal, maxWireBytes: number, fetcher: typeof fetch = fetch,
  policy: TransferPolicy = { kind: "production" },
): Promise<{ bytes: Buffer; capturedAt: string; requests: number }> => {
  if (!Number.isSafeInteger(wireBytes) || wireBytes < 0 || wireBytes > maxWireBytes) throw new Error("ingest-wire-budget-exceeded");
  let url = checkedUrl(sourceUrl, true, policy).href;
  for (let redirects = 0; redirects <= 3; redirects++) {
    const response = await fetcher(url, { signal, redirect: "manual", headers: {
      "Accept-Encoding": "identity", "User-Agent": "dfs-ev-demo-feature-store-spike", Accept: "application/octet-stream",
    } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
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
        (!/^\d+$/.test(length) || Number(length) !== wireBytes))) {
      await response.body.cancel(); throw new Error("ingest-wire-metadata-refused");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let count = 0;
    try {
      for (;;) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        count += value.byteLength;
        if (count > maxWireBytes || count > wireBytes) throw new Error("ingest-wire-budget-exceeded");
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    if (count !== wireBytes) throw new Error("ingest-wire-size-mismatch");
    return { bytes: Buffer.concat(chunks, count), capturedAt: new Date().toISOString(), requests: redirects + 1 };
  }
  throw new Error("ingest-redirect-refused");
};
