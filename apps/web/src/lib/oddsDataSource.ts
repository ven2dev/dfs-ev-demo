export const ODDS_DATA_SOURCES = ["live", "fixture"] as const;

export type OddsDataSource = (typeof ODDS_DATA_SOURCES)[number];

export const isOddsDataSource = (value: unknown): value is OddsDataSource =>
  typeof value === "string" && (ODDS_DATA_SOURCES as readonly string[]).includes(value);
