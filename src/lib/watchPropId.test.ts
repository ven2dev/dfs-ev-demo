import { describe, it, expect } from "vitest";
import { buildWatchPropId } from "./watchPropId.ts";

describe("buildWatchPropId", () => {
  it("combines eventId, marketKey, and playerName into one stable string", () => {
    expect(
      buildWatchPropId({
        eventId: "evt-1",
        marketKey: "player_pass_yds",
        playerName: "Jalen Hurts",
      })
    ).toBe("evt-1:player_pass_yds:Jalen Hurts");
  });

  it("produces a different id for a different player on the same event+market", () => {
    const a = buildWatchPropId({
      eventId: "evt-1",
      marketKey: "player_pass_yds",
      playerName: "Jalen Hurts",
    });
    const b = buildWatchPropId({
      eventId: "evt-1",
      marketKey: "player_pass_yds",
      playerName: "Sam Darnold",
    });

    expect(a).not.toBe(b);
  });
});
