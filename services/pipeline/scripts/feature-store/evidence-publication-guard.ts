import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { scanTrackedPayloads, type PayloadPolicy } from "./evidence-payload-inventory.ts";

const policyPath = "docs/evidence/feature-store-261/payload-dispositions.json";
/** Check the complete tested Git tree, including unchanged original dependencies.
 * No changed-path selector can hide an encoded archive or a revoked original.
 * Policy changes remain explicit review decisions; detection is not legal clearance.
 */
export const checkPublishedEvidence = (root: string, checkpoint: string) => {
  assert(/^[a-f0-9]{40}$/.test(checkpoint), "publication guard requires an exact checkpoint SHA");
  const policy = JSON.parse(execFileSync("git", ["show", `${checkpoint}:${policyPath}`],
    { cwd: root, encoding: "utf8" })) as PayloadPolicy;
  const inventory = scanTrackedPayloads(root, checkpoint, policy);
  const unapproved = inventory.findings.filter(f => !f.approvedForPublication).map(f => ({ path: f.path, sha256: f.sha256 }));
  assert.equal(unapproved.length, 0, `unapproved published payloads: ${JSON.stringify(unapproved)}`);
  // A pending removal remains forbidden even if a later classifier no longer
  // recognizes its payload shape. The exact owner-selected public file is gone.
  for (const disposition of policy.dispositions.filter(d => d.decision === "remove-going-forward")) {
    assert(!inventory.records.some(r => r.path === disposition.path), `removed archive republished: ${disposition.path}`);
  }
  return { schema: "published-evidence-guard-v1", checkpoint, verdict: "pass", scope: "complete-tested-Git-tree",
    trackedPaths: inventory.summary.trackedPaths, compressedPaths: inventory.summary.compressedPaths,
    archiveLeafMembers: inventory.summary.archiveLeafMembers, decodedJsonStrings: inventory.summary.decodedJsonStrings,
    decodedBase64Sources: inventory.summary.decodedBase64Sources, approvedFindingPaths: inventory.findings.length,
    unapprovedFindingPaths: 0 };
};

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert.equal(process.argv.length, 2, "publication guard accepts no bypass or changed-path arguments");
  const checkpoint = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  process.stdout.write(JSON.stringify(checkPublishedEvidence(process.cwd(), checkpoint)) + "\n");
}
