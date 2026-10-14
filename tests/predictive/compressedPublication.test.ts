import { expect, it } from "vitest";
import { checkCompressedPublicationInput, compressedSourceAsset, prepareCompressedPublication } from "../../src/lib/predictive/compressedPublication.ts";
import { SOURCE_PROFILE_VERSION, sourceAsset } from "../../src/lib/predictive/sourceAdapters.ts";
import { compressedPublicationFixture } from "./fixtures/compressedPublication.ts";

it("pins exact feed season asset header and separate wire identity without changing legacy qualification", () => {
  for (const season of [2025, 2026] as const) for (const feed of ["player", "team"] as const) {
    const { input, source, checkedAt } = compressedPublicationFixture(season, feed);
    const checked = checkCompressedPublicationInput(input, checkedAt);
    expect(checked.request).toEqual({ feed, season, wireSha256: input.artifact.sha256, wireBytes: source.length });
    expect(checked.rightsAtCapture).toBe("rights:csv-synthetic-" + feed);
    expect(checked.rightsAtPreparation).toBe(checked.rightsAtCapture);
    const original = checked.input.profile.assetPattern; input.profile.assetPattern = "changed";
    expect(checked.input.profile.assetPattern).toBe(original);
  }
  expect(sourceAsset("player", 2026).name).toBe("stats_player_week_2026.csv");
  expect(() => sourceAsset("player", 2025)).toThrow("source-scope-refused");
  expect(() => compressedSourceAsset("player", 2024 as 2025)).toThrow("compressed-publication-scope-refused");
});

it("refuses legacy parsers wrong assets filtered snapshots and incompatible profile declarations", () => {
  const { input, checkedAt } = compressedPublicationFixture();
  for (const profile of [ { parserVersion: SOURCE_PROFILE_VERSION }, { provider: "other" }, { releaseTag: "stats_team" },
    { assetPattern: "stats_player_week_2026.csv.gz" }, { headerProfileSha256: "0".repeat(64) },
    { evidenceKinds: ["team-game-stats"] }, { allowlistVersion: "future" } ]) {
    expect(() => checkCompressedPublicationInput({ ...input, profile: { ...input.profile, ...profile } } as never, checkedAt)).toThrow("compressed-publication-profile-refused");
  }
  for (const artifact of [{ retrievalKind: "header-probe" }, { origin: "fixture://filtered" }, { scopeFilter: "QB" },
    { scopeWeek: 6 }, { scopeGameId: "2025_06_CAR_PHI" }, { profileId: "another-profile" }]) {
    expect(() => checkCompressedPublicationInput({ ...input, artifact: { ...input.artifact, ...artifact } } as never, checkedAt)).toThrow();
  }
});

it("requires historical and current research rights and refuses future registration knowledge", async () => {
  const { input, source, checkedAt } = compressedPublicationFixture();
  const root = input.rightsDecisions[0];
  const successor = { ...root, id: "revoked", predecessorId: root.id, allowedUses: [], evidenceKind: "synthetic" as const,
    decidedAt: "2026-10-12T00:00:00.000Z", effectiveFrom: "2026-10-12T00:00:00.000Z" };
  await expect(prepareCompressedPublication(source, { ...input, rightsDecisions: [root, successor] }, checkedAt))
    .rejects.toThrow("compressed-publication-rights-refused");
  expect(() => checkCompressedPublicationInput({ ...input, rightsDecisions: [{ ...root, allowedUses: ["adapter-testing"] }] }, checkedAt))
    .toThrow("compressed-publication-rights-refused");
  expect(() => checkCompressedPublicationInput({ ...input, rightsDecisions: [{ ...root, effectiveFrom: "2026-10-10T00:00:00.000Z" }] }, checkedAt))
    .toThrow("compressed-publication-rights-refused");
  expect(() => checkCompressedPublicationInput({ ...input, rightsDecisions: [root, { ...successor, decidedAt: "2026-10-14T00:00:00.000Z" }] }, checkedAt))
    .toThrow("source-publication-time-refused");
});

it("rejects future capture metadata malformed identities and oversized wire declarations before runtime access", async () => {
  const { input, source, checkedAt } = compressedPublicationFixture();
  for (const patch of [{ capturedAt: "2026-10-14T00:00:00.000Z" }, { captureId: "\ninvalid" },
    { artifact: { ...input.artifact, wireBytes: 8_000_001 } }, { artifact: { ...input.artifact, releaseUpdatedAt: checkedAt } }]) {
    await expect(prepareCompressedPublication(source, { ...input, ...patch }, checkedAt)).rejects.toThrow();
  }
  expect(() => checkCompressedPublicationInput({ ...input, extra: true } as never, checkedAt)).toThrow();
  await expect(prepareCompressedPublication(source, { ...input, artifact: { ...input.artifact, sha256: "0".repeat(64) } }, checkedAt))
    .rejects.toThrow("compressed-wire-integrity-failed");
  await expect(prepareCompressedPublication(source, { ...input, artifact: { ...input.artifact, wireBytes: source.length + 1 } }, checkedAt))
    .rejects.toThrow("compressed-worker-input-refused");
});

it("keeps request identity stable across preparation clocks and binds profile capture and wire changes", () => {
  const { input, checkedAt } = compressedPublicationFixture();
  const hash = checkCompressedPublicationInput(input, checkedAt).requestHash;
  expect(checkCompressedPublicationInput(input, "2026-10-14T12:00:00.000Z").requestHash).toBe(hash);
  for (const changed of [{ ...input, captureId: "another-capture" }, { ...input, artifact: { ...input.artifact, sha256: "1".repeat(64) } },
    { ...input, profile: { ...input.profile, attribution: "required source attribution" } }]) {
    expect(checkCompressedPublicationInput(changed, checkedAt).requestHash).not.toBe(hash);
  }
});
