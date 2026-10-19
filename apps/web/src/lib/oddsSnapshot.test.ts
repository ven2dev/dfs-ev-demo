import { describe, expect, it } from "vitest";
import type { EventOddsResponse } from "./oddsApi";
import { normalizeMarketSnapshot } from "./oddsSnapshot";

const response = (): EventOddsResponse => ({
  id: "event-1",
  bookmakers: [
    {
      key: "fanduel",
      markets: [
        {
          key: "player_pass_yds",
          last_update: "2026-10-02T20:01:00Z",
          outcomes: [
            { name: "Under", description: "Jalen Hurts", point: 244.5, price: 1.91 },
            { name: "Over", description: "Jalen Hurts", point: 244.5, price: 1.87 },
          ],
        },
      ],
    },
    {
      key: "draftkings",
      markets: [
        {
          key: "player_pass_yds",
          last_update: "2026-10-02T20:00:00Z",
          outcomes: [
            { name: "Over", description: "Jalen Hurts", point: 244.5, price: 1.9 },
            { name: "Under", description: "Jalen Hurts", point: 244.5, price: 1.9 },
          ],
        },
      ],
    },
  ],
});

describe("normalizeMarketSnapshot", () => {
  it("normalizes complete same-player/same-point pairs into directional quotes", () => {
    const result = normalizeMarketSnapshot(response(), "player_pass_yds");

    expect(result.status).toBe("returned");
    expect(result.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.quotes).toEqual([
      {
        bookmakerKey: "draftkings",
        rawPlayerName: "Jalen Hurts",
        playerId: null,
        direction: "over",
        point: 244.5,
        decimalPrice: 1.9,
      },
      {
        bookmakerKey: "draftkings",
        rawPlayerName: "Jalen Hurts",
        playerId: null,
        direction: "under",
        point: 244.5,
        decimalPrice: 1.9,
      },
      {
        bookmakerKey: "fanduel",
        rawPlayerName: "Jalen Hurts",
        playerId: null,
        direction: "over",
        point: 244.5,
        decimalPrice: 1.87,
      },
      {
        bookmakerKey: "fanduel",
        rawPlayerName: "Jalen Hurts",
        playerId: null,
        direction: "under",
        point: 244.5,
        decimalPrice: 1.91,
      },
    ]);
    expect(result.bookmakerObservations).toEqual([
      { bookmakerKey: "draftkings", providerUpdatedAt: "2026-10-02T20:00:00Z" },
      { bookmakerKey: "fanduel", providerUpdatedAt: "2026-10-02T20:01:00Z" },
    ]);
  });

  it("is order-independent and excludes provider update times from quote content", () => {
    const first = response();
    const second = response();
    second.bookmakers.reverse();
    second.bookmakers[0].markets[0].outcomes.reverse();
    second.bookmakers[1].markets[0].last_update = "2026-10-02T20:05:00Z";

    expect(normalizeMarketSnapshot(second, "player_pass_yds").contentHash).toBe(
      normalizeMarketSnapshot(first, "player_pass_yds").contentHash
    );
  });

  it("changes the content hash when a quote value changes", () => {
    const changed = response();
    changed.bookmakers[0].markets[0].outcomes[0].price = 1.95;

    expect(normalizeMarketSnapshot(changed, "player_pass_yds").contentHash).not.toBe(
      normalizeMarketSnapshot(response(), "player_pass_yds").contentHash
    );
  });

  it("does not create a pair from mismatched points or invalid prices", () => {
    const malformed = response();
    malformed.bookmakers = [
      {
        key: "draftkings",
        markets: [
          {
            key: "player_pass_yds",
            outcomes: [
              { name: "Over", description: "Jalen Hurts", point: 244.5, price: 1.9 },
              { name: "Under", description: "Jalen Hurts", point: 245.5, price: 1.9 },
              { name: "Over", description: "Josh Allen", point: 255.5, price: 1 },
              { name: "Under", description: "Josh Allen", point: 255.5, price: 2 },
            ],
          },
        ],
      },
    ];

    expect(normalizeMarketSnapshot(malformed, "player_pass_yds")).toMatchObject({
      status: "invalid",
      contentHash: null,
      quotes: [],
    });
  });

  it("distinguishes unavailable, empty, and invalid requested markets", () => {
    expect(normalizeMarketSnapshot(response(), "player_receptions").status).toBe(
      "unavailable"
    );

    const empty = response();
    empty.bookmakers[0].markets[0].outcomes = [];
    empty.bookmakers = [empty.bookmakers[0]];
    expect(normalizeMarketSnapshot(empty, "player_pass_yds").status).toBe("empty");

    const invalid = response();
    invalid.bookmakers[0].markets[0].outcomes = [
      { name: "Yes", description: "Jalen Hurts", price: 1.7 },
    ];
    invalid.bookmakers = [invalid.bookmakers[0]];
    expect(normalizeMarketSnapshot(invalid, "player_pass_yds").status).toBe("invalid");
  });

  it("deduplicates identical provider outcomes before pairing", () => {
    const duplicated = response();
    const outcomes = duplicated.bookmakers[0].markets[0].outcomes;
    outcomes.push({ ...outcomes[0] }, { ...outcomes[1] });

    const result = normalizeMarketSnapshot(duplicated, "player_pass_yds");
    expect(result.status).toBe("returned");
    expect(result.quotes).toHaveLength(4);
  });

  it("rejects an ambiguous duplicate side instead of choosing by input order", () => {
    const ambiguous = response();
    ambiguous.bookmakers = [ambiguous.bookmakers[0]];
    ambiguous.bookmakers[0].markets[0].outcomes.push({
      name: "Over",
      description: "Jalen Hurts",
      point: 244.5,
      price: 1.8,
    });

    expect(normalizeMarketSnapshot(ambiguous, "player_pass_yds")).toMatchObject({
      status: "invalid",
      contentHash: null,
      quotes: [],
    });
  });
});
