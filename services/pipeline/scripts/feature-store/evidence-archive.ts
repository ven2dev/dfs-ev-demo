import { gunzipSync } from "node:zlib";

const decoder = new TextDecoder("utf-8", { fatal: true });
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

export const readEvidenceTar = <T>(bytes: Buffer, visit: (name: string, body: Buffer) => T): T[] => {
  check(bytes.length >= 1024 && bytes.length % 512 === 0, "truncated tar");
  const members: T[] = [], seen = new Set<string>();
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

// Auditors use the same USTAR validation as the scanner. No filesystem
// extraction or third-party package is needed for a standalone private audit.
export const evidenceArchiveMembers = (bytes: Buffer) => {
  const raw = gunzipSync(bytes, { maxOutputLength: 256 * 1024 * 1024 });
  return new Map(readEvidenceTar(raw, (name, body) => [name, body] as const));
};
