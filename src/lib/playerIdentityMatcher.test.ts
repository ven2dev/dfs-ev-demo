import { describe, expect, it } from "vitest";
import {
  matchPlayerIdentity,
  type PlayerIdentityCandidate,
} from "./playerIdentityMatcher";

const candidate = (
  overrides: Partial<PlayerIdentityCandidate> = {}
): PlayerIdentityCandidate => ({
  playerId: "00-0036389",
  fullName: "Jalen Hurts",
  firstName: "Jalen",
  lastName: "Hurts",
  footballName: "Jalen",
  team: "PHI",
  position: "QB",
  ...overrides,
});

describe("matchPlayerIdentity", () => {
  it("matches a unique normalized full name", () => {
    const result = matchPlayerIdentity(
      "Jalen Hurts Jr.",
      "player_pass_yds",
      ["PHI", "DAL"],
      [candidate({ fullName: "Jalen Hurts" })]
    );

    expect(result).toMatchObject({ playerId: "00-0036389", confidence: 1 });
  });

  it("matches the roster football-name alias", () => {
    const result = matchPlayerIdentity(
      "Josh Palmer",
      "player_reception_yds",
      ["LAC", "LV"],
      [
        candidate({
          playerId: "player-2",
          fullName: "Joshua Palmer",
          firstName: "Joshua",
          lastName: "Palmer",
          footballName: "Josh",
          team: "LAC",
          position: "WR",
        }),
      ]
    );

    expect(result?.playerId).toBe("player-2");
    expect(result?.matchedAlias).toBe("Josh Palmer");
  });

  it("accepts one small spelling variation only when the match remains unique", () => {
    const result = matchPlayerIdentity(
      "Jalen Hurst",
      "player_pass_yds",
      ["PHI", "DAL"],
      [candidate()]
    );

    expect(result?.playerId).toBe("00-0036389");
    expect(result?.confidence).toBeGreaterThanOrEqual(0.94);
  });

  it("uses market-position compatibility to disambiguate an initial and surname", () => {
    const result = matchPlayerIdentity(
      "J. Williams",
      "player_rush_yds",
      ["DEN", "ATL"],
      [
        candidate({
          playerId: "safety",
          fullName: "James Williams",
          firstName: "James",
          lastName: "Williams",
          footballName: "James",
          team: "ATL",
          position: "S",
        }),
        candidate({
          playerId: "running-back",
          fullName: "Javonte Williams",
          firstName: "Javonte",
          lastName: "Williams",
          footballName: "Javonte",
          team: "DEN",
          position: "RB",
        }),
      ]
    );

    expect(result?.playerId).toBe("running-back");
  });

  it("does not guess when two compatible candidates remain equally plausible", () => {
    const result = matchPlayerIdentity(
      "J. Williams",
      "player_rush_yds",
      ["DEN", "ATL"],
      [
        candidate({
          playerId: "one",
          fullName: "Javonte Williams",
          firstName: "Javonte",
          lastName: "Williams",
          team: "DEN",
          position: "RB",
        }),
        candidate({
          playerId: "two",
          fullName: "James Williams",
          firstName: "James",
          lastName: "Williams",
          team: "ATL",
          position: "RB",
        }),
      ]
    );

    expect(result).toBeNull();
  });

  it("rejects even an exact name when the roster position is incompatible", () => {
    const result = matchPlayerIdentity(
      "Jalen Hurts",
      "player_pass_yds",
      ["PHI", "DAL"],
      [candidate({ position: "S" })]
    );

    expect(result).toBeNull();
  });

  it("ignores an otherwise exact candidate outside the selected event teams", () => {
    const result = matchPlayerIdentity(
      "Jalen Hurts",
      "player_pass_yds",
      ["DAL", "NYG"],
      [candidate({ team: "PHI" })]
    );

    expect(result).toBeNull();
  });

  it("rejects a low-confidence unrelated name", () => {
    const result = matchPlayerIdentity(
      "Dak Prescott",
      "player_pass_yds",
      ["PHI", "DAL"],
      [candidate()]
    );

    expect(result).toBeNull();
  });

  it("fails closed when the market has no explicit position contract", () => {
    expect(
      matchPlayerIdentity("Jalen Hurts", "unknown_market", ["PHI", "DAL"], [
        candidate(),
      ])
    ).toBeNull();
    expect(
      matchPlayerIdentity("Jalen Hurts", "player_anytime_td", ["PHI", "DAL"], [
        candidate(),
      ])
    ).toBeNull();
  });

  it("is independent of candidate order", () => {
    const candidates = [
      candidate(),
      candidate({
        playerId: "other",
        fullName: "Dak Prescott",
        firstName: "Dak",
        lastName: "Prescott",
        footballName: "Dak",
        team: "DAL",
      }),
    ];

    const forward = matchPlayerIdentity(
      "Jalen Hurts",
      "player_pass_yds",
      ["PHI", "DAL"],
      candidates
    );
    const reverse = matchPlayerIdentity(
      "Jalen Hurts",
      "player_pass_yds",
      ["PHI", "DAL"],
      [...candidates].reverse()
    );

    expect(forward?.playerId).toBe("00-0036389");
    expect(reverse?.playerId).toBe("00-0036389");
  });
});
