import { describe, it, expect } from "vitest";
import { devigTwoWay } from "./devig.ts";

describe("devigTwoWay", () => {
  it("a fair (no-vig) 50/50 market stays 50/50", () => {
    const { impliedProbOver, impliedProbUnder } = devigTwoWay(2.0, 2.0);
    expect(impliedProbOver).toBeCloseTo(0.5, 9);
    expect(impliedProbUnder).toBeCloseTo(0.5, 9);
  });

  it("removes the bookmaker's margin so probabilities sum to 1", () => {
    // Realistic vig'd two-way prices (raw implied probs sum to > 1)
    const { impliedProbOver, impliedProbUnder } = devigTwoWay(1.91, 1.91);
    expect(impliedProbOver + impliedProbUnder).toBeCloseTo(1, 9);
  });

  it("a shorter price implies a higher devigged probability", () => {
    const { impliedProbOver, impliedProbUnder } = devigTwoWay(1.5, 3.0);
    expect(impliedProbOver).toBeGreaterThan(impliedProbUnder);
  });
});
