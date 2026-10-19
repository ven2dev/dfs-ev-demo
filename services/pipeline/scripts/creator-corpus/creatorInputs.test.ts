// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  InputError,
  isEndWeekClosed,
  loadRegistration,
  parseCreatorsFile,
  parseRegistration,
  parseVideoId,
  windowEnd,
  windowStart,
} from "./creatorInputs.ts";

const ID = "abcdefghijk";

describe("parseVideoId", () => {
  it.each([
    [ID, ID],
    [`  ${ID}  `, ID],
    [`https://www.youtube.com/watch?v=${ID}`, ID],
    [`https://www.youtube.com/watch?v=${ID}&t=323s`, ID],
    [`https://m.youtube.com/watch?feature=share&v=${ID}`, ID],
    [`https://youtube.com/watch?v=${ID}`, ID],
    [`https://youtu.be/${ID}?t=5`, ID],
  ])("reads %s", (input, expected) => expect(parseVideoId(input)).toBe(expected));

  it.each([
    "",
    "short",
    "abcdefghijkl",
    "abcdefghij!",
    `https://evil.example/watch?v=${ID}`,
    `https://www.youtube.com.evil.example/watch?v=${ID}`,
    `ftp://www.youtube.com/watch?v=${ID}`,
    "https://www.youtube.com/watch?v=short",
    "https://www.youtube.com/channel/UC" + "a".repeat(22),
    "javascript:alert(1)",
  ])("refuses %j", (input) => expect(parseVideoId(input)).toBeNull());
});

describe("parseCreatorsFile", () => {
  const entry = (overrides: Record<string, unknown> = {}) => ({
    key: "creator-a",
    name: " Example Channel ",
    seedVideoId: `https://www.youtube.com/watch?v=${ID}&t=9s`,
    ...overrides,
  });
  const code = (input: unknown) => {
    try {
      parseCreatorsFile(input);
    } catch (error) {
      expect(error).toBeInstanceOf(InputError);
      return (error as InputError).code;
    }
    return "accepted";
  };

  it("accepts a valid file, trimming names and reducing seed URLs to video IDs", () => {
    expect(parseCreatorsFile([entry(), entry({ key: "b2", name: "Two", seedVideoId: ID })])).toEqual([
      { key: "creator-a", name: "Example Channel", seedVideoId: ID },
      { key: "b2", name: "Two", seedVideoId: ID },
    ]);
  });

  it("refuses malformed files with specific fixed codes", () => {
    expect(code({})).toBe("invalid-creators-file");
    expect(code([])).toBe("invalid-creators-file");
    expect(code(Array.from({ length: 21 }, (_, index) => entry({ key: `k${index}` })))).toBe("invalid-creators-file");
    expect(code(["not an object"])).toBe("invalid-creators-file");
    expect(code([entry({ extra: 1 })])).toBe("invalid-creators-file");
    for (const key of ["Creator", "-lead", "has space", "a".repeat(33), "", 5]) {
      expect(code([entry({ key })])).toBe("invalid-creator-key");
    }
    for (const name of ["", "   ", "x".repeat(121), 7]) expect(code([entry({ name })])).toBe("invalid-creator-name");
    for (const seedVideoId of ["nope", "https://evil.example/", 9, undefined]) {
      expect(code([entry({ seedVideoId })])).toBe("invalid-seed-video");
    }
    expect(code([entry(), entry({ name: "Other" })])).toBe("duplicate-creator-key");
  });
});

describe("registration", () => {
  const record = (overrides: Record<string, unknown> = {}) => ({
    formatVersion: 1,
    ruleVersion: "v1",
    window: { endSeason: 2026, endWeek: 4 },
    registeredAt: "2026-10-06T00:00:00Z",
    ...overrides,
  });

  it("loads the committed registration: window ends at 2026 Week 4 under rule v1", async () => {
    expect(await loadRegistration()).toEqual(record());
  });

  it("refuses a different rule version, a bad window, extra keys, or a bad date", () => {
    for (const bad of [
      record({ ruleVersion: "v2" }),
      record({ window: { endSeason: 2023, endWeek: 4 } }),
      record({ window: { endSeason: 2026, endWeek: 19 } }),
      record({ window: { endSeason: 2026, endWeek: 4, extra: 1 } }),
      record({ extra: true }),
      record({ registeredAt: "someday" }),
      record({ formatVersion: 2 }),
      null,
      [],
    ]) {
      expect(() => parseRegistration(bad)).toThrow(expect.objectContaining({ code: "invalid-registration" }));
    }
  });
});

describe("window bounds", () => {
  it("starts at 2024 Week 1 and ends when the registered end week closes", () => {
    expect(windowStart().toISOString()).toBe("2024-09-03T04:00:00.000Z");
    expect(windowEnd({ endSeason: 2026, endWeek: 4 }).toISOString()).toBe("2026-10-06T04:00:00.000Z");
  });

  it("treats the end week as open until Tuesday midnight Eastern", () => {
    const window = { endSeason: 2026, endWeek: 4 };
    expect(isEndWeekClosed(window, new Date("2026-10-06T03:59:59.999Z"))).toBe(false);
    expect(isEndWeekClosed(window, new Date("2026-10-06T04:00:00.000Z"))).toBe(true);
    expect(isEndWeekClosed({ endSeason: 2026, endWeek: 5 }, new Date("2026-10-07T00:00:00Z"))).toBe(false);
  });
});
