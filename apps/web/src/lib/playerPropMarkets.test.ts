import { describe, expect, it } from "vitest";
import {
  getPlayerPropMarket,
  isTrackablePlayerPropMarket,
  PLAYER_PROP_MARKETS,
  TRACKABLE_PLAYER_PROP_MARKET_KEYS,
} from "./playerPropMarkets";

describe("player prop market capabilities", () => {
  it("maps every two-way discovery market to a historical stat and enables tracking", () => {
    const expectedMappings = {
      player_pass_yds: "passing_yards",
      player_pass_tds: "passing_tds",
      player_pass_completions: "completions",
      player_pass_attempts: "attempts",
      player_pass_interceptions: "passing_interceptions",
      player_rush_yds: "rushing_yards",
      player_rush_attempts: "carries",
      player_reception_yds: "receiving_yards",
      player_receptions: "receptions",
    } as const;

    for (const [marketKey, statType] of Object.entries(expectedMappings)) {
      expect(getPlayerPropMarket(marketKey)).toMatchObject({
        outcomeShape: "over-under",
        historicalStatType: statType,
        trackable: true,
      });
      expect(isTrackablePlayerPropMarket(marketKey)).toBe(true);
    }
    expect(TRACKABLE_PLAYER_PROP_MARKET_KEYS).toEqual(Object.keys(expectedMappings));
  });

  it("keeps every yes-only touchdown market browse-only", () => {
    const yesOnlyMarkets = PLAYER_PROP_MARKETS.filter(
      (market) => market.outcomeShape === "yes-only"
    );

    expect(yesOnlyMarkets.map((market) => market.key)).toEqual([
      "player_anytime_td",
      "player_1st_td",
      "player_last_td",
    ]);
    expect(yesOnlyMarkets.every((market) => !market.trackable)).toBe(true);
  });
});
