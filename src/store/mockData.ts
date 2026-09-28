import type { Matchup, PickEmGoal } from "@/types";

// Real upcoming NFL game and real player-prop markets, confirmed live
// on The Odds API's free tier as of 2026-09-27 (americanfootball_nfl,
// player_pass_yds + player_rush_yds). Rotates weekly to the current
// notable matchup until live slate ingestion (CLAUDE.md's near-term
// priorities) replaces this manual step entirely -- each rotation:
// 1. Confirm the real game (kickoff, teams, Odds API eventId, home
//    team's stadium coordinates, and a current line) and each player's
//    nflverse `player_id` -- verify live, don't guess (all of these
//    change season to season, sometimes week to week). A hardcoded
//    venue was the exact bug the LAST rotation shipped: weather.ts once
//    hardcoded Seattle's coordinates, so this game's "real weather" was
//    silently Seattle's forecast, not Chicago's -- venueLat/venueLon
//    below is what fetchGameWeather actually uses now.
// 2. Update this file's `mockMatchup`/`mockGoal`.
// 3. Re-run db/seed_crosswalk.sql against the live DB (replaces the
//    old rotation's crosswalk rows, not additive).
// 4. Trigger a manual sync (see README's "Keeping it in sync") so real
//    historical stats exist for the new players immediately, rather
//    than waiting for the next scheduled cron run.
//
// Current rotation (2026-09-27): Eagles @ Bears, Monday Night
// Football, 2026-09-28 8:15pm ET / Soldier Field -- verified via
// nfl.com's schedule and confirmed live on the Odds API. Next
// rotations, per the plan: that week's Thursday Night Football game,
// then whichever Sunday game has the highest combined-score/marquee
// billing.
//
// `recentGameStats` here is a fallback only — /api/stream overwrites it
// with real nflverse-backed history per player when available (see
// playerStatsRepo.ts); the two values below are each player's actual
// weeks 1-2 stat lines (real, not fabricated), since week 3 wasn't
// posted yet as of this rotation. `salary` is mocked (no free
// DFS-platform salary API exists) and currently unused by the UI —
// kept on the type/seed for the still-deferred SalaryCapGoal display,
// same category of limitation as the mocked coverage filters.
export const mockMatchup: Matchup = {
  id: "matchup-1",
  homeTeam: "Chicago Bears",
  awayTeam: "Philadelphia Eagles",
  startTime: "2026-09-29T00:15:00.000Z",
  sportKey: "americanfootball_nfl",
  eventId: "47dc7baa254659f3beb2ed2b38c207b6",
  // Soldier Field, Chicago (home team's stadium) -- verified live, not
  // estimated: 41.8623 N, 87.6167 W.
  venueLat: 41.8623,
  venueLon: -87.6167,
  props: [
    {
      propId: "prop-jalen-hurts-pass-yds",
      playerName: "Jalen Hurts",
      propType: "Passing Yards",
      marketKey: "player_pass_yds",
      line: 214.5,
      salary: 7600,
      recentGameStats: [203, 264],
    },
    {
      propId: "prop-saquon-barkley-rush-yds",
      playerName: "Saquon Barkley",
      propType: "Rushing Yards",
      marketKey: "player_rush_yds",
      line: 71.5,
      salary: 8200,
      recentGameStats: [83, 9],
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
// (CLAUDE.md, 2026-09-27). The one seeded pick (Saquon Barkley, Over
// 71.5 rushing yards) uses a real devigged-market probability (~0.504,
// from DraftKings' Over/Under 1.88/1.91 as of 2026-09-27) -- only the
// FIRST seeded prop (Jalen Hurts) is actually wired into the live SSE
// stream (see route.ts), so this leg has no LIVE number to draw from,
// but the seed itself isn't fabricated. Re-devig from a fresh odds pull
// each rotation (see mockMatchup's header comment) rather than leaving
// this stale -- a two-game-old market snapshot is a worse look than an
// honestly-labeled mock, for a number that IS meant to be real.
export const mockGoal: PickEmGoal = {
  kind: "pickEm",
  pickCount: 2,
  picks: [
    { propId: "prop-saquon-barkley-rush-yds", direction: "over", impliedProb: 0.504 },
  ],
};
