import type { Matchup } from "@/types";

export const mockMatchup: Matchup = {
  id: "matchup-1",
  homeTeam: "Kansas City Chiefs",
  awayTeam: "Buffalo Bills",
  startTime: "2026-09-07T20:20:00.000Z",
  props: [
    {
      propId: "prop-1",
      playerName: "Patrick Mahomes",
      propType: "Passing Yards",
      line: 275.5,
      recentGameStats: [312, 265, 298, 240, 301, 289, 255],
    },
    {
      propId: "prop-2",
      playerName: "Travis Kelce",
      propType: "Receiving Yards",
      line: 65.5,
      recentGameStats: [72, 58, 81, 45, 90, 63, 55],
    },
    {
      propId: "prop-3",
      playerName: "Josh Allen",
      propType: "Passing Touchdowns",
      line: 1.5,
      recentGameStats: [2, 1, 3, 1, 2, 0, 2],
    },
  ],
};

export const mockEnvironment: Record<string, unknown> = {
  temperatureF: 42,
  windSpeedMph: 8,
  precipitationChance: 0.1,
  isDome: false,
};

export const mockCoverageFilters: Record<string, unknown> = {
  primaryDefender: "J. Smith",
  shadowCoverageRate: 0.35,
  avgSeparationYards: 2.3,
};
