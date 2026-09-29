import { describe, it, expect } from "vitest";
import { groupOddsByPlayer } from "./discoveredProps.ts";
import type { EventOddsResponse } from "./oddsApi.ts";

describe("groupOddsByPlayer", () => {
  it("groups a two-way Over/Under market's outcomes under the same player and market", () => {
    const response: EventOddsResponse = {
      id: "evt-1",
      bookmakers: [
        {
          key: "draftkings",
          markets: [
            {
              key: "player_pass_yds",
              outcomes: [
                { name: "Over", description: "Jalen Hurts", price: 1.91, point: 214.5 },
                { name: "Under", description: "Jalen Hurts", price: 1.91, point: 214.5 },
              ],
            },
          ],
        },
      ],
    };

    const players = groupOddsByPlayer(response);

    expect(players).toEqual([
      {
        playerName: "Jalen Hurts",
        markets: [
          {
            marketKey: "player_pass_yds",
            lines: [
              { bookmakerKey: "draftkings", side: "over", price: 1.91, point: 214.5 },
              { bookmakerKey: "draftkings", side: "under", price: 1.91, point: 214.5 },
            ],
          },
        ],
      },
    ]);
  });

  it("treats a single-sided touchdown-scorer outcome as a 'yes' line with no point", () => {
    const response: EventOddsResponse = {
      id: "evt-1",
      bookmakers: [
        {
          key: "draftkings",
          markets: [
            {
              key: "player_anytime_td",
              outcomes: [{ name: "Yes", description: "Jaylen Warren", price: 1.91 }],
            },
          ],
        },
      ],
    };

    const players = groupOddsByPlayer(response);

    expect(players).toEqual([
      {
        playerName: "Jaylen Warren",
        markets: [
          {
            marketKey: "player_anytime_td",
            lines: [{ bookmakerKey: "draftkings", side: "yes", price: 1.91, point: undefined }],
          },
        ],
      },
    ]);
  });

  it("combines the same player+market from multiple bookmakers into one market entry with multiple lines", () => {
    const response: EventOddsResponse = {
      id: "evt-1",
      bookmakers: [
        {
          key: "draftkings",
          markets: [
            {
              key: "player_pass_yds",
              outcomes: [{ name: "Over", description: "Jalen Hurts", price: 1.91, point: 214.5 }],
            },
          ],
        },
        {
          key: "fanduel",
          markets: [
            {
              key: "player_pass_yds",
              outcomes: [{ name: "Over", description: "Jalen Hurts", price: 1.87, point: 213.5 }],
            },
          ],
        },
      ],
    };

    const players = groupOddsByPlayer(response);

    expect(players).toHaveLength(1);
    expect(players[0].markets).toHaveLength(1);
    expect(players[0].markets[0].lines.map((l) => l.bookmakerKey).sort()).toEqual([
      "draftkings",
      "fanduel",
    ]);
  });

  it("separates a player's different markets into different entries, not merged together", () => {
    const response: EventOddsResponse = {
      id: "evt-1",
      bookmakers: [
        {
          key: "draftkings",
          markets: [
            {
              key: "player_pass_yds",
              outcomes: [{ name: "Over", description: "Jalen Hurts", price: 1.91, point: 214.5 }],
            },
            {
              key: "player_pass_tds",
              outcomes: [{ name: "Over", description: "Jalen Hurts", price: 2.1, point: 1.5 }],
            },
          ],
        },
      ],
    };

    const players = groupOddsByPlayer(response);

    expect(players).toHaveLength(1);
    expect(players[0].markets.map((m) => m.marketKey).sort()).toEqual([
      "player_pass_tds",
      "player_pass_yds",
    ]);
  });

  it("groups multiple different players into separate entries", () => {
    const response: EventOddsResponse = {
      id: "evt-1",
      bookmakers: [
        {
          key: "draftkings",
          markets: [
            {
              key: "player_pass_yds",
              outcomes: [
                { name: "Over", description: "Jalen Hurts", price: 1.91, point: 214.5 },
                { name: "Over", description: "Sam Darnold", price: 1.91, point: 199.5 },
              ],
            },
          ],
        },
      ],
    };

    const players = groupOddsByPlayer(response);

    expect(players.map((p) => p.playerName).sort()).toEqual(["Jalen Hurts", "Sam Darnold"]);
  });

  it("skips an outcome with no player description instead of throwing or showing a blank entry", () => {
    const response: EventOddsResponse = {
      id: "evt-1",
      bookmakers: [
        {
          key: "draftkings",
          markets: [
            {
              key: "player_pass_yds",
              outcomes: [{ name: "Over", price: 1.91, point: 214.5 }],
            },
          ],
        },
      ],
    };

    const players = groupOddsByPlayer(response);

    expect(players).toEqual([]);
  });

  it("returns an empty array for a response with no bookmakers", () => {
    expect(groupOddsByPlayer({ id: "evt-1", bookmakers: [] })).toEqual([]);
  });
});
