import { describe, it, expect } from "vitest";
import { buildWatchPropId } from "./watchPropId.ts";

describe("buildWatchPropId", () => {
  it("combines the full watched selection identity into one stable string", () => {
    expect(
      buildWatchPropId({
        eventId: "evt-1",
        marketKey: "player_pass_yds",
        playerName: "Jalen Hurts",
        direction: "over",
        bookmakerKey: "draftkings",
      })
    ).toBe("evt-1:player_pass_yds:Jalen Hurts:over:draftkings");
  });

  it("produces a different id for a different player on the same event+market", () => {
    const a = buildWatchPropId({
      eventId: "evt-1",
      marketKey: "player_pass_yds",
      playerName: "Jalen Hurts",
      direction: "over",
      bookmakerKey: "draftkings",
    });
    const b = buildWatchPropId({
      eventId: "evt-1",
      marketKey: "player_pass_yds",
      playerName: "Sam Darnold",
      direction: "over",
      bookmakerKey: "draftkings",
    });

    expect(a).not.toBe(b);
  });

  it("keeps Over/Under and bookmaker snapshots separate", () => {
    const base = {
      eventId: "evt-1",
      marketKey: "player_pass_yds",
      playerName: "Jalen Hurts",
      bookmakerKey: "draftkings",
      direction: "over" as const,
    };

    expect(buildWatchPropId(base)).not.toBe(
      buildWatchPropId({ ...base, direction: "under" })
    );
    expect(buildWatchPropId(base)).not.toBe(
      buildWatchPropId({ ...base, bookmakerKey: "fanduel" })
    );
  });
});
