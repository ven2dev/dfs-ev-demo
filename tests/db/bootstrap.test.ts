import { expect, it } from "vitest";
import { bootstrapTestDatabase, withTestClient } from "./harness";

it("bootstraps the full application schema twice on PostgreSQL 18", async () => {
  await withTestClient(async (client) => {
    const tables = await client.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename"
    );
    expect(tables.rows.map((row) => row.tablename)).toEqual([
      "creator_video_submissions",
      "creators",
      "db_migrations",
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
      "predictive_artifact_observations",
      "predictive_artifacts",
      "predictive_captures",
      "predictive_games",
      "predictive_ingestion_runs",
      "predictive_observations",
      "predictive_teams",
      "sync_state",
    ]);
    const historySql = "SELECT * FROM public.db_migrations ORDER BY version";
    const history = (await client.query(historySql)).rows;
    expect(history.map(({ version, provenance, sha256 }) => ({ version, provenance, sha256 }))).toEqual([
      { version: 1, provenance: "executed", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
      { version: 2, provenance: "executed", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
      { version: 3, provenance: "executed", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
      { version: 4, provenance: "executed", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
    ]);
    await client.query(`INSERT INTO live_prop_inputs_cache (sport_key, event_id, market_key, player_name)
      VALUES ('synthetic-bootstrap', 'synthetic-event', 'player_pass_yds', 'Synthetic Player')`);
    const rows = (await client.query("SELECT * FROM live_prop_inputs_cache")).rows;
    const result = await bootstrapTestDatabase();
    expect(result.first.executed).toEqual([]);
    expect(result.repeat.executed).toEqual([]);
    expect(result.repeat.schemaVersion).toBe(4);
    expect((await client.query(historySql)).rows).toEqual(history);
    expect((await client.query("SELECT * FROM live_prop_inputs_cache")).rows).toEqual(rows);
  });
});
