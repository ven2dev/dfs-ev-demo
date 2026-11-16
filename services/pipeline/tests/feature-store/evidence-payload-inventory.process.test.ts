import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanTrackedPayloads } from "../../scripts/feature-store/evidence-payload-inventory.ts";
import type { PayloadPolicy } from "../../scripts/feature-store/evidence-payload-inventory.ts";
import { scanEvidencePayload } from "../../scripts/feature-store/evidence-payload-scan.ts";

const policy: PayloadPolicy = { schema: "published-payload-policy-v1", decisionUrl: "synthetic-test-decision", dispositions: [] };

describe("#261 inventory provenance", () => {
  it("pins exact Git bytes and introductions, ignoring untracked/current edits and reporting unapproved payloads", () => {
    const root = mkdtempSync(join(tmpdir(), "dfs261-inventory-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    const commit = (message: string) => git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "-c", "commit.gpgsign=false", "commit", "-m", message);
    try {
      git("init"); writeFileSync(join(root, "plain.json"), '{"elapsedMs":1}\n'); git("add", "plain.json");
      commit("synthetic timing fixture"); const first = git("rev-parse", "HEAD");
      const source = Buffer.from(JSON.stringify({ playerId: "invented", gameId: "invented", featureId: "invented", value: 1 }));
      writeFileSync(join(root, "row.json"), source); git("add", "row.json"); commit("synthetic payload fixture");
      const checkpoint = git("rev-parse", "HEAD");
      writeFileSync(join(root, "untracked.json"), source); writeFileSync(join(root, "plain.json"), "broken current worktree");
      const result = scanTrackedPayloads(root, checkpoint, policy);
      expect(result.summary.trackedPaths).toBe(2);
      expect(result.summary.unclassifiedFindings).toEqual(["row.json"]);
      expect(result.records.find(r => r.path === "plain.json")?.introducedAtCurrentPath).toBe(first);
      expect(result.records.find(r => r.path === "row.json")?.introducedAtCurrentPath).toBe(checkpoint);
      expect(result.records.find(r => r.path === "row.json")?.gitBlob).toBe(git("rev-parse", `${checkpoint}:row.json`));
      const row = scanEvidencePayload("row.json", source);
      const decided: PayloadPolicy = { ...policy, dispositions: [ { path: row.path, sha256: row.sha256, byteSize: row.byteSize,
        decision: "synthetic-control", basis: "exact invented fixture" } ] };
      expect(scanTrackedPayloads(root, checkpoint, decided).summary.unclassifiedFindings).toEqual([]);
      expect(() => scanTrackedPayloads(root, "HEAD", policy)).toThrow("exact checkpoint");
      expect(() => scanTrackedPayloads(root, checkpoint, { ...policy, schema: "unknown" as PayloadPolicy["schema"] })).toThrow("unknown payload policy");
      symlinkSync("row.json", join(root, "link.json")); git("add", "link.json"); commit("synthetic unsupported link");
      expect(() => scanTrackedPayloads(root, git("rev-parse", "HEAD"), policy)).toThrow("unsupported tracked mode");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("keeps #169 approvals exact and dependent on the #138 original", () => {
    const ownerPolicy = JSON.parse(readFileSync("docs/evidence/feature-store-261/payload-dispositions.json", "utf8")) as PayloadPolicy;
    const copies = ownerPolicy.dispositions.filter(d => d.decision === "exact-copy-notice");
    expect(copies.map(c => c.sha256)).toEqual([
      "99fa7a58f3d73e41b3c7f0d08c0350ece1442e16e567c35d951adca8d4eba230",
      "0a119dfed3b46860631ef912aa2db2e88c931ca76601edf87254dc3d9876fcd0",
    ]);
    expect(copies.every(c => c.original?.sha256 === "a08d54d2c8a53eb550a900a81ad32ce70d7fc9e44683fea7dcfd2f310e743db9" && c.original.byteSize === 22624)).toBe(true);
    expect(ownerPolicy.dispositions.filter(d => d.decision === "remove-going-forward")).toHaveLength(3);
  });
});
