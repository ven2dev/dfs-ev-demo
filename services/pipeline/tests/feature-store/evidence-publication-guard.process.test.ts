import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { checkPublishedEvidence } from "../../scripts/feature-store/evidence-publication-guard.ts";
import { deterministicEvidenceBundle } from "../../scripts/feature-store/evidence-bundle.ts";
import { evidenceArchiveMembers } from "../../scripts/feature-store/evidence-archive.ts";
import { evidenceIdentity } from "../../scripts/feature-store/evidence-records.ts";
import type { PayloadPolicy } from "../../scripts/feature-store/evidence-payload-inventory.ts";

const policyPath = "docs/evidence/feature-store-261/payload-dispositions.json";
const invented = { playerId: "invented-player", gameId: "invented-game", forecast: { overProbability: 0.5 }, synthetic: true };
const fixture = (run: (f: { root: string; pin: () => string; write: (path: string, data: string | Buffer) => void }) => void) => {
  const root = mkdtempSync(join(tmpdir(), "dfs261-guard-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const write = (path: string, data: string | Buffer) => {
    const target = join(root, path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, data);
  };
  const pin = () => {
    git("add", ".");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "synthetic guard test checkpoint");
    return git("rev-parse", "HEAD");
  };
  try {
    git("init"); write(policyPath, JSON.stringify({ schema: "published-payload-policy-v1", decisionUrl: "synthetic-test", dispositions: [] }));
    run({ root, pin, write });
  } finally { rmSync(root, { recursive: true, force: true }); }
};

