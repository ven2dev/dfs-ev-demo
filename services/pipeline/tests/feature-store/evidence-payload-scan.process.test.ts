import { describe, expect, it } from "vitest";
import { gunzipSync, gzipSync } from "node:zlib";
import { deterministicEvidenceBundle } from "../../scripts/feature-store/evidence-bundle.ts";
import { approvedPayload, newScanBudget, payloadCounts, payloadNodes, scanEvidencePayload } from "../../scripts/feature-store/evidence-payload-scan.ts";
import type { PayloadDisposition } from "../../scripts/feature-store/evidence-payload-scan.ts";

// Deliberately invented identities/values; no source row is used by the controls.
const row = { playerId: "invented-player", gameId: "invented-game", forecast: { overProbability: 0.5 }, synthetic: true };
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
const scan = (value: unknown) => scanEvidencePayload("control.json", bytes(value));
const bundle = (name: string, body: Buffer) => deterministicEvidenceBundle([{ member: name, bytes: body }]);
const tar = (name: string, body: Buffer) => gunzipSync(bundle(name, body));
const fixChecksum = (raw: Buffer) => {
  raw.fill(32, 148, 156);
  raw.write(raw.subarray(0, 512).reduce((n, b) => n + b, 0).toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return raw;
};

describe("#261 bounded shared payload decoder", () => {
  it.each([
    ["structured", row],
    ["encoded", { serialized: JSON.stringify(row) }],
    ["double encoded", { serialized: JSON.stringify(JSON.stringify(row)) }],
    ["fragment in a string", { log: `prediction output: ${JSON.stringify(row)} done` }],
  ])("finds %s without publishing field values or accepting a synthetic marker", (_name, value) => {
    const result = scan(value);
    expect(payloadCounts(result)).toEqual({ forecastResponse: 1 });
    expect(JSON.stringify(result)).not.toContain("invented-player");
    expect(JSON.stringify(result)).not.toContain("invented-game");
    expect(approvedPayload(result, [], [])).toBe(false);
  });

  it("finds a log fragment, JSONL and delimited row values", () => {
    expect(payloadCounts(scanEvidencePayload("output.log", Buffer.from(`prefix ${JSON.stringify(row)} suffix`)))).toEqual({ forecastResponse: 1 });
    expect(payloadCounts(scanEvidencePayload("output.jsonl", Buffer.from(`${JSON.stringify(row)}\n${JSON.stringify(row)}\n`)))).toEqual({ forecastResponse: 2 });
    for (const [name, delimiter] of [["control.csv", ","], ["control.tsv", "\t"]]) {
      const data = ["player_id", "game_id", "offense_play_count"].join(delimiter) + "\n" + ["invented-player", "invented-game", "1"].join(delimiter);
      expect(payloadCounts(scanEvidencePayload(name, Buffer.from(data)))).toEqual({ normalizedParticipation: 1 });
    }
  });

  it("recognizes feature, dataset, label and history rows, with timing/identifier-only negatives", () => {
    const identity = { playerId: "invented-player", gameId: "invented-game" };
    expect(payloadCounts(scan({ ...identity, featureId: "feature", value: 1, history: [{ gameId: "older-invented", passingYards: 1 }] })))
      .toEqual({ featureOrDatasetRow: 1, historyRow: 1 });
    expect(payloadCounts(scan({ ...identity, labelId: "label", value: 1 }))).toEqual({ labelRow: 1 });
    expect(payloadCounts(scan({ records: { feature_values: [{ featureId: "feature", value: 1 }], outcome_labels: [{ labelId: "label", value: 1 }] } })))
      .toEqual({ materializedFeatures: 1, materializedLabels: 1 });
    expect(payloadCounts(scan({ ...identity, passingYards: 1 }))).toEqual({ otherRowLevelValues: 1 });
    expect(payloadCounts(scan({ gameId: "invented-game", playId: 1, invalidTokens: [] }))).toEqual({ sourcePlayDiagnostics: 1 });
    expect(payloadCounts(scan({ ...identity, status: "available", elapsedMs: 1, n: 2, sql: 3 }))).toEqual({});
  });

  it("decodes base64 source maps and explicitly declared bytes with hashes", () => {
    const source = bytes({ ...row, value: 1 });
    for (const value of [
      { records: { "sources.json": { "evidence.json": source.toString("base64") } } },
      { encoding: "base64", bytes: source.toString("base64") },
      { contentBase64: source.toString("base64") },
    ]) {
      const result = scan(value);
      expect(payloadCounts(result)).toEqual({ forecastResponse: 1 });
      expect(result.decodedSources).toHaveLength(1);
      expect(result.decodedSources[0].record.byteSize).toBe(source.length);
    }
    // Construct malformed transport at runtime rather than publishing a
    // malformed declared source-map fragment in this tracked test source.
    const invalidBase64 = ["not", "base64"].join("-");
    expect(() => scan({ records: { "sources.json": { "evidence.json": invalidBase64 } } })).toThrow("invalid base64");
    expect(() => scan({ contentBase64: "Zh==" })).toThrow("noncanonical base64");
    // A package name is not a declaration that its version string is encoded.
    expect(() => scan({ dependencies: { "base64-js": "^1.0.0", "@protobufjs/base64": "^1.0.0" } })).not.toThrow();
  });

  it("recurses through nested archives and encoded source containers", () => {
    const result = scanEvidencePayload("outer.tar.gz", bundle("inner.tar.gz", bundle("record.json", bytes(row))));
    expect(payloadCounts(result)).toEqual({ forecastResponse: 1 });
    expect([...payloadNodes(result)].filter(n => n.record.format === "gzip")).toHaveLength(2);
    const encoded = { records: { "sources.json": { "nested.tar.gz": bundle("record.json", bytes(row)).toString("base64") } } };
    expect(payloadCounts(scan(encoded))).toEqual({ forecastResponse: 1 });
  });

  it.each(["../escape.json", "/absolute.json", "C:/absolute.json", "a//b.json", "a/./b.json", "a\\b.json", "a#b.json"])("refuses unsafe member %s", name => {
    const raw = tar("safe.json", bytes(row)); raw.fill(0, 0, 100); raw.write(name);
    expect(() => scanEvidencePayload("bad.tar", fixChecksum(raw))).toThrow("unsafe archive member");
  });

  it("refuses duplicate members, links, corrupted headers, truncation and trailing bytes", () => {
    const raw = tar("record.json", bytes(row));
    expect(() => scanEvidencePayload("bad.tar", Buffer.concat([raw.subarray(0, -1024), raw]))).toThrow("duplicate archive member");
    const link = Buffer.from(raw); link[156] = 50;
    expect(() => scanEvidencePayload("bad.tar", fixChecksum(link))).toThrow("non-regular archive member");
    const corrupt = Buffer.from(raw); corrupt[0] ^= 1;
    expect(() => scanEvidencePayload("bad.tar", corrupt)).toThrow("tar checksum mismatch");
    expect(() => scanEvidencePayload("bad.tar", raw.subarray(0, -1))).toThrow("truncated tar");
    expect(() => scanEvidencePayload("bad.tar", raw.subarray(0, -1024))).toThrow("missing tar end");
    const trailing = Buffer.concat([raw, Buffer.alloc(512)]); trailing[trailing.length - 1] = 1;
    expect(() => scanEvidencePayload("bad.tar", trailing)).toThrow("invalid tar end");
    expect(() => scanEvidencePayload("bad.gz", gzipSync(bytes(row)).subarray(0, -1))).toThrow("invalid gzip");
  });

  it("refuses malformed structured/encoded inputs and unsupported binary/container formats", () => {
    expect(() => scanEvidencePayload("bad.json", Buffer.from("{"))).toThrow("malformed JSON");
    expect(() => scanEvidencePayload("bad.jsonl", Buffer.from('{}\n{'))).toThrow("malformed JSON");
    expect(() => scan({ serialized: "{bad}" })).toThrow("malformed serialized JSON");
    for (const name of ["bad.zip", "bad.bz2", "bad.xz", "bad.zst", "bad.7z", "bad.rar", "bad.gz"]) {
      expect(() => scanEvidencePayload(name, bytes(row))).toThrow("unsupported or malformed container");
    }
    expect(() => scanEvidencePayload("renamed.txt", Buffer.from([0x50, 0x4b, 3, 4]))).toThrow("unsupported or malformed container");
    expect(() => scanEvidencePayload("bad.bin", Buffer.from([0xff]))).toThrow("unsupported binary");
    expect(() => scanEvidencePayload("bad.bin", Buffer.from([0]))).toThrow("unsupported binary");
  });

  it("bounds input, expansion, recursion, JSON work, fragments and aggregate tree work", () => {
    const data = bytes(row);
    expect(() => scanEvidencePayload("control.json", data, { limits: { inputBytes: 1 } })).toThrow("input byte limit");
    expect(() => scanEvidencePayload("control.json.gz", gzipSync(data), { limits: { expandedBytes: 1 } })).toThrow("expanded byte limit");
    expect(() => scanEvidencePayload("double.gz", gzipSync(gzipSync(data)), { limits: { containerDepth: 1 } })).toThrow("container nesting limit");
    expect(() => scanEvidencePayload("deep.json", bytes({ nested: { nested: row } }), { limits: { jsonDepth: 1 } })).toThrow("JSON nesting limit");
    expect(() => scanEvidencePayload("control.json", data, { limits: { nodes: 1 } })).toThrow("JSON node limit");
    expect(() => scanEvidencePayload("control.log", Buffer.from('{} {}'), { limits: { fragments: 1 } })).toThrow("fragment limit");
    expect(() => scanEvidencePayload("control.tar", tar("record.json", data), { limits: { members: 1 } })).not.toThrow();
    expect(() => scanEvidencePayload("control.tar.gz", bundle("record.json", data), { limits: { members: 1 } })).toThrow("member limit");
    const budget = newScanBudget(), input = gzipSync(Buffer.from('{}'));
    scanEvidencePayload("first.json.gz", input, { budget, limits: { expandedBytes: 3 } });
    expect(() => scanEvidencePayload("second.json.gz", input, { budget, limits: { expandedBytes: 3 } })).toThrow("expanded byte limit");
  });
});

describe("#261 exact owner dispositions", () => {
  const original = scanEvidencePayload("original.json", bytes(row));
  const copy = scanEvidencePayload("copy.json", bytes({ records: { "sources.json": { "original.json": bytes(row).toString("base64") } } }));
  const identity = ({ path, sha256, byteSize }: typeof original) => ({ path, sha256, byteSize });
  const dispositions: PayloadDisposition[] = [
    { ...identity(original), decision: "existing-notice", basis: "scoped original notice" },
    { ...identity(copy), decision: "exact-copy-notice", basis: "owner exact-copy decision", original: identity(original) },
  ];
  it("accepts the exact noticed copy only while its exact original stays approved and present", () => {
    expect(approvedPayload(copy, dispositions, [identity(original)])).toBe(true);
    expect(approvedPayload(copy, dispositions, [])).toBe(false);
    expect(approvedPayload(copy, dispositions.slice(1), [identity(original)])).toBe(false);
    expect(approvedPayload(copy, dispositions, [{ ...identity(original), sha256: "0".repeat(64) }])).toBe(false);
    const held = dispositions.map(d => d.path === original.path ? { ...d, decision: "remove-going-forward" as const } : d);
    expect(approvedPayload(copy, held, [identity(original)])).toBe(false);
  });
  it("refuses changed bytes, size, path and a missing decoded-source proof", () => {
    for (const changed of [ { sha256: "0".repeat(64) }, { byteSize: copy.byteSize + 1 }, { path: "another.json" }, { decodedSources: [] } ]) {
      expect(approvedPayload({ ...copy, ...changed }, dispositions, [identity(original)])).toBe(false);
    }
  });
  it("distinguishes pending removal from permission to republish", () => {
    const removal: PayloadDisposition = { ...identity(copy), decision: "remove-going-forward", basis: "owner deletion" };
    expect(approvedPayload(copy, [removal], [])).toBe(false);
    expect(approvedPayload(copy, [removal], [], true)).toBe(true);
  });
});
