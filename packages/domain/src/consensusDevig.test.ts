import { describe, expect, it } from "vitest";
import { devigTwoWay } from "./devig";
import {
  CONSENSUS_DEVIG_METHOD,
  CONSENSUS_DEVIG_VERSION,
  consensusDevigAtLine,
} from "./consensusDevig";

type LineOverrides = Partial<{
  bookmakerKey: string;
  overPrice: number;
  underPrice: number;
  point: number;
}>;

const line = (overrides: LineOverrides = {}) => ({
  bookmakerKey: "book-a",
  overPrice: 1.91,
  underPrice: 1.91,
  point: 250.5,
  ...overrides,
});

describe("consensusDevigAtLine", () => {
  it("uses the median independently-devigged Over probability and derives Under", () => {
    const lines = [
      line({ bookmakerKey: "book-a", overPrice: 1.8, underPrice: 2.0 }),
      line({ bookmakerKey: "book-b", overPrice: 2.0, underPrice: 1.8 }),
      line({ bookmakerKey: "book-c", overPrice: 1.91, underPrice: 1.91 }),
    ];

    const result = consensusDevigAtLine(lines, 250.5);

    expect(result).toEqual(
      expect.objectContaining({
        line: 250.5,
        contributingBookCount: 3,
        method: CONSENSUS_DEVIG_METHOD,
        version: CONSENSUS_DEVIG_VERSION,
      })
    );
    expect(result?.impliedProbOver).toBeCloseTo(0.5, 9);
    expect(result?.impliedProbUnder).toBeCloseTo(1 - (result?.impliedProbOver ?? 0), 12);
  });

  it("averages the middle two probabilities for an even number of books", () => {
    const first = line({ bookmakerKey: "book-a", overPrice: 1.8, underPrice: 2.2 });
    const second = line({ bookmakerKey: "book-b", overPrice: 2.1, underPrice: 1.75 });
    const firstProbability = devigTwoWay(first.overPrice, first.underPrice).impliedProbOver;
    const secondProbability = devigTwoWay(second.overPrice, second.underPrice).impliedProbOver;

    const result = consensusDevigAtLine([first, second], 250.5);

    expect(result?.impliedProbOver).toBeCloseTo(
      (firstProbability + secondProbability) / 2,
      12
    );
  });

  it("is independent of bookmaker input order", () => {
    const lines = [
      line({ bookmakerKey: "book-a", overPrice: 1.7, underPrice: 2.2 }),
      line({ bookmakerKey: "book-b", overPrice: 1.9, underPrice: 1.9 }),
      line({ bookmakerKey: "book-c", overPrice: 2.2, underPrice: 1.7 }),
      line({ bookmakerKey: "book-d", overPrice: 2.0, underPrice: 1.8 }),
    ];

    expect(consensusDevigAtLine(lines, 250.5)).toEqual(
      consensusDevigAtLine([...lines].reverse(), 250.5)
    );
  });

  it("falls back to one valid book without changing its devigged probability", () => {
    const onlyLine = line({ overPrice: 1.83, underPrice: 2.05 });
    const expected = devigTwoWay(onlyLine.overPrice, onlyLine.underPrice);

    const result = consensusDevigAtLine([onlyLine], 250.5);

    expect(result?.contributingBookCount).toBe(1);
    expect(result?.impliedProbOver).toBeCloseTo(expected.impliedProbOver, 12);
    expect(result?.impliedProbUnder).toBeCloseTo(expected.impliedProbUnder, 12);
  });

  it("excludes different points and invalid decimal prices", () => {
    const valid = line({ bookmakerKey: "valid", overPrice: 1.85, underPrice: 2.0 });
    const result = consensusDevigAtLine(
      [
        valid,
        line({ bookmakerKey: "other-point", point: 251.5 }),
        line({ bookmakerKey: "invalid-over", overPrice: 1 }),
        line({ bookmakerKey: "invalid-under", underPrice: Number.NaN }),
      ],
      250.5
    );

    expect(result?.contributingBookCount).toBe(1);
    expect(result?.impliedProbOver).toBeCloseTo(
      devigTwoWay(valid.overPrice, valid.underPrice).impliedProbOver,
      12
    );
  });

  it("returns null when no structurally valid exact-line pair remains", () => {
    expect(
      consensusDevigAtLine(
        [line({ point: 251.5 }), line({ bookmakerKey: "bad", overPrice: Infinity })],
        250.5
      )
    ).toBeNull();
    expect(consensusDevigAtLine([line()], Number.NaN)).toBeNull();
  });

  it("resists one extreme outlier without assigning bookmaker weights", () => {
    const centralProbability = devigTwoWay(1.91, 1.91).impliedProbOver;
    const result = consensusDevigAtLine(
      [
        line({ bookmakerKey: "book-a" }),
        line({ bookmakerKey: "book-b" }),
        line({ bookmakerKey: "outlier", overPrice: 1.05, underPrice: 10 }),
      ],
      250.5
    );

    expect(result?.impliedProbOver).toBeCloseTo(centralProbability, 12);
  });
});
