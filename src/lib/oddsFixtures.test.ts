import { describe, expect, it } from "vitest";
import { groupOddsByPlayer } from "./discoveredProps";
import {
  FIXTURE_PLAYERS,
  FIXTURE_SPORT_KEY,
  getFixtureEventOdds,
  getFixtureSlateEvents,
} from "./oddsFixtures";

const now = new Date("2026-10-03T12:00:00.000Z");

describe("odds fixtures", () => {
  it("derives a stable, visibly synthetic event from the injected NFL-week clock", () => {
    const first = getFixtureSlateEvents(FIXTURE_SPORT_KEY, now);
    const second = getFixtureSlateEvents(FIXTURE_SPORT_KEY, new Date("2026-10-05T12:00:00.000Z"));

    expect(first).toEqual(second);
    expect(first).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^fixture-week-/),
        homeTeam: "Summit City Sentinels",
        awayTeam: "Harbor Point Captains",
      }),
    ]);
    expect(getFixtureSlateEvents("basketball_nba", now)).toEqual([]);
  });

  it("returns deterministic multi-book lines only for requested markets", () => {
    const event = getFixtureSlateEvents(FIXTURE_SPORT_KEY, now)[0];
    const odds = getFixtureEventOdds(
      event.id,
      ["player_pass_yds", "player_anytime_td"],
      now
    );

    expect(odds?.bookmakers).toHaveLength(3);
    expect(odds?.bookmakers.every((bookmaker) => bookmaker.key.startsWith("fixture-"))).toBe(true);
    expect(
      odds?.bookmakers.flatMap((bookmaker) => bookmaker.markets.map((market) => market.key))
    ).toEqual([
      "player_pass_yds",
      "player_anytime_td",
      "player_pass_yds",
      "player_anytime_td",
      "player_pass_yds",
      "player_anytime_td",
    ]);
    expect(getFixtureEventOdds("provider-looking-id", ["player_pass_yds"], now)).toBeNull();
  });

  it("produces discoverable fictional players with complete two-way quotes", () => {
    const event = getFixtureSlateEvents(FIXTURE_SPORT_KEY, now)[0];
    const odds = getFixtureEventOdds(event.id, ["player_pass_yds"], now);
    const discovered = groupOddsByPlayer(odds!);

    expect(discovered.map((player) => player.playerName)).toEqual([
      FIXTURE_PLAYERS[0].name,
      FIXTURE_PLAYERS[1].name,
    ]);
    for (const player of discovered) {
      expect(player.markets[0].lines).toHaveLength(6);
      expect(new Set(player.markets[0].lines.map((line) => line.bookmakerKey)).size).toBe(3);
    }
  });
});
