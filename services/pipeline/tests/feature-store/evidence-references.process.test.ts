import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { deterministicEvidenceBundle } from "../../scripts/feature-store/evidence-bundle.ts";
import { compactBehavior, verifyEvidenceBundle } from "../../scripts/feature-store/artifact-governance-evidence.ts";
import { retainEvidenceArchive } from "../../scripts/feature-store/evidence-retention.ts";
import { archiveProjectionName, archiveReferenceName, evidenceIdentity, resolveEvidenceArchive, resolveEvidenceRecord,
  validateArchiveReference, type ArchiveReference } from "../../scripts/feature-store/evidence-records.ts";
import { validateEvidenceProjection, type EvidencePublicProjection } from "../../scripts/feature-store/evidence-public-projection.ts";
import type { ObjectStore } from "../../src/featureStore/objectStore.ts";

const archive = "synthetic-records.tar.gz", member = "run/full.json";
const memoryStore = () => {
  const objects = new Map<string, Buffer>();
  const store: Pick<ObjectStore, "putIfAbsent" | "get"> = {
    putIfAbsent: async (key, input) => {
      const bytes = Buffer.from(input), created = !objects.has(key);
      if (created) objects.set(key, bytes);
      return { created, object: { key, ...evidenceIdentity(bytes) } };
    },
    get: async key => { const value = objects.get(key); if (!value) throw new Error("object-unavailable"); return Buffer.from(value); },
  };
  return { store, objects };
};
const fixture = async (run: (value: { directory: string; store: ReturnType<typeof memoryStore>["store"];
  objects: Map<string, Buffer>; reference: ArchiveReference; receipt: ReturnType<typeof compactBehavior> }) => Promise<void>) => {
  const directory = await mkdtemp(join(tmpdir(), "dfs261-reference-")), { store, objects } = memoryStore();
  try {
    const bytes = Buffer.from(JSON.stringify({ kind: "synthetic-validation", verdict: "pass", tests: 1 }));
    const receipt = compactBehavior(bytes, `${archive}#${member}`);
    await writeFile(join(directory, "receipt.json"), JSON.stringify(receipt));
    await writeFile(join(directory, archive), deterministicEvidenceBundle([{ member, bytes }]));
    await retainEvidenceArchive(directory, archive, store);
    const reference = JSON.parse(await readFile(join(directory, archiveReferenceName(archive)), "utf8")) as ArchiveReference;
    await run({ directory, store, objects, reference, receipt });
  } finally { await rm(directory, { recursive: true, force: true }); }
};

