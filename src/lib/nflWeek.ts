// Verified live 2026-09-29 (web search, not guessed): the 2026 NFL
// regular season's Week 1 opened Wednesday 2026-09-09 (Seahawks @
// Patriots), with the bulk of Week 1 on Sun 9-13/Mon 9-14. NFL weeks
// reset every Tuesday regardless of which days that week's games fall
// on (true even in a Thursday-heavy week like Thanksgiving) -- so the
// anchor here is the Tuesday immediately before Week 1's first game.
//
// Display-only precision: this is a UTC calendar-week bucket for a text
// label ("Browse the Week 4 slate"), not an input to any EV
// calculation -- exact timezone-boundary correctness at the Monday
// night into Tuesday transition isn't worth the complexity it'd add.
const WEEK_1_TUESDAY_ANCHOR_MS = Date.parse("2026-09-08T00:00:00Z");
const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;
const REGULAR_SEASON_WEEKS = 18;

// Not clamped to 1 -- a date before the season start legitimately
// produces 0 or negative, which is what lets getCurrentNflWeekLabel
// tell "before the season" apart from "Week 1" instead of conflating them.
export const getCurrentNflWeek = (now: Date = new Date()): number =>
  Math.floor((now.getTime() - WEEK_1_TUESDAY_ANCHOR_MS) / MS_PER_WEEK) + 1;

// A plain week number doesn't mean anything before the season starts or
// after the regular season ends -- those get their own honest label
// rather than a fabricated "Week 0" or "Week 21".
export const getCurrentNflWeekLabel = (now: Date = new Date()): string => {
  const week = getCurrentNflWeek(now);
  if (week < 1) return "preseason";
  if (week > REGULAR_SEASON_WEEKS) return "playoffs";
  return `Week ${week}`;
};
