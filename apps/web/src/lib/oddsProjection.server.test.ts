import { describe, expect, it } from "vitest";
import { canonicalOddsMarkets, mergeOddsSlices, projectPlayerPropLines, sliceOddsByMarket } from "./oddsProjection";
import type { EventOddsResponse } from "./oddsApi";

const response: EventOddsResponse = {
  id: "event-1",
  bookmakers: [{
    key: "book-a",
    markets: [{
      key: "player_pass_yds",
      outcomes: [
        { name: "Over", description: "Player A", price: 1.9, point: 200 },
        { name: "Under", description: "Player A", price: 1.8, point: 200 },
        { name: "Over", description: "Player B", price: 1.7, point: 250 },
        { name: "Under", description: "Player B", price: 2.0, point: 250 },
      ],
    }, {
      key: "player_anytime_td",
      outcomes: [{ name: "Yes", description: "Player A", price: 2.5 }],
    }],
  }],
};

describe("raw odds identity and projection", () => {
  it("canonicalizes permutations and duplicates without mutating the request", () => {
    const keys = ["player_pass_yds", "player_anytime_td", "player_pass_yds"];
    expect(canonicalOddsMarkets(keys)).toEqual(["player_anytime_td", "player_pass_yds"]);
    expect(keys).toHaveLength(3);
  });
  it("projects distinct player lines from the same raw response without changing it", () => {
    const before = JSON.stringify(response);
    expect(projectPlayerPropLines(response, "player_pass_yds", "Player A")[0].point).toBe(200);
    expect(projectPlayerPropLines(response, "player_pass_yds", "Player B")[0].point).toBe(250);
    expect(JSON.stringify(response)).toBe(before);
  });
  it("keeps exact-name matching and absent-player behavior", () => {
    expect(projectPlayerPropLines(response, "player_pass_yds", "player a")).toEqual([]);
    expect(projectPlayerPropLines(response, "player_pass_yds", "Absent")).toEqual([]);
  });
  it("does not manufacture two-way lines from yes-only outcomes", () => {
    expect(projectPlayerPropLines(response, "player_anytime_td", "Player A")).toEqual([]);
    expect(sliceOddsByMarket(response, "player_anytime_td").bookmakers[0].markets[0].outcomes)
      .toEqual([{ name: "Yes", description: "Player A", price: 2.5 }]);
  });
  it("retains all players when slicing and merges shared bookmakers", () => {
    const slices = ["player_pass_yds", "player_anytime_td"].map(k => sliceOddsByMarket(response, k));
    expect(slices[0].bookmakers[0].markets[0].outcomes).toHaveLength(4);
    expect(mergeOddsSlices(response.id, slices)).toEqual(response);
  });
  it("publishes an empty slice for a market missing from the provider response", () => {
    const empty = sliceOddsByMarket(response, "player_receptions");
    expect(empty).toEqual({ bookmakers: [] });
    expect(mergeOddsSlices(response.id, [empty])).toEqual({ id: response.id, bookmakers: [] });
  });
});
