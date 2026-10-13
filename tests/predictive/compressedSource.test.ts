import { createHash } from "node:crypto";
import { mkdtemp, writeFile, chmod, link, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { inspectCompressedSource, COMPRESSED_SOURCE_LIMITS, type CompressedInspectionRequest } from "../../src/lib/predictive/compressedSource.ts";
import { runCompressedInspection } from "../../scripts/predictive/compressedInspect.ts";
import { canonical } from "../../src/lib/predictive/validation.ts";
import { RAW_ALLOWLISTS } from "../../src/lib/predictive/validation.ts";
import { sourceCsv, sourceSamples } from "./fixtures/source.ts";
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const request = (bytes: Uint8Array): CompressedInspectionRequest => ({ feed: "player" as const, season: 2025 as const, wireSha256: sha(bytes), wireBytes: bytes.length });
const csv = () => sourceCsv("player", [{ ...sourceSamples().player[0], season: "2025", game_id: "2025_06_CAR_PHI", player_name: "quoted,\n東京", passing_yards: "-2", attempts: "0" }]);
describe("qualification-only bounded gzip CSV decoder", () => {
  it("preserves independent wire and decoded digests, CSV ordinals and selected-column hashes", async () => {
    const text = csv(), bytes = gzipSync(text);
    const r = await inspectCompressedSource(bytes, request(bytes));
    expect(r).toMatchObject({ wireSha256: sha(bytes), decodedSha256: sha(text), decodedBytes: Buffer.byteLength(text), rows: 1, inScopeRows: 1, outOfScopeRows: 0,
      inspection: "complete-codec-proof-only", publicationSupported: false, featuresPublished: false, labelsFinalized: false });
    const raw = { ...sourceSamples().player[0], season: "2025", game_id: "2025_06_CAR_PHI", player_name: "quoted,\n東京", passing_yards: "-2", attempts: "0" };
    const selected = Object.fromEntries(RAW_ALLOWLISTS.player.map(column => [column, raw[column as keyof typeof raw] ?? ""]));
    expect(r.selectedRecordsSha256).toBe(sha(canonical([1, selected]) + "\n"));
    expect(r).not.toHaveProperty("values");
    expect(await inspectCompressedSource(bytes, request(bytes))).toEqual(r);
  });
  it("pins the input buffer and request across asynchronous decoding", async () => {
    const text = csv(), bytes = gzipSync(text), r = request(bytes);
    const pending = inspectCompressedSource(bytes, r);
    bytes.fill(0); r.season = 2026;
    expect(await pending).toMatchObject({ season: 2025, decodedSha256: sha(text), inScopeRows: 1 });
  });
  it("decodes UTF-8 split across zlib output chunks", async () => {
    const text = sourceCsv("player", [{ ...sourceSamples().player[0], player_name: "東京".repeat(10_000) }]);
    const bytes = gzipSync(text);
    expect((await inspectCompressedSource(bytes, request(bytes))).decodedSha256).toBe(sha(text));
  });
  it("refuses when the monotonic decode deadline expires", async () => {
    const bytes = gzipSync(csv());
    const clock = vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValue(2);
    try { await expect(inspectCompressedSource(bytes, request(bytes), { limits: { elapsedMs: 1 } })).rejects.toThrow("compressed-deadline-exceeded"); }
    finally { clock.mockRestore(); }
  });
  it("ignores excluded columns only in the selected digest, retaining them in the original decoded digest", async () => {
    const row = { ...sourceSamples().player[0], season: "2025", game_id: "2025_06_CAR_PHI" };
    const a = gzipSync(sourceCsv("player", [{ ...row, fantasy_points: "999" }]));
    const b = gzipSync(sourceCsv("player", [{ ...row, fantasy_points: "-99" }]));
    const ra = await inspectCompressedSource(a, request(a)), rb = await inspectCompressedSource(b, request(b));
    expect(ra.selectedRecordsSha256).toBe(rb.selectedRecordsSha256);
    expect(ra.decodedSha256).not.toBe(rb.decodedSha256);
    expect(ra.wireSha256).not.toBe(rb.wireSha256);
  });
  it("requires inclusive byte and row limits, refusing overflow without a partial report", async () => {
    const text = csv(), bytes = gzipSync(text), decodedBytes = Buffer.byteLength(text);
    expect((await inspectCompressedSource(bytes, request(bytes), { limits: { wireBytes: bytes.length, decodedBytes, rows: 1 } })).rows).toBe(1);
    await expect(inspectCompressedSource(bytes, request(bytes), { limits: { wireBytes: bytes.length - 1 } })).rejects.toThrow("compressed-wire-refused");
    await expect(inspectCompressedSource(bytes, request(bytes), { limits: { decodedBytes: decodedBytes - 1 } })).rejects.toThrow("compressed-decoded-budget-exceeded");
    const double = gzipSync(sourceCsv("player", [sourceSamples().player[0], sourceSamples().player[0]]));
    await expect(inspectCompressedSource(double, request(double), { limits: { rows: 1 } })).rejects.toThrow("compressed-row-budget-exceeded");
    await expect(inspectCompressedSource(bytes, request(bytes), { limits: { decodedBytes: COMPRESSED_SOURCE_LIMITS.decodedBytes + 1 } })).rejects.toThrow("compressed-limits-refused");
  });
  it.each(["hash", "truncation", "crc", "not-gzip"])("refuses %s even when CSV prefixes are valid", async variant => {
    const bytes = gzipSync(csv()); let source: Uint8Array = bytes;
    if (variant === "truncation") source = bytes.subarray(0, bytes.length - 4);
    if (variant === "crc") { source = Buffer.from(bytes); source[source.length - 8] ^= 1; }
    if (variant === "not-gzip") source = Buffer.from(csv());
    const r = request(source); if (variant === "hash") r.wireSha256 = "0".repeat(64);
    await expect(inspectCompressedSource(source, r)).rejects.toThrow(variant === "hash" ? "compressed-wire-integrity-failed" : "compressed-gzip-refused");
  });
  it("refuses fatal UTF-8, header drift, malformed CSV and oversized records", async () => {
    const invalid = gzipSync(Buffer.concat([Buffer.from(csv()), Buffer.from([0xc3])]));
    await expect(inspectCompressedSource(invalid, request(invalid))).rejects.toThrow("compressed-utf8-refused");
    const drift = gzipSync(csv().replace("player_id,", "unexpected_id,"));
    await expect(inspectCompressedSource(drift, request(drift))).rejects.toThrow("compressed-header-drift");
    const malformed = gzipSync(csv() + '"unterminated');
    await expect(inspectCompressedSource(malformed, request(malformed))).rejects.toThrow("compressed-csv-refused");
    const record = gzipSync(sourceCsv("player", [{ ...sourceSamples().player[0], player_name: "a".repeat(5000) }]));
    await expect(inspectCompressedSource(record, request(record), { limits: { recordBytes: 4000 } })).rejects.toThrow("compressed-record-budget-exceeded");
  });
  it("enforces record bytes for multibyte text and bounded expansion for highly compressible input", async () => {
    const text = sourceCsv("player", [{ ...sourceSamples().player[0], player_name: "東京".repeat(1000) }]);
    const recordBytes = Buffer.byteLength(text.slice(text.indexOf("\n") + 1));
    expect(recordBytes - 1).toBeGreaterThan(Buffer.byteLength(text.slice(0, text.indexOf("\n") + 1)));
    const unicode = gzipSync(text);
    expect((await inspectCompressedSource(unicode, request(unicode), { limits: { recordBytes } })).rows).toBe(1);
    await expect(inspectCompressedSource(unicode, request(unicode), { limits: { recordBytes: recordBytes - 1 } })).rejects.toThrow("compressed-record-budget-exceeded");
    const expansion = gzipSync(Buffer.alloc(100_000, 0x61));
    expect(expansion.length).toBeLessThan(1000);
    await expect(inspectCompressedSource(expansion, request(expansion), { limits: { decodedBytes: 4096 } })).rejects.toThrow("compressed-decoded-budget-exceeded");
  });
  it("counts data records across BOM, blank lines and concatenated gzip members", async () => {
    const text = '\ufeff' + csv().replace('\n', '\n\n');
    const midpoint = Buffer.byteLength(text) >> 1;
    const source = Buffer.from(text), bytes = Buffer.concat([gzipSync(source.subarray(0, midpoint)), gzipSync(source.subarray(midpoint))]);
    const r = await inspectCompressedSource(bytes, request(bytes));
    expect(r.rows).toBe(1);
    expect(r.decodedSha256).toBe(sha(source));
  });
  it("reports out-of-scope records rather than filtering them", async () => {
    const text = sourceCsv("player", [sourceSamples().player[0], { ...sourceSamples().player[0], season: "2025" }]);
    const bytes = gzipSync(text), r = await inspectCompressedSource(bytes, request(bytes));
    expect(r).toMatchObject({ rows: 2, inScopeRows: 1, outOfScopeRows: 1, publicationSupported: false });
  });
  it("cancels before decoding and during a yielding batch", async () => {
    const bytes = gzipSync(csv()), controller = new AbortController(); controller.abort();
    await expect(inspectCompressedSource(bytes, request(bytes), { signal: controller.signal })).rejects.toThrow("compressed-cancelled");
    const many = gzipSync(sourceCsv("player", Array.from({ length: 3000 }, () => sourceSamples().player[0])));
    const active = new AbortController(); const result = inspectCompressedSource(many, request(many), { signal: active.signal });
    setTimeout(() => active.abort(), 0);
    await expect(result).rejects.toThrow("compressed-cancelled");
  });
  it("reads exact private source bytes and refuses insecure modes, links and wrong sizes", async () => {
    const root = await mkdtemp(join(tmpdir(), "dfs106-codec-cli-"));
    try {
      await chmod(root, 0o700);
      const bytes = gzipSync(csv()), file = join(root, "source.csv.gz");
      await writeFile(file, bytes, { mode: 0o600 });
      const args = ["--feed", "player", "--season", "2025", "--file", file, "--sha256", sha(bytes), "--bytes", String(bytes.length)];
      expect((await runCompressedInspection(args, { NODE_ENV: "test" })).rows).toBe(1);
      await expect(runCompressedInspection([...args.slice(0, -1), String(bytes.length + 1)], { NODE_ENV: "test" })).rejects.toThrow("compressed-inspection-file-refused");
      await chmod(file, 0o644);
      await expect(runCompressedInspection(args, { NODE_ENV: "test" })).rejects.toThrow("compressed-inspection-file-refused");
      await chmod(file, 0o600);
      const alias = join(root, "alias.csv.gz"); await symlink(file, alias);
      await expect(runCompressedInspection(args.map(value => value === file ? alias : value), { NODE_ENV: "test" })).rejects.toThrow();
      await link(file, join(root, "hardlink.csv.gz"));
      await expect(runCompressedInspection(args, { NODE_ENV: "test" })).rejects.toThrow("compressed-inspection-file-refused");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("refuses malformed CLI requests and ambient application credentials before accessing a file", async () => {
    await expect(runCompressedInspection([], { NODE_ENV: "test" })).rejects.toThrow("compressed-inspection-arguments-refused");
    await expect(runCompressedInspection([], { NODE_ENV: "test", DATABASE_URL: "" })).rejects.toThrow("credentials are not allowed");
  });
});
