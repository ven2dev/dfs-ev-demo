import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { parse as parseDelimited } from "csv-parse/sync";

export const payloadScanFormat = "published-payload-scan-v1";
export type ScanLimits = { inputBytes: number; expandedBytes: number; containerDepth: number; jsonDepth: number;
  nodes: number; members: number; fragments: number };
export const payloadScanLimits: Readonly<ScanLimits> = Object.freeze({
  inputBytes: 256 * 1024 * 1024,
  expandedBytes: 512 * 1024 * 1024,
  containerDepth: 12,
  jsonDepth: 160,
  nodes: 20_000_000,
  members: 10_000,
  fragments: 1_000_000,
});
export type PayloadKind = "forecastResponse" | "normalizedParticipation" | "featureOrDatasetRow" |
  "labelRow" | "otherRowLevelValues" | "sourcePlayDiagnostics" | "materializedFeatures" |
  "materializedLabels" | "historyRow";
export type PayloadMatch = { count: number; encoded: number; paths: string[] };
export type PayloadScan = {
  path: string;
  sha256: string;
  byteSize: number;
  format: "text" | "png" | "ico" | "gzip" | "tar";
  findings: Partial<Record<PayloadKind, PayloadMatch>>;
  members: PayloadScan[];
  decodedSources: { jsonPath: string; record: PayloadScan }[];
  decodedJsonStrings: number;
  identifierOccurrences: number;
};
export type ScanBudget = { expandedBytes: number; nodes: number; members: number; fragments: number };
export const newScanBudget = (): ScanBudget => ({ expandedBytes: 0, nodes: 0, members: 0, fragments: 0 });
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const normalize = (key: string) => key.toLowerCase().replace(/[^a-z0-9]/g, "");
const decoder = new TextDecoder("utf-8", { fatal: true });
const identifier = /00-\d{7}|20\d{2}_\d{2}_[A-Z]{2,3}_[A-Z]{2,3}/g;

const check: (condition: unknown, message: string) => asserts condition = (condition, message) => {
  if (!condition) throw new Error(`payload-scan: ${message}`);
};

// No extraction, links, platform separators or ambiguous names. The same
// member grammar is used for nested containers and decoded source-map paths.
export const safeEvidencePath = (path: string) => path.length > 0 && !/[\\\x00-\x1f#]/.test(path) &&
  !/^(?:\/|[a-z]:)/i.test(path) && path.split("/").every(part => part && part !== "." && part !== "..");

const octal = (bytes: Buffer) => {
  const value = bytes.toString("ascii").split("\0", 1)[0].trim();
  check(/^[0-7]+$/.test(value), "invalid tar number");
  const number = Number.parseInt(value, 8);
  check(Number.isSafeInteger(number), "tar number overflow");
  return number;
};

const readTar = (bytes: Buffer, visit: (name: string, body: Buffer) => PayloadScan): PayloadScan[] => {
  check(bytes.length >= 1024 && bytes.length % 512 === 0, "truncated tar");
  const members: PayloadScan[] = [], seen = new Set<string>();
  let offset = 0;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) {
      check(bytes.length - offset >= 1024 && bytes.subarray(offset).every(byte => byte === 0), "invalid tar end");
      return members;
    }
    check(header.subarray(257, 262).toString("ascii") === "ustar", "unsupported tar header");
    const expected = octal(header.subarray(148, 156));
    const checksum = header.reduce((sum, byte, i) => sum + (i >= 148 && i < 156 ? 32 : byte), 0);
    check(checksum === expected, "tar checksum mismatch");
    const field = (start: number, end: number) => decoder.decode(header.subarray(start, end)).split("\0", 1)[0];
    const prefix = field(345, 500), name = (prefix ? `${prefix}/` : "") + field(0, 100);
    check(safeEvidencePath(name), "unsafe archive member");
    check(!seen.has(name), "duplicate archive member"); seen.add(name);
    check(header[156] === 0 || header[156] === 48, "non-regular archive member");
    check(header.subarray(157, 257).every(byte => byte === 0), "tar link target");
    const size = octal(header.subarray(124, 136));
    const end = offset + 512 + size, paddedEnd = Math.ceil(end / 512) * 512;
    check(paddedEnd <= bytes.length, "truncated tar member");
    check(bytes.subarray(end, paddedEnd).every(byte => byte === 0), "nonzero tar padding");
    members.push(visit(name, bytes.subarray(offset + 512, end)));
    offset = paddedEnd;
  }
  throw new Error("payload-scan: missing tar end");
};

