import type { PickEmGoal } from "@/types";

// mockMatchup/mockEnvironment (the single hardcoded game + its manual
// weekly-rotation ritual) are retired as of #27 step 8 -- the app
// ingests the real slate now (SlateBrowser + /api/stream driven by a
// real watched selection), so there's no longer a single seeded game to
// keep in sync by hand. mockCoverageFilters/mockGoal below remain: both
// are still-legitimate, deliberately-scoped mocks (no affordable
// alignment/coverage data source exists; no goal-building UI exists
// yet), not artifacts of the retired rotation habit.
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
// from a real DraftKings Over/Under captured 2026-09-27) -- a genuine
// snapshot, not fabricated, but a static one: since #27's real slate
// ingestion, no seeded pick here is wired into live tracking (a real
// selection only exists once a user actually clicks Watch on a real
// discovered prop), so this leg's probability doesn't move and its
// propId doesn't resolve to anything live -- it's a fixed illustrative
// value for the joint-probability demo, not a second real-time leg.
export const mockGoal: PickEmGoal = {
  kind: "pickEm",
  pickCount: 2,
  picks: [
    { propId: "prop-saquon-barkley-rush-yds", direction: "over", impliedProb: 0.504 },
  ],
};
