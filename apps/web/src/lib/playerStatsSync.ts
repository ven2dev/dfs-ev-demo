// Pure, DI'd orchestration -- mirrors accountDeletion.ts's pattern.
// Network/CSV-parsing/Postgres concerns all live in the real
// implementations wired in later; this only deals with already-parsed
// row objects, so it's testable with plain fakes.

// nflverse's own game_id format ("{season}_{week}_{away}_{home}", e.g.
// "2026_01_ATL_PIT") lets is_home be derived without a join, but there's
// no calendar date encoded in it -- the weekly stats file itself has no
// game_date/is_home column at all (confirmed against the live CSV
// header). Both come from a join against nflverse's separate schedules
// release (games.csv) via the same game_id.
export const NFLVERSE_STATS_SOURCE = "nflverse_stats_player";
export const NFLVERSE_SCHEDULES_SOURCE = "nflverse_schedules";

// The realistic set of player props across skill positions, kickers,
// and defense, plus both standard and PPR fantasy points (nflverse
// precomputes both -- no conversion formula needed) -- cross-checked
// against Underdog's own published NFL scoring rules. A few (anytime_td,
// total_tds, kicking_points, tackles_plus_assists, first_downs) are
// derived from more than one column rather than a direct mapping; see
// STAT_TYPE_SOURCE below for exactly how each is computed.
//
// Deliberately NOT here, regardless of cost: First/Last/Nth TD scorer,
// first completion/reception/rush (yards), quarter/half splits, red
// zone attempts/targets, X+ yard play counts, Game/Day High markets --
// all of these need play-by-play sequencing (nflverse's separate,
// much larger nflfastR dataset), not the weekly aggregate totals this
// ticket ingests. A genuinely separate future initiative, not a cost
// tradeoff to make here.
export type SupportedStatType =
  | "passing_yards"
  | "passing_tds"
  | "completions"
  | "attempts"
  | "passing_interceptions"
  | "passing_first_downs"
  | "rushing_yards"
  | "rushing_tds"
  | "carries"
  | "receiving_yards"
  | "receiving_tds"
  | "receptions"
  | "targets"
  | "field_goals_made"
  | "extra_points_made"
  | "fantasy_points"
  | "fantasy_points_ppr"
  | "anytime_td"
  | "total_tds"
  | "rush_rec_first_downs"
  | "kicking_points"
  | "total_fumbles"
  | "fumbles_lost"
  | "solo_tackles"
  | "tackle_assists"
  | "tackles_plus_assists"
  | "sacks"
  | "tackles_for_loss";

// A source is either a direct nflverse column name, or a function
// deriving a value from the row -- for stats that aren't a single
// column. Returning undefined means "not applicable to this row" (e.g.
// a kicker has no rushing/receiving columns at all), same as a blank
// column value -- distinct from a genuine zero.
type StatSource = string | ((row: NflverseStatsRow) => number | undefined);

const numberOrUndefined = (value: string | undefined): number | undefined =>
  value === undefined || value === "" ? undefined : Number(value);

// Sums several columns, treating a present-but-blank column as 0 --
// but only once at least ONE of them is actually present on this row.
// If none are, the whole stat isn't applicable (e.g. rush/rec first
// downs for a pure defensive player), not "zero."
const sumColumns = (row: NflverseStatsRow, columns: string[]): number | undefined => {
  const values = columns.map((column) => numberOrUndefined(row[column]));
  if (values.every((value) => value === undefined)) return undefined;
  return values.reduce((sum: number, value) => sum + (value ?? 0), 0);
};