// Find balanced JSON candidates in logs/source text without repeatedly parsing
// every suffix. Invalid source-language candidates are ignored; .json/.jsonl
// and explicitly encoded inputs below are parsed strictly.
function* fragments(text: string, budget: ScanBudget, limits: ScanLimits): Generator<unknown> {
  for (let i = 0; i < text.length; i++) {
    const first = text[i];
    if (first !== "{" && first !== "[" && first !== '"') continue;
    check(++budget.fragments <= limits.fragments, "fragment limit");
    let quoted = first === '"', escaped = false, depth = quoted ? 0 : 1, end = i + 1;
    for (; end < text.length; end++) {
      const char = text[end];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') { quoted = false; if (depth === 0) break; }
        else if (char === "\n" || char === "\r") break;
      } else if (char === '"') quoted = true;
      else if (char === "{" || char === "[") {
        check(++depth <= limits.jsonDepth, "fragment nesting limit");
      } else if (char === "}" || char === "]") { if (--depth === 0) break; }
    }
    if (end >= text.length) continue;
    let value: unknown;
    try { value = JSON.parse(text.slice(i, end + 1)); } catch { continue; }
    yield value;
    i = end;
  }
}

const classify = (row: Record<string, unknown>, table: string): PayloadKind[] => {
  const keys = new Set(Object.keys(row).map(normalize)), has = (...names: string[]) => names.some(n => keys.has(n));
  const kinds = new Set<PayloadKind>(), game = has("gameid", "nflversegameid", "gamekey");
  if (game && has("playerid", "gsisid")) {
    if (has("forecast", "overprobability", "underprobability", "probabilities", "modelprobability")) kinds.add("forecastResponse");
    if (has("offenseplaycount")) kinds.add("normalizedParticipation");
    if (has("featureid") && has("history", "value")) kinds.add("featureOrDatasetRow");
    if ((has("labelid") || has("outcome")) && has("value")) kinds.add("labelRow");
    if (kinds.size === 0 && has("history", "historygaps", "labelvalue", "passingyards", "actualvalue", "yards", "label")) {
      kinds.add("otherRowLevelValues");
    }
  }
  if (game && has("playid") && has("invalidtokens", "offenseplayers", "defenseplayers")) kinds.add("sourcePlayDiagnostics");
  if (table === "featurevalues" && has("featureid") && has("value")) kinds.add("materializedFeatures");
  if (table === "outcomelabels" && has("labelid") && has("value")) kinds.add("materializedLabels");
  if (["history", "usablehistory", "historygaps"].includes(table) && game && has("passingyards", "offenseplaycount", "value", "yards")) {
    kinds.add("historyRow");
  }
  return [...kinds].sort();
};

/** Pure bounded decoder shared by inventory generation and the CI guard.
 * A caller scanning a tree shares one budget across every root. No row values
 * are returned: only addresses/counts, cryptographic identity and format data.
 */
