import { describe, expect, it } from "vitest";
import { isOddsDataSource } from "./oddsDataSource";

describe("isOddsDataSource", () => {
  it("accepts only the two response-contract values", () => {
    expect(isOddsDataSource("live")).toBe(true);
    expect(isOddsDataSource("fixture")).toBe(true);
    expect(isOddsDataSource("mock")).toBe(false);
    expect(isOddsDataSource(undefined)).toBe(false);
  });
});