describe("#261 complete-tree CI publication guard", () => {
  it.each(["structured", "encoded", "double-encoded", "base64-source-map", "nested-archive"])("rejects a new %s payload despite its synthetic marker", encoding => {
    fixture(({ root, pin, write }) => {
      write("timing.json", JSON.stringify({ totalMs: 1, sql: 3 }));
      expect(checkPublishedEvidence(root, pin())).toMatchObject({ verdict: "pass", trackedPaths: 2, unapprovedFindingPaths: 0 });
      let value: unknown = invented;
      if (encoding === "encoded") value = { serialized: JSON.stringify(value) };
      if (encoding === "double-encoded") value = { serialized: JSON.stringify(JSON.stringify(value)) };
      if (encoding === "base64-source-map") value = { records: { "sources.json": { "output.json": Buffer.from(JSON.stringify(value)).toString("base64") } } };
      const bytes = Buffer.from(JSON.stringify(value));
      if (encoding === "nested-archive") write("output.tar.gz", deterministicEvidenceBundle([{ member: "nested.tar.gz",
        bytes: deterministicEvidenceBundle([{ member: "output.json", bytes }]) }]));
      else write("output.json", bytes);
      expect(() => checkPublishedEvidence(root, pin())).toThrow("unapproved published payloads");
    });
  });

  it("uses the complete exact Git tree and its pinned policy; uncommitted policy cannot approve a finding", () => {
    fixture(({ root, pin, write }) => {
      write("old-output.json", JSON.stringify(invented)); const failedPin = pin();
      write("unrelated.md", "documentation only");
      const unrelatedPin = pin();
      expect(() => checkPublishedEvidence(root, unrelatedPin)).toThrow("unapproved published payloads");
      write(policyPath, JSON.stringify({ schema: "published-payload-policy-v1", decisionUrl: "synthetic", dispositions: [
        { path: "old-output.json", ...evidenceIdentity(Buffer.from(JSON.stringify(invented))), decision: "synthetic-control", basis: "exact invented fixture" },
      ] }));
      expect(() => checkPublishedEvidence(root, failedPin)).toThrow("unapproved published payloads");
      expect(() => checkPublishedEvidence(root, unrelatedPin)).toThrow("unapproved published payloads");
      expect(checkPublishedEvidence(root, pin())).toMatchObject({ verdict: "pass", approvedFindingPaths: 1 });
      expect(() => checkPublishedEvidence(root, "HEAD")).toThrow("exact checkpoint SHA");
      const bypass = spawnSync(process.execPath, [resolve("services/pipeline/scripts/feature-store/evidence-publication-guard.ts"), "--changed-only"],
        { cwd: root, encoding: "utf8" });
      expect(bypass.error).toBeUndefined();
      expect(bypass.status).toBe(1);
      expect(bypass.stderr).toContain("publication guard accepts no bypass or changed-path arguments");
      expect(bypass.stdout).toBe("");
    });
  });

  it("fails closed on unsupported containers and a republished owner-selected archive", () => {
    fixture(({ root, pin, write }) => {
      write("unknown.zip", Buffer.from("unsupported"));
      expect(() => checkPublishedEvidence(root, pin())).toThrow("scan failed: unknown.zip");
      rmSync(join(root, "unknown.zip"));
      const name = "removed.tar.gz", bytes = deterministicEvidenceBundle([{ member: "timing.json", bytes: Buffer.from('{}') }]);
      // Even a classifier-negative archive at a selected removal path is refused.
      write(name, bytes);
      write(policyPath, JSON.stringify({ schema: "published-payload-policy-v1", decisionUrl: "synthetic", dispositions: [
        { path: name, sha256: "a".repeat(64), byteSize: 1, decision: "remove-going-forward", basis: "synthetic owner removal control" },
      ] }));
      expect(() => checkPublishedEvidence(root, pin())).toThrow("removed archive republished");
    });
  });

  it("checks the two real #169 copies by exact hashes and withdraws approval when their original disappears or is held", () => {
    fixture(({ root, pin, write }) => {
      const policy = JSON.parse(readFileSync(policyPath, "utf8")) as PayloadPolicy;
      const copies = policy.dispositions.filter(d => d.decision === "exact-copy-notice"), originalPath = copies[0].original!.path;
      const original = policy.dispositions.find(d => d.path === originalPath)!;
      const scoped: PayloadPolicy = { ...policy, dispositions: [original, ...copies] };
      write(policyPath, JSON.stringify(scoped)); write(originalPath, readFileSync(originalPath));
      for (const copy of copies) write(copy.path, readFileSync(copy.path));
      expect(checkPublishedEvidence(root, pin())).toMatchObject({ verdict: "pass", approvedFindingPaths: 3, decodedBase64Sources: 154 });
      rmSync(join(root, originalPath));
      expect(() => checkPublishedEvidence(root, pin())).toThrow("unapproved published payloads");
      write(originalPath, readFileSync(originalPath));
      scoped.dispositions[0] = { ...original, decision: "remove-going-forward" };
      write(policyPath, JSON.stringify(scoped));
      expect(() => checkPublishedEvidence(root, pin())).toThrow("unapproved published payloads");
      scoped.dispositions[0] = original; write(policyPath, JSON.stringify(scoped));
      const archive = evidenceArchiveMembers(readFileSync(copies[0].path));
      const changed = deterministicEvidenceBundle([...archive].map(([member, bytes]) => ({ member, bytes: Buffer.concat([bytes, Buffer.from("\n")]) })));
      write(copies[0].path, changed);
      expect(() => checkPublishedEvidence(root, pin())).toThrow("unapproved published payloads");
    });
  });

  it("passes the real post-removal branch tree with every root/member scanned", () => {
    const checkpoint = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const expectedPaths = execFileSync("git", ["ls-tree", "-rz", "--full-tree", checkpoint]).toString().split("\0").filter(Boolean).length;
    const result = checkPublishedEvidence(process.cwd(), checkpoint);
    expect(result).toMatchObject({ checkpoint, verdict: "pass", trackedPaths: expectedPaths,
      approvedFindingPaths: 8, unapprovedFindingPaths: 0, compressedPaths: 30, archiveLeafMembers: 341 });
  });
});
