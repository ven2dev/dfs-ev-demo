import { describe, it, expect } from "vitest";
import { parseSampleWindow, DEFAULT_SAMPLE_WINDOW } from "./streamConfig.ts";

describe("parseSampleWindow", () => {
  it.each([
    ["3", 3],
    ["5", 5],
    ["7", 7],
  ])("accepts %s as a valid sample window", (input, expected) => {
    expect(parseSampleWindow(input)).toBe(expected);
  });

  it("defaults when the value is missing", () => {
    expect(parseSampleWindow(null)).toBe(DEFAULT_SAMPLE_WINDOW);
  });

  it.each(["4", "0", "-5", "abc", "", "5.0"])(
    "defaults for an invalid value: %s",
    (input) => {
      expect(parseSampleWindow(input)).toBe(DEFAULT_SAMPLE_WINDOW);
    }
  );
});
