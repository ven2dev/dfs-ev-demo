import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { approvedPayload, newScanBudget, payloadCounts, payloadNodes, payloadScanFormat,
  payloadScanLimits, scanEvidencePayload } from "./evidence-payload-scan.ts";
import type { PayloadDisposition, PayloadScan } from "./evidence-payload-scan.ts";

export type PayloadPolicy = { schema: "published-payload-policy-v1"; decisionUrl: string; dispositions: PayloadDisposition[] };
export type TrackedPayloadScan = PayloadScan & { gitBlob: string; gitMode: string; introducedAtCurrentPath: string };
const git = (root: string, args: string[]) => execFileSync("git", args, { cwd: root, maxBuffer: payloadScanLimits.inputBytes });

export const scanTrackedPayloads = (root: string, checkpoint: string, policy: PayloadPolicy) => {
  if (!/^[a-f0-9]{40}$/.test(checkpoint)) throw new Error("inventory requires an exact checkpoint SHA");
  if (policy.schema !== "published-payload-policy-v1") throw new Error("unknown payload policy");
  const entries = git(root, ["ls-tree", "-rz", "--full-tree", checkpoint]).toString("utf8").split("\0").filter(Boolean);
  const history = git(root, ["log", "--reverse", "--topo-order", "-m", "--format=commit:%H", "--name-only",
    "--diff-filter=A", "--no-renames", checkpoint]).toString("utf8");
  const introductions = new Map<string, string>(); let commit = "";
  for (const line of history.split("\n")) {
    if (line.startsWith("commit:")) commit = line.slice(7);
    else if (line && !introductions.has(line)) introductions.set(line, commit);
  }
  const budget = newScanBudget(), records: TrackedPayloadScan[] = [];
  for (const entry of entries) {
    const tab = entry.indexOf("\t"), [mode, kind, blob] = entry.slice(0, tab).split(" "), path = entry.slice(tab + 1);
    if (kind !== "blob" || !["100644", "100755"].includes(mode)) throw new Error(`unsupported tracked mode: ${path}`);
    const introducedAtCurrentPath = introductions.get(path);
    if (!introducedAtCurrentPath) throw new Error(`missing introduction: ${path}`);
    try {
      records.push({ ...scanEvidencePayload(path, git(root, ["cat-file", "blob", blob]), { budget }),
        gitBlob: blob, gitMode: mode, introducedAtCurrentPath });
    } catch (error) { throw new Error(`scan failed: ${path}`, { cause: error }); }
  }
  const originals = records.map(r => ({ path: r.path, sha256: r.sha256, byteSize: r.byteSize }));
  let compressedPaths = 0, archiveLeafMembers = 0, decodedJsonStrings = 0, decodedBase64Sources = 0;
  const findings = [];
  const countArchiveLeaves = (r: PayloadScan): number => r.members.length ? r.members.reduce((n, m) => n + countArchiveLeaves(m), 0) : 1;
  for (const record of records) {
    if (record.members.length) { compressedPaths++; archiveLeafMembers += countArchiveLeaves(record); }
    for (const node of payloadNodes(record)) {
      decodedJsonStrings += node.record.decodedJsonStrings;
      decodedBase64Sources += node.record.decodedSources.length;
    }
    const counts = payloadCounts(record);
    if (Object.keys(counts).length) findings.push({ path: record.path, sha256: record.sha256, byteSize: record.byteSize,
      introducedAtCurrentPath: record.introducedAtCurrentPath, counts,
      disposition: policy.dispositions.find(d => d.path === record.path && d.sha256 === record.sha256) ?? null,
      approvedForInventory: approvedPayload(record, policy.dispositions, originals, true),
      approvedForPublication: approvedPayload(record, policy.dispositions, originals) });
  }
  return {
    schema: payloadScanFormat, checkpoint, policy, limits: payloadScanLimits,
    scannerSources: ["evidence-payload-scan.ts", "evidence-payload-inventory.ts", "evidence-archive.ts"].map(name => {
      const source = readFileSync(new URL(name, import.meta.url));
      return { path: `services/pipeline/scripts/feature-store/${name}`,
        sha256: createHash("sha256").update(source).digest("hex"), byteSize: source.length };
    }),
    summary: { trackedPaths: records.length, compressedPaths, archiveLeafMembers, decodedJsonStrings,
      decodedBase64Sources, expandedBytes: budget.expandedBytes, nodes: budget.nodes,
      unclassifiedFindings: findings.filter(f => !f.approvedForInventory).map(f => f.path) },
    scope: "Complete pinned tree; gzip/USTAR recursively, JSON/JSONL, JSON strings/fragments, declared base64 sources and CSV/TSV. No extraction or row values in inventory.",
    limitations: ["Heuristic candidates require explicit classification; absence is not rights clearance.",
      "PNG/ICO are hashed/enumerated; no OCR, steganography or encrypted-container inspection.",
      "Introductions are at the current path; monorepo relocations need earlier-path provenance separately.",
      "Current tree only; owner accepted public history exposure for the selected removals."],
    findings, records,
  };
};

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [checkpoint, policyPath, outputPath, ...extra] = process.argv.slice(2);
  if (!checkpoint || !policyPath || !outputPath || extra.length) throw new Error("usage: evidence-payload-inventory.ts CHECKPOINT POLICY OUTPUT");
  const inventory = scanTrackedPayloads(process.cwd(), checkpoint, JSON.parse(readFileSync(policyPath, "utf8")) as PayloadPolicy);
  writeFileSync(outputPath, JSON.stringify(inventory, null, 2) + "\n", { flag: "wx" });
  process.stdout.write(JSON.stringify(inventory.summary) + "\n");
  if (inventory.summary.unclassifiedFindings.length) process.exitCode = 1;
}
