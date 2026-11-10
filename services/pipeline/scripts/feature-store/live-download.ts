import { checkLimits, INGEST_LIMITS, type IngestLimits, type SourceAsset } from "../../src/featureStore/source.ts";
import { observeWire, type TransferProgress } from "../../src/featureStore/sourceTransfer.ts";

const refusalCodes = new Set(["ingest-limits-refused", "ingest-url-refused", "ingest-redirect-refused",
  "ingest-http-refused", "ingest-wire-metadata-refused", "ingest-wire-budget-exceeded", "ingest-wire-size-mismatch"]);
type ObservationOptions = { signal?: AbortSignal; limits?: IngestLimits; fetcher?: typeof fetch };
type ExpectedWire = Pick<SourceAsset, "wire_bytes" | "sha256" | "provider_digest">;
type ReceiptBase = { elapsedMs: number; expected: ExpectedWire; requests: TransferProgress["requests"]; redirects: number };
export type LiveDownloadReceipt = ReceiptBase & (
  { status: "completed"; observed: { wireBytes: number; sha256: string };
    changed: { wireBytes: boolean; sha256: boolean | null; providerDigest: boolean | null }; error: null }
  | { status: "failed"; observed: { wireBytes: number; sha256: null }; changed: null;
    error: { code: string; censored: true } }
);

// Provisional script API: one bounded receipt, never raw bytes or retry policy.
// #169 owns pairing, journals, timing boundaries and qualification decisions.
export const observeLiveDownload = async (asset: SourceAsset, options: ObservationOptions = {}): Promise<LiveDownloadReceipt> => {
  const started = performance.now();
  const expected = { wire_bytes: asset.wire_bytes, sha256: asset.sha256, provider_digest: asset.provider_digest };
  const sourceUrl = asset.url, limits = { ...(options.limits ?? INGEST_LIMITS) };
  const progress: TransferProgress = { wireBytes: 0, redirects: 0, requests: [] };
  let signal = options.signal;
  const base = (): ReceiptBase => ({ elapsedMs: performance.now() - started, expected,
    requests: progress.requests.map(request => ({ ...request })), redirects: progress.redirects });
  try {
    checkLimits(limits);
    if (!Number.isSafeInteger(expected.wire_bytes) || expected.wire_bytes < 0 || expected.wire_bytes > limits.wireBytes)
      throw new Error("ingest-wire-budget-exceeded");
    const deadline = AbortSignal.timeout(limits.deadlineMs);
    signal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const hash = await observeWire(sourceUrl, signal, limits.wireBytes, options.fetcher ?? fetch, progress);
    signal.throwIfAborted();
    return { ...base(), status: "completed", observed: { wireBytes: progress.wireBytes, sha256: hash },
      changed: { wireBytes: progress.wireBytes !== expected.wire_bytes,
        sha256: expected.sha256 === null ? null : hash !== expected.sha256,
        providerDigest: expected.provider_digest === null ? null : "sha256:" + hash !== expected.provider_digest }, error: null };
  } catch (error) {
    const code = signal?.aborted ? signal.reason?.name === "TimeoutError" ? "ingest-deadline-exceeded" : "ingest-transfer-aborted"
      : error instanceof Error && refusalCodes.has(error.message) ? error.message : "ingest-transport-failed";
    return { ...base(), status: "failed", observed: { wireBytes: progress.wireBytes, sha256: null },
      changed: null, error: { code, censored: true } };
  }
};
