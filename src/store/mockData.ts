import type { Matchup, PickEmGoal } from "@/types";

// Real upcoming NFL game and real player-prop market, confirmed available
// on The Odds API's free tier (americanfootball_nfl, player_pass_yds).
// The game/player/line are real. `recentGameStats` here is a fallback
// only — /api/stream overwrites it with real nflverse-backed history per
// player when available (see playerStatsRepo.ts). `salary` is mocked (no
// free DFS-platform salary API exists) and currently unused by the UI —
// kept on the type/seed for the still-deferred SalaryCapGoal display,
// same category of limitation as the mocked coverage filters.
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

// The only goal value anyone gets today, signed in or not -- no real
// goal-building UI exists yet (Phase 10). Shared between page.tsx's
// signed-out demo-preview seed and useInitAuth's signed-in Firestore
// seed so a signed-in user's first-ever goal is the SAME value in both
// places, not two independently-defined "defaults" that could drift.
//
// PickEmGoal, not SalaryCapGoal -- this is a player-props product
// (CLAUDE.md, 2026-09-27). The one seeded pick (Sam Darnold) uses an
// illustrative devigged-market probability, not a live one -- only the
// FIRST seeded prop (Drake Maye) is actually wired into the live SSE
// stream (see route.ts), so this leg has no live number to draw from
// yet. Real once live slate ingestion replaces the hardcoded matchup.
export const mockGoal: PickEmGoal = {
  kind: "pickEm",
  pickCount: 2,
  picks: [{ propId: "prop-sam-darnold-pass-yds", direction: "over", impliedProb: 0.53 }],
};
