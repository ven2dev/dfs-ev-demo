import { expect, it } from "vitest";
import { withTestClient } from "./harness";

it("bootstraps the full application schema twice on PostgreSQL 18", async () => {
  await withTestClient(async (client) => {
    const tables = await client.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename"
    );
    expect(tables.rows.map((row) => row.tablename)).toEqual([
      "creator_video_submissions",
      "creators",
      "event_market_odds_cache",
      "live_prop_inputs_cache",
      "nflverse_roster_players",
      "odds_api_request_log",
      "odds_collection_checkpoints",
      "odds_free_pilot_selections",
      "odds_observation_book_markets",
      "odds_observation_markets",
      "odds_observations",
      "odds_priority_targets",
      "odds_quote_sets",
      "odds_quotes",
      "player_crosswalk",
      "player_game_stats",
      "sync_state",
    ]);
  });
});
