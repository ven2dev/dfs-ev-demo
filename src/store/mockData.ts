import type { Matchup } from "@/types";

// Real upcoming NFL game and real player-prop market, confirmed available
// on The Odds API's free tier (americanfootball_nfl, player_pass_yds).
// The game/player/line are real. recentGameStats AND salary are mocked —
// no free historical game-log API or DFS-platform salary API exists in
// the time available. The Goal-impact display (projected pts, salary
// used) is therefore internally consistent (correctly derived from its
// stated inputs, not misusing the edge percentage) but still ultimately
// rests on invented historical/salary numbers, not real DFS platform
// data — same category of limitation as the mocked coverage filters.
export const mockMatchup: Matchup = {
  id: "matchup-1",
  homeTeam: "Seattle Seahawks",
  awayTeam: "New England Patriots",
  startTime: "2026-09-10T00:15:00.000Z",
  sportKey: "americanfootball_nfl",
  eventId: "8c94552d022acec4a0458d70c19d3da9",
  props: [
    {
      propId: "prop-drake-maye-pass-yds",
      playerName: "Drake Maye",
      propType: "Passing Yards",
      marketKey: "player_pass_yds",
      line: 229.5,
      salary: 7200,
      recentGameStats: [245, 198, 261, 210, 233, 189, 254],
    },
    {
      propId: "prop-sam-darnold-pass-yds",
      playerName: "Sam Darnold",
      propType: "Passing Yards",
      marketKey: "player_pass_yds",
      line: 233.5,
      salary: 6800,
      recentGameStats: [268, 241, 219, 255, 230, 248, 201],
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
