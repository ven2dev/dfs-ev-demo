import { describe, it, expect } from "vitest";
import {
  getAllBookmakerKeys,
  getBestBookmakerKey,
  groupLinesByBookmaker,
  groupOddsByPlayer,
} from "./discoveredProps.ts";
import type { EventOddsResponse } from "./oddsApi.ts";
import type { DiscoveredLine } from "./discoveredProps.ts";

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

describe("groupLinesByBookmaker", () => {
  it("pairs a bookmaker's Over and Under lines into one row", () => {
    const lines: DiscoveredLine[] = [
      { bookmakerKey: "draftkings", side: "over", price: 1.91, point: 214.5 },
      { bookmakerKey: "draftkings", side: "under", price: 1.91, point: 214.5 },
    ];

    expect(groupLinesByBookmaker(lines)).toEqual([
      { bookmakerKey: "draftkings", point: 214.5, overPrice: 1.91, underPrice: 1.91 },
    ]);
  });

  it("keeps different bookmakers as separate rows", () => {
    const lines: DiscoveredLine[] = [
      { bookmakerKey: "draftkings", side: "over", price: 1.91, point: 214.5 },
      { bookmakerKey: "draftkings", side: "under", price: 1.91, point: 214.5 },
      { bookmakerKey: "fanduel", side: "over", price: 1.87, point: 213.5 },
      { bookmakerKey: "fanduel", side: "under", price: 1.95, point: 213.5 },
    ];

    const rows = groupLinesByBookmaker(lines);

    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.bookmakerKey).sort()).toEqual(["draftkings", "fanduel"]);
  });

  it("leaves a single-sided 'yes' line as its own row, not paired with anything", () => {
    const lines: DiscoveredLine[] = [{ bookmakerKey: "draftkings", side: "yes", price: 1.91 }];

    expect(groupLinesByBookmaker(lines)).toEqual([
      { bookmakerKey: "draftkings", yesPrice: 1.91 },
    ]);
  });

  it("returns an empty array for no lines", () => {
    expect(groupLinesByBookmaker([])).toEqual([]);
  });
});

describe("getAllBookmakerKeys", () => {
  it("returns the union of bookmaker keys across every player and market, sorted", () => {
    const players = [
      {
        playerName: "Jalen Hurts",
        markets: [
          {
            marketKey: "player_pass_yds",
            lines: [
              { bookmakerKey: "fanduel", side: "over" as const, price: 1.91, point: 214.5 },
              { bookmakerKey: "draftkings", side: "over" as const, price: 1.9, point: 214.5 },
            ],
          },
        ],
      },
      {
        playerName: "Saquon Barkley",
        markets: [
          {
            marketKey: "player_rush_yds",
            lines: [{ bookmakerKey: "betmgm", side: "over" as const, price: 1.87, point: 71.5 }],
          },
        ],
      },
    ];

    expect(getAllBookmakerKeys(players)).toEqual(["betmgm", "draftkings", "fanduel"]);
  });

  it("de-duplicates a bookmaker that appears in multiple players/markets", () => {
    const players = [
      {
        playerName: "Jalen Hurts",
        markets: [
          {
            marketKey: "player_pass_yds",
            lines: [{ bookmakerKey: "draftkings", side: "over" as const, price: 1.91, point: 214.5 }],
          },
        ],
      },
      {
        playerName: "Saquon Barkley",
        markets: [
          {
            marketKey: "player_rush_yds",
            lines: [{ bookmakerKey: "draftkings", side: "over" as const, price: 1.87, point: 71.5 }],
          },
        ],
      },
    ];

    expect(getAllBookmakerKeys(players)).toEqual(["draftkings"]);
  });

  it("returns an empty array when there are no players", () => {
    expect(getAllBookmakerKeys([])).toEqual([]);
  });
});

describe("getBestBookmakerKey", () => {
  it("for a two-way market, picks the lowest-overround book among those at the MODAL line, ignoring an off-modal book even if its own overround looks better", () => {
    const lines = [
      { bookmakerKey: "bookA", side: "over" as const, price: 1.91, point: 214.5 },
      { bookmakerKey: "bookA", side: "under" as const, price: 1.91, point: 214.5 },
      { bookmakerKey: "bookB", side: "over" as const, price: 2.0, point: 214.5 },
      { bookmakerKey: "bookB", side: "under" as const, price: 1.83, point: 214.5 },
      // Off-modal line (only one book here vs two at 214.5) -- a
      // perfectly no-vig 2.0/2.0 price, which would win if this weren't
      // correctly excluded from consideration.
      { bookmakerKey: "bookC", side: "over" as const, price: 2.0, point: 220.5 },
      { bookmakerKey: "bookC", side: "under" as const, price: 2.0, point: 220.5 },
    ];

    expect(getBestBookmakerKey(lines)).toBe("bookB");
  });

  it("for a single-sided ('yes') market, picks the highest price -- no line to shop", () => {
    const lines = [
      { bookmakerKey: "bookA", side: "yes" as const, price: 3.5 },
      { bookmakerKey: "bookB", side: "yes" as const, price: 4.2 },
      { bookmakerKey: "bookC", side: "yes" as const, price: 2.1 },
    ];

    expect(getBestBookmakerKey(lines)).toBe("bookB");
  });

  it("returns the only book when there's just one, rather than treating it as a degenerate case", () => {
    const lines = [
      { bookmakerKey: "bookA", side: "over" as const, price: 1.91, point: 214.5 },
      { bookmakerKey: "bookA", side: "under" as const, price: 1.91, point: 214.5 },
    ];

    expect(getBestBookmakerKey(lines)).toBe("bookA");
  });

  it("returns null for no lines", () => {
    expect(getBestBookmakerKey([])).toBeNull();
  });
});
