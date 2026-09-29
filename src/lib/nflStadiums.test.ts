import { describe, it, expect } from "vitest";
import { NFL_TEAM_VENUES, getVenueForTeam } from "./nflStadiums.ts";

const ALL_32_TEAMS = [
  "Buffalo Bills",
  "Miami Dolphins",
  "New England Patriots",
  "New York Jets",
  "New York Giants",
  "Baltimore Ravens",
  "Cincinnati Bengals",
  "Cleveland Browns",
  "Pittsburgh Steelers",
  "Houston Texans",
  "Indianapolis Colts",
  "Jacksonville Jaguars",
  "Tennessee Titans",
  "Denver Broncos",
  "Kansas City Chiefs",
  "Las Vegas Raiders",
  "Los Angeles Chargers",
  "Los Angeles Rams",
  "Dallas Cowboys",
  "Philadelphia Eagles",
  "Washington Commanders",
  "Chicago Bears",
  "Detroit Lions",
  "Green Bay Packers",
  "Minnesota Vikings",
  "Atlanta Falcons",
  "Carolina Panthers",
  "New Orleans Saints",
  "Tampa Bay Buccaneers",
  "Arizona Cardinals",
  "San Francisco 49ers",
  "Seattle Seahawks",
];

describe("NFL_TEAM_VENUES", () => {
  it("has exactly all 32 teams, no more, no fewer", () => {
    const keys = Object.keys(NFL_TEAM_VENUES);
    expect(keys).toHaveLength(32);
    expect(keys.sort()).toEqual([...ALL_32_TEAMS].sort());
  });

  it("every entry has plausible (non-zero, real-looking) coordinates", () => {
    for (const [team, { lat, lon }] of Object.entries(NFL_TEAM_VENUES)) {
      // Continental US + Hawaii/Alaska-generous bounds -- catches an
      // obvious typo (e.g. a swapped sign or a stray zero) without
      // hardcoding each team's own precise expected range.
      expect(lat, `${team} latitude`).toBeGreaterThan(20);
      expect(lat, `${team} latitude`).toBeLessThan(50);
      expect(lon, `${team} longitude`).toBeGreaterThan(-125);
      expect(lon, `${team} longitude`).toBeLessThan(-65);
    }
  });

  it("shares identical coordinates for teams that share a real stadium", () => {
    expect(NFL_TEAM_VENUES["New York Jets"]).toEqual(NFL_TEAM_VENUES["New York Giants"]);
    expect(NFL_TEAM_VENUES["Los Angeles Chargers"]).toEqual(NFL_TEAM_VENUES["Los Angeles Rams"]);
  });
});

describe("getVenueForTeam", () => {
  it("returns the real venue for a known team", () => {
    expect(getVenueForTeam("Chicago Bears")).toEqual({ lat: 41.8623, lon: -87.6167 });
  });

  it("returns null for an unrecognized team name, rather than throwing", () => {
    expect(getVenueForTeam("Not A Real Team")).toBeNull();
  });
});
