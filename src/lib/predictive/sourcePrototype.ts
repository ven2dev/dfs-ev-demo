import { parse } from "csv-parse/sync";
import type { ArtifactStore } from "./artifacts.ts";
import { SOURCE_FEEDS, SOURCE_PROFILE_VERSION, parseSourceCsv, sourceAsset, validateSourceHeader, type SourceFeed, type SourceRow } from "./sourceAdapters.ts";
import { SOURCE_LIMITS, createSourceTransport, validateSourceLimits, type SourceLimits } from "./sourceTransport.ts";
import { qualifySourceSamples } from "./sourceQualification.ts";
import { canonical, digest, exact, instant, object, PredictiveError, refuse } from "./validation.ts";

export type SourceReference = { reference: string; sha256: string; byteSize: number };
type Capture = { feed: SourceFeed; asset: ReturnType<typeof sourceAsset>; metadata: SourceReference; metadataCapturedAt: string; source: SourceReference | null;
  state: "captured" | "header-only" | "refused"; capturedAt: string | null; availableAt: string | null; ingestedAt: string | null;
  sourcePublishedAt: null; upstreamUpdatedAt: string; upstreamBytes: number; providerDigest: string | null;
  rows: number; failureCode: string | null; headerSha256: string | null; sourceContentRange: string | null };
const reference = async (store: ArtifactStore, bytes: string): Promise<SourceReference> => {
  const sha256 = digest(bytes);
  return { reference: await store.write(bytes, sha256), sha256, byteSize: Buffer.byteLength(bytes) };
};
const metadataAsset = (bytes: string, expected: ReturnType<typeof sourceAsset>) => {
  const release = object(JSON.parse(bytes));
  if (release.tag_name !== expected.tag || !Array.isArray(release.assets)) refuse("source-metadata-refused");
  const assets = release.assets.filter((value) => object(value).name === expected.name);
  if (assets.length !== 1) refuse("source-asset-missing");
  const row = object(assets[0]);
  if (!Number.isSafeInteger(row.size) || Number(row.size) < 1 || row.browser_download_url !== expected.url ||
      typeof row.updated_at !== "string" || !Number.isFinite(Date.parse(row.updated_at)) ||
      (row.digest !== null && row.digest !== undefined && (typeof row.digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(row.digest)))) refuse("source-metadata-refused");
  return { size: Number(row.size), updatedAt: row.updated_at, providerDigest: typeof row.digest === "string" ? row.digest : null };
};

export const captureSourcePrototype = async (store: ArtifactStore, season: number, targetGameId: string,
  suppliedTransport?: ReturnType<typeof createSourceTransport>, limits: SourceLimits = SOURCE_LIMITS) => {
  validateSourceLimits(limits);
  if (!/^\d{4}_\d{2}_[A-Z]{2,3}_[A-Z]{2,3}$/.test(targetGameId) || !targetGameId.startsWith(String(season) + "_")) refuse("source-scope-refused");
  const transport = suppliedTransport ?? createSourceTransport(limits);
  // This prototype keeps raw source research isolated from the synthetic SQL
  // publication contract. No report is an eligible feature batch.
  const samples: Partial<Record<SourceFeed, SourceRow[]>> = {}; const captures: Capture[] = [];
  let rows = 0; let qualification: ReturnType<typeof qualifySourceSamples> | null = null;
  let failureCode: string | null = null;
  for (const feed of SOURCE_FEEDS) {
    const asset = sourceAsset(feed, season);
    try {
      transport.check();
      const metadata = await transport.get(asset.metadataUrl, { maxBytes: Math.min(limits.responseBytes, 2_000_000) });
      const found = metadataAsset(metadata.bytes, asset);
      const metadataRef = await reference(store, metadata.bytes);
      const capture: Capture = { feed, asset, metadata: metadataRef, metadataCapturedAt: metadata.capturedAt, source: null, state: "refused", capturedAt: null,
        availableAt: null, ingestedAt: null, sourcePublishedAt: null, upstreamUpdatedAt: found.updatedAt, upstreamBytes: found.size,
        providerDigest: found.providerDigest, rows: 0, failureCode: null, headerSha256: null, sourceContentRange: null };
      captures.push(capture);
      const partial = found.size > limits.responseBytes || found.size > limits.totalBytes - transport.metrics().responseBytesRead;
      const source = await transport.get(asset.url, partial ? { maxBytes: Math.min(4096, limits.responseBytes), range: true } : {});
      capture.source = await reference(store, source.bytes); capture.capturedAt = source.capturedAt;
      capture.availableAt = source.capturedAt; capture.ingestedAt = new Date().toISOString();
      capture.sourceContentRange = source.headers.contentRange;
      if (partial) {
        const range = source.headers.contentRange;
        if (range !== `bytes 0-${source.byteSize - 1}/${found.size}`) refuse("source-range-refused");
        capture.headerSha256 = validateSourceHeader(feed, parse(source.bytes, { bom: true, to: 1 })[0]);
        capture.state = "header-only"; capture.failureCode = "source-file-over-budget";
        continue;
      }
      if (source.byteSize !== found.size || (found.providerDigest && found.providerDigest !== "sha256:" + digest(source.bytes))) refuse("source-release-integrity-failed");
      if (capture.sourceContentRange !== null) refuse("source-range-refused");
      const projected = await parseSourceCsv(feed, source.bytes, limits.rows - rows);
      transport.check(); rows += projected.rows.length;
      samples[feed] = projected.rows; capture.rows = projected.rows.length; capture.headerSha256 = projected.headerSha256;
      capture.state = "captured";
    } catch (error) {
      failureCode = error instanceof PredictiveError ? error.code : "source-acquisition-refused";
      const capture = captures.at(-1);
      if (capture?.feed === feed) capture.failureCode = failureCode;
      break;
    }
  }
  try { if (samples.schedule) qualification = qualifySourceSamples(samples, season, targetGameId); if (!failureCode) transport.check(); }
  catch (error) { failureCode ??= error instanceof PredictiveError ? error.code : "source-qualification-refused"; }
  const report = { formatVersion: 1, prototypeVersion: "nflverse-bounded-source-v1", parserVersion: SOURCE_PROFILE_VERSION,
    rightsReviewVersion: "nflverse-internal-research-2026-10-05", usage: "private-internal-research", season, targetGameId,
    finishedAt: new Date().toISOString(), status: failureCode ? "refused" : captures.some((capture) => capture.state !== "captured") ? "incomplete" : "captured",
    failureCode, featuresPublished: false, limits, metrics: { ...transport.metrics(), rows, storedRawBytes: captures.reduce((sum, capture) => sum + (capture.source?.byteSize ?? 0), 0) },
    captures, qualification };
  return { report, journal: await reference(store, canonical(report)) };
};

