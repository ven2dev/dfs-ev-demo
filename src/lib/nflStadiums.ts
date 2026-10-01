// Real venue coordinates for all 32 NFL teams' current home stadiums,
// keyed by the exact team-name strings the Odds API returns (e.g.
// "Chicago Bears") -- this retires the "look up venue coordinates
// live, every rotation" manual step that caused a real bug: weather.ts
// once hardcoded Seattle's coordinates regardless of which game was
// actually seeded, so a rotated-in Chicago game silently used Seattle's
// forecast (see #26).
//
// Verified 2026-09-29 directly against Wikipedia's live MediaWiki API
// (action=query&prop=coordinates), not a static/possibly-stale CSV --
// naming-rights churn and outright relocations are common enough that
// a stale source is a real risk, not a hypothetical one. Two real
// examples caught during this verification pass alone:
// - Houston's stadium reverted from "NRG Stadium" back to "Reliant
//   Stadium" in August 2026 (same building, name reverted to its
//   original 2002 name) -- Wikipedia's article title is a redirect,
//   coordinates unaffected either way.
// - Buffalo's Bills opened a BRAND NEW physical stadium in 2026 that
//   reuses the old stadium's name ("Highmark Stadium") -- a naive
//   "same name, so same location" assumption would have used the OLD
//   building's coordinates for the new one.
//
// Two stadiums are intentionally shared by two teams (Jets/Giants at
// MetLife, Chargers/Rams at SoFi) -- both team keys map to the same
// coordinates on purpose, not a copy-paste accident.
export const NFL_TEAM_VENUES: Record<string, { lat: number; lon: number }> = {
  "Buffalo Bills": { lat: 42.77305556, lon: -78.79222222 }, // Highmark Stadium
  "Miami Dolphins": { lat: 25.95805556, lon: -80.23888889 }, // Hard Rock Stadium
  "New England Patriots": { lat: 42.091, lon: -71.264 }, // Gillette Stadium
  "New York Jets": { lat: 40.81361111, lon: -74.07444444 }, // MetLife Stadium
  "New York Giants": { lat: 40.81361111, lon: -74.07444444 }, // MetLife Stadium (shared)
  "Baltimore Ravens": { lat: 39.27805556, lon: -76.62277778 }, // M&T Bank Stadium
  "Cincinnati Bengals": { lat: 39.095, lon: -84.516 }, // Paycor Stadium
  "Cleveland Browns": { lat: 41.50611111, lon: -81.69944444 }, // Huntington Bank Field
  "Pittsburgh Steelers": { lat: 40.44666667, lon: -80.01583333 }, // Acrisure Stadium
  "Houston Texans": { lat: 29.68472222, lon: -95.41083333 }, // Reliant Stadium
  "Indianapolis Colts": { lat: 39.76005556, lon: -86.16380556 }, // Lucas Oil Stadium
  "Jacksonville Jaguars": { lat: 30.32388889, lon: -81.6375 }, // EverBank Stadium
  "Tennessee Titans": { lat: 36.16638889, lon: -86.77138889 }, // Nissan Stadium
  "Denver Broncos": { lat: 39.74388889, lon: -105.02 }, // Empower Field at Mile High
  "Kansas City Chiefs": { lat: 39.04888889, lon: -94.48388889 }, // Arrowhead Stadium
  "Las Vegas Raiders": { lat: 36.09055556, lon: -115.18388889 }, // Allegiant Stadium
  "Los Angeles Chargers": { lat: 33.953, lon: -118.339 }, // SoFi Stadium
  "Los Angeles Rams": { lat: 33.953, lon: -118.339 }, // SoFi Stadium (shared)
  "Dallas Cowboys": { lat: 32.74777778, lon: -97.09277778 }, // AT&T Stadium
  "Philadelphia Eagles": { lat: 39.90083333, lon: -75.1675 }, // Lincoln Financial Field
  "Washington Commanders": { lat: 38.90777778, lon: -76.86444444 }, // Northwest Stadium
  "Chicago Bears": { lat: 41.8623, lon: -87.6167 }, // Soldier Field
  "Detroit Lions": { lat: 42.34, lon: -83.04555556 }, // Ford Field
  "Green Bay Packers": { lat: 44.50138889, lon: -88.06222222 }, // Lambeau Field
  "Minnesota Vikings": { lat: 44.974, lon: -93.258 }, // U.S. Bank Stadium
  "Atlanta Falcons": { lat: 33.75555556, lon: -84.4 }, // Mercedes-Benz Stadium
  "Carolina Panthers": { lat: 35.22583333, lon: -80.85277778 }, // Bank of America Stadium
  "New Orleans Saints": { lat: 29.95083333, lon: -90.08111111 }, // Caesars Superdome
  "Tampa Bay Buccaneers": { lat: 27.97583333, lon: -82.50333333 }, // Raymond James Stadium
  "Arizona Cardinals": { lat: 33.528, lon: -112.263 }, // State Farm Stadium
  "San Francisco 49ers": { lat: 37.403, lon: -121.97 }, // Levi's Stadium
  "Seattle Seahawks": { lat: 47.5952, lon: -122.3316 }, // Lumen Field
};

// The Odds API identifies event teams by full display name, while
// nflverse roster rows use these abbreviations. Keep this provider
// boundary explicit instead of attempting to derive abbreviations from
// city/nickname strings (notably LA/LAC, NYG/NYJ, and JAX).
export const NFL_TEAM_ABBREVIATIONS: Record<string, string> = {
  "Arizona Cardinals": "ARI",
  "Atlanta Falcons": "ATL",
  "Baltimore Ravens": "BAL",
  "Buffalo Bills": "BUF",
  "Carolina Panthers": "CAR",
  "Chicago Bears": "CHI",
  "Cincinnati Bengals": "CIN",
  "Cleveland Browns": "CLE",
  "Dallas Cowboys": "DAL",
  "Denver Broncos": "DEN",
  "Detroit Lions": "DET",
  "Green Bay Packers": "GB",
  "Houston Texans": "HOU",
  "Indianapolis Colts": "IND",
  "Jacksonville Jaguars": "JAX",
  "Kansas City Chiefs": "KC",
  "Las Vegas Raiders": "LV",
  "Los Angeles Chargers": "LAC",
  "Los Angeles Rams": "LA",
  "Miami Dolphins": "MIA",
  "Minnesota Vikings": "MIN",
  "New England Patriots": "NE",
  "New Orleans Saints": "NO",
  "New York Giants": "NYG",
  "New York Jets": "NYJ",
  "Philadelphia Eagles": "PHI",
  "Pittsburgh Steelers": "PIT",
  "San Francisco 49ers": "SF",
  "Seattle Seahawks": "SEA",
  "Tampa Bay Buccaneers": "TB",
  "Tennessee Titans": "TEN",
  "Washington Commanders": "WAS",
};

// Returns null for an unrecognized team name rather than throwing --
// callers decide how to degrade (e.g. fall back to a default location
// rather than fail the whole request) since this table can go stale
// (a relocation, a new team) without warning.
export const getVenueForTeam = (teamName: string): { lat: number; lon: number } | null =>
  NFL_TEAM_VENUES[teamName] ?? null;

export const getNflverseTeamAbbreviation = (teamName: string): string | null =>
  NFL_TEAM_ABBREVIATIONS[teamName] ?? null;
