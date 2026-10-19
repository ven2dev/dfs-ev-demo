// @vitest-environment node
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  GATE_DOMAIN_SEPARATOR,
  MAXIMUM_FEATURE_COUNT,
  ReadinessGateError,
  buildReadinessGate,
  canonicalGateManifest,
  computeGateCommitment,
  parsePrivateGateRecord,
  parseReadinessGate,
  loadReadinessGate,
  registerReadinessGate,
} from "./readinessGate.ts";
import { writePrivateJson } from "./privateOutput.ts";
import { loadRegistration } from "./creatorInputs.ts";

const paths: string[] = [];
const directory = async () => {
  const path = await mkdtemp(join(tmpdir(), "creator-gate-"));
  paths.push(path);
  return path;
};

afterEach(async () => {
  await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("readiness gate commitment", () => {
  const saltHex = "01".repeat(32);

  it("sorts the private keys into one canonical manifest and binds the domain and salt", () => {
    expect(canonicalGateManifest(["creator-b", "creator-a"])).toBe(
      '{"formatVersion":1,"eligibleCreatorKeys":["creator-a","creator-b"]}'
    );
    expect(GATE_DOMAIN_SEPARATOR).toBe("dfs-ev-demo:creator-readiness-gate:v1\0");
    expect(computeGateCommitment(["creator-b", "creator-a"], saltHex)).toBe(
      "b141c0ac499bc5e3773d636b703ef3b94466048fb3b6dbcf8c4da6335ff5743a"
    );
    expect(computeGateCommitment(["creator-a"], saltHex)).not.toBe(
      computeGateCommitment(["creator-b"], saltHex)
    );
  });

  it("rejects malformed, unsorted, duplicate, or weak private records", () => {
    for (const value of [
      null,
      { formatVersion: 1, eligibleCreatorKeys: ["creator-b", "creator-a"], saltHex },
      { formatVersion: 1, eligibleCreatorKeys: ["creator-a", "creator-a"], saltHex },
      { formatVersion: 1, eligibleCreatorKeys: ["Creator"], saltHex },
      { formatVersion: 1, eligibleCreatorKeys: ["creator-a"], saltHex: "01" },
      { formatVersion: 1, eligibleCreatorKeys: ["creator-a"], saltHex, extra: true },
    ]) {
      expect(() => parsePrivateGateRecord(value)).toThrow(ReadinessGateError);
    }
  });

  it("fixes the approved thresholds, window and ten-parameter complexity ceiling", () => {
    const gate = buildReadinessGate({
      keys: ["creator-a", "creator-b"],
      saltHex,
      registeredAt: "2026-10-12T04:51:56.000Z",
      endSeason: 2026,
      endWeek: 4,
      ruleVersion: "v1",
    });
    expect(parseReadinessGate(gate)).toMatchObject({
      eligibleCreatorCount: 2,
      minimumReviewedGradablePicksOverall: 500,
      minimumReviewedGradablePicksPerCreator: 100,
      maximumFeatureCount: MAXIMUM_FEATURE_COUNT,
      collectionWindow: {
        startSeason: 2024,
        startWeek: 1,
        endSeason: 2026,
        endWeek: 4,
        seasonType: "regular",
      },
      ruleVersion: "v1",
    });
    expect(() => parseReadinessGate({ ...gate, maximumFeatureCount: 11 })).toThrow(
      expect.objectContaining({ code: "invalid-readiness-gate" })
    );
  });

  it("keeps the committed public gate aligned with the registered collection contract", async () => {
    const gate = await loadReadinessGate();
    const registration = await loadRegistration();
    expect(gate.collectionWindow).toEqual({
      startSeason: 2024,
      startWeek: 1,
      endSeason: registration.window.endSeason,
      endWeek: registration.window.endWeek,
      seasonType: "regular",
    });
    expect(gate.ruleVersion).toBe(registration.ruleVersion);
    expect(gate.eligibleCreatorCount).toBeGreaterThan(0);
    expect(JSON.stringify(gate)).not.toMatch(/eligibleCreatorKeys|saltHex|creator-[a-z]/);
  });
});

describe("owner-only gate registration", () => {
  it("writes only opaque keys and salt privately, and only the commitment publicly", async () => {
    const root = await directory();
    const creatorsPath = join(root, "creators.json");
    const privateRecordPath = join(root, "gate-private.json");
    const publicPath = join(root, "readiness-gate.json");
    await writePrivateJson(creatorsPath, [
      { key: "creator-b", name: "Synthetic B", seedVideoId: "bbbbbbbbbbb" },
      { key: "creator-a", name: "Synthetic A", seedVideoId: "aaaaaaaaaaa" },
    ]);

    const gate = await registerReadinessGate({
      creatorsPath,
      privateRecordPath,
      outputPath: publicPath,
      now: new Date("2026-10-12T04:51:56.000Z"),
    });
    const privateText = await readFile(privateRecordPath, "utf8");
    const publicText = await readFile(publicPath, "utf8");
    expect(privateText).toContain('"eligibleCreatorKeys"');
    expect(privateText).toContain('"saltHex"');
    expect(privateText).not.toContain("Synthetic");
    expect(publicText).not.toContain("creator-a");
    expect(publicText).not.toContain("saltHex");
    expect(JSON.parse(publicText)).toEqual(gate);
  });

  it("reuses the private commitment record after an interrupted public write and refuses creator drift", async () => {
    const root = await directory();
    const creatorsPath = join(root, "creators.json");
    const privateRecordPath = join(root, "gate-private.json");
    await writePrivateJson(creatorsPath, [
      { key: "creator-a", name: "Synthetic", seedVideoId: "aaaaaaaaaaa" },
    ]);
    const first = await registerReadinessGate({
      creatorsPath,
      privateRecordPath,
      outputPath: join(root, "first.json"),
      now: new Date("2026-10-12T04:51:56.000Z"),
    });
    const second = await registerReadinessGate({
      creatorsPath,
      privateRecordPath,
      outputPath: join(root, "second.json"),
      now: new Date("2026-10-12T05:00:00.000Z"),
    });
    expect(second.commitment).toEqual(first.commitment);

    const changed = join(root, "changed.json");
    await writePrivateJson(changed, [
      { key: "creator-b", name: "Synthetic", seedVideoId: "bbbbbbbbbbb" },
    ]);
    await expect(registerReadinessGate({
      creatorsPath: changed,
      privateRecordPath,
      outputPath: join(root, "third.json"),
      now: new Date(),
    })).rejects.toMatchObject({ code: "gate-creators-changed" });
  });

  it("does not create a replacement private record when the immutable public gate already exists", async () => {
    const root = await directory();
    const creatorsPath = join(root, "creators.json");
    const privateRecordPath = join(root, "gate-private.json");
    const publicPath = join(root, "readiness-gate.json");
    await writePrivateJson(creatorsPath, [
      { key: "creator-a", name: "Synthetic", seedVideoId: "aaaaaaaaaaa" },
    ]);
    await writeFile(publicPath, "already registered\n");
    await expect(registerReadinessGate({
      creatorsPath,
      privateRecordPath,
      outputPath: publicPath,
      now: new Date(),
    })).rejects.toMatchObject({ code: "readiness-gate-exists" });
    await expect(access(privateRecordPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