// Offline restoration re-verifies every exact source and release metadata file,
// projects using the registered parser, and recomputes qualification evidence.
const checkedReference = (value: unknown, maximum: number): SourceReference => {
  const row = exact(value, ["reference", "sha256", "byteSize"]);
  if (typeof row.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(row.sha256) || row.reference !== row.sha256 + ".json" ||
      !Number.isSafeInteger(row.byteSize) || Number(row.byteSize) < 1 || Number(row.byteSize) > maximum) refuse("source-journal-refused");
  return row as SourceReference;
};
const failure = (value: unknown) => typeof value === "string" && /^[a-z][a-z0-9-]{1,96}$/.test(value);
export const verifySourcePrototype = async (store: ArtifactStore, journal: SourceReference) => {
  checkedReference(journal, SOURCE_LIMITS.responseBytes);
  const report = exact(JSON.parse(await store.read(journal.reference, journal.sha256, journal.byteSize)), ["formatVersion", "prototypeVersion", "parserVersion",
    "rightsReviewVersion", "usage", "season", "targetGameId", "finishedAt", "status", "failureCode", "featuresPublished", "limits", "metrics", "captures", "qualification"]);
  if (report.formatVersion !== 1 || report.prototypeVersion !== "nflverse-bounded-source-v1" || report.parserVersion !== SOURCE_PROFILE_VERSION ||
      report.rightsReviewVersion !== "nflverse-internal-research-2026-10-05" || report.usage !== "private-internal-research" ||
      report.featuresPublished !== false || typeof report.season !== "number" || typeof report.targetGameId !== "string" ||
      !/^\d{4}_\d{2}_[A-Z]{2,3}_[A-Z]{2,3}$/.test(report.targetGameId) || !report.targetGameId.startsWith(report.season + "_") ||
      !["captured", "incomplete", "refused"].includes(String(report.status)) ||
      (report.status === "refused" ? !failure(report.failureCode) : report.failureCode !== null) ||
      !Array.isArray(report.captures) || report.captures.length > SOURCE_FEEDS.length) refuse("source-journal-refused");
  sourceAsset("player", report.season);
  const finished = instant(report.finishedAt);
  const limits = report.limits as SourceLimits; validateSourceLimits(limits);
  const metrics = exact(report.metrics, ["requests", "responseBytesRead", "elapsedMs", "peakRssBytes", "rows", "storedRawBytes"]);
  for (const value of Object.values(metrics)) if (!Number.isSafeInteger(value) || Number(value) < 0) refuse("source-journal-refused");
  if (Number(metrics.requests) > limits.requests || Number(metrics.peakRssBytes) < 1 ||
      (report.status !== "refused" && (Number(metrics.responseBytesRead) > limits.totalBytes || Number(metrics.elapsedMs) > limits.elapsedMs))) refuse("source-journal-refused");
  let rows = 0; let storedRawBytes = 0; let retainedBytes = 0; let headerOnly = 0; let refused = 0;
  const samples: Partial<Record<SourceFeed, SourceRow[]>> = {};
  for (const [index, value] of report.captures.entries()) {
    const capture = exact(value, ["feed", "asset", "metadata", "metadataCapturedAt", "source", "state", "capturedAt", "availableAt", "ingestedAt", "sourcePublishedAt",
      "upstreamUpdatedAt", "upstreamBytes", "providerDigest", "rows", "failureCode", "headerSha256", "sourceContentRange"]) as unknown as Capture;
    if (capture.feed !== SOURCE_FEEDS[index] || !["captured", "header-only", "refused"].includes(capture.state) ||
        capture.sourcePublishedAt !== null || !Number.isSafeInteger(capture.rows) || capture.rows < 0 ||
        (capture.sourceContentRange !== null && typeof capture.sourceContentRange !== "string")) refuse("source-journal-refused");
    const asset = sourceAsset(capture.feed, report.season);
    if (canonical(capture.asset) !== canonical(asset)) refuse("source-journal-refused");
    checkedReference(capture.metadata, Math.min(limits.responseBytes, 2_000_000));
    const metadataTime = instant(capture.metadataCapturedAt);
    if (metadataTime > finished) refuse("source-journal-refused");
    retainedBytes += capture.metadata.byteSize;
    const found = metadataAsset(await store.read(capture.metadata.reference, capture.metadata.sha256, capture.metadata.byteSize), asset);
    if (found.size !== capture.upstreamBytes || found.updatedAt !== capture.upstreamUpdatedAt || found.providerDigest !== capture.providerDigest) refuse("source-journal-refused");
    if (capture.state === "refused") {
      refused++;
      if (!failure(capture.failureCode) || capture.failureCode !== report.failureCode || capture.rows !== 0 || capture.headerSha256 !== null ||
          index !== report.captures.length - 1 || report.status !== "refused") refuse("source-journal-refused");
    } else if (capture.state === "header-only") {
      headerOnly++;
      if (capture.failureCode !== "source-file-over-budget" || capture.rows !== 0) refuse("source-journal-refused");
    } else if (capture.failureCode !== null || capture.rows < 1) refuse("source-journal-refused");
    if (!capture.source) {
      if (capture.state !== "refused" || capture.capturedAt !== null || capture.availableAt !== null || capture.ingestedAt !== null || capture.sourceContentRange !== null) refuse("source-journal-refused");
      continue;
    }
    checkedReference(capture.source, limits.responseBytes);
    storedRawBytes += capture.source.byteSize; retainedBytes += capture.source.byteSize;
    const bytes = await store.read(capture.source.reference, capture.source.sha256, capture.source.byteSize);
    if (capture.capturedAt === null || capture.availableAt !== capture.capturedAt || capture.ingestedAt === null ||
        instant(capture.capturedAt) < metadataTime || instant(capture.ingestedAt) < instant(capture.capturedAt) ||
        instant(capture.ingestedAt) > finished) refuse("source-journal-refused");
    if (capture.state === "captured") {
      if (capture.source.byteSize !== found.size || (found.providerDigest && "sha256:" + digest(bytes) !== found.providerDigest)) refuse("source-release-integrity-failed");
      if (capture.sourceContentRange !== null) refuse("source-journal-refused");
      const projected = await parseSourceCsv(capture.feed, bytes, limits.rows - rows);
      rows += projected.rows.length;
      if (projected.rows.length !== capture.rows || projected.headerSha256 !== capture.headerSha256) refuse("source-journal-refused");
      samples[capture.feed] = projected.rows;
    } else if (capture.state === "header-only") {
      if (capture.source.byteSize > 4096 || capture.source.byteSize >= found.size ||
          capture.sourceContentRange !== `bytes 0-${capture.source.byteSize - 1}/${found.size}` ||
          validateSourceHeader(capture.feed, parse(bytes, { bom: true, to: 1 })[0]) !== capture.headerSha256) refuse("source-journal-refused");
    }
  }
  if (Number(metrics.rows) !== rows || Number(metrics.storedRawBytes) !== storedRawBytes || Number(metrics.responseBytesRead) < retainedBytes ||
      Number(metrics.requests) < report.captures.length * 2 - refused ||
      (report.status !== "refused" && (report.captures.length !== SOURCE_FEEDS.length || refused > 0 ||
        report.status !== (headerOnly > 0 ? "incomplete" : "captured")))) refuse("source-journal-refused");
  let qualification: ReturnType<typeof qualifySourceSamples> | null = null;
  try { if (samples.schedule) qualification = qualifySourceSamples(samples, report.season, report.targetGameId); }
  catch (error) {
    if (report.status !== "refused" || !(error instanceof PredictiveError)) refuse("source-restoration-mismatch");
  }
  if (canonical(qualification) !== canonical(report.qualification)) refuse("source-restoration-mismatch");
  return { verified: true, featuresPublished: false, captures: report.captures.length, qualification: report.qualification };
};