export const scanEvidencePayload = (path: string, bytes: Buffer,
  options: { limits?: Partial<ScanLimits>; budget?: ScanBudget } = {}): PayloadScan => {
  const limits = { ...payloadScanLimits, ...options.limits }, budget = options.budget ?? newScanBudget();
  for (const value of Object.values(limits)) check(Number.isSafeInteger(value) && value > 0, "invalid limit");
  const charge = (size: number) => {
    budget.expandedBytes += size;
    check(budget.expandedBytes <= limits.expandedBytes, "expanded byte limit");
  };
  const scan = (name: string, body: Buffer, level: number): PayloadScan => {
    check(safeEvidencePath(name), "unsafe source path");
    check(level <= limits.containerDepth, "container nesting limit");
    check(body.length <= limits.inputBytes, "input byte limit");
    const record: PayloadScan = { path: name, sha256: digest(body), byteSize: body.length, format: "text",
      findings: {}, members: [], decodedSources: [], decodedJsonStrings: 0, identifierOccurrences: 0 };
    const child = (member: string, data: Buffer) => {
      check(++budget.members <= limits.members, "member limit");
      return scan(member, data, level + 1);
    };
    if (body[0] === 0x1f && body[1] === 0x8b) {
      record.format = "gzip";
      const room = Math.min(limits.inputBytes, limits.expandedBytes - budget.expandedBytes);
      check(room > 0, "expanded byte limit");
      let expanded: Buffer;
      try { expanded = gunzipSync(body, { maxOutputLength: room }); }
      catch { throw new Error("payload-scan: invalid gzip or expanded byte limit"); }
      charge(expanded.length);
      record.members.push(child(name.endsWith(".gz") ? name.slice(0, -3) : `${name}.decoded`, expanded));
      return record;
    }
    if (body.subarray(257, 262).toString("ascii") === "ustar" || /\.tar$/i.test(name)) {
      record.format = "tar";
      record.members = readTar(body, child);
      return record;
    }
    const unsupported = /\.(?:gz|tgz|zip|bz2|xz|zst|7z|rar|br)$/i.test(name) ||
      body.subarray(0, 2).toString("ascii") === "PK" || body.subarray(0, 3).toString("ascii") === "BZh" ||
      body.subarray(0, 6).equals(Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0])) ||
      body.subarray(0, 4).equals(Buffer.from([0x28, 0xb5, 0x2f, 0xfd])) ||
      body.subarray(0, 6).equals(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) ||
      body.subarray(0, 4).toString("ascii") === "Rar!";
    check(!unsupported, "unsupported or malformed container");
    if (body.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) { record.format = "png"; return record; }
    if (body.subarray(0, 4).equals(Buffer.from([0, 0, 1, 0]))) { record.format = "ico"; return record; }
    let text: string;
    try { text = decoder.decode(body); } catch { throw new Error("payload-scan: unsupported binary"); }
    check(!text.includes("\0"), "unsupported binary");
    record.identifierOccurrences = [...text.matchAll(identifier)].length;
    const match = (row: Record<string, unknown>, location: string, encoded: boolean, table: string) => {
      for (const kind of classify(row, table)) {
        const group = record.findings[kind] ??= { count: 0, encoded: 0, paths: [] };
        group.count++; group.encoded += Number(encoded);
        if (group.paths.length < 3) group.paths.push(location);
      }
    };
    const inspect = (value: unknown, location: string, encoded = false, depth = 0, table = "") => {
      check(depth <= limits.jsonDepth, "JSON nesting limit");
      check(++budget.nodes <= limits.nodes, "JSON node limit");
      if (typeof value === "string") {
        const trimmed = value.trim();
        if (/^[\[{\"]/.test(trimmed)) {
          let decoded: unknown;
          try { decoded = JSON.parse(trimmed); } catch {
            check(table !== "serialized", "malformed serialized JSON");
          }
          if (decoded !== undefined && decoded !== value) {
            record.decodedJsonStrings++;
            inspect(decoded, `${location}<json>`, true, depth + 1, table);
            return;
          }
        }
        // Fragments in logs/command output use the same decoder as root text.
        if (/(?:player_?Id|game_?Id|gsis_id|sampleRows|offense_play_count)/i.test(value)) {
          let i = 0;
          for (const piece of fragments(value, budget, limits)) {
            if (piece !== value) inspect(piece, `${location}<fragment:${i++}>`, true, depth + 1, table);
          }
        }
      } else if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) inspect(value[i], `${location}[${i}]`, encoded, depth + 1, table);
      } else if (value && typeof value === "object") {
        const row = value as Record<string, unknown>;
        match(row, location, encoded, table);
        for (const [key, field] of Object.entries(row)) {
          const address = `${location}[${JSON.stringify(key)}]`;
          const base64 = typeof field === "string" && (["base64", "contentbase64", "bytesbase64", "sourcebase64", "database64", "textbase64", "payloadbase64"].includes(normalize(key)) || table === "sourcesjson" ||
            (row.encoding === "base64" && ["content", "data", "bytes"].includes(key)));
          if (base64) {
            check(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(field), `invalid base64 at ${name}:${address}`);
            const decoded = Buffer.from(field, "base64");
            check(decoded.toString("base64") === field, "noncanonical base64");
            charge(decoded.length);
            record.decodedSources.push({ jsonPath: address, record: child(table === "sourcesjson" ? key : `${key}.decoded`, decoded) });
          } else inspect(field, address, encoded, depth + 1, normalize(key));
        }
      }
    };
    const strict = (source: string, location: string) => {
      let parsed: unknown;
      try { parsed = JSON.parse(source); } catch { throw new Error("payload-scan: malformed JSON"); }
      inspect(parsed, location);
    };
    if (/\.json$/i.test(name)) strict(text, "$");
    else if (/\.jsonl$/i.test(name)) {
      text.split(/\r?\n/).forEach((line, i) => { if (line.trim()) strict(line, `$line:${i + 1}`); });
    } else if (/\.(?:csv|tsv)$/i.test(name)) {
      const rows = parseDelimited(text, { columns: true, bom: true, delimiter: /\.tsv$/i.test(name) ? "\t" : "," }) as Record<string, unknown>[];
      rows.forEach((row, i) => inspect(row, `$row:${i}`));
    } else {
      let i = 0;
      for (const value of fragments(text, budget, limits)) inspect(value, `$fragment:${i++}`);
    }
    return record;
  };
  return scan(path, bytes, 0);
};