export const STAT_TYPE_SOURCE: Record<SupportedStatType, StatSource> = {
  passing_yards: "passing_yards",
  passing_tds: "passing_tds",
  completions: "completions",
  attempts: "attempts",
  passing_interceptions: "passing_interceptions",
  passing_first_downs: "passing_first_downs",
  rushing_yards: "rushing_yards",
  rushing_tds: "rushing_tds",
  carries: "carries",
  receiving_yards: "receiving_yards",
  receiving_tds: "receiving_tds",
  receptions: "receptions",
  targets: "targets",
  field_goals_made: "fg_made",
  extra_points_made: "pat_made",
  fantasy_points: "fantasy_points",
  fantasy_points_ppr: "fantasy_points_ppr",
  total_fumbles: "fumbles_total",
  fumbles_lost: "fumbles_lost_total",
  solo_tackles: "def_tackles_solo",
  tackle_assists: "def_tackle_assists",
  sacks: "def_sacks",
  tackles_for_loss: "def_tackles_for_loss",
  // Passing TDs don't count -- that's the QB throwing, not scoring.
  anytime_td: (row) => sumColumns(row, ["rushing_tds", "receiving_tds"]),
  // Distinct from anytime_td: Underdog's "Total TDs" explicitly
  // includes passing TDs too.
  total_tds: (row) => sumColumns(row, ["passing_tds", "rushing_tds", "receiving_tds"]),
  rush_rec_first_downs: (row) => sumColumns(row, ["rushing_first_downs", "receiving_first_downs"]),
  tackles_plus_assists: (row) => sumColumns(row, ["def_tackles_solo", "def_tackle_assists"]),
  kicking_points: (row) => {
    const fg = numberOrUndefined(row.fg_made);
    const pat = numberOrUndefined(row.pat_made);
    if (fg === undefined && pat === undefined) return undefined;
    return (fg ?? 0) * 3 + (pat ?? 0) * 1;
  },
};

// Raw CSV rows arrive as strings -- numeric coercion happens in the
// melt loop below, not here.
export type NflverseStatsRow = {
  player_id: string;
  player_name: string;
  team: string;
  opponent_team: string;
  season: string;
  week: string;
  game_id: string;
  // Coarse category (QB/RB/WR/TE/OL/DL/LB/DB/SPEC) and the finer
  // position within it (SPEC covers K/LS/P, which is why kicking stats
  // below gate on `position`, not `position_group`) -- both confirmed
  // against the live nflverse CSV, can be blank for some rows.
  position: string;
  position_group: string;
} & Record<string, string | undefined>;

export type NflverseScheduleRow = {
  game_id: string;
  gameday: string; // "YYYY-MM-DD"
  home_team: string;
};

export type PlayerGameStatRow = {
  player_id: string;
  player_name: string;
  team: string;
  opponent: string;
  is_home: boolean;
  season: number;
  week: number;
  game_date: string;
  stat_type: SupportedStatType;
  stat_value: number;
};

export type SyncPlayerStatsDeps = {
  // Cheap metadata checks (GitHub Releases API), not the actual files.
  fetchStatsReleaseUpdatedAt: () => Promise<string>;
  fetchSchedulesReleaseUpdatedAt: () => Promise<string>;
  readSyncState: (sourceName: string) => Promise<string | null>;
  writeSyncState: (sourceName: string, updatedAt: string) => Promise<void>;
  // Only called if something changed since last sync.
  fetchStatsRows: () => Promise<NflverseStatsRow[]>;
  fetchScheduleRows: () => Promise<NflverseScheduleRow[]>;
  upsertStats: (rows: PlayerGameStatRow[]) => Promise<void>;
};

export type SyncPlayerStatsResult =
  | { status: "up-to-date" }
  | { status: "synced"; rowsUpserted: number };

const OFFENSE_SKILL_GROUPS = new Set(["QB", "RB", "WR", "TE"]);
const DEFENSE_GROUPS = new Set(["DB", "DL", "LB"]);

