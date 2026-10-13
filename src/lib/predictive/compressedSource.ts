import { createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setImmediate as yieldImmediate } from "node:timers/promises";
import { createGunzip } from "node:zlib";
import { parse } from "csv-parse";
import { SOURCE_HEADERS } from "./sourceHeaders.ts";
import type { SourceRow } from "./sourceAdapters.ts";
import { RAW_ALLOWLISTS, canonical, exact, PredictiveError, refuse } from "./validation.ts";

/** Qualification-only profile. Not registered for publication or database reads. */
export const COMPRESSED_SOURCE_CODEC = "nflverse-gzip-csv-inspection-v1";
export const COMPRESSED_SOURCE_LIMITS = Object.freeze({ wireBytes: 8_000_000, decodedBytes: 20_000_000,
  rows: 80_000, recordBytes: 65_536, elapsedMs: 30_000 });
type Limits = { [K in keyof typeof COMPRESSED_SOURCE_LIMITS]: number };
export type CompressedFeed = "player" | "team" | "roster";
export interface CompressedInspectionRequest {
  feed: CompressedFeed;
  season: 2025 | 2026;
  wireSha256: string;
  wireBytes: number;
}

/**
 * Verifies a complete gzip CSV before returning a report or retained records.
 * No publication callbacks; CRC, UTF-8, header and budgets pass before return.
 * Hash exact wire/decoded bytes separately; record ordinals count CSV records.
 */
type DecodeOptions = { limits?: Partial<Limits>; signal?: AbortSignal };
async function processCompressedSource(source: Uint8Array, request: CompressedInspectionRequest,
  options: DecodeOptions, retainRows: boolean) {
  exact(request, ["feed", "season", "wireSha256", "wireBytes"]);
  request = { ...request };
  const signal = options.signal;
  if (!["player", "team", "roster"].includes(request.feed) || ![2025, 2026].includes(request.season)) refuse("compressed-scope-refused");
  if (options.limits && Object.keys(options.limits).some(key => !(key in COMPRESSED_SOURCE_LIMITS))) refuse("compressed-limits-refused");
  const limits = { ...COMPRESSED_SOURCE_LIMITS, ...options.limits };
  for (const key of Object.keys(limits) as (keyof Limits)[]) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > COMPRESSED_SOURCE_LIMITS[key]) refuse("compressed-limits-refused");
  }
  if (!(source instanceof Uint8Array) || source.byteLength > limits.wireBytes || !Number.isSafeInteger(request.wireBytes) ||
      request.wireBytes < 1 || request.wireBytes !== source.byteLength || !/^[a-f0-9]{64}$/.test(request.wireSha256)) refuse("compressed-wire-refused");
  // Copy before awaiting: external mutation cannot change already-hashed bytes.
  const bytes = Buffer.from(source);
  if (createHash("sha256").update(bytes).digest("hex") !== request.wireSha256) refuse("compressed-wire-integrity-failed");
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) refuse("compressed-gzip-refused");
  if (signal?.aborted) refuse("compressed-cancelled");
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener("abort", cancel, { once: true });
  let expired = false;
  const started = performance.now();
  const timer = setTimeout(() => { expired = true; controller.abort(); }, limits.elapsedMs);
  timer.unref();
  const check = () => {
    if (performance.now() - started >= limits.elapsedMs) { expired = true; refuse("compressed-deadline-exceeded"); }
    if (controller.signal.aborted) refuse("compressed-cancelled");
  };
  const decodedHash = createHash("sha256"), selectedHash = createHash("sha256");
  const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let decodedBytes = 0, rows = 0, inScopeRows = 0, headerSha256 = "";
  const selectedRows: SourceRow[] = [];
  const decode = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      try {
        check(); decodedBytes += chunk.byteLength;
        if (decodedBytes > limits.decodedBytes) refuse("compressed-decoded-budget-exceeded");
        decodedHash.update(chunk);
        let text: string;
        try { text = utf8.decode(chunk, { stream: true }); } catch { refuse("compressed-utf8-refused"); }
        done(null, text);
      } catch (error) { done(error as Error); }
    },
    flush(done) {
      try {
        let text: string;
        try { text = utf8.decode(); } catch { refuse("compressed-utf8-refused"); }
        done(null, text);
      } catch (error) { done(error as Error); }
    },
  });
  const parser = parse({ bom: true, raw: true, skip_empty_lines: true, max_record_size: limits.recordBytes,
    columns: (header: string[]) => {
      if (canonical(header) !== canonical(SOURCE_HEADERS[request.feed])) refuse("compressed-header-drift");
      headerSha256 = createHash("sha256").update(canonical(header)).digest("hex");
      const allowed: readonly string[] = RAW_ALLOWLISTS[request.feed];
      return header.map(column => allowed.includes(column) ? column : false);
    } });
  try {
    await pipeline(Readable.from([bytes]), createGunzip({ chunkSize: 16_384 }), decode, parser,
      async function consume(records) {
        for await (const packet of records) {
          const row = packet.record as Record<string, string>;
          check();
          if (Buffer.byteLength(packet.raw) > limits.recordBytes) refuse("compressed-record-budget-exceeded");
          rows++;
          if (rows > limits.rows) refuse("compressed-row-budget-exceeded");
          if (row.season === String(request.season)) inScopeRows++;
          selectedHash.update(canonical([rows, row]) + "\n");
          if (retainRows) selectedRows.push(row);
          if (rows % 1024 === 0) await yieldImmediate(undefined, { signal: controller.signal });
        }
      }, { signal: controller.signal });
    check();
    if (!headerSha256 || rows === 0) refuse("compressed-empty-csv");
    const inspection = { codecVersion: COMPRESSED_SOURCE_CODEC, feed: request.feed, season: request.season,
      wireSha256: request.wireSha256, wireBytes: bytes.length, decodedSha256: decodedHash.digest("hex"), decodedBytes,
      headerSha256, selectedRecordsSha256: selectedHash.digest("hex"), rows, inScopeRows, outOfScopeRows: rows - inScopeRows,
      limits, inspection: "complete-codec-proof-only", publicationSupported: false, featuresPublished: false, labelsFinalized: false };
    return { inspection, selectedRows };
  } catch (error) {
    if (expired) refuse("compressed-deadline-exceeded");
    if (signal?.aborted) refuse("compressed-cancelled");
    if (error instanceof PredictiveError) throw error;
    if (error instanceof Error && "code" in error && String(error.code).startsWith("CSV")) refuse(error.code === "CSV_MAX_RECORD_SIZE" ? "compressed-record-budget-exceeded" : "compressed-csv-refused");
    refuse("compressed-gzip-refused");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}

export async function inspectCompressedSource(source: Uint8Array, request: CompressedInspectionRequest,
  options: DecodeOptions = {}) {
  return (await processCompressedSource(source, request, options, false)).inspection;
}

// Preparation only. Retain every allowlisted record, with no callback or partial
// result before complete CRC/UTF-8/header/budget verification. The streaming
// inspector above still avoids retaining rows. Production use additionally needs
// the process-memory ceiling, rights gate and SQL codec envelope.
export async function decodeCompressedSource(source: Uint8Array, request: CompressedInspectionRequest,
  options: DecodeOptions = {}) {
  return processCompressedSource(source, request, options, true);
}