export function* payloadNodes(record: PayloadScan, address = record.path): Generator<{ address: string; record: PayloadScan }> {
  yield { address, record };
  for (const child of record.members) yield* payloadNodes(child, `${address}#${child.path}`);
  for (const child of record.decodedSources) yield* payloadNodes(child.record, `${address}${child.jsonPath}<base64>`);
}

export const payloadCounts = (record: PayloadScan) => {
  const counts: Partial<Record<PayloadKind, number>> = {};
  for (const node of payloadNodes(record)) {
    for (const [kind, match] of Object.entries(node.record.findings)) {
      const key = kind as PayloadKind;
      counts[key] = (counts[key] ?? 0) + match.count;
    }
  }
  return counts;
};

export type PayloadDisposition = {
  path: string; sha256: string; byteSize: number;
  decision: "existing-notice" | "independent-example" | "synthetic-control" | "remove-going-forward" | "exact-copy-notice";
  basis: string;
  original?: { path: string; sha256: string; byteSize: number };
};

/** Exact bytes and explicit policy, never a self-declared synthetic flag. */
export const approvedPayload = (record: PayloadScan, dispositions: PayloadDisposition[],
  originals: { path: string; sha256: string; byteSize: number }[], allowPendingRemoval = false) => {
  const decision = dispositions.find(d => d.path === record.path && d.sha256 === record.sha256 && d.byteSize === record.byteSize);
  if (!decision || (decision.decision === "remove-going-forward" && !allowPendingRemoval)) return false;
  if (decision.decision !== "exact-copy-notice") return true;
  const original = decision.original;
  if (!original || !dispositions.some(d => d.path === original.path && d.sha256 === original.sha256 &&
      d.byteSize === original.byteSize && d.decision === "existing-notice")) return false;
  if (!originals.some(o => o.path === original.path && o.sha256 === original.sha256 && o.byteSize === original.byteSize)) return false;
  return [...payloadNodes(record)].some(n => n.record.path === original.path && n.record.sha256 === original.sha256 &&
    n.record.byteSize === original.byteSize && n.address.endsWith("<base64>"));
};