describe("#261 shared archive/reference resolution", () => {
  it("retains exact bytes and every member, then distinguishes public metadata from full private-byte verification", async () => {
    await fixture(async ({ directory, store, objects, reference, receipt }) => {
      expect(objects.size).toBe(2);
      const before = await verifyEvidenceBundle(directory);
      expect(before).toMatchObject([{ audit: "full-bytes", verdict: "pass" }]);
      await rm(join(directory, archive));
      const publicAudit = await verifyEvidenceBundle(directory);
      expect(publicAudit).toMatchObject([{ audit: "public-metadata", verdict: "pass" }]);
      const publicRecord = await resolveEvidenceRecord(directory, receipt.fullRecord);
      expect(publicRecord.mode).toBe("public-metadata");
      expect("bytes" in publicRecord).toBe(false);
      await expect(resolveEvidenceArchive(directory, archive, { mode: "private" })).rejects.toThrow("private-evidence-bytes-required");
      const privateRecord = await resolveEvidenceRecord(directory, receipt.fullRecord, { mode: "private", privateStore: store });
      expect(privateRecord.mode).toBe("full-bytes");
      const privateAudit = await verifyEvidenceBundle(directory, true, { mode: "private", privateStore: store });
      expect(privateAudit).toEqual(before);
      expect(reference.archive.key).toBe(`audits/${reference.archive.sha256}`);
      expect(JSON.stringify(reference)).not.toContain(directory);
      const root = JSON.parse(await readFile(join(directory, archiveReferenceName(archive)), "utf8"));
      root.members[0].sha256 = "0".repeat(64);
      await writeFile(join(directory, archiveReferenceName(archive)), JSON.stringify(root));
      await expect(verifyEvidenceBundle(directory, true, { mode: "private", privateStore: store })).rejects.toThrow("evidence-sha256-mismatch");
    });
  });

  it.each(["schema", "size", "hash", "key", "absolute-extra", "member", "duplicate", "projection-path"])("refuses invalid reference %s", async kind => {
    await fixture(async ({ reference }) => {
      const altered = structuredClone(reference);
      if (kind === "schema") Object.assign(altered, { schema: "unknown" });
      if (kind === "size") altered.archive.byteSize = -1;
      if (kind === "hash") altered.archive.sha256 = "bad";
      if (kind === "key") altered.archive.key = "/private/location";
      if (kind === "absolute-extra") Object.assign(altered, { privatePath: "/private/location" });
      if (kind === "member") altered.members[0].path = "../escape";
      if (kind === "duplicate") altered.members.push(altered.members[0]);
      if (kind === "projection-path") altered.publicProjection.path = "../public.json";
      expect(() => validateArchiveReference(altered, archive)).toThrow();
    });
  });

  it("refuses missing objects, corrupt private bytes, wrong member size and changed public projection before parsing", async () => {
    await fixture(async ({ directory, store, objects, reference, receipt }) => {
      await rm(join(directory, archive));
      await expect(resolveEvidenceArchive(directory, archive, { mode: "private", privateStore: memoryStore().store })).rejects.toThrow("object-unavailable");
      const original = objects.get(reference.archive.key)!;
      objects.set(reference.archive.key, Buffer.from("not an archive"));
      await expect(resolveEvidenceArchive(directory, archive, { mode: "private", privateStore: store })).rejects.toThrow("evidence-sha256-mismatch");
      objects.set(reference.archive.key, original);
      await expect(resolveEvidenceRecord(directory, { ...receipt.fullRecord, byteSize: receipt.fullRecord.byteSize + 1 })).rejects.toThrow("byte-size-mismatch");
      await writeFile(join(directory, reference.publicProjection.path), "not JSON");
      await expect(resolveEvidenceArchive(directory, archive)).rejects.toThrow("evidence-sha256-mismatch");
    });
  });

  it("rejects an unknown projection format even with an updated checksum, or any missing projection/reference/archive", async () => {
    await fixture(async ({ directory, reference }) => {
      await rm(join(directory, archive));
      const bytes = Buffer.from(JSON.stringify({ schema: "unknown" }));
      await writeFile(join(directory, reference.publicProjection.path), bytes);
      reference.publicProjection = { path: reference.publicProjection.path, ...evidenceIdentity(bytes) };
      await writeFile(join(directory, archiveReferenceName(archive)), JSON.stringify(reference));
      await expect(resolveEvidenceArchive(directory, archive)).rejects.toThrow("unknown-public-projection-format");
      await rm(join(directory, reference.publicProjection.path));
      await expect(resolveEvidenceArchive(directory, archive)).rejects.toThrow();
      await rm(join(directory, archiveReferenceName(archive)));
      await expect(resolveEvidenceArchive(directory, archive)).rejects.toThrow();
    });
  });

  it("does not write a retention reference when a readback is corrupt", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dfs261-readback-"));
    try {
      await writeFile(join(directory, archive), deterministicEvidenceBundle([{ member, bytes: Buffer.from('{}') }]));
      const store = memoryStore().store;
      store.get = async () => Buffer.from("corrupt");
      await expect(retainEvidenceArchive(directory, archive, store)).rejects.toThrow("evidence-sha256-mismatch");
      await expect(readFile(join(directory, archiveReferenceName(archive)))).rejects.toThrow();
      expect((await readFile(join(directory, archive))).length).toBeGreaterThan(0);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("enforces the minimal public per-sample fields and known formats", async () => {
    const name = "final-benchmark-full-records-20261108T064349Z.tar.gz";
    const value = JSON.parse(await readFile(`docs/evidence/feature-store-242/${archiveProjectionName(name)}`, "utf8")) as EvidencePublicProjection;
    expect(() => validateEvidenceProjection(value, value.archiveSha256)).not.toThrow();
    for (const field of ["playerId", "gameId", "featureId", "forecast", "context", "serialized", "value"]) {
      const altered = structuredClone(value); Object.assign(altered.records[0].capacity!.samples[0], { [field]: "invented" });
      expect(() => validateEvidenceProjection(altered, value.archiveSha256)).toThrow("unexpected-public-projection-fields");
    }
    const unknown = structuredClone(value); Object.assign(unknown, { schema: "unknown" });
    expect(() => validateEvidenceProjection(unknown, value.archiveSha256)).toThrow("unknown-public-projection-format");
  });

  it("audits the public checkout without node_modules, a database or a private store", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dfs261-standalone-"));
    const copied = new Set<string>(), entry = "services/pipeline/scripts/feature-store/artifact-governance-evidence.ts";
    const copySource = async (path: string): Promise<void> => {
      if (copied.has(path)) return; copied.add(path);
      const name = relative(process.cwd(), path);
      expect(name.startsWith("..")).toBe(false);
      const text = await readFile(path, "utf8"), target = join(directory, name);
      await mkdir(dirname(target), { recursive: true }); await writeFile(target, text);
      for (const match of text.matchAll(/(?:from\s*|import\s*\()\s*["'](\.[^"']+)["']/g)) {
        await copySource(resolve(dirname(path), match[1]));
      }
    };
    try {
      await writeFile(join(directory, "package.json"), '{"type":"module"}');
      await copySource(resolve(entry));
      // The unchanged #169 auditor imports this public hash-only manifest.
      await mkdir(join(directory, "docs/evidence/feature-store-138"), { recursive: true });
      await cp("docs/evidence/feature-store-138/step-3-source-manifest.json",
        join(directory, "docs/evidence/feature-store-138/step-3-source-manifest.json"));
      for (const issue of [168, 242]) {
        const evidence = `docs/evidence/feature-store-${issue}`;
        await cp(evidence, join(directory, evidence), { recursive: true });
        const output = execFileSync(process.execPath, [entry, "audit", evidence], { cwd: directory, encoding: "utf8" });
        const records = output.trim().split("\n").map(line => JSON.parse(line));
        expect(records).toHaveLength(issue === 168 ? 32 : 24);
        expect(records.some(r => r.audit === "public-metadata")).toBe(true);
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
