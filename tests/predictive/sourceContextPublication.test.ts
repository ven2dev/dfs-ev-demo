import { describe, expect, it } from "vitest";
import { prepareSourceContextPublication, type SourceContextPublication } from "../../src/lib/predictive/sourceContextPublication.ts";
import { sourceContextFixture as fixture } from "./fixtures/sourceContext.ts";
const checkedAt = "2026-10-13T12:00:00.000Z";
describe("detached context publication preparation", () => {
  it.each(["schedule", "identifiers"] as const)("prepares %s from original bytes with exact research rights references", async feed => {
    const input = fixture(feed), result = await prepareSourceContextPublication(input, checkedAt);
    expect(result.prepared.rows[0].projection).not.toBeNull();
    expect(result.rightsAtCapture).toBe(input.rightsDecisions[0].id);
    expect(result.rightsAtPreparation).toBe(input.rightsDecisions[0].id);
    expect(result).toMatchObject({ canonicalEvidencePublished: false, featuresPublished: false, labelsFinalized: false });
  });
  it("refuses provider, origin, filtered scope and parser substitution", async () => {
    for (const mutate of [
      (x: SourceContextPublication) => { x.profile.provider = "other"; },
      (x: SourceContextPublication) => { x.artifact.origin += "?filter=QB"; },
      (x: SourceContextPublication) => { x.artifact.scopeFilter = "QB"; },
      (x: SourceContextPublication) => { x.profile.parserVersion = "nflverse-csv-qualification-v1"; },
    ]) { const input = fixture(); mutate(input); await expect(prepareSourceContextPublication(input, checkedAt)).rejects.toThrow("context-publication-profile-refused"); }
  });
  it("requires research rights at capture and preparation rather than adapter-only permission", async () => {
    const input = fixture(); input.rightsDecisions[0].allowedUses = ["adapter-testing"];
    await expect(prepareSourceContextPublication(input, checkedAt)).rejects.toThrow("context-publication-rights-refused");
    const expired = fixture(); expired.rightsDecisions[0].effectiveTo = "2026-10-12T00:00:00.000Z";
    await expect(prepareSourceContextPublication(expired, checkedAt)).rejects.toThrow("context-publication-rights-refused");
  });
  it.each([true, false])("refuses a rights chain authorized only on one side of capture/preparation (%s)", async originallyAllowed => {
    const input = fixture(), first = input.rightsDecisions[0];
    first.allowedUses = originallyAllowed ? ["internal-research"] : [];
    input.rightsDecisions.push({ ...first, id: "later-review", predecessorId: first.id,
      allowedUses: originallyAllowed ? [] : ["internal-research"], effectiveFrom: "2026-10-10T00:00:00.000Z", decidedAt: "2026-10-10T00:00:00.000Z" });
    await expect(prepareSourceContextPublication(input, checkedAt)).rejects.toThrow("context-publication-rights-refused");
  });
  it("refuses future registration/capture and damaged original bytes", async () => {
    const future = fixture(); future.capturedAt = "2026-10-14T00:00:00.000Z";
    await expect(prepareSourceContextPublication(future, checkedAt)).rejects.toThrow("source-publication-time-refused");
    const damaged = fixture(); damaged.artifact.bytes += "\n";
    await expect(prepareSourceContextPublication(damaged, checkedAt)).rejects.toThrow("artifact-integrity-failed");
  });
  it("pins caller-owned source and registration data before parsing awaits", async () => {
    const input = fixture(), pending = prepareSourceContextPublication(input, checkedAt);
    input.artifact.bytes = "forged"; input.profile.provider = "forged";
    expect((await pending).input.profile.provider).toBe("nflverse");
  });
});
