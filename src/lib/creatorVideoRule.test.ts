import { describe, expect, it } from "vitest";
import {
  INCLUSION_RULE_VERSION,
  SHORT_FORM_MAX_SECONDS,
  assertValidWindow,
  classifyVideo,
  isWeekInWindow,
  listWindowWeeks,
  type RegisteredWindow,
  type VideoRecord,
} from "./creatorVideoRule.ts";

// 2025-10-09 falls in 2025 Week 6 (Tuesday 2025-10-07 to Monday 2025-10-13).
const WINDOW: RegisteredWindow = { endSeason: 2026, endWeek: 4 };
const video = (overrides: Partial<VideoRecord> = {}): VideoRecord => ({
  videoId: "synthetic-1",
  title: "Synthetic title",
  description: "",
  publishedAt: "2025-10-09T15:00:00Z",
  durationSeconds: 1800,
  liveBroadcastContent: "none",
  apiFetchedAt: "2026-10-01T00:00:00Z",
  ...overrides,
});
const classify = (overrides: Partial<VideoRecord>) => classifyVideo(video(overrides), WINDOW);

describe("window helpers", () => {
  it("expects every week from 2024 Week 1 through the registered end week", () => {
    const weeks = listWindowWeeks(WINDOW);
    expect(weeks).toHaveLength(18 + 18 + 4);
    expect(weeks[0]).toEqual({ season: 2024, week: 1 });
    expect(weeks.at(-1)).toEqual({ season: 2026, week: 4 });
  });

  it("includes the end week itself and nothing after it", () => {
    expect(isWeekInWindow(2026, 4, WINDOW)).toBe(true);
    expect(isWeekInWindow(2026, 5, WINDOW)).toBe(false);
    expect(isWeekInWindow(2025, 18, WINDOW)).toBe(true);
  });

  it("refuses an unregistered season or an invalid week as the window end", () => {
    for (const bad of [
      { endSeason: 2023, endWeek: 4 },
      { endSeason: 2027, endWeek: 4 },
      { endSeason: 2026, endWeek: 0 },
      { endSeason: 2026, endWeek: 19 },
      { endSeason: 2026, endWeek: 2.5 },
    ]) {
      expect(() => assertValidWindow(bad)).toThrow();
    }
    expect(() => assertValidWindow(WINDOW)).not.toThrow();
  });
});

describe("clear matches", () => {
  it.each([
    "Week 6 NFL Player Props & Best Bets",
    "NFL player props today",
    "Week 6 Player Props",
    "WEEK-6: NFL, Props!!",
    "Sunday Night Football Props",
    "NFL DFS picks Week 6",
    "Week 6 Player TD's",
    "NFL Week 6 player props + Underdog Fantasy picks",
  ])("accepts %j as a candidate with the week taken from the publish date", (title) => {
    expect(classify({ title })).toEqual({
      status: "candidate",
      reasons: ["prop-and-nfl-signal-in-title"],
      season: 2025,
      week: 6,
      ruleVersion: INCLUSION_RULE_VERSION,
    });
  });
});

describe("cases that must be reviewed, never decided automatically", () => {
  it("flags a title week that disagrees with the publish week", () => {
    expect(classify({ title: "Week 7 NFL Player Props" })).toMatchObject({
      status: "needs-review",
      reasons: ["prop-and-nfl-signal-in-title", "title-week-mismatch"],
    });
  });

  it("flags titles that reference more than one week", () => {
    expect(classify({ title: "Week 6 vs Week 7 NFL props" })).toMatchObject({
      status: "needs-review",
      reasons: ["prop-and-nfl-signal-in-title", "multiple-week-references"],
    });
  });

  it("treats a team name alone as ambiguous with other leagues", () => {
    expect(classify({ title: "Giants vs Cardinals player props" })).toMatchObject({
      status: "needs-review",
      reasons: ["nfl-signal-team-name-only"],
    });
  });

  it("does not accept an NFL signal found only in the description", () => {
    expect(classify({ title: "Player props today", description: "NFL Week 6 slate" })).toMatchObject({
      status: "needs-review",
      reasons: ["nfl-signal-description-only"],
    });
  });

  it("flags NFL picks videos that never say props in the title", () => {
    expect(classify({ title: "NFL Week 6 best bets" })).toMatchObject({
      status: "needs-review",
      reasons: ["picks-without-prop-signal"],
    });
  });

  it("treats pick'em platform words as picks, not as clear prop signals", () => {
    for (const title of ["Best PrizePicks plays NFL", "NFL Pick'Em Week 6"]) {
      expect(classify({ title })).toMatchObject({
        status: "needs-review",
        reasons: ["picks-without-prop-signal"],
      });
    }
  });

  it("flags a prop mention found only in the description", () => {
    expect(classify({ title: "NFL Week 6 breakdown", description: "Includes player props." })).toMatchObject({
      status: "needs-review",
      reasons: ["prop-signal-description-only"],
    });
  });

  it("flags a title naming the NFL and another league", () => {
    expect(classify({ title: "NFL and NBA player props" })).toMatchObject({
      status: "needs-review",
      reasons: ["mixed-league-title"],
    });
  });

  it("downgrades an otherwise clear match when the duration is unknown", () => {
    expect(classify({ title: "NFL Week 6 Player Props", durationSeconds: null })).toMatchObject({
      status: "needs-review",
      reasons: ["prop-and-nfl-signal-in-title", "duration-unknown"],
    });
  });
});

