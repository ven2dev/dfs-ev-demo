import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// Standard USTAR + gzip -n: sorted regular-file entries, fixed metadata, no
// platform-specific tar flags, filesystem extraction, caches or Python tooling.
// Receipts remain the authority for each uncompressed member's SHA-256/size.
export const deterministicEvidenceBundle = (records: { member: string; bytes: Buffer }[]) => {
  assert(records.length > 0); assert.equal(new Set(records.map(r => r.member)).size, records.length);
  const chunks: Buffer[] = [];
  for (const { member, bytes } of [...records].sort((a, b) => a.member < b.member ? -1 : a.member > b.member ? 1 : 0)) {
    assert(/^[a-zA-Z0-9][a-zA-Z0-9_./-]*$/.test(member) && Buffer.byteLength(member) <= 100 &&
      member.split("/").every(part => part && part !== "." && part !== ".."), "unsafe-bundle-member");
    const header = Buffer.alloc(512);
    const octal = (value: number, offset: number, width: number) => {
      const text = value.toString(8); assert(text.length < width, "ustar-field-overflow");
      header.write(text.padStart(width - 1, "0") + "\0", offset, width, "ascii");
    };
    header.write(member, 0, 100, "ascii");
    octal(0o644, 100, 8); octal(0, 108, 8); octal(0, 116, 8);
    octal(bytes.byteLength, 124, 12); octal(0, 136, 12);
    header.fill(32, 148, 156); header.write("0", 156); header.write("ustar\0", 257); header.write("00", 263);
    const checksum = header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0");
    header.write(checksum + "\0 ", 148, 8, "ascii");
    chunks.push(header, bytes, Buffer.alloc((512 - bytes.byteLength % 512) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  return execFileSync("gzip", ["-n", "-c"], { input: Buffer.concat(chunks), maxBuffer: 32 * 1024 * 1024 });
};
