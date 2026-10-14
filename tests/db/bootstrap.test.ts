import { expect, it } from "vitest";
import { bootstrapTestDatabase, withTestClient } from "./harness";

it("bootstraps the full application schema twice on PostgreSQL 18", async () => {
  await withTestClient(async (client) => {
    const tables = await client.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename"
    );
    expect(tables.rows.map((row) => row.tablename)).toEqual([
      "corpus_api_videos",
      "corpus_capture_events",
      "corpus_decision_events",
      "corpus_gate_registrations",
      "corpus_imports",
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
      "predictive_blob_removals",
      "predictive_blobs",
      "predictive_captures",
      "predictive_decision_inputs",
      "predictive_decisions",
      "predictive_feature_run_dependencies",
      "predictive_feature_run_pins",
      "predictive_feature_run_unpins",
      "predictive_feature_runs",
      "predictive_games",
      "predictive_ingestion_runs",
      "predictive_observations",
      "predictive_outcome_labels",
      "predictive_profile_identity_links",
      "predictive_retention_authorizations",
      "predictive_retention_events",
      "predictive_retention_tombstones",
      "predictive_rights_decisions",
      "predictive_run_rights",
      "predictive_source_binding_captures",
      "predictive_source_binding_decisions",
      "predictive_source_binding_dependencies",
      "predictive_source_binding_links",
      "predictive_source_binding_rights",
      "predictive_source_binding_rows",
      "predictive_source_bindings",
      "predictive_source_consumer_bindings",
      "predictive_source_consumer_decisions",
      "predictive_source_consumer_observations",
      "predictive_source_consumer_rights",
      "predictive_source_consumer_source_decisions",
      "predictive_source_consumers",
      "predictive_source_decision_bindings",
      "predictive_source_decision_inputs",
      "predictive_source_decision_rights",
      "predictive_source_decisions",
      "predictive_source_profiles",
      "predictive_source_stats_revisions",
      "predictive_source_stats_rows",
      "predictive_teams",
      "predictive_training_retention_audits",
      "predictive_training_run_events",
      "predictive_training_run_identities",
      "predictive_training_run_profiles",
      "predictive_training_run_slots",
      "predictive_training_runs",
      "sync_state",
    ]);
    const historySql = "SELECT * FROM public.db_migrations ORDER BY version";
    const history = (await client.query(historySql)).rows;
    expect(history.map(({ version, provenance, sha256 }) => ({ version, provenance, sha256 }))).toEqual([
      { version: 1, provenance: "executed", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
      { version: 2, provenance: "executed", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
      { version: 3, provenance: "executed", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
      { version: 4, provenance: "executed", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
      { version: 5, provenance: "executed", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
      { version: 6, provenance: "executed", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
      { version: 7, provenance: "executed", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
      { version: 8, provenance: "executed", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
      { version: 9, provenance: "executed", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
      { version: 10, provenance: "executed", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
      { version: 11, provenance: "executed", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
      { version: 12, provenance: "executed", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
      { version: 13, provenance: "executed", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
      { version: 14, provenance: "executed", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
    ]);
    await client.query(`INSERT INTO live_prop_inputs_cache (sport_key, event_id, market_key, player_name)
      VALUES ('synthetic-bootstrap', 'synthetic-event', 'player_pass_yds', 'Synthetic Player')`);
    const rows = (await client.query("SELECT * FROM live_prop_inputs_cache")).rows;
    const result = await bootstrapTestDatabase();
    expect(result.first.executed).toEqual([]);
    expect(result.repeat.executed).toEqual([]);
    expect(result.repeat.schemaVersion).toBe(14);
    expect((await client.query(historySql)).rows).toEqual(history);
    expect((await client.query("SELECT * FROM live_prop_inputs_cache")).rows).toEqual(rows);
  });
});
