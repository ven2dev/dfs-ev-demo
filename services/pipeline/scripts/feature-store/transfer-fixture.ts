import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { checkLimits, INGEST_LIMITS, type SourceAsset, type downloadSource } from "../../src/featureStore/source.ts";
import { parseObjectKey, type ObjectStore } from "../../src/featureStore/objectStore.ts";
import { downloadPinnedWire } from "../../src/featureStore/sourceTransfer.ts";

type FixtureMapping = { asset: SourceAsset; key: string };

// Script-only test capability. Production downloadSource has no host override.
export const openTransferFixture = async (
  store: ObjectStore, assets: readonly FixtureMapping[], options: { testOnlyLoopback: true },
) => {
  if (options?.testOnlyLoopback !== true || !assets.length) throw new Error("fixture-loopback-setting-required");
  const mappings = assets.map(({ asset, key }, index) => {
    if (parseObjectKey(key).namespace !== "raw" || !Number.isSafeInteger(asset.wire_bytes) || asset.wire_bytes < 0 ||
        asset.wire_bytes > INGEST_LIMITS.wireBytes) throw new Error("fixture-mapping-refused");
    return { sourceUrl: asset.url, key, wireBytes: asset.wire_bytes, pathname: `/fixture/${index}` };
  });
  if (new Set(mappings.map(m => m.sourceUrl)).size !== mappings.length) throw new Error("fixture-mapping-refused");
  let origin = "", closing: Promise<void> | undefined;
  const sendError = (response: ServerResponse, status: number) => {
    if (!response.destroyed) response.writeHead(status, { "Content-Length": "0" }).end();
  };
  const serve = async (request: IncomingMessage, response: ServerResponse) => {
    if (request.headers.host !== new URL(origin).host) return sendError(response, 403);
    if (request.method !== "GET" && request.method !== "HEAD") return sendError(response, 405);
    const mapping = mappings.find(m => m.pathname === request.url);
    if (!mapping) return sendError(response, 404);
    const bytes = await store.get(mapping.key);
    if (bytes.length !== mapping.wireBytes) return sendError(response, 500);
    if (response.destroyed) return;
    response.writeHead(200, { "Content-Length": bytes.length, "Content-Type": "application/octet-stream",
      "Content-Encoding": "identity", "Cache-Control": "no-store" });
    response.end(request.method === "HEAD" ? undefined : bytes);
  };
  const server = createServer((request, response) => {
    void serve(request, response).catch(() => sendError(response, 500));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
  });
  const address = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${address.port}`;
  const download: typeof downloadSource = async (asset, signal, limits = INGEST_LIMITS) => {
    if (closing) throw new Error("fixture-server-closed");
    checkLimits(limits);
    const mapping = mappings.find(m => m.sourceUrl === asset.url);
    if (!mapping) throw new Error("fixture-asset-refused");
    return downloadPinnedWire(origin + mapping.pathname, asset.wire_bytes, signal, limits.wireBytes, fetch,
      { kind: "fixture", origin, pathname: mapping.pathname });
  };
  const close = () => closing ??= new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
  return { origin, download, close };
};
