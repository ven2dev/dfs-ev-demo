import { refuse } from "./errors.mjs";

// Minimum Step 1 checks. Full generated catalog contracts belong to Step 2.
export const baselineTables = Object.freeze([
  "creator_video_submissions", "creators", "event_market_odds_cache", "live_prop_inputs_cache",
  "nflverse_roster_players", "player_crosswalk", "player_game_stats", "sync_state",
]);
export const currentTables = Object.freeze([...baselineTables,
  "odds_api_request_log", "odds_collection_checkpoints", "odds_free_pilot_selections",
  "odds_observation_book_markets", "odds_observation_markets", "odds_observations",
  "odds_priority_targets", "odds_quote_sets", "odds_quotes",
].sort());

export async function verifyCandidateTables(client, version) {
  const tables = version === 1 ? baselineTables : version === 2 ? currentTables : null;
  if (!tables) refuse("unknown-candidate-schema-version");
  const { rows } = await client.query("SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = 'public' ORDER BY tablename");
  const expected = [...tables, "db_migrations"].sort();
  if (JSON.stringify(rows.map((row) => row.tablename)) !== JSON.stringify(expected)) refuse("candidate-table-mismatch");
}
