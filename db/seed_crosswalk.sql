-- #26: manual player_crosswalk seed, right-sized for the two players
-- currently seeded in src/store/mockData.ts. Looked up directly against
-- the synced player_game_stats table (nflverse's short-form player_name,
-- e.g. "J.Hurts", not the Odds API's full "Jalen Hurts").
--
-- Rotates with the working example (see mockData.ts's header comment) --
-- until live slate ingestion (CLAUDE.md's near-term priorities) replaces
-- this manual step, re-run this file each time the seeded matchup
-- changes. Old entries are intentionally replaced, not accumulated --
-- their already-synced player_game_stats rows are unaffected either way.
INSERT INTO player_crosswalk (odds_api_name, nflverse_player_id, nflverse_player_name)
VALUES
  ('Jalen Hurts', '00-0036389', 'J.Hurts'),
  ('Saquon Barkley', '00-0034844', 'S.Barkley')
ON CONFLICT (odds_api_name) DO UPDATE SET
  nflverse_player_id = EXCLUDED.nflverse_player_id,
  nflverse_player_name = EXCLUDED.nflverse_player_name;
