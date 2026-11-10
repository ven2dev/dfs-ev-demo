import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { sha256, type ObjectStore } from "../../src/featureStore/objectStore.ts";
import { evidenceArchiveMembers, safeEvidencePath } from "./evidence-archive.ts";

export type EvidenceIdentity = { sha256: string; byteSize: number };
export type ArchiveReference = {
  schema: "private-evidence-archive-v1";
  archive: EvidenceIdentity & { name: string; key: string };
  members: (EvidenceIdentity & { path: string })[];
  publicProjection: EvidenceIdentity & { path: string };
};
export type EvidenceAuditOptions = { mode?: "public" | "private"; privateStore?: Pick<ObjectStore, "get"> };
export type EvidenceArchive = {
  mode: "full-bytes"; members: Map<string, Buffer>; reference?: ArchiveReference;
} | { mode: "public-metadata"; reference: ArchiveReference; projection: unknown };
export const archiveReferenceName = (archive: string) => archive.replace(/\.tar\.gz$/, ".reference.json");
export const archiveProjectionName = (archive: string) => archive.replace(/\.tar\.gz$/, ".public.json");
export const evidenceIdentity = (bytes: Buffer): EvidenceIdentity => ({ sha256: sha256(bytes), byteSize: bytes.length });
export const verifyEvidenceIdentity = (identity: EvidenceIdentity, bytes: Buffer) => {
  assert.equal(sha256(bytes), identity.sha256, "evidence-sha256-mismatch");
  assert.equal(bytes.length, identity.byteSize, "evidence-byte-size-mismatch");
};
const exact = (value: object, keys: string[]) => assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), "unexpected-reference-fields");
const identity = (value: EvidenceIdentity) => {
  assert(/^[a-f0-9]{64}$/.test(value.sha256), "invalid-reference-sha256");
  assert(Number.isSafeInteger(value.byteSize) && value.byteSize >= 0, "invalid-reference-size");
};
const archiveName = (name: string) => assert(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*\.tar\.gz$/.test(name), "unexpected-full-record-bundle");
export const validateArchiveReference = (reference: ArchiveReference, expectedName: string) => {
  exact(reference, ["schema", "archive", "members", "publicProjection"]);
  assert.equal(reference.schema, "private-evidence-archive-v1", "unknown-archive-reference-format");
  exact(reference.archive, ["name", "key", "sha256", "byteSize"]); identity(reference.archive);
  archiveName(reference.archive.name); assert.equal(reference.archive.name, expectedName, "reference-archive-mismatch");
  assert.equal(reference.archive.key, `audits/${reference.archive.sha256}`, "reference-object-key-mismatch");
  assert(Array.isArray(reference.members) && reference.members.length > 0, "empty-reference-members");
  const seen = new Set<string>();
  for (const member of reference.members) {
    exact(member, ["path", "sha256", "byteSize"]); identity(member);
    assert(safeEvidencePath(member.path), "unsafe-full-record-member");
    assert(!seen.has(member.path), "duplicate-reference-member"); seen.add(member.path);
  }
  exact(reference.publicProjection, ["path", "sha256", "byteSize"]); identity(reference.publicProjection);
  assert.equal(reference.publicProjection.path, archiveProjectionName(expectedName), "unsafe-public-projection-path");
};
const optionalFile = async (path: string) => {
  try { return await readFile(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
};

// Public mode never discovers a private location from the environment. The
// explicit private mode fails if bytes are unavailable; hashes are no substitute.
export const resolveEvidenceArchive = async (directory: string, name: string,
  options: EvidenceAuditOptions = {}): Promise<EvidenceArchive> => {
  archiveName(name);
  assert(options.mode === undefined || options.mode === "public" || options.mode === "private", "unknown-evidence-audit-mode");
  const referenceBytes = await optionalFile(resolve(directory, archiveReferenceName(name)));
  if (!referenceBytes) return { mode: "full-bytes", members: evidenceArchiveMembers(await readFile(resolve(directory, name))) };
  const reference = JSON.parse(referenceBytes.toString("utf8")) as ArchiveReference;
  validateArchiveReference(reference, name);
  const publicBytes = await readFile(resolve(directory, reference.publicProjection.path));
  verifyEvidenceIdentity(reference.publicProjection, publicBytes);
  const projection = JSON.parse(publicBytes.toString("utf8"));
  assert.equal(projection.schema, "prediction-evidence-public-v1", "unknown-public-projection-format");
  const local = await optionalFile(resolve(directory, name));
  if (options.mode !== "private" && !local) return { mode: "public-metadata", reference, projection };
  assert(local || options.privateStore, "private-evidence-bytes-required");
  const bytes = options.mode === "private" && options.privateStore ? await options.privateStore.get(reference.archive.key)
    : local ?? await options.privateStore!.get(reference.archive.key);
  verifyEvidenceIdentity(reference.archive, bytes);
  const members = evidenceArchiveMembers(bytes);
  assert.deepEqual([...members.keys()].sort(), reference.members.map(m => m.path).sort(), "reference-membership-mismatch");
  for (const member of reference.members) verifyEvidenceIdentity(member, members.get(member.path)!);
  return { mode: "full-bytes", members, reference };
};

export const splitEvidenceAddress = (address: string) => {
  const [archive, member, extra] = address.split("#");
  assert(!address.startsWith("/"), "absolute-full-record-path"); archiveName(archive);
  assert(member && !extra && safeEvidencePath(member), "unsafe-full-record-member");
  return { archive, member };
};

export const resolveEvidenceRecord = async (directory: string, record: EvidenceIdentity & { path: string },
  options: EvidenceAuditOptions = {}) => {
  const { archive, member } = splitEvidenceAddress(record.path), resolved = await resolveEvidenceArchive(directory, archive, options);
  if (resolved.mode === "full-bytes") {
    const bytes = resolved.members.get(member); assert(bytes, "missing-full-record-member");
    verifyEvidenceIdentity(record, bytes);
    return { mode: "full-bytes" as const, bytes };
  }
  const expected = resolved.reference.members.find(m => m.path === member); assert(expected, "missing-full-record-member");
  assert.equal(record.sha256, expected.sha256, "record-reference-sha256-mismatch");
  assert.equal(record.byteSize, expected.byteSize, "record-reference-byte-size-mismatch");
  return { mode: "public-metadata" as const, projection: resolved.projection, member };
};
