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
export const PLAYER_PROP_MARKETS = [
  { key: "player_pass_yds", label: "Passing Yards" },
  { key: "player_pass_tds", label: "Passing Touchdowns" },
  { key: "player_pass_completions", label: "Pass Completions" },
  { key: "player_pass_attempts", label: "Pass Attempts" },
  { key: "player_pass_interceptions", label: "Interceptions Thrown" },
  { key: "player_rush_yds", label: "Rushing Yards" },
  { key: "player_rush_attempts", label: "Rush Attempts" },
  { key: "player_reception_yds", label: "Receiving Yards" },
  { key: "player_receptions", label: "Receptions" },
  { key: "player_anytime_td", label: "Anytime Touchdown" },
  { key: "player_1st_td", label: "First Touchdown" },
  { key: "player_last_td", label: "Last Touchdown" },
] as const;

export type PlayerPropMarketKey = (typeof PLAYER_PROP_MARKETS)[number]["key"];

export const isValidPlayerPropMarketKey = (key: string): key is PlayerPropMarketKey =>
  PLAYER_PROP_MARKETS.some((market) => market.key === key);