// nflverse fills a position-inapplicable column with a literal "0", not
// a blank -- e.g. a kicker's row has passing_yards: "0", not "". Without
// this gate, numberOrUndefined/sumColumns treat that "0" as a genuine
// present value, storing a meaningless "this kicker has 0 passing
// yards" row (confirmed live: N.Folk, a real kicker, had exactly this
// happen for anytime_td/attempts/carries/completions before this fix).
// Gates on the actual applicability of the stat to the position, not on
// whether this particular row's value happens to be zero.
const isApplicableToPosition = (statType: SupportedStatType, row: NflverseStatsRow): boolean => {
  switch (statType) {
    case "passing_yards":
    case "passing_tds":
    case "completions":
    case "attempts":
    case "passing_interceptions":
    case "passing_first_downs":
      return row.position_group === "QB";
    case "rushing_yards":
    case "rushing_tds":
    case "carries":
    case "receiving_yards":
    case "receiving_tds":
    case "receptions":
    case "targets":
    case "total_fumbles":
    case "fumbles_lost":
    case "anytime_td":
    case "total_tds":
    case "rush_rec_first_downs":
      return OFFENSE_SKILL_GROUPS.has(row.position_group);
    // SPEC also covers punters/long-snappers, who never have real FG/XP
    // stats -- the finer `position` field is required here, not
    // position_group.
    case "field_goals_made":
    case "extra_points_made":
    case "kicking_points":
      return row.position === "K";
    case "solo_tackles":
    case "tackle_assists":
    case "tackles_plus_assists":
    case "sacks":
    case "tackles_for_loss":
      return DEFENSE_GROUPS.has(row.position_group);
    // nflverse computes these for every player regardless of position --
    // no gate needed; a kicker's real fantasy_points is a real fact,
    // not injected noise.
    case "fantasy_points":
    case "fantasy_points_ppr":
      return true;
    default: {
      const exhaustiveCheck: never = statType;
      throw new Error(`isApplicableToPosition: unhandled stat type ${exhaustiveCheck}`);
    }
  }
};

export const syncPlayerStats = async (
  deps: SyncPlayerStatsDeps
): Promise<SyncPlayerStatsResult> => {
  const [statsUpdatedAt, schedulesUpdatedAt] = await Promise.all([
    deps.fetchStatsReleaseUpdatedAt(),
    deps.fetchSchedulesReleaseUpdatedAt(),
  ]);
  const [lastStats, lastSchedules] = await Promise.all([
    deps.readSyncState(NFLVERSE_STATS_SOURCE),
    deps.readSyncState(NFLVERSE_SCHEDULES_SOURCE),
  ]);

  // Compared as parsed instants, not raw strings: confirmed live against
  // the real Postgres round-trip that GitHub's raw timestamp format
  // ("...T00:38:02Z") and Postgres's stored/returned format don't share
  // a single string representation, even for the identical instant --
  // a naive string comparison here is always false, silently defeating
  // the whole idempotency check on every run.
  const sameInstant = (a: string | null, b: string) =>
    a !== null && new Date(a).getTime() === new Date(b).getTime();

  // Either source moving is enough to re-sync: a schedules-only change
  // (e.g. a corrected game date) still needs re-joining against the
  // stats we already have.
  if (sameInstant(lastStats, statsUpdatedAt) && sameInstant(lastSchedules, schedulesUpdatedAt)) {
    return { status: "up-to-date" };
  }

  const [statsRows, scheduleRows] = await Promise.all([
    deps.fetchStatsRows(),
    deps.fetchScheduleRows(),
  ]);
  const gameById = new Map(scheduleRows.map((game) => [game.game_id, game]));

  const rows: PlayerGameStatRow[] = [];
  for (const statRow of statsRows) {
    const game = gameById.get(statRow.game_id);
    // Schedules data not published for this game yet -- skip for now,
    // the next sync (schedules will have moved) picks it up.
    if (!game) continue;

    for (const [statType, source] of Object.entries(STAT_TYPE_SOURCE) as [
      SupportedStatType,
      StatSource,
    ][]) {
      if (!isApplicableToPosition(statType, statRow)) continue;

      const statValue =
        typeof source === "string" ? numberOrUndefined(statRow[source]) : source(statRow);
      if (statValue === undefined) continue;

      rows.push({
        player_id: statRow.player_id,
        player_name: statRow.player_name,
        team: statRow.team,
        opponent: statRow.opponent_team,
        is_home: statRow.team === game.home_team,
        season: Number(statRow.season),
        week: Number(statRow.week),
        game_date: game.gameday,
        stat_type: statType,
        stat_value: statValue,
      });
    }
  }

  if (rows.length > 0) {
    await deps.upsertStats(rows);
  }

  // Both watermarks advance together, even if only one source actually
  // changed -- a no-op re-sync of an unchanged source is harmless, and
  // this keeps the "did anything change" check above a simple equality.
  await Promise.all([
    deps.writeSyncState(NFLVERSE_STATS_SOURCE, statsUpdatedAt),
    deps.writeSyncState(NFLVERSE_SCHEDULES_SOURCE, schedulesUpdatedAt),
  ]);

  return { status: "synced", rowsUpserted: rows.length };
};
