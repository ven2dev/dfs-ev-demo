import { describe, expect, it } from "vitest";
import { getOddsProvenanceCopy } from "./oddsProvenance";

describe("getOddsProvenanceCopy", () => {
  it("labels every fixture-derived input as synthetic and provider-free", () => {
    const copy = getOddsProvenanceCopy("fixture");

    expect(copy).toMatchObject({
      isFixture: true,
      line: expect.stringContaining("synthetic fixture"),
      environment: expect.stringContaining("synthetic fixture"),
      history: expect.stringContaining("synthetic fixture"),
      stream: "fixture stream",
      edge: "fixture edge",
      ticks: "fixture ticks recorded",
    });
    expect(Object.values(copy).join(" ")).toContain("no provider call");
    expect(Object.values(copy).join(" ")).not.toContain("live Odds API");
    expect(Object.values(copy).join(" ")).not.toContain("real weather");
  });

  it("retains explicit live-provider provenance for Production ticks", () => {
    const copy = getOddsProvenanceCopy("live");

    expect(copy.line).toBe("real player-prop line, live Odds API");
    expect(copy.environment).toBe("After environment adjustment (real weather)");
    expect(copy.history).toContain("historical average");
    expect(copy.stream).toBe("live stream");
  });

  it("uses neutral copy before the first authoritative tick arrives", () => {
    const copy = getOddsProvenanceCopy(undefined);

    expect(copy.line).toBe("awaiting fresh source data");
    expect(copy.stream).toBeUndefined();
    expect(copy.waiting).toBe("Waiting for first tick…");
  });
});
