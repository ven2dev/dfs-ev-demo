import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ObjectStore } from "../../src/featureStore/objectStore.ts";
import { evidenceArchiveMembers } from "./evidence-archive.ts";
import { archiveProjectionName, archiveReferenceName, evidenceIdentity, validateArchiveReference, verifyEvidenceIdentity,
  type ArchiveReference } from "./evidence-records.ts";
import { projectCapacityResponses, receiptIdentity, validateEvidenceProjection, type EvidencePublicProjection } from "./evidence-public-projection.ts";
import type { FullCapacityBenchmark } from "./prediction-capacity-evidence.ts";

// This operation does not delete anything. The caller reviews its verified
// receipt and runs both audits before removing the selected public archive.
export const retainEvidenceArchive = async (directory: string, name: string,
  store: Pick<ObjectStore, "putIfAbsent" | "get">) => {
  const bytes = await readFile(resolve(directory, name)), archive = { name, ...evidenceIdentity(bytes), key: "" };
  archive.key = `audits/${archive.sha256}`;
  const members = evidenceArchiveMembers(bytes);
  const receipts = await Promise.all((await readdir(directory)).filter(n => n.endsWith(".json") &&
    !n.endsWith(".reference.json") && !n.endsWith(".public.json")).map(async n => JSON.parse(await readFile(resolve(directory, n), "utf8"))));
  const projection: EvidencePublicProjection = { schema: "prediction-evidence-public-v1", archiveSha256: archive.sha256,
    records: [...members].map(([member, body]) => {
      let full: FullCapacityBenchmark | undefined;
      if (member.endsWith(".json")) {
        const parsed = JSON.parse(body.toString("utf8"));
        if (parsed.kind === "prediction-capacity-benchmark") full = parsed;
      }
      return { member, receipts: receipts.filter(r => r.fullRecord?.path === `${name}#${member}`).map(receiptIdentity),
        ...(full ? { capacity: projectCapacityResponses(full) } : {}) };
    }) };
  validateEvidenceProjection(projection, archive.sha256);
  const publicBytes = Buffer.from(JSON.stringify(projection, null, 2) + "\n");
  const reference: ArchiveReference = { schema: "private-evidence-archive-v1", archive,
    members: [...members].map(([path, body]) => ({ path, ...evidenceIdentity(body) })),
    publicProjection: { path: archiveProjectionName(name), ...evidenceIdentity(publicBytes) } };
  validateArchiveReference(reference, name);
  const retained = [];
  for (const body of [bytes, ...members.values()]) {
    const identity = evidenceIdentity(body), key = `audits/${identity.sha256}`;
    await store.putIfAbsent(key, body);
    verifyEvidenceIdentity(identity, await store.get(key));
    retained.push({ key, ...identity, readbackVerified: true });
  }
  // Verify every member again from the retained archive, rather than trusting
  // the source archive or successful put calls as evidence of durable bytes.
  const reread = await store.get(archive.key); verifyEvidenceIdentity(archive, reread);
  const durable = evidenceArchiveMembers(reread);
  assert.deepEqual([...durable.keys()], [...members.keys()]);
  for (const member of reference.members) verifyEvidenceIdentity(member, durable.get(member.path)!);
  await writeFile(resolve(directory, archiveProjectionName(name)), publicBytes, { flag: "wx" });
  await writeFile(resolve(directory, archiveReferenceName(name)), JSON.stringify(reference, null, 2) + "\n", { flag: "wx" });
  return { archive, members: reference.members, retained, publicProjection: reference.publicProjection };
};
