import { describe, expect, it } from "vitest";
import type { SlateEvent } from "./oddsApi";
import {
  parseOddsCollectionProfile,
  planBaselineCheckpoints,
  selectBaselineEvents,
} from "./oddsCollectionPolicy";

const event = (id: string, commenceTime: string): SlateEvent => ({
  id,
  sportKey: "americanfootball_nfl",
  homeTeam: `${id} home`,
  awayTeam: `${id} away`,
  commenceTime,
});

describe("parseOddsCollectionProfile", () => {
  it("fails closed when collection is not explicitly configured", () => {
    expect(parseOddsCollectionProfile(undefined)).toBe("disabled");
    expect(parseOddsCollectionProfile("")).toBe("disabled");
  });

  it("accepts only the three named profiles", () => {
    expect(parseOddsCollectionProfile("free-pilot")).toBe("free-pilot");
    expect(parseOddsCollectionProfile("paid-baseline")).toBe("paid-baseline");
    expect(() => parseOddsCollectionProfile("paid")).toThrow("Unknown odds collection profile");
  });
});

describe("selectBaselineEvents", () => {
  const slate = [
    event("thu", "2026-10-02T00:15:00Z"),
    event("sun-early", "2026-10-04T17:00:00Z"),
    event("sun-late", "2026-10-05T00:20:00Z"),
    event("mon", "2026-10-06T00:15:00Z"),
  ];

  it("selects no baseline work when disabled", () => {
    expect(selectBaselineEvents("disabled", slate)).toEqual([]);
  });

  it("pins the latest Sunday kickoff for the free pilot", () => {
    expect(selectBaselineEvents("free-pilot", slate)).toEqual([
      { event: slate[2], reason: "latest-sunday" },
    ]);
  });

  it("honors an explicit free-pilot event override and fails loudly if it is stale", () => {
    expect(selectBaselineEvents("free-pilot", slate, { freePilotEventId: "thu" })).toEqual([
      { event: slate[0], reason: "explicit-override" },
    ]);
    expect(() =>
      selectBaselineEvents("free-pilot", slate, { freePilotEventId: "missing" })
    ).toThrow("is not in the current slate");
  });

  it("selects the full slate in deterministic kickoff order for paid baseline", () => {
    expect(selectBaselineEvents("paid-baseline", [...slate].reverse()).map(({ event }) => event.id))
      .toEqual(["thu", "sun-early", "sun-late", "mon"]);
  });
});

describe("planBaselineCheckpoints", () => {
  it("plans all five Eastern-evening checkpoints plus T-6 and T-15 for Sunday", () => {
    expect(planBaselineCheckpoints(event("sun", "2026-10-04T20:25:00Z"))).toEqual([
      { eventId: "sun", checkpointKey: "tuesday-opening", dueAt: "2026-09-30T00:00:00.000Z" },
      { eventId: "sun", checkpointKey: "wednesday-evening", dueAt: "2026-10-01T00:00:00.000Z" },
      { eventId: "sun", checkpointKey: "thursday-evening", dueAt: "2026-10-02T00:00:00.000Z" },
      { eventId: "sun", checkpointKey: "friday-final-practice", dueAt: "2026-10-03T00:00:00.000Z" },
      { eventId: "sun", checkpointKey: "saturday-evening", dueAt: "2026-10-04T00:00:00.000Z" },
      { eventId: "sun", checkpointKey: "t-6h", dueAt: "2026-10-04T14:25:00.000Z" },
      { eventId: "sun", checkpointKey: "t-15m", dueAt: "2026-10-04T20:10:00.000Z" },
    ]);
  });

  it("stops daily checkpoints the day before a Thursday game", () => {
    expect(
      planBaselineCheckpoints(event("thu", "2026-10-02T00:15:00Z")).map(
        ({ checkpointKey }) => checkpointKey
      )
    ).toEqual(["tuesday-opening", "wednesday-evening", "t-6h", "t-15m"]);
  });

  it("uses Eastern wall-clock evenings across the daylight-saving transition", () => {
    const checkpoints = planBaselineCheckpoints(event("sun", "2026-11-08T18:00:00Z"));
    expect(checkpoints[0]).toEqual({
      eventId: "sun",
      checkpointKey: "tuesday-opening",
      dueAt: "2026-11-04T01:00:00.000Z",
    });
    expect(checkpoints.at(-1)).toEqual({
      eventId: "sun",
      checkpointKey: "t-15m",
      dueAt: "2026-11-08T17:45:00.000Z",
    });
  });

  it("recomputes relative checkpoints when kickoff flexes", () => {
    const original = planBaselineCheckpoints(event("flex", "2026-10-04T17:00:00Z"));
    const flexed = planBaselineCheckpoints(event("flex", "2026-10-04T20:25:00Z"));
    expect(original.find(({ checkpointKey }) => checkpointKey === "t-6h")?.dueAt).toBe(
      "2026-10-04T11:00:00.000Z"
    );
    expect(flexed.find(({ checkpointKey }) => checkpointKey === "t-6h")?.dueAt).toBe(
      "2026-10-04T14:25:00.000Z"
    );
  });

  it("rejects invalid kickoff and configuration values", () => {
    expect(() => planBaselineCheckpoints(event("bad", "not-a-date"))).toThrow(
      "invalid commenceTime"
    );
    expect(() =>
      planBaselineCheckpoints(event("sun", "2026-10-04T20:25:00Z"), {
        eveningHourEastern: 24,
      })
    ).toThrow("eveningHourEastern");
  });
});