describe("exclusions", () => {
  it("excludes videos with no prop signal or no football signal", () => {
    expect(classify({ title: "NFL Week 6 recap and reaction" })).toMatchObject({
      status: "excluded",
      reasons: ["no-prop-signal"],
    });
    expect(classify({ title: "Best player props today" })).toMatchObject({
      status: "excluded",
      reasons: ["no-nfl-signal"],
    });
  });

  it("excludes fantasy-football titles unless they also say props", () => {
    for (const title of ["Week 6 Fantasy Football Start Sit", "NFL Week 6 DFS and fantasy lineups"]) {
      expect(classify({ title })).toMatchObject({ status: "excluded", reasons: ["fantasy-in-title"] });
    }
    // The word in a description alone does not exclude a video.
    expect(classify({ title: "NFL Week 6 Player Props", description: "Fantasy football tips too" }).status).toBe(
      "candidate"
    );
  });

  it("does not read a channel-style word such as DFSnDonuts as the DFS signal", () => {
    expect(classify({ title: "DFSnDonuts NFL Week 6 recap" })).toMatchObject({
      status: "excluded",
      reasons: ["no-prop-signal"],
    });
  });

  it("matches whole words only", () => {
    expect(classify({ title: "NFL Week 6 proposal and propaganda" })).toMatchObject({
      status: "excluded",
      reasons: ["no-prop-signal"],
    });
  });

  it("excludes another league's props unless the title also names the NFL", () => {
    expect(classify({ title: "NBA player props tonight" })).toMatchObject({
      status: "excluded",
      reasons: ["other-league-in-title"],
    });
    expect(classify({ title: "College Football Week 6 player props" })).toMatchObject({
      status: "excluded",
      reasons: ["other-league-in-title"],
    });
  });

  it("excludes short-form videos at the documented boundary", () => {
    expect(SHORT_FORM_MAX_SECONDS).toBe(120);
    const title = "NFL Week 6 Player Props";
    expect(classify({ title, durationSeconds: 119 })).toMatchObject({ status: "excluded", reasons: ["short-form"] });
    expect(classify({ title, durationSeconds: 120 }).status).toBe("candidate");
  });

  it("excludes live and upcoming broadcasts until they are finished videos", () => {
    for (const liveBroadcastContent of ["live", "upcoming"] as const) {
      expect(classify({ title: "NFL Week 6 Player Props", liveBroadcastContent })).toMatchObject({
        status: "excluded",
        reasons: ["not-yet-vod"],
      });
    }
  });

  it("excludes dates outside every registered regular season and an unparseable date", () => {
    expect(classify({ publishedAt: "2025-02-01T12:00:00Z", title: "NFL Week 6 Player Props" })).toMatchObject({
      status: "excluded",
      reasons: ["outside-registered-regular-season"],
      season: null,
      week: null,
    });
    expect(classify({ publishedAt: "yesterday", title: "NFL Week 6 Player Props" })).toMatchObject({
      status: "excluded",
      reasons: ["invalid-published-at"],
    });
  });

  it("excludes weeks after the registered end week while still reporting their week", () => {
    // 2026 Week 5 starts Tuesday 2026-10-06.
    expect(classify({ publishedAt: "2026-10-08T15:00:00Z", title: "NFL Week 5 Player Props" })).toMatchObject({
      status: "excluded",
      reasons: ["after-registered-end-week"],
      season: 2026,
      week: 5,
    });
    expect(classify({ publishedAt: "2026-10-01T15:00:00Z", title: "NFL Week 4 Player Props" }).status).toBe(
      "candidate"
    );
  });

  it("applies window and format exclusions before looking at the title", () => {
    expect(
      classify({ title: "NFL Week 6 Player Props", publishedAt: "2025-02-01T12:00:00Z", durationSeconds: 30 })
        .reasons
    ).toEqual(["outside-registered-regular-season"]);
  });
});
