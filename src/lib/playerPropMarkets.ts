// The fixed checklist of NFL player-prop markets discovery can request
// (see #27's roadmap). Every key here was verified live against a real
// upcoming event (2026-09-29) -- each one actually returned real
// outcome data, not guessed off a name pattern.
//
// Two distinct outcome shapes exist across these, confirmed live:
// - Yardage/count markets (yds, attempts, completions, interceptions,
//   receptions): real two-way Over/Under lines, each outcome shaped
//   { name: "Over" | "Under", description: playerName, price, point }.
// - Touchdown-scorer markets (anytime/1st/last): single-sided "Yes"
//   props, no Under side, no point -- { name: "Yes", description:
//   playerName, price }. discoveredProps.ts's grouping handles both
//   shapes uniformly rather than special-casing this list.
import type { SupportedStatType } from "./playerStatsSync";

export type PlayerPropDirection = "over" | "under";
export type PlayerPropOutcomeShape = "over-under" | "yes-only";

type PlayerPropMarketDefinition = {
  key: string;
  label: string;
  outcomeShape: PlayerPropOutcomeShape;
  historicalStatType: SupportedStatType | null;
  compatibleRosterPositions: readonly string[] | null;
  trackable: boolean;
};

// This is the single capability registry used by discovery, watch
// controls, and the live stream. A market is trackable only when it has
// both a two-way price (needed for devigging) and a matching historical
// stat (needed for the model). Yes-only scorer markets remain visible
// for browsing, but cannot silently enter the two-way live pipeline.
export const PLAYER_PROP_MARKETS = [
  {
    key: "player_pass_yds",
    label: "Passing Yards",
    outcomeShape: "over-under",
    historicalStatType: "passing_yards",
    compatibleRosterPositions: ["QB"],
    trackable: true,
  },
  {
    key: "player_pass_tds",
    label: "Passing Touchdowns",
    outcomeShape: "over-under",
    historicalStatType: "passing_tds",
    compatibleRosterPositions: ["QB"],
    trackable: true,
  },
  {
    key: "player_pass_completions",
    label: "Pass Completions",
    outcomeShape: "over-under",
    historicalStatType: "completions",
    compatibleRosterPositions: ["QB"],
    trackable: true,
  },
  {
    key: "player_pass_attempts",
    label: "Pass Attempts",
    outcomeShape: "over-under",
    historicalStatType: "attempts",
    compatibleRosterPositions: ["QB"],
    trackable: true,
  },
  {
    key: "player_pass_interceptions",
    label: "Interceptions Thrown",
    outcomeShape: "over-under",
    historicalStatType: "passing_interceptions",
    compatibleRosterPositions: ["QB"],
    trackable: true,
  },
  {
    key: "player_rush_yds",
    label: "Rushing Yards",
    outcomeShape: "over-under",
    historicalStatType: "rushing_yards",
    compatibleRosterPositions: ["QB", "RB", "FB", "WR", "TE"],
    trackable: true,
  },
  {
    key: "player_rush_attempts",
    label: "Rush Attempts",
    outcomeShape: "over-under",
    historicalStatType: "carries",
    compatibleRosterPositions: ["QB", "RB", "FB", "WR", "TE"],
    trackable: true,
  },
  {
    key: "player_reception_yds",
    label: "Receiving Yards",
    outcomeShape: "over-under",
    historicalStatType: "receiving_yards",
    compatibleRosterPositions: ["RB", "FB", "WR", "TE"],
    trackable: true,
  },
  {
    key: "player_receptions",
    label: "Receptions",
    outcomeShape: "over-under",
    historicalStatType: "receptions",
    compatibleRosterPositions: ["RB", "FB", "WR", "TE"],
    trackable: true,
  },
  {
    key: "player_anytime_td",
    label: "Anytime Touchdown",
    outcomeShape: "yes-only",
    historicalStatType: "anytime_td",
    compatibleRosterPositions: null,
    trackable: false,
  },
  {
    key: "player_1st_td",
    label: "First Touchdown",
    outcomeShape: "yes-only",
    historicalStatType: null,
    compatibleRosterPositions: null,
    trackable: false,
  },
  {
    key: "player_last_td",
    label: "Last Touchdown",
    outcomeShape: "yes-only",
    historicalStatType: null,
    compatibleRosterPositions: null,
    trackable: false,
  },
] as const satisfies readonly PlayerPropMarketDefinition[];

export type PlayerPropMarketKey = (typeof PLAYER_PROP_MARKETS)[number]["key"];

export const isValidPlayerPropMarketKey = (key: string): key is PlayerPropMarketKey =>
  PLAYER_PROP_MARKETS.some((market) => market.key === key);

export const getPlayerPropMarket = (key: string) =>
  PLAYER_PROP_MARKETS.find((market) => market.key === key);

export const isTrackablePlayerPropMarket = (key: string): key is PlayerPropMarketKey =>
  getPlayerPropMarket(key)?.trackable === true;
