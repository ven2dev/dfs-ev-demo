import { describe, it, expect } from "vitest";
import { computeEntryHitProbability } from "./pickEm.ts";
import type { Pick } from "@/types";

describe("computeEntryHitProbability", () => {
  it("returns 1 (vacuously certain) for an empty entry", () => {
    expect(computeEntryHitProbability([])).toBe(1);
  });

  it("returns the single pick's own probability for a 1-pick entry", () => {
    const picks: Pick[] = [{ propId: "a", direction: "over", impliedProb: 0.6 }];
    expect(computeEntryHitProbability(picks)).toBe(0.6);
  });

  it("multiplies probabilities across picks, not adds/averages them", () => {
    const picks: Pick[] = [
      { propId: "a", direction: "over", impliedProb: 0.6 },
      { propId: "b", direction: "under", impliedProb: 0.5 },
    ];
    expect(computeEntryHitProbability(picks)).toBeCloseTo(0.3);
  });

  it("a longer entry has strictly lower joint probability than its worst leg", () => {
    const picks: Pick[] = [
      { propId: "a", direction: "over", impliedProb: 0.7 },
      { propId: "b", direction: "over", impliedProb: 0.65 },
      { propId: "c", direction: "over", impliedProb: 0.8 },
    ];
    expect(computeEntryHitProbability(picks)).toBeLessThan(0.65);
  });
});
