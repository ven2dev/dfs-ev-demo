-- #26: manual player_crosswalk seed, right-sized for the two players
-- currently seeded in src/store/mockData.ts. Looked up directly against
-- the synced player_game_stats table (nflverse's short-form player_name,
-- e.g. "J.Hurts", not the Odds API's full "Jalen Hurts").
--
-- Rotates with the working example (see mockData.ts's header comment) --
-- until live slate ingestion (CLAUDE.md's near-term priorities) replaces
-- this manual step, re-run this file each time the seeded matchup
-- changes. The DELETE below is what actually makes "replaced, not
-- accumulated" true -- an earlier version of this file only upserted,
-- so every past rotation's players silently piled up in the live table
-- (caught in review: Drake Maye/Sam Darnold were still present two
-- rotations later). Deleting the crosswalk row does NOT touch that
-- player's already-synced player_game_stats rows -- those stay, keyed
-- by nflverse_player_id, independent of the crosswalk.
DELETE FROM player_crosswalk
WHERE odds_api_name NOT IN ('Jalen Hurts', 'Saquon Barkley');

INSERT INTO player_crosswalk (odds_api_name, nflverse_player_id, nflverse_player_name)
VALUES
  ('Jalen Hurts', '00-0036389', 'J.Hurts'),
  ('Saquon Barkley', '00-0034844', 'S.Barkley')
ON CONFLICT (odds_api_name) DO UPDATE SET
  nflverse_player_id = EXCLUDED.nflverse_player_id,
  nflverse_player_name = EXCLUDED.nflverse_player_name;
