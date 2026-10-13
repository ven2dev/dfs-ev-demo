import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { expect, it } from "vitest";
import { prepareCompressedSourceClaims } from "../../src/lib/predictive/compressedClaims.ts";
import { decodeCompressedSource, inspectCompressedSource, type CompressedInspectionRequest } from "../../src/lib/predictive/compressedSource.ts";
import { projectSourceClaim } from "../../src/lib/predictive/sourceClaims.ts";
import { canonical, RAW_ALLOWLISTS } from "../../src/lib/predictive/validation.ts";
import { sourceCsv, sourceSamples } from "./fixtures/source.ts";
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const request = (bytes: Uint8Array, season: 2025 | 2026 = 2025, feed: "player" | "team" = "player"): CompressedInspectionRequest =>
  ({ feed, season, wireSha256: sha(bytes), wireBytes: bytes.length });
const player = () => ({ ...sourceSamples().player[0], season: "2025", game_id: "2025_06_CAR_PHI", passing_yards: "-2", attempts: "0", completions: "0" });

it("prepares signed 2025 claims with exact full-file and independent selected-row identities", async () => {
  const raw = player(), text = sourceCsv("player", [raw]), bytes = gzipSync(text);
  const result = await prepareCompressedSourceClaims("compressed-capture", bytes, request(bytes));
  const selected = Object.fromEntries(RAW_ALLOWLISTS.player.map(column => [column, raw[column as keyof typeof raw] ?? ""]));
  expect(result.inspection).toEqual(await inspectCompressedSource(bytes, request(bytes)));
  expect(result.inspection).toMatchObject({ wireSha256: sha(bytes), decodedSha256: sha(text), rows: 1,
    selectedRecordsSha256: sha(canonical([1, selected]) + "\n") });
  expect(result.rows[0]).toMatchObject({ id: "source-row:" + sha('["compressed-capture",1]'), rowOrdinal: 1,
    selectedSha256: sha(canonical(selected)), rawKeySha256: sha('["2025_06_CAR_PHI","PHI","00-0000001"]'),
    failureCode: null, projection: { season: 2025, values: { passingYards: -2, attempts: 0, completions: 0 } } });
  expect(result).toMatchObject({ publicationSupported: false, featuresPublished: false, labelsFinalized: false });
  expect(projectSourceClaim("legacy", "player", selected, 1)).toMatchObject({ projection: null, failureCode: "source-stats-scope-refused" });
});

it("retains out-of-scope and invalid numeric records at their full-file ordinals instead of filtering", async () => {
  const text = sourceCsv("player", [player(), { ...player(), season: "2026", game_id: "2026_06_CAR_PHI" },
    { ...player(), attempts: "bad" }, { ...player(), passing_yards: "95", attempts: "10", completions: "8" }]);
  const bytes = gzipSync(text), result = await prepareCompressedSourceClaims("scope", bytes, request(bytes));
  expect(result.inspection).toMatchObject({ rows: 4, inScopeRows: 3, outOfScopeRows: 1 });
  expect(result.rows.map(row => [row.rowOrdinal, row.failureCode])).toEqual([[1, null], [2, "source-stats-scope-refused"], [3, "source-number-refused"], [4, null]]);
  expect(result.rows[1].projection).toBeNull(); expect(result.rows[2].projection).toBeNull();
  expect(result.rows[3].projection?.values.passingYards).toBe(95);
});

it("prepares team claims without fabricating a player identity and keeps 2026 support", async () => {
  const raw = { ...sourceSamples().team[0], passing_yards: "0" }, bytes = gzipSync(sourceCsv("team", [raw]));
  const result = await prepareCompressedSourceClaims("team", bytes, request(bytes, 2026, "team"));
  expect(result.rows[0]).toMatchObject({ projection: { feed: "team", season: 2026, rawPlayerId: null, playerIdProvider: null, values: { passingYards: 0 } } });
  await expect(prepareCompressedSourceClaims("roster", bytes, { ...request(bytes), feed: "roster" })).rejects.toThrow("compressed-claims-feed-refused");
});

it("withholds every claim until complete gzip and decoded-work verification succeeds", async () => {
  const bytes = gzipSync(sourceCsv("player", [player(), player()]));
  const bad = Buffer.from(bytes); bad[bad.length - 8] ^= 1;
  await expect(prepareCompressedSourceClaims("crc", bad, request(bad))).rejects.toThrow("compressed-gzip-refused");
  await expect(prepareCompressedSourceClaims("truncated", bytes.subarray(0, bytes.length - 4), request(bytes.subarray(0, bytes.length - 4))))
    .rejects.toThrow("compressed-gzip-refused");
  await expect(prepareCompressedSourceClaims("rows", bytes, request(bytes), { limits: { rows: 1 } })).rejects.toThrow("compressed-row-budget-exceeded");
  await expect(prepareCompressedSourceClaims("decoded", bytes, request(bytes), { limits: { decodedBytes: 1 } })).rejects.toThrow("compressed-decoded-budget-exceeded");
});

it("pins mutable requests and buffers before preparation and keeps later decodes independent", async () => {
  const bytes = gzipSync(sourceCsv("player", [player()])), original = Buffer.from(bytes), scope = request(bytes);
  const pending = prepareCompressedSourceClaims("pinned", bytes, scope); bytes.fill(0); scope.season = 2026; scope.feed = "team";
  expect((await pending).rows[0].projection).toMatchObject({ season: 2025, feed: "player" });
  const first = await decodeCompressedSource(original, request(original)); first.selectedRows[0].passing_yards = "999";
  expect((await decodeCompressedSource(original, request(original))).selectedRows[0].passing_yards).toBe("-2");
  expect(await inspectCompressedSource(original, request(original))).not.toHaveProperty("selectedRows");
});

it("refuses malformed capture identities, scope and wire hashes before returning claims", async () => {
  const bytes = gzipSync(sourceCsv("player", [player()]));
  await expect(prepareCompressedSourceClaims("\ninvalid", bytes, request(bytes))).rejects.toThrow("source-publication-id-refused");
  await expect(prepareCompressedSourceClaims("hash", bytes, { ...request(bytes), wireSha256: "0".repeat(64) })).rejects.toThrow("compressed-wire-integrity-failed");
  await expect(prepareCompressedSourceClaims("scope", bytes, { ...request(bytes), season: 2024 as 2025 })).rejects.toThrow("compressed-scope-refused");
});
